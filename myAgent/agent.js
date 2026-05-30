import { socket, me, parcels }       from './context.js';
import { IntentionRevisionReplace }   from './intentions/IntentionRevisionReplace.js';
import { selectStrategy }             from './strategies/selectStrategy.js';

const myAgent = new IntentionRevisionReplace();

// Chosen once the agent is ready (server config has arrived). See selectStrategy().
let strategy = null;

function optionsGeneration() {
    if (!me.isReady) return;
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

myAgent.loop();
