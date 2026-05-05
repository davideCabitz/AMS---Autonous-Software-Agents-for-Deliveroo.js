import { IntentionDeliberation } from './IntentionDeliberation.js';

export class IntentionRevision {
    #queue = [];

    get intention_queue() { return this.#queue; }

    log(...args) { console.log(...args); }

    async loop() {
        while (true) {
            if (this.#queue.length > 0) {
                const intention = this.#queue[0];
                await intention.achieve().catch(() => {});
                this.#queue.shift();
            }
            // yield to event loop so sensing callbacks can update beliefs
            await new Promise(res => setImmediate(res));
        }
    }

    /** Override in subclasses to implement a revision strategy. */
    async push(_predicate) {}
}
