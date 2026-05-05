import { IntentionDeliberation } from '../intentions/IntentionDeliberation.js';

export class PlanBase {
    #stopped = false;
    #sub_intentions = [];
    #parent;

    constructor(parent) {
        this.#parent = parent;
    }

    get stopped() {
        return this.#stopped;
    }

    stop() {
        this.#stopped = true;
        for (const sub of this.#sub_intentions) sub.stop();
    }

    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    async subIntention(predicate) {
        const sub = new IntentionDeliberation(this.#parent, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }

    /** @param {...any} _predicate */
    static isApplicableTo(..._predicate) {
        return false;
    }

    /** @param {...any} _predicate */
    async execute(..._predicate) {
        throw new Error('execute() not implemented');
    }
}
