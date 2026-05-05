import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

/**
 * Utility-based strategy — switch to a new intention only when its score
 * beats the current one by a threshold (avoids thrashing).
 *
 * TODO: implement utility scoring:
 *   score = parcel.reward / Math.max(1, distance(me, parcel))
 *   replace current if newScore > currentScore + SWITCH_THRESHOLD
 */
export class IntentionRevisionRevise extends IntentionRevision {
    #SWITCH_THRESHOLD = 0.5;

    async push(predicate) {
        // TODO: compute utility and decide whether to switch
        const last = this.intention_queue.at(-1);
        if (!last) {
            this.intention_queue.push(new IntentionDeliberation(this, predicate));
            return;
        }
        // placeholder: behave like Replace until utility logic is added
        if (last.predicate.join(' ') !== predicate.join(' ')) {
            this.intention_queue.push(new IntentionDeliberation(this, predicate));
            last.stop();
        }
    }
}
