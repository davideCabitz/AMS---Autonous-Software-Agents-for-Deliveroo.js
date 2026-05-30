import { socket, me, parcels }       from './context.js';
import { IntentionRevisionReplace }   from './intentions/IntentionRevisionReplace.js';
import { selectStrategy }             from './strategies/selectStrategy.js';

const myAgent = new IntentionRevisionReplace();

// Chosen once the agent is ready (server config has arrived). See selectStrategy().
let strategy = null;

function optionsGeneration() {
    if (!me.isReady) return;
    if (!strategy) strategy = selectStrategy();

    const currentIntent = myAgent.intention_queue.at(-1)?.predicate ?? null;
    const option = strategy.decide(currentIntent);

    if (option) myAgent.push(option);
}

socket.onYou(data => {
    me.update(data);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels);
    optionsGeneration();
});

myAgent.loop();
