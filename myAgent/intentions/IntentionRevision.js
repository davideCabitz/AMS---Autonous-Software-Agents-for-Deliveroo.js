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
            const p = parcels.get(id);
            return !!p && !p.carriedBy;
        }
        return true;
    }
}
