import { socket, me, directive, trafficLight, manualHold, lightMission } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('llm');
const chatLog = createLogger('llm:chat');

const adminId  = process.env.ADMIN_ID  ?? null;
const workerId = process.env.WORKER_ID ?? null;
import { runDirective, runConversation, classifyDirective } from './commandLoop.js';
import { handlePartnerMessage } from './partner.js';
import { stopHandoff } from './handoff.js';

/**
 * Wait until the agent is authenticated (id and position known)
 * @returns {Promise<void>} Resolves once me.isReady
 */
function whenReady() {
    if (me.isReady) return Promise.resolve();
    return new Promise(resolve => {
        const t = setInterval(() => {
            if (me.isReady) { clearInterval(t); resolve(); }
        }, 100);
    });
}

/**
 * Register the LLM command layer and wire up all message routing
 * @param {Object} myAgent - Agent with commandAndAwait and haltCurrent methods
 * @param {{resumeAutonomy?: Function}} options - Optional autonomy control callback
 */
export function registerLlm(myAgent, { resumeAutonomy } = {}) {
    /** @type {number} Max history turns kept per sender (1 turn = request + response) */
    const MAX_HISTORY_TURNS = 5;

    /** @type {Set<string>} Keywords that abort the current directive immediately */
    const ABORT_KEYWORDS = new Set([
        'exit', 'abort', 'abort directive', 'exit directive',
        'back to bdi', 'go back to bdi',
    ]);

    /** @type {boolean} True while an ACTION directive runs */
    let busy = false;

    /** @type {Object|null} Pending directive (at most one; new replaces old) */
    let pending = null;

    /** @type {Map<string, Array>} History keyed by sender ID */
    const histories = new Map();

    /**
     * Send a reply to the sender via emitSay
     * @param {string} key - Sender identifier (for logging)
     * @param {string} sender - Sender socket ID
     * @param {string} answer - Reply text
     * @returns {Promise<void>}
     */
    const sendReply = async (key, sender, answer) => {
        log(`reply -> ${key}: ${answer}`);
        if (sender) {
            // Bound the ack wait: emitSay to a disconnected recipient never acks, and
            // the reply is best-effort anyway.
            const timeout = new Promise(res => setTimeout(res, 5_000, 'timeout'));
            try {
                const r = await Promise.race([socket.emitSay(sender, answer), timeout]);
                if (r === 'timeout') log.warn(`reply to ${key} not acked within 5s`);
            } catch (err) { log.error('emitSay failed:', err?.message ?? err); }
        }
    };

    /**
     * Record a message exchange in history for a sender
     * @param {string} key - Sender identifier
     * @param {string} userText - The user's message
     * @param {string} answer - The assistant's response
     */
    const record = (key, userText, answer) => {
        const h = histories.get(key) ?? [];
        h.push({ role: 'user', content: userText });
        h.push({ role: 'assistant', content: answer });
        while (h.length > MAX_HISTORY_TURNS * 2) h.shift();
        histories.set(key, h);
    };

    /**
     * Abort the current directive and return to BDI autonomy
     * @returns {string} Confirmation message for the operator
     */
    function abortCurrent() {
        directive.aborted = true;
        directive.active  = false;
        manualHold.active = false;      // abort also releases any hold
        lightMission.active = false;    // and ends any red-light-green-light mission
        trafficLight.red  = false;
        stopHandoff();                  // and ends the background handoff routine
        pending = null;                 // discard any pending directive
        myAgent.haltCurrent();          // reject the pending commandAndAwait (if any)
        resumeAutonomy?.();
        // busy clears itself once runDirective's finally runs
        return 'Back to BDI.';
    }

    /**
     * Drain the pending directive queue, one directive at a time
     * @returns {Promise<void>}
     */
    async function drain() {
        if (busy) return;
        busy = true;
        try {
            while (pending) {
                directive.aborted = false;       // clear any previous abort first
                const { objective, replySender } = pending;
                pending = null;
                const key = replySender ?? 'console';
                const cmd = objective.toLowerCase();
                let answer;

                if (cmd === '/reset') {
                    histories.delete(key);
                    answer = 'Conversation memory cleared.';
                    await sendReply(key, replySender, answer);
                } else if (cmd === '/memory') {
                    const h = histories.get(key) ?? [];
                    answer = h.length ? h.map(m => `${m.role}: ${m.content}`).join(' | ') : 'No memory yet.';
                    await sendReply(key, replySender, answer);
                } else {
                    await whenReady();         // don't act before beliefs are populated
                    log(`directive from ${key}: ${objective}`);
                    try {
                        answer = await runDirective(objective, myAgent, replySender, resumeAutonomy, histories.get(key) ?? []);
                    } catch (err) {
                        answer = `Sorry, the directive failed: ${err?.message ?? err}`;
                    }
                    // Silent endings (never sent — outcomes are observed in-game): null,
                    // bare Done/Failure, give-ups, iteration-limit. "Mission accepted.",
                    // "Mission declined." (a rejection the sender must hear), and substantive
                    // answers (quiz/calc) all reach the sender.
                    const SILENT = /^(Done\.?|Failure:.*|Could not complete the directive.*|Directive not completed.*|Mission cannot be.*|Can'?t comply:.*)$/is;
                    if (answer != null && !SILENT.test(answer.trim())) {
                        record(key, objective, answer);
                        await sendReply(key, replySender, answer);
                    }
                }
            }
        } finally {
            busy = false;
        }
    }

    /**
     * Enqueue a directive for serialized execution, preempting the current one
     * @param {string} objective - Directive text
     * @param {string} replySender - Sender ID for the reply
     */
    function enqueue(objective, replySender) {
        if (busy) {
            directive.aborted = true;
            myAgent.haltCurrent();
        }
        pending = { objective, replySender };
        drain();
    }

    /**
     * Answer a read-only chat message concurrently, without touching the action queue
     * @param {string} text - Message text
     * @param {string} sender - Sender socket ID
     * @returns {Promise<void>}
     */
    async function handleChat(text, sender) {
        const key = sender ?? 'console';
        chatLog(`message from ${key}: ${text}`);
        let answer;
        try {
            answer = await runConversation(text, histories.get(key) ?? []);
        } catch (err) {
            answer = `Sorry: ${err?.message ?? err}`;
        }
        record(key, text, answer);
        await sendReply(key, sender, answer);
    }

    /**
     * Route an incoming message (abort/action/chat/partner-protocol)
     * @param {string} rawText - Raw message text
     * @param {string} sender - Sender socket ID
     * @returns {Promise<void>}
     */
    async function route(rawText, sender) {
        const text = String(rawText ?? '').trim();
        if (!text) return;
        const lower = text.toLowerCase();

        // Partner-protocol JSON (worker hello/result/status) is consumed here, never
        // reaching the classifier (which would waste an LLM call and misroute).
        if (text.startsWith('{')) {
            try {
                const j = JSON.parse(text);
                if (j?.type) { handlePartnerMessage(j, sender); return; }
            } catch { /* not JSON — fall through */ }
        }

        // Abort keywords bypass the queue and execute immediately.
        if (ABORT_KEYWORDS.has(lower)) {
            const reply = abortCurrent();
            const key = sender ?? 'console';
            log(`abort triggered by ${key}`);
            await sendReply(key, sender, reply);
            return;
        }

        if (lower === '/reset' || lower === '/memory') {
            enqueue(text, sender);
            return;
        }
        // Question fast-path: a question or greeting goes straight to the read-only
        // chat lane (no classifier round-trip). Questions are NEVER actions —
        // "can you go to 5,3?" gets a verbal answer, not movement.
        if (/\?\s*$/.test(text) || /^(hi|hello|hey|ciao|hola)\b/i.test(text)) {
            handleChat(text, sender);
            return;
        }
        // Otherwise classify (ONE model call) so red/green-light shouts are interpreted
        // per-shout. Trade-off: the call is on the critical path, so a slow proxy can
        // let a move slip through during red before STOP lands.
        //   STOP → red light: freeze BOTH. GO → green: resume BOTH.
        //   CHAT → read-only fast-lane. ACTION → serialized action lane (incl. setup).
        let kind = 'ACTION';
        try { kind = await classifyDirective(text); } catch { /* default ACTION */ }
        // Bare "red light" / "green light" with no imperative is noise: drop it silently
        // (no reply, no behaviour change) so it never arms/stops/resumes the agents. Only
        // real announcements (ACTION) and full live shouts (STOP/GO) affect the game.
        if (kind === 'IGNORE') return;
        // Live RED/GREEN shouts go to the LLM action lane. The red_light()/green_light()
        // tools enforce the lightMission.active gate — unarmed shouts are explicit no-ops.
        if (kind === 'STOP' || kind === 'GO') {
            enqueue(text, sender);
            return;
        }
        if (kind === 'CHAT') handleChat(text, sender);
        else                 enqueue(text, sender);
    }

    // Chat path: a message from another agent / the admin.
    socket.onMsg((id, _name, msg, replyAck) => {
        const text = typeof msg === 'string' ? msg : (msg?.text ?? JSON.stringify(msg));
        replyAck?.('ack');
        if (id === adminId) {
            route(text, id);
        } else if (id === workerId && text.startsWith('{')) {
            route(text, id);
        } else {
            log(`ignoring message from ${id} — not admin or worker`);
        }
    });

    // Local stdin test path: each line typed or piped in is a message.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        for (const line of String(chunk).split('\n')) route(line, null);
    });
    log(`command layer ready — ${process.stdin.isTTY ? 'type a directive and press enter' : 'pipe a directive via stdin'} (or message the agent in chat).`);
}
