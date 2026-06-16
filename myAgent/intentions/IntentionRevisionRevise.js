import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';

/**
 * @class IntentionRevisionRevise
 * Revising intention revision: stop current intention when a different one is pushed
 */
export class IntentionRevisionRevise extends IntentionRevision {
    /** @type {number} Threshold for switching (unused) */
    #SWITCH_THRESHOLD = 0.5;

    /**
     * Push intention, stopping current if different
     * @param {Array} predicate - Intention predicate
     * @returns {Promise<void>}
     */
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
