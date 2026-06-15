import { callModel }                    from './llmClient.js';
import { buildSystemPrompt, buildChatPrompt } from './prompt.js';
import { buildTools, buildChatTools }   from './commandTools.js';
import { directive, me, parcels }      from '../context.js';
import { handoffRunning }               from './handoff.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('llm');
const toolLog = createLogger('llm:tool');

/*
 * Single ReAct execution loop for one chat directive (Step-7 style: one model
 * call -> Action/Observation -> ... -> Final Answer). No planner: the command
 * tools already encapsulate multi-tile work via BDI, so step-decomposition would
 * only add cost and failure surface.
 *
 * Autonomy is NOT gated during the LLM's initial thinking (the agent keeps doing
 * its own BDI work). The first command takes control and the gate is held through
 * the command sequence (released in runDirective's finally), so a multi-step
 * directive doesn't drift between commands.
 */

// Two-agent directives (order partner + own commands) use more steps than the
// original single-agent ceiling allowed.
const MAX_ITERATIONS = 30;
// Give up a stuck directive after this many failed command attempts, so the LLM
// can't keep the agent occupied indefinitely — it returns to autonomous BDI work.
const MAX_TOOL_FAILURES = 1;

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

/** "End" on its own line marks the accompanying Action as the directive's last
 *  step: the directive terminates the moment that action completes. */
function hasEndMarker(text) {
    return /^End\.?\s*$/im.test(text);
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
    // We do NOT gate autonomy at the start: the agent keeps doing its own BDI work
    // while the LLM is still THINKING (before any command). The first command takes
    // control (see commandTools) and the gate is HELD through the command sequence,
    // then released once here in finally — so a multi-step directive like "go to X
    // then freeze" stays at X instead of drifting between the two commands.
    const tools = buildTools(myAgent, replySender, resumeAutonomy);
    const messages = [
        { role: 'system', content: buildSystemPrompt(objective) },
        ...history,                                // earlier directives + answers (context)
        { role: 'user',   content: `Directive from chat: ${objective}` },
    ];

    let failures = 0;                              // failed command attempts (budget)

    try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            if (directive.aborted)
                return null; // aborted: the abort handler already replied — stay silent

            let out;
            try {
                out = await callModel(messages, { temperature: 0 });
            } catch (err) {
                // A single API error (400 content filter, 500, network) must not
                // crash the BDI agent — report it and end the directive. Chat gets
                // only a short tag; the full message goes to the log.
                log.error('callModel failed:', err?.message ?? err);
                const brief = String(err?.message ?? err).split(/[\n.]/)[0].slice(0, 80);
                return `Failure: LLM error — ${brief}`;
            }

            if (directive.aborted)
                return null; // aborted: the abort handler already replied — stay silent

            log(`iter ${i + 1}: ${out.replace(/\s+/g, ' ').slice(0, 160)}`);
            messages.push({ role: 'assistant', content: out });

            const act   = extractAction(out);
            const final = extractFinal(out);

            // Bare "End" with no Action: the model declares the directive already
            // complete — terminate silently (no chat reply for action directives).
            if (!act && hasEndMarker(out)) return null;

            // If both appear, run the Action first.
            if (act) {
                const fn = tools[act.action];
                const obs = fn
                    ? await fn(act.input === 'none' ? undefined : act.input)
                    : `Error: unknown tool '${act.action}'. Available: ${Object.keys(tools).join(', ')}`;
                toolLog(`${act.action}(${act.input}) -> ${obs}`);

                if (directive.aborted)
                    return null; // aborted: the abort handler already replied — stay silent

                // "End" marker with the Action = "this is my last step": the
                // directive ends the INSTANT the action completes — no confirmation
                // round-trip, no chat reply (success or failure is observed in-game).
                if ((hasEndMarker(out) || final) && fn) return null;

                // Failure budget: don't let the LLM keep retrying a stuck directive.
                // After a few failed commands, give up and let the BDI agent carry on.
                if (/^Failed/.test(obs) && ++failures >= MAX_TOOL_FAILURES) {
                    return `Could not complete the directive after ${failures} failed attempts; resuming autonomous work.`;
                }

                // Live state with every observation: the system-prompt snapshot is
                // stale after the first command, and the model must never act on a
                // remembered position/cargo (e.g. "drop" while carrying nothing).
                const state = `[Your live state: at (${me.x},${me.y}), carrying ${parcels.carriedBy(me.id).length} parcel(s)]`;
                messages.push({
                    role: 'user',
                    content: `Observation: ${obs}\n${state}\nContinue with the next Action (append "End" to the last one). If the directive is already complete, output ONLY the single line "End" — do NOT write a Final Answer or any confirmation.`,
                });
                continue;
            }

            if (final) return final;

            messages.push({
                role: 'user',
                content: 'Observation: invalid format. Output exactly one Action (with Action Input), the single line "End" if the directive is already complete, or one Final Answer (word-only directives and mission offers only).',
            });
        }
        return `Directive not completed within ${MAX_ITERATIONS} iterations.`;
    } finally {
        // Defensive: make sure the gate is released and BDI is kicked even if a
        // command threw before its own finally could run. EXCEPT while the handoff
        // routine runs: it outlives the directive that started it and owns the
        // gate until stop_handoff (or abort) ends it.
        if (!handoffRunning()) {
            directive.active = false;
            resumeAutonomy?.();
        }
    }
}

