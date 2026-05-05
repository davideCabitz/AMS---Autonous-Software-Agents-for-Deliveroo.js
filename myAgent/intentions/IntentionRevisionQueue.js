import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

/** FIFO strategy — no interruption, each intention runs to completion. */
export class IntentionRevisionQueue extends IntentionRevision {
    async push(predicate) {
        const key = predicate.join(' ');
        if (this.intention_queue.find(i => i.predicate.join(' ') === key)) return;
        this.intention_queue.push(new IntentionDeliberation(this, predicate));
    }
}
