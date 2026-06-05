import { callModel }         from './llmClient.js';
import { buildSystemPrompt }  from './memory.js';
import { createPlan }         from './planner.js';
import { TOOLS }              from './tools.js';

/*
 * LLM-Executor + LLM-Replanner.
 *
 * runLoop:  ReAct loop for ONE step — the model emits a single Action, we run it,
 *           feed back an Observation, repeat until it returns a Final Answer or we
 *           hit the iteration cap.
 *
 * executeObjective: plans the objective, runs each step's ReAct loop, and applies
 *           lightweight Reflexion — if the agent gets blocked repeatedly it asks
 *           the planner to revise the remaining plan around the obstacle.
 */

const MAX_STEP_ITERATIONS = 12;
const BLOCKED_REPLAN_THRESHOLD = 3;

function extractAction(text) {
    const a = text.match(/^Action:\s*(.+)$/im);
    const i = text.match(/^Action Input:\s*(.+)$/im);
    if (!a) return null;
    return { action: a[1].trim(), input: i ? i[1].trim() : 'none' };
}

function extractFinal(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}

/**
 * Run one planned step to completion via ReAct.
 * Returns { result, blocked } where `blocked` counts failed/blocked moves so the
 * caller can decide whether to replan.
 */
export async function runStep(objective, step, plan, completedResults) {
    const messages = [
        { role: 'system', content: buildSystemPrompt(objective) },
        {
            role: 'user',
            content:
                `Full plan:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
                `Completed so far:\n${completedResults.length ? completedResults.join('\n') : 'none'}\n\n` +
                `Execute ONLY this step now: ${step}`,
        },
    ];

    let blocked = 0;

    for (let i = 0; i < MAX_STEP_ITERATIONS; i++) {
        const out = await callModel(messages, { temperature: 0 });
        messages.push({ role: 'assistant', content: out });

        const act = extractAction(out);
        const final = extractFinal(out);

        // Defensive: if both appear, execute the Action and ignore the premature Final.
        if (act) {
            const fn = TOOLS[act.action];
            const obs = fn
                ? await fn(act.input === 'none' ? undefined : act.input)
                : `Error: unknown tool '${act.action}'. Available: ${Object.keys(TOOLS).join(', ')}`;
            if (/^Failed|^Error/.test(obs)) blocked++;
            console.log(`  [tool] ${act.action}(${act.input}) -> ${obs}`);
            messages.push({
                role: 'user',
                content: `Observation: ${obs}\nContinue the step, or give the Final Answer if it is done.`,
            });
            continue;
        }

        if (final) return { result: final, blocked };

        // Malformed output — nudge back into format.
        messages.push({
            role: 'user',
            content: 'Observation: invalid format. Output exactly one Action (with Action Input) OR one Final Answer.',
        });
    }

    return { result: `Step not completed within ${MAX_STEP_ITERATIONS} iterations: ${step}`, blocked };
}

/** Plan → execute each step → (Reflexion) replan on repeated blocking. */
export async function executeObjective(objective) {
    let plan = await createPlan(objective);
    console.log('[plan]', JSON.stringify(plan.steps));

    const completedResults = [];

    for (let s = 0; s < plan.steps.length; s++) {
        const step = plan.steps[s];
        console.log(`\n[step ${s + 1}/${plan.steps.length}] ${step}`);

        const { result, blocked } = await runStep(objective, step, plan, completedResults);
        completedResults.push(result);
        console.log(`[step ${s + 1} done] ${result}`);

        // Reflexion: if this step hit the environment hard, rebuild the remaining
        // plan with the failure noted, then continue from the revised plan.
        if (blocked >= BLOCKED_REPLAN_THRESHOLD && s < plan.steps.length - 1) {
            console.log(`[replan] step was blocked ${blocked}x — revising remaining plan.`);
            const note =
                `Original objective: ${objective}\n` +
                `Already done: ${completedResults.join(' | ')}\n` +
                `The agent got blocked repeatedly on the last step (${result}). ` +
                `Produce a revised plan for the REMAINING work only.`;
            const revised = await createPlan(note);
            plan = { steps: [...plan.steps.slice(0, s + 1), ...revised.steps] };
            console.log('[replan] new plan:', JSON.stringify(plan.steps));
        }
    }

    return completedResults.join('\n');
}