const CLASSIFY_PROMPT =
    'You route a chat message sent to a robot agent in a delivery game where a ' +
    '"red light, green light" mission may be running. Reply with EXACTLY one word:\n' +
    '- STOP    if THIS message is a LIVE red-light / stop / freeze command the agent must obey NOW ' +
    '(e.g. "RED LIGHT! Stop moving until the next green light!", "stop moving", "freeze", "everyone stop"). ' +
    'A red-light command often ALSO mentions the green light ("stop until the next green light") — it is ' +
    'STILL STOP; the leading RED/STOP is the active order. NOT the long mission announcement that explains the rules.\n' +
    '- GO      if THIS message is a LIVE green-light / resume / you-may-move-again signal ' +
    '(e.g. "GREEN LIGHT! You can move again!", "go", "you can move again").\n' +
    '- ACTION  if it asks the agent to move, go somewhere, pick up, deliver, wait, ' +
    'apply or remove a mission/constraint, abort/cancel/drop/clear a mission, ' +
    'or otherwise DO something in the game world. ALSO any mission offer or challenge ' +
    '(mentions a bonus/penalty/points, or asks to calculate/answer something for a reward) — ' +
    'INCLUDING a "red light green light" mission ANNOUNCEMENT that starts/explains the game ' +
    '(that is a setup directive, NOT a live light command). Announcements look like: ' +
    '"Let\'s begin a red light green light game", "All agents prepare to stop at red light and wait ' +
    'for the green light before moving, as in a red light green light game", "Red light green light: ' +
    'move to an odd row and wait for our message. 700pts" — all ACTION.\n' +
    '- CHAT    if it is only a question, greeting, or status request answerable with words ' +
    '(e.g. "can you hear me?", "where are you?", "what are you doing?").\n' +
    'Reply STOP, GO, ACTION, or CHAT only.';

/**
 * Classify an incoming chat message. One cheap model call. Besides ACTION
 * (control the agent, serialized) vs CHAT (verbal answer, concurrent), it also
 * recognises the LIVE "red light"/"green light" signals as STOP/GO so the
 * red-light-green-light mission is interpreted by the model on EVERY shout
 * (no hardcoded keyword reflex). Defaults to ACTION on anything ambiguous or on
 * error — the safe routing choice (serialized lane, never concurrent movement).
 * @returns {Promise<'STOP'|'GO'|'ACTION'|'CHAT'>}
 */
export async function classifyDirective(text) {
    try {
        const out = await callModel([
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user',   content: text },
        ], { temperature: 0 });
        const u = out.toUpperCase();
        if (/\bSTOP\b/.test(u)) return 'STOP';
        if (/\bGO\b/.test(u))   return 'GO';
        if (/\bCHAT\b/.test(u) && !/\bACTION\b/.test(u)) return 'CHAT';
        return 'ACTION';
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
            toolLog(`${act.action}(${act.input}) -> ${obs}`);
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
