import { parcels } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agent');

/**
 * @class IntentionRevision
 * Base intention loop over a queue of intentions.
 */
export class IntentionRevision {
    /** @type {Array<IntentionDeliberation>} Intention queue */
    #queue = [];

    /** @type {Array<IntentionDeliberation>} Queue (read-only) */
    get intention_queue() { return this.#queue; }

    /**
     * Log through the module logger
     * @param {...any} args - Log arguments
     */
    log(...args) { log(...args); }

    /**
     * Main execution loop
     * @returns {Promise<void>}
     */
    async loop() {
        while (true) {
            await new Promise(res => setImmediate(res));
            while (this.#queue.length > 0 && this.#queue[0].stopped) {
                this.#queue.shift();
            }

            if (this.#queue.length === 0) continue;

            const intention = this.#queue[0];

            if (!this.#isValid(intention)) {
                this.log('dropping stale intention:', intention.predicate.join(' '));
                intention.cancel();   // settle completion so awaiters don't hang
                this.#queue.shift();
                continue;
            }

            this.log('pursuing:', intention.predicate.join(' '));

            await intention.achieve().catch(err => {
                const tag = Array.isArray(err) ? err[0] : err;
                if (tag !== 'stopped') this.log('intention failed:', err);
            });

            this.#queue.shift();
        }
    }

    /**
     * Push a new intention (overridden by subclasses)
     * @param {Array} _predicate - Intention predicate
     * @returns {Promise<void>}
     */
    async push(_predicate) {}

    /**
     * Whether an intention should keep executing
     * @param {IntentionDeliberation} intention - Intention to validate
     * @returns {boolean}
     */
    #isValid(intention) {
        const [intent, , , id] = intention.predicate;
        if (intent === 'go_pick_up') {
            // Fall back to memory when the parcel left the sensing zone.
            // getRemembered() is null when memory is disabled, so this is a
            // no-op for strategies without memory.
            const p = parcels.get(id) ?? parcels.getRemembered(id);
            return !!p && !p.carriedBy;
        }
        return true;
    }
}
