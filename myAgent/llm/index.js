import { socket, me, directive, trafficLight, manualHold, lightMission } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('llm');
const chatLog = createLogger('llm:chat');

const adminId  = process.env.ADMIN_ID  ?? null;
const workerId = process.env.WORKER_ID ?? null;
import { runDirective, runConversation, classifyDirective } from './commandLoop.js';
import { handlePartnerMessage, sendHalt, sendResume } from './partner.js';
import { stopHandoff } from './handoff.js';

/**
 * Wait until the agent is authenticated (id and position known)
 * @returns {Promise<void>} Resolves when me.isReady is true
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
 * @param {Object} myAgent - Agent instance with commandAndAwait and haltCurrent methods
 * @param {{resumeAutonomy?: Function}} options - Optional autonomy control callback
 */
export function registerLlm(myAgent, { resumeAutonomy } = {}) {
    /** @type {number} Max conversational history turns kept per sender (1 turn = request + response) */
    const MAX_HISTORY_TURNS = 5;

    /** @type {Set<string>} Keywords that abort the current directive immediately */
    const ABORT_KEYWORDS = new Set([
        'exit', 'abort', 'abort directive', 'exit directive',
        'back to bdi', 'go back to bdi',
    ]);

    /** @type {boolean} True while an ACTION directive is running */
    let busy = false;

    /** @type {Object|null} Pending directive (at most one; new ones replace old) */
    let pending = null;

    /** @type {Map<string, Array>} Conversational history keyed by sender ID */
    const histories = new Map();

    /**
     * Send a reply back to the message sender via emitSay
     * @param {string} key - Sender identifier used for logging
     * @param {string} sender - Sender socket ID passed to emitSay
     * @param {string} answer - Reply text to deliver
     * @returns {Promise<void>}
     */
    const sendReply = async (key, sender, answer) => {
        log(`reply -> ${key}: ${answer}`);
        if (sender) {
            // Bound the ack wait: emitSay to a disconnected recipient can stay
            // pending forever (the server ack never arrives) and the reply is
            // best-effort anyway.
            const timeout = new Promise(res => setTimeout(res, 5_000, 'timeout'));
            try {
                const r = await Promise.race([socket.emitSay(sender, answer), timeout]);
                if (r === 'timeout') log.warn(`reply to ${key} not acked within 5s`);
            } catch (err) { log.error('emitSay failed:', err?.message ?? err); }
        }
    };

    /**
     * Record a message exchange in conversational history for the given sender
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
     * @returns {string} Confirmation message sent to the operator
     */
    function abortCurrent() {
        directive.aborted = true;
        directive.active  = false;
        manualHold.active = false;      // an operator abort also releases any hold
        lightMission.active = false;    // and ends any red-light-green-light mission
        trafficLight.red  = false;
        stopHandoff();                  // and ends the background handoff routine
        pending = null;                 // discard any pending directive
        myAgent.haltCurrent();          // reject the pending commandAndAwait (if any)
        resumeAutonomy?.();
        // busy will fall to false on its own once runDirective's finally executes
        return 'Back to BDI.';
    }

    /**
     * Drain the pending directive queue, executing one directive at a time
     * @returns {Promise<void>}
     */
    async function drain() {
        if (busy) return;
        busy = true;
        try {
            while (pending) {
                directive.aborted = false;       // clear any previous abort before starting
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
                    // Silent endings: null (aborted / last-action-completed) and bare
                    // Done/Failure confirmations are never sent — outcomes are observed
                    // in-game. Mission FAILURES are silent too: a declined mission, a
                    // give-up after failed commands, or the iteration-limit message never
                    // go to chat — only a successful "Mission accepted." (and substantive
                    // answers like quiz/calculation results) are sent back to the sender.
                    const SILENT = /^(Done\.?|Failure:.*|Mission declined\.?|Could not complete the directive.*|Directive not completed.*|Mission cannot be.*|Can'?t comply:.*)$/is;
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
     * Enqueue a directive for serialized execution, preempting the current one if running
     * @param {string} objective - Directive text to execute
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
     * Handle a read-only chat message concurrently without touching the action queue
     * @param {string} text - Message text to answer
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
     * Route an incoming message to the appropriate handler (abort/action/chat/partner-protocol)
     * @param {string} rawText - Raw message text
     * @param {string} sender - Sender socket ID
     * @returns {Promise<void>}
     */
    async function route(rawText, sender) {
        const text = String(rawText ?? '').trim();
        if (!text) return;
        const lower = text.toLowerCase();

        // Partner-protocol JSON (worker hello/result/status) is consumed here and
        // never reaches the classifier — it would waste an LLM call and misroute.
        if (text.startsWith('{')) {
            try {
                const j = JSON.parse(text);
                if (j?.type) { handlePartnerMessage(j, sender); return; }
            } catch { /* not JSON — fall through to normal routing */ }
        }

        // Abort keywords bypass the queue entirely and execute immediately so the
        // operator never has to wait for the current directive to finish.
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
        // Question fast-path: anything phrased as a question (or a greeting) goes
        // straight to the read-only chat lane — no classifier round-trip, so the
        // answer arrives in one model call even while a directive is running.
        // Questions are NEVER actions (operator decision): "can you go to 5,3?"
        // gets a verbal answer, not movement.
        if (/\?\s*$/.test(text) || /^(hi|hello|hey|ciao|hola)\b/i.test(text)) {
            handleChat(text, sender);
            return;
        }
        // Always classify (ONE model call). The classifier interprets the live
        // "red light, green light" signals per-shout (STOP/GO) instead of a hardcoded
        // keyword reflex — the mission is LLM-driven. Trade-off: the model call sits on
        // the critical path, so a slow proxy/VPN can let a move slip through during red
        // (a penalty) before STOP lands; stopping is enforced the instant it returns.
        //   STOP → red light: freeze BOTH agents (trafficLight.red stays the instant
        //          enforcement flag, read by command()/orders/optionsGeneration).
        //   GO   → green light: resume BOTH agents.
        //   CHAT → read-only fast-lane (concurrent, never moves the agent).
        //   ACTION → serialized action lane (incl. the mission ANNOUNCEMENT/setup).
        let kind = 'ACTION';
        try { kind = await classifyDirective(text); } catch { /* default ACTION */ }
        // Live red/green-light signals only control the agents once the mission has
        // been STARTED (the LLM read an announcement and called start_light_mission).
        // Before that, a stray "red light"/"green light" in chat is recognised but
        // IGNORED — it must not change behaviour.
        if (kind === 'STOP' || kind === 'GO') {
            if (!lightMission.active) {
                // Outside a red-light/green-light mission, STOP/GO are plain
                // freeze/resume commands (e.g. "freeze worker", "resume worker").
                if (kind === 'STOP') {
                    manualHold.active = true;
                    myAgent.haltCurrent();
                    sendHalt();
                    log(`freeze command "${text}" — coordinator and worker halted`);
                } else {
                    manualHold.active = false;
                    sendResume();
                    log(`resume command "${text}" — both agents resuming BDI`);
                    if (!directive.active) resumeAutonomy?.();
                }
                return;
            }
            if (kind === 'STOP') {
                trafficLight.red = true;
                myAgent.haltCurrent();
                sendHalt();
                log('RED LIGHT (LLM) — both agents holding');
            } else {
                trafficLight.red = false;
                // A GREEN LIGHT also releases a "wait for the light" hold: the
                // announcement makes the agent hold()/halt_partner() to wait, and the
                // green signal is exactly what ends that wait. Without clearing
                // manualHold here, optionsGeneration keeps standing the agent down and
                // it never moves again (a reported bug). sendResume() unfreezes the worker.
                manualHold.active = false;
                sendResume();
                log('GREEN LIGHT (LLM) — both agents resuming');
                if (!directive.active) resumeAutonomy?.();
            }
            return;
        }
        if (kind === 'CHAT') handleChat(text, sender);
        else                 enqueue(text, sender);
    }

    // Chat path: a message arrives from another agent / the admin.
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

    // Local stdin test path: each line typed (TTY) or piped in is a message.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        for (const line of String(chunk).split('\n')) route(line, null);
    });
    log(`command layer ready — ${process.stdin.isTTY ? 'type a directive and press enter' : 'pipe a directive via stdin'} (or message the agent in chat).`);
}
