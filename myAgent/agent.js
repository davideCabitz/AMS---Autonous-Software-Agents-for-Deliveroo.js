import { socket, me, parcels, directive, trafficLight, manualHold, role } from './context.js';
import { IntentionRevisionReplace }   from './intentions/IntentionRevisionReplace.js';
import { selectStrategy }             from './strategies/selectStrategy.js';
import { registerLlm }                from './llm/index.js';
import { registerWorker }             from './partnerWorker.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('llm');

const myAgent = new IntentionRevisionReplace();

// Chosen once the agent is ready (server config has arrived). See selectStrategy().
let strategy = null;

function optionsGeneration() {
    if (!me.isReady) return;
    // RED LIGHT: every movement is penalized — no new intentions until green.
    if (trafficLight.red) return;
    // Operator-requested indefinite hold (LLM hold() tool) — stand down until released.
    if (manualHold.active) return;
    // The LLM command layer is driving the agent: stand down so the autonomous
    // strategy doesn't clobber the intention it pushed. Beliefs still update
    // (parcels.sync in onSensing runs regardless) — only deciding/pushing pauses.
    if (directive.active) return;
    if (!strategy) {
        strategy = selectStrategy();
        // The strategy declares its re-deliberation cadence; the loop owns the timer.
        // Needed for strategies that can idle with no event to wake them (e.g. blind,
        // stationary after a pickup, where own-tile sensing emits nothing).
        if (strategy.tickIntervalMs > 0) setInterval(optionsGeneration, strategy.tickIntervalMs);
    }

    const currentIntent = myAgent.intention_queue.at(-1)?.predicate ?? null;
    const option = strategy.decide(currentIntent);

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

// Role split (see launch.js): the coordinator runs the LLM command layer; the
// worker runs plain BDI plus the partner-order handler that lets the coordinator
// command it over chat. resumeAutonomy lets either re-deliberate immediately.
if (role === 'worker') {
    registerWorker(myAgent, { resumeAutonomy: optionsGeneration });
} else if (process.env.LITELLM_API_KEY) {
    registerLlm(myAgent, { resumeAutonomy: optionsGeneration });
} else {
    log('LITELLM_API_KEY not set — running BDI only, no chat command layer.');
}

myAgent.loop();
