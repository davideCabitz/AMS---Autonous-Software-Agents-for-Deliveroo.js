import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';
import { pddl } from '../context.js';

export class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const last = this.intention_queue.at(-1);

        // Never interrupt the same intention.
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        // Don't replace a go_deliver with another go_deliver.
        if (last && last.predicate[0] === 'go_deliver' && predicate[0] === 'go_deliver') return;

        // Never interrupt a PDDL plan mid-execution. Once the solver has returned a
        // plan and the agent is executing it (pddl.busy), any new intention is queued
        // but the current plan runs to completion first.
        if (pddl.busy) {
            console.log(`[intention] PDDL plan in progress — deferring: ${predicate.join(' ')}`);
            return;
        }

        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);

        if (last) last.stop();
    }
}
