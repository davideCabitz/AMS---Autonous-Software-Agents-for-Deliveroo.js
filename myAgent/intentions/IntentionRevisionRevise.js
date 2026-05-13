import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

export class IntentionRevisionRevise extends IntentionRevision {
    #SWITCH_THRESHOLD = 0.5;

    async push(predicate) {
        const last = this.intention_queue.at(-1);
        if (!last) {
            this.intention_queue.push(new IntentionDeliberation(this, predicate));
            return;
        }
        if (last.predicate.join(' ') !== predicate.join(' ')) {
            this.intention_queue.push(new IntentionDeliberation(this, predicate));
            last.stop();
        }
    }
}
