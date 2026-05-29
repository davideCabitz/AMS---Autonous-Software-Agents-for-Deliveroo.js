import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

export class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const last = this.intention_queue.at(-1);

        // Never interrupt the same intention.
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        // Don't replace a go_deliver with another go_deliver: the planner may have
        // chosen a different (more efficient) delivery tile and is mid-execution.
        // Interrupting it causes an infinite stop/restart loop when crates block
        // the "obvious" delivery tile and the PDDL plan routes to a different one.
        if (last && last.predicate[0] === 'go_deliver' && predicate[0] === 'go_deliver') return;

        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);

        if (last) last.stop();
    }
}
