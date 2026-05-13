import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

export class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const last = this.intention_queue.at(-1);
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);

        if (last) last.stop();
    }
}
