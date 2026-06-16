import { callModel }                    from './llmClient.js';
import { buildSystemPrompt, buildChatPrompt } from './prompt.js';
import { buildTools, buildChatTools }   from './commandTools.js';
import { directive, me, parcels }      from '../context.js';
import { handoffRunning }               from './handoff.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('llm');
const toolLog = createLogger('llm:tool');

/**
 * @typedef { {role: string, content: string} } ChatMessage
 */

/** @type {number} Max ReAct iterations before giving up on a directive */
const MAX_ITERATIONS = 30;

/** @type {number} Max tool failures before aborting the directive */
const MAX_TOOL_FAILURES = 1;

// Tools that ACCEPT/CHANGE a persistent mission. When one of these succeeds the
// directive is a mission, not an action: it must acknowledge with "Mission
// accepted." in chat. Because the model applies a mission via a TOOL and then
// ends the directive with "End" (the action output contract forbids a Final
// Answer after a tool), the loop itself emits the ack — otherwise the mission is
// applied silently and the sender never hears back (observed bug).
const MISSION_TOOLS = new Set([
    'apply_mission', 'forbid_delivery', 'restrict_exploration',
    'dropMission', 'dropMissions',
    'start_light_mission', 'stop_light_mission',
    'start_handoff', 'stop_handoff',
]);

/**
 * Parse ReAct action from model response, tolerating multiple output formats
 * @param {string} text - Raw model response text
 * @returns {{action: string, input: string}|null} Parsed action and input, or null if not found
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

/**
 * Extract Final Answer from model response
 * @param {string} text - Raw model response text
 * @returns {string|null} Final answer text, or null if not present
 */
function extractFinal(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}

/**
 * Check if model response contains an "End" termination marker
 * @param {string} text - Raw model response text
 * @returns {boolean} True if the response signals directive completion
 */
function hasEndMarker(text) {
    return /^End\.?\s*$/im.test(text);
}

/**
 * Run one chat directive to completion via the ReAct tool-use loop
 * @param {string} objective - The directive text from chat
 * @param {Object} myAgent - The IntentionRevisionReplace instance
 * @param {string|null} replySender - Chat ID to reply to (null for stdin tests)
 * @param {Function} [resumeAutonomy] - Called once when the directive ends
 * @param {Array<ChatMessage>} [history] - Prior turns for conversational context
 * @returns {Promise<string|null>} Final answer or failure summary; null when aborted
 */
export async function runDirective(objective, myAgent, replySender, resumeAutonomy, history = []) {
    // We do NOT gate autonomy at the start: the agent keeps doing its own BDI work
    // while the LLM is still THINKING (before any command). Each command takes
    // control for its duration and releases it optimistically when it finishes (see
    // commandTools), so the agent resumes autonomous work during the think between
    // commands and after the last one — instead of idling through the confirmation
    // round-trip. The finally below is a backstop that guarantees the gate is open
    // and BDI is kicked once the directive ends (except while a handoff owns it).
    const tools = buildTools(myAgent, replySender, resumeAutonomy);
    const messages = [
        { role: 'system', content: buildSystemPrompt(objective) },
        ...history,                                // earlier directives + answers (context)
        { role: 'user',   content: `Directive from chat: ${objective}` },
    ];

    let failures = 0;                              // failed command attempts (budget)
    let missionApplied = false;                    // a mission tool succeeded → ack with "Mission accepted."
    let missionDeclined = false;                   // a Level-3 routine refused a net-penalty offer → reply "Mission declined."

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
            // complete. A pure action directive ends silently; a mission directive
            // (a mission tool ran earlier this turn-sequence) acks "Mission accepted.".
            if (!act && hasEndMarker(out)) return missionDeclined ? 'Mission declined.' : missionApplied ? 'Mission accepted.' : null;

            // If both appear, run the Action first.
            if (act) {
                const fn = tools[act.action];
                const obs = fn
                    ? await fn(act.input === 'none' ? undefined : act.input)
                    : `Error: unknown tool '${act.action}'. Available: ${Object.keys(tools).join(', ')}`;
                toolLog(`${act.action}(${act.input}) -> ${obs}`);

                // Remember a successful mission change so the directive acks with
                // "Mission accepted." when it ends (a mission tool that fails leaves
                // this false → the failure stays silent, as the operator wants).
                // A tool that returns "Mission declined." (a points-bearing Level-3
                // routine refusing a net-penalty offer) is NOT an applied mission — it
                // must NOT flip this true, or the End/final path below would override
                // its decline with a bogus "Mission accepted." ack.
                const declinedNow = MISSION_TOOLS.has(act.action) && fn
                    && /^Mission declined\.?$/i.test(obs.trim());
                if (declinedNow) missionDeclined = true;
                if (MISSION_TOOLS.has(act.action) && fn
                    && !/^(Error|Failed)/i.test(obs) && !declinedNow)
                    missionApplied = true;

                if (directive.aborted)
                    return null; // aborted: the abort handler already replied — stay silent

                // "End" marker with the Action = "this is my last step": the
                // directive ends the INSTANT the action completes. Action directives
                // end silently; a mission directive acks "Mission accepted.".
                if ((hasEndMarker(out) || final) && fn) return missionDeclined ? 'Mission declined.' : missionApplied ? 'Mission accepted.' : null;

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
    '- STOP    if THIS message is a LIVE red-light / stop / freeze command targeting ALL agents NOW ' +
    '(e.g. "RED LIGHT! Stop moving until the next green light!", "stop moving", "freeze", "everyone stop"). ' +
    'A red-light command often ALSO mentions the green light ("stop until the next green light") — it is ' +
    'STILL STOP; the leading RED/STOP is the active order. NOT the long mission announcement that explains the rules. ' +
    'IMPORTANT: if the command targets a SPECIFIC agent ("freeze the worker", "halt the worker", "freeze worker", ' +
    '"stop the partner") it is ACTION, not STOP — the coordinator must decide how to handle it.\n' +
    '- GO      if THIS message is a LIVE green-light / resume / you-may-move-again signal targeting ALL agents ' +
    '(e.g. "GREEN LIGHT! You can move again!", "go", "you can move again"). ' +
    'IMPORTANT: if the command targets a SPECIFIC agent ("resume the worker", "unfreeze worker", "resume partner") ' +
    'it is ACTION, not GO.\n' +
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
 * Classify an incoming chat message as STOP, GO, ACTION, or CHAT
 * @param {string} text - Raw message text to classify
 * @returns {Promise<'STOP'|'GO'|'ACTION'|'CHAT'>} Classification result; defaults to ACTION on ambiguity or error
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
 * Conversational fast-lane: answer a read-only chat message without moving the agent
 * @param {string} message - Chat message to answer
 * @param {Array<ChatMessage>} [history] - Prior conversation turns for context
 * @returns {Promise<string>} Final answer to send back to the sender
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
