import { socket, me, parcels, directive } from './context.js';
import { IntentionRevisionReplace }   from './intentions/IntentionRevisionReplace.js';
import { selectStrategy }             from './strategies/selectStrategy.js';
import { registerLlm }                from './llm/index.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('llm');

const myAgent = new IntentionRevisionReplace();

// Chosen once the agent is ready (server config has arrived). See selectStrategy().
let strategy = null;

function optionsGeneration() {
    if (!me.isReady) return;
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

// LLM command layer: listens to chat directives and commands this same agent.
// Enabled only when an LLM key is configured, so the BDI agent runs standalone
// without it. resumeAutonomy lets a finished directive re-deliberate immediately.
if (process.env.LITELLM_API_KEY) {
    registerLlm(myAgent, { resumeAutonomy: optionsGeneration });
} else {
    log('LITELLM_API_KEY not set — running BDI only, no chat command layer.');
}

myAgent.loop();
