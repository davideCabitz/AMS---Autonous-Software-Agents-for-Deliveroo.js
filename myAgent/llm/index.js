import { socket, me }    from '../context.js';
import { runDirective }   from './commandLoop.js';

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

export function registerLlm(myAgent, { resumeAutonomy } = {}) {
    let busy = false;
    const queue = [];

    async function drain() {
        if (busy) return;
        busy = true;
        try {
            while (queue.length) {
                const { objective, replySender } = queue.shift();
                await whenReady();             // don't act before beliefs are populated
                console.log(`[llm] directive from ${replySender ?? 'console'}: ${objective}`);
                let answer;
                try {
                    answer = await runDirective(objective, myAgent, replySender, resumeAutonomy);
                } catch (err) {
                    answer = `Sorry, the directive failed: ${err?.message ?? err}`;
                }
                console.log(`[llm] reply -> ${replySender ?? 'console'}: ${answer}`);
                if (replySender) {
                    try { await socket.emitSay(replySender, answer); }
                    catch (err) { console.error('[llm] emitSay failed:', err?.message ?? err); }
                }
            }
        } finally {
            busy = false;
        }
    }

    function enqueue(objective, replySender) {
        const text = String(objective ?? '').trim();
        if (!text) return;
        queue.push({ objective: text, replySender });
        drain();
    }

    // Chat path: a directive arrives from another agent / the admin.
    socket.onMsg((id, _name, msg, replyAck) => {
        const text = typeof msg === 'string' ? msg : (msg?.text ?? JSON.stringify(msg));
        replyAck?.('ack');                 // acknowledge the SDK callback immediately
        enqueue(text, id);                 // the real answer is sent later via emitSay
    });

    // Local stdin test path: each line typed (TTY) or piped in is a directive.
    // sender=null, so the answer is only logged (no emitSay). Harmless in
    // production — nothing is typed there.
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        for (const line of String(chunk).split('\n')) enqueue(line, null);
    });
    console.log(`[llm] command layer ready — ${process.stdin.isTTY ? 'type a directive and press enter' : 'pipe a directive via stdin'} (or message the agent in chat).`);
}
