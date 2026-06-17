import { socket, me, parcels, directive, trafficLight, manualHold, role, runtime } from './context.js';
import { IntentionRevisionReplace }   from './intentions/IntentionRevisionReplace.js';
import { selectStrategy }             from './strategies/selectStrategy.js';
import { registerLlm }                from './llm/index.js';
import { registerWorker }             from './worker_agent.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('llm');

const myAgent = new IntentionRevisionReplace();

// The chosen strategy lives in shared `runtime.strategy` (context.js) so the handoff
// routine can drive B's acquisition with the SAME strategy. Created lazily once the
// agent is ready. See selectStrategy().

function optionsGeneration() {
    if (!me.isReady) return;
    // RED LIGHT: every movement is penalized — stand down until green.
    if (trafficLight.red) return;
    // Indefinite hold (LLM hold() tool) — stand down until released.
    if (manualHold.active) return;
    // LLM command layer is driving: stand down so the strategy doesn't clobber its
    // intention. Beliefs still update (parcels.sync) — only deciding/pushing pauses.
    if (directive.active) return;
    if (!runtime.strategy) {
        runtime.strategy = selectStrategy();
        // The strategy declares its re-deliberation cadence; the loop owns the timer.
        // Needed for strategies that idle with no event to wake them (e.g. blind).
        if (runtime.strategy.tickIntervalMs > 0) setInterval(optionsGeneration, runtime.strategy.tickIntervalMs);
    }

    const currentIntent = myAgent.intention_queue.at(-1)?.predicate ?? null;
    // A one-shot bonus (oneShotBonus) competes with the parcel loop in the value
    // functions: divert only when its net beats banking now. Checked before decide()
    // so every strategy is bonus-aware with no per-subclass edits.
    const option = runtime.strategy.bonusDiversion(currentIntent)
                ?? runtime.strategy.decide(currentIntent);

    if (option) myAgent.push(option);
}

socket.onYou(data => {
    me.update(data);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels, me.id);
    optionsGeneration();
});

// Role split (see launch.js): coordinator runs the LLM command layer; worker runs
// plain BDI plus the partner-order handler. resumeAutonomy lets either re-deliberate.
if (role === 'worker') {
    registerWorker(myAgent, { resumeAutonomy: optionsGeneration });
} else if (process.env.LITELLM_API_KEY) {
    registerLlm(myAgent, { resumeAutonomy: optionsGeneration });
} else {
    log('LITELLM_API_KEY not set — running BDI only, no chat command layer.');
}

myAgent.loop();
