import { socket, me, directive, trafficLight, manualHold } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('llm');
const chatLog = createLogger('llm:chat');
import { runDirective, runConversation, classifyDirective } from './commandLoop.js';
import { handlePartnerMessage, sendHalt, sendResume } from './partner.js';
import { stopHandoff } from './handoff.js';

/** Resolves once the agent is authenticated (id + position known), so a
 *  directive never runs against an empty belief snapshot. */
function whenReady() {
    if (me.isReady) return Promise.resolve();
    return new Promise(resolve => {
        const t = setInterval(() => {
            if (me.isReady) { clearInterval(t); resolve(); }
        }, 100);
    });
}

/*
 * Entry point of the LLM command layer. Wires the SDK chat channel to the ReAct
 * loop and serializes directives (one at a time) so two directives never fight
 * over the intention queue or the autonomy gate. Each directive's final answer
 * is sent back to its sender via emitSay. A stdin path is provided for local
 * testing without a second agent to chat from.
 */

// Conversational memory across directives, kept per chat sender so follow-ups
// like "do the same" or "I said spawn not delivery" have context. Capped to the
// last few turns so it never grows unbounded. /reset clears it, /memory prints it.
const MAX_HISTORY_TURNS = 5;   // 1 turn = 1 user directive + 1 assistant answer

const ABORT_KEYWORDS = new Set([
    'exit', 'abort', 'abort directive', 'exit directive',
    'back to bdi', 'go back to bdi',
]);

export function registerLlm(myAgent, { resumeAutonomy } = {}) {
    let busy = false;                       // true while an ACTION directive runs
    // NOT a queue: at most ONE pending directive. A new one overwrites it — the
    // latest order is the only one that counts.
    let pending = null;
    const histories = new Map();            // sender key -> [{role,content}, ...]

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

    const record = (key, userText, answer) => {
        const h = histories.get(key) ?? [];
        h.push({ role: 'user', content: userText });
        h.push({ role: 'assistant', content: answer });
        while (h.length > MAX_HISTORY_TURNS * 2) h.shift();
        histories.set(key, h);
    };

    // --- abort: stop any running directive immediately and return to BDI ----------
    function abortCurrent() {
        directive.aborted = true;
        directive.active  = false;
        manualHold.active = false;      // an operator abort also releases any hold
        stopHandoff();                  // and ends the background handoff routine
        pending = null;                 // discard any pending directive
        myAgent.haltCurrent();          // reject the pending commandAndAwait (if any)
        resumeAutonomy?.();
        // busy will fall to false on its own once runDirective's finally executes
        return 'Back to BDI.';
    }

    // --- serialized ACTION lane: one at a time; touches movement + the autonomy gate ---
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
                    // in-game. Substantive answers (quiz results, scored QuestionAnswer
                    // replies) still go back to the sender.
                    if (answer != null && !/^(Done\.?|Failure:.*)$/is.test(answer.trim())) {
                        record(key, objective, answer);
                        await sendReply(key, replySender, answer);
                    }
                }
            }
        } finally {
            busy = false;
        }
    }

    function enqueue(objective, replySender) {
        // Priority: a NEW directive preempts the running one and replaces any
        // pending one. The running ReAct loop sees directive.aborted at its next
        // checkpoint and exits silently; drain then starts this directive.
        if (busy) {
            directive.aborted = true;
            myAgent.haltCurrent();      // reject the pending commandAndAwait now, not at timeout
        }
        pending = { objective, replySender };
        drain();
    }

    // --- conversational fast-lane: read-only, never moves the agent, so it can run
    //     CONCURRENTLY with an action directive (answers questions without waiting). ---
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

    // --- routing: where does each incoming message go? ---
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

        // Red/green-light fast-path: a 20s light cycle cannot afford LLM latency,
        // so the light shouts bypass the model entirely. ANCHORED match ("RED
        // LIGHT! ..."), because the mission ANNOUNCEMENT also contains the words
        // "red light" mid-sentence and must still reach the LLM as a directive.
        // Halt/resume BOTH agents (the worker also hears the shout itself — the
        // relay is redundancy).
        if (/^\s*red light\b/i.test(text)) {
            trafficLight.red = true;
            myAgent.haltCurrent();
            sendHalt();
            log('RED LIGHT — both agents holding');
            return;
        }
        if (/^\s*green light\b/i.test(text)) {
            trafficLight.red = false;
            sendResume();
            log('GREEN LIGHT — both agents resuming');
            if (!directive.active && !manualHold.active) resumeAutonomy?.();
            return;
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
        // Always classify: CHAT → fast-lane (reads history, sends reply, never moves
        // the agent — safe to run concurrently even when idle).
        // ACTION → action lane (queued; completion is silent by design).
        let kind = 'ACTION';
        try { kind = await classifyDirective(text); } catch { /* default ACTION */ }
        if (kind === 'CHAT') handleChat(text, sender);
        else                 enqueue(text, sender);
    }

    // Chat path: a message arrives from another agent / the admin.
    socket.onMsg((id, _name, msg, replyAck) => {
        const text = typeof msg === 'string' ? msg : (msg?.text ?? JSON.stringify(msg));
        replyAck?.('ack');                 // acknowledge the SDK callback immediately
        route(text, id);                   // the real answer is sent later via emitSay
    });

    // Local stdin test path: each line typed (TTY) or piped in is a message.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        for (const line of String(chunk).split('\n')) route(line, null);
    });
    log(`command layer ready — ${process.stdin.isTTY ? 'type a directive and press enter' : 'pipe a directive via stdin'} (or message the agent in chat).`);
}
