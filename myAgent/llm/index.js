import { socket, me }    from '../context.js';
import { runDirective, runConversation, classifyDirective } from './commandLoop.js';

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

export function registerLlm(myAgent, { resumeAutonomy } = {}) {
    let busy = false;                       // true while an ACTION directive runs
    const queue = [];
    const histories = new Map();            // sender key -> [{role,content}, ...]

    const sendReply = async (key, sender, answer) => {
        console.log(`[llm] reply -> ${key}: ${answer}`);
        if (sender) {
            try { await socket.emitSay(sender, answer); }
            catch (err) { console.error('[llm] emitSay failed:', err?.message ?? err); }
        }
    };

    const record = (key, userText, answer) => {
        const h = histories.get(key) ?? [];
        h.push({ role: 'user', content: userText });
        h.push({ role: 'assistant', content: answer });
        while (h.length > MAX_HISTORY_TURNS * 2) h.shift();
        histories.set(key, h);
    };

    // --- serialized ACTION lane: one at a time; touches movement + the autonomy gate ---
    async function drain() {
        if (busy) return;
        busy = true;
        try {
            while (queue.length) {
                const { objective, replySender } = queue.shift();
                const key = replySender ?? 'console';
                const cmd = objective.toLowerCase();
                let answer;

                if (cmd === '/reset') {
                    histories.delete(key);
                    answer = 'Conversation memory cleared.';
                } else if (cmd === '/memory') {
                    const h = histories.get(key) ?? [];
                    answer = h.length ? h.map(m => `${m.role}: ${m.content}`).join(' | ') : 'No memory yet.';
                } else {
                    await whenReady();         // don't act before beliefs are populated
                    console.log(`[llm] directive from ${key}: ${objective}`);
                    try {
                        answer = await runDirective(objective, myAgent, replySender, resumeAutonomy, histories.get(key) ?? []);
                    } catch (err) {
                        answer = `Sorry, the directive failed: ${err?.message ?? err}`;
                    }
                    record(key, objective, answer);
                }
                await sendReply(key, replySender, answer);
            }
        } finally {
            busy = false;
        }
    }

    function enqueue(objective, replySender) {
        queue.push({ objective, replySender });
        drain();
    }

    // --- conversational fast-lane: read-only, never moves the agent, so it can run
    //     CONCURRENTLY with an action directive (answers questions without waiting). ---
    async function handleChat(text, sender) {
        const key = sender ?? 'console';
        console.log(`[llm:chat] message from ${key}: ${text}`);
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
        // Commands, and anything arriving while idle, just run on the action lane
        // (it starts immediately — no need to spend a classifier call).
        if (lower === '/reset' || lower === '/memory' || !busy) {
            enqueue(text, sender);
            return;
        }
        // An action directive is already running: classify so a question still gets
        // answered concurrently instead of waiting behind it.
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
    console.log(`[llm] command layer ready — ${process.stdin.isTTY ? 'type a directive and press enter' : 'pipe a directive via stdin'} (or message the agent in chat).`);
}
