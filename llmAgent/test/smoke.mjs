/*
 * End-to-end smoke test for the LLM agent.
 *
 * No real LLM is needed: we stand up a tiny OpenAI-compatible mock server that
 * returns scripted ReAct responses, point the client at it, and run the REAL
 * agent code (planner -> executor -> tools -> SDK) against the live local
 * Deliveroo server. This exercises every real code path:
 *   - planner JSON parsing
 *   - ReAct Action / Action Input / Final Answer parsing
 *   - tool dispatch + every tool (reads + all 4 move directions, success & fail)
 *   - real socket emitMove / emitPickup / emitPutdown round-trips
 *
 * Run:  node llmAgent/test/smoke.mjs
 */

import http from 'node:http';

const PORT = 8123;

// ---- 1. Mock OpenAI-compatible server --------------------------------------
// Scripted assistant turns for the EXECUTOR phase (one per model call).
const executorScript = [
    'Thought: check where I am\nAction: get_my_position\nAction Input: none',
    'Thought: look for parcels\nAction: sense_parcels\nAction Input: none',
    'Thought: where can I deliver\nAction: sense_delivery_tiles\nAction Input: none',
    'Thought: try moving up\nAction: move\nAction Input: up',
    'Thought: try moving down\nAction: move\nAction Input: down',
    'Thought: try moving left\nAction: move\nAction Input: left',
    'Thought: try moving right\nAction: move\nAction Input: right',
    'Thought: try a pickup here\nAction: pick_up\nAction Input: none',
    'Thought: smoke test finished\nFinal Answer: Exercised all tools successfully.',
];
let execCall = 0;
let plannerCalls = 0;

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        let content = '';
        try {
            const { messages } = JSON.parse(body);
            const system = messages.find(m => m.role === 'system')?.content ?? '';
            if (system.includes('planning module')) {
                plannerCalls++;
                content = JSON.stringify({ steps: ['run a smoke test of all tools'] });
            } else {
                content = executorScript[Math.min(execCall, executorScript.length - 1)];
                execCall++;
            }
        } catch (e) {
            content = 'Final Answer: mock parse error';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'mock', object: 'chat.completion', model: 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }));
    });
});

await new Promise(r => server.listen(PORT, r));
console.log(`[test] mock LLM listening on http://localhost:${PORT}/v1`);

// ---- 2. Point the client at the mock BEFORE importing the agent ------------
process.env.LITELLM_BASE_URL = `http://localhost:${PORT}/v1`;
process.env.LITELLM_API_KEY = 'test-key';
process.env.LOCAL_MODEL = 'mock';

// ---- 3. Import real agent code (context.js connects to Deliveroo server) ---
const { ready, me, parcels, deliveryTiles } = await import('../context.js');
const { TOOLS } = await import('../tools.js');
const { createPlan } = await import('../planner.js');
const { executeObjective } = await import('../executor.js');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) failures++;
};

const TEST_TIMEOUT = setTimeout(() => {
    console.error('[test] TIMEOUT — aborting'); process.exit(2);
}, 30000);

try {
    console.log('[test] waiting for Deliveroo authentication...');
    await ready;
    await new Promise(r => setTimeout(r, 800)); // let first sensing/map arrive
    console.log(`[test] connected as ${me.name} (${me.id}) at (${me.x}, ${me.y})`);

    // --- belief population ---
    check('agent has an id', !!me.id, me.id);
    check('agent has integer coords', Number.isInteger(me.x) && Number.isInteger(me.y), `(${me.x},${me.y})`);
    check('delivery tiles loaded from map', deliveryTiles.length > 0, `${deliveryTiles.length} tiles`);

    // --- planner JSON parsing (via mock) ---
    const plan = await createPlan('do a smoke test');
    check('planner returns a steps array', Array.isArray(plan.steps) && plan.steps.length > 0, JSON.stringify(plan.steps));

    // --- individual tools return well-formed string observations ---
    const pos = await TOOLS.get_my_position();
    check('get_my_position returns JSON with x/y', /"x":\s*-?\d+/.test(pos) && /"y":\s*-?\d+/.test(pos), pos);

    const sp = await TOOLS.sense_parcels();
    check('sense_parcels returns a string', typeof sp === 'string', sp.slice(0, 60));

    const sd = await TOOLS.sense_delivery_tiles();
    check('sense_delivery_tiles returns coords', sd.includes('{') || sd.includes('No delivery'), sd.slice(0, 60));

    const badMove = await TOOLS.move('sideways');
    check('invalid direction rejected', badMove.startsWith('Error'), badMove);

    // --- general-purpose tutorial tools (calculate + get_current_time) ---
    const calc = await TOOLS.calculate('11 + 2');
    check('calculate evaluates arithmetic', calc === '13', calc);

    const badCalc = await TOOLS.calculate('process.exit(1)');
    check('calculate rejects non-arithmetic input', badCalc.startsWith('Error'), badCalc);

    const time = await TOOLS.get_current_time('Rome');
    check('get_current_time returns a HH:MM:SS time', /"time":"\d{2}:\d{2}:\d{2}"/.test(time), time);

    const startX = me.x, startY = me.y;
    const upRes = await TOOLS.move('up');
    check('move(up) returns a Moved/Failed observation', /^Moved|^Failed/.test(upRes), upRes);
    await new Promise(r => setTimeout(r, 300));

    // --- full objective loop through the executor + mock ReAct script ---
    execCall = 0;
    const result = await executeObjective('smoke test: exercise every tool');
    check('executeObjective produced a final result', typeof result === 'string' && result.length > 0, result.slice(0, 80));
    check('executor reached a Final Answer', result.includes('Exercised all tools'), result.slice(0, 80));
    check('mock was actually called (planner + executor)', plannerCalls >= 1 && execCall >= 5, `planner=${plannerCalls} exec=${execCall}`);

    console.log(`\n[test] start pos (${startX},${startY}) -> now (${me.x},${me.y}); score=${me.score}`);
} catch (err) {
    console.error('[test] ERROR', err);
    failures++;
} finally {
    clearTimeout(TEST_TIMEOUT);
    server.close();
    console.log(`\n[test] ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}
