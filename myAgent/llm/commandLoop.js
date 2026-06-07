import { callModel }                    from '../../llmAgent/llmClient.js';
import { buildSystemPrompt, buildChatPrompt } from './prompt.js';
import { buildTools, buildChatTools }   from './commandTools.js';
import { directive }                    from '../context.js';

/*
 * Single ReAct execution loop for one chat directive (Step-7 style: one model
 * call -> Action/Observation -> ... -> Final Answer). No planner: the command
 * tools already encapsulate multi-tile work via BDI, so step-decomposition would
 * only add cost and failure surface.
 *
 * For the whole directive, directive.active gates the autonomous strategy loop
 * (set on entry, cleared in finally, then resumeAutonomy() re-deliberates once).
 */

const MAX_ITERATIONS = 12;

/**
 * Parse a ReAct action. Tolerates both `Action: go_to` + `Action Input: 5,3` and
 * function-call syntax `Action: go_to(5,3)` (the latter caused "unknown tool"
 * failures in the standalone agent). Returns { action, input } or null.
 */
function extractAction(text) {
    const a = text.match(/^Action:\s*(.+)$/im);
    if (!a) return null;
    const i = text.match(/^Action Input:\s*(.+)$/im);
    let action = a[1].trim();
    let input  = i ? i[1].trim() : 'none';

    const call = action.match(/^([a-zA-Z_]\w*)\s*\((.*)\)\s*$/);
    if (call) {
        action = call[1];
        const inner = call[2].trim();
        if ((input === 'none' || !i) && inner) input = inner;
    }
    return { action, input };
}

function extractFinal(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}

/**
 * Run one chat directive to completion.
 * @param {string} objective   the directive text
 * @param {object} myAgent      the IntentionRevisionReplace instance
 * @param {string|null} replySender  chat id to reply to (null for stdin tests)
 * @param {function} [resumeAutonomy] called once when the directive ends
 * @param {Array} [history]     prior {role,content} turns for conversational context
 * @returns {Promise<string>} the final answer / failure summary
 */
export async function runDirective(objective, myAgent, replySender, resumeAutonomy, history = []) {
    directive.active = true;                       // autonomy stands down

    const tools = buildTools(myAgent, replySender);
    const messages = [
        { role: 'system', content: buildSystemPrompt(objective) },
        ...history,                                // earlier directives + answers (context)
        { role: 'user',   content: `Directive from chat: ${objective}` },
    ];

    try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            let out;
            try {
                out = await callModel(messages, { temperature: 0 });
            } catch (err) {
                // A single API error (400 content filter, 500, network) must not
                // crash the BDI agent — report it and end the directive.
                console.error('[llm] callModel failed:', err?.message ?? err);
                return `Could not complete the directive — LLM error: ${err?.message ?? err}`;
            }
            messages.push({ role: 'assistant', content: out });

            const act   = extractAction(out);
            const final = extractFinal(out);

            // If both appear, run the Action first (never trust a premature Final).
            if (act) {
                const fn = tools[act.action];
                const obs = fn
                    ? await fn(act.input === 'none' ? undefined : act.input)
                    : `Error: unknown tool '${act.action}'. Available: ${Object.keys(tools).join(', ')}`;
                console.log(`[llm tool] ${act.action}(${act.input}) -> ${obs}`);
                messages.push({
                    role: 'user',
                    content: `Observation: ${obs}\nContinue, or give the Final Answer if the directive is done.`,
                });
                continue;
            }

            if (final) return final;

            messages.push({
                role: 'user',
                content: 'Observation: invalid format. Output exactly one Action (with Action Input) OR one Final Answer.',
            });
        }
        return `Directive not completed within ${MAX_ITERATIONS} iterations.`;
    } finally {
        directive.active = false;                  // autonomy gate off
        resumeAutonomy?.();                         // one re-deliberation kick
    }
}

const CLASSIFY_PROMPT =
    'You route a chat message sent to a robot agent in a delivery game. ' +
    'Reply with EXACTLY one word:\n' +
    '- ACTION  if it asks the agent to move, go somewhere, pick up, deliver, wait, stop, ' +
    'or otherwise DO something in the game world.\n' +
    '- CHAT    if it is only a question, greeting, or status request answerable with words ' +
    '(e.g. "can you hear me?", "where are you?", "what are you doing?").\n' +
    'Reply ACTION or CHAT only.';

/**
 * Decide whether a message needs to control the agent (ACTION) or is purely
 * conversational (CHAT). One cheap model call. Defaults to ACTION on anything
 * ambiguous or on error — the safe choice, since ACTION goes through the
 * serialized queue and never runs movement concurrently.
 * @returns {Promise<'ACTION'|'CHAT'>}
 */
export async function classifyDirective(text) {
    try {
        const out = await callModel([
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user',   content: text },
        ], { temperature: 0 });
        return /\bchat\b/i.test(out) && !/\baction\b/i.test(out) ? 'CHAT' : 'ACTION';
    } catch {
        return 'ACTION';
    }
}

/**
 * Conversational fast-lane: answer a chat message with read-only tools only.
 * Does NOT set directive.active and never moves the agent, so it is safe to run
 * concurrently with an action directive. The Final Answer is the reply.
 * @returns {Promise<string>}
 */
export async function runConversation(message, history = []) {
    const tools = buildChatTools();
    const messages = [
        { role: 'system', content: buildChatPrompt(message) },
        ...history,
        { role: 'user',   content: `Message from chat: ${message}` },
    ];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let out;
        try {
            out = await callModel(messages, { temperature: 0 });
        } catch (err) {
            return `Could not answer — LLM error: ${err?.message ?? err}`;
        }
        messages.push({ role: 'assistant', content: out });

        const act   = extractAction(out);
        const final = extractFinal(out);

        if (act) {
            const fn = tools[act.action];
            const obs = fn
                ? await fn(act.input === 'none' ? undefined : act.input)
                : `Error: '${act.action}' is not available here (this is a conversation — read-only). Available: ${Object.keys(tools).join(', ')}`;
            console.log(`[llm:chat tool] ${act.action}(${act.input}) -> ${obs}`);
            messages.push({ role: 'user', content: `Observation: ${obs}\nNow answer with a Final Answer.` });
            continue;
        }
        if (final) return final;

        messages.push({
            role: 'user',
            content: 'Observation: invalid format. Output one Action (read-only) OR a Final Answer.',
        });
    }
    return 'Sorry, I could not put together an answer.';
}
