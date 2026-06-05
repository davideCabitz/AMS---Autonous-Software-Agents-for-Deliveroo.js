import { callModel } from './llmClient.js';

/*
 * LLM-Planner. Decomposes a conversational objective into a short, ordered list
 * of concrete sub-steps (Chain-of-Thought made explicit as discrete steps).
 * Returns strict JSON; falls back to a single-step plan on malformed output.
 */

const PLANNER_PROMPT = `
You are the planning module of a Deliveroo delivery agent.
Break the user's objective into a short ordered list of 1 to 10 concrete steps.

Rules:
- Return ONLY valid JSON. No markdown, no prose, no explanation.
- Each step is one short imperative sentence the executor can carry out.
- A step may involve sensing, moving toward a target, picking up, or delivering.

Return exactly this shape:
{"steps": ["step 1", "step 2"]}
`.trim();

function safeJsonParse(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch { return null; }
}

export async function createPlan(objective) {
    const raw = await callModel([
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user',   content: objective },
    ], { temperature: 0 });

    const parsed = safeJsonParse(raw);
    if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0)
        return parsed;

    console.log('[planner] invalid JSON, using single-step fallback.');
    return { steps: [objective] };
}
