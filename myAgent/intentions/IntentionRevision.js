import { parcels } from '../context.js';

export class IntentionRevision {
    #queue = [];

    get intention_queue() { return this.#queue; }

    log(...args) { console.log('[agent]', ...args); }

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

    async push(_predicate) {}

    #isValid(intention) {
        const [intent, , , id] = intention.predicate;
        if (intent === 'go_pick_up') {
            // Fall back to memory when the parcel has left the sensing zone;
            // getRemembered() returns null when memory is disabled (all existing
            // strategies), so this ?? branch is a no-op for them.
            const p = parcels.get(id) ?? parcels.getRemembered(id);
            return !!p && !p.carriedBy;
        }
        return true;
    }
}
