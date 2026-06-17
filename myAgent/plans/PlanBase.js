import { IntentionDeliberation } from '../intentions/IntentionDeliberation.js';

/**
 * @class PlanBase
 * Base class for executable plans (BDI plan library).
 */
export class PlanBase {
    /** @type {boolean} Stopped flag */
    #stopped = false;

    /** @type {Array<IntentionDeliberation>} Sub-intentions spawned by this plan */
    #sub_intentions = [];

    /** @type {Object} Parent intention context */
    #parent;

    /** @param {Object} parent - Parent intention */
    constructor(parent) {
        this.#parent = parent;
    }

    /** @type {boolean} Stopped flag */
    get stopped() {
        return this.#stopped;
    }

    /** Stop this plan and all its sub-intentions */
    stop() {
        this.#stopped = true;
        for (const sub of this.#sub_intentions) sub.stop();
    }

    /**
     * Log through the parent intention
     * @param {...any} args - Log arguments
     */
    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    /**
     * Create and execute a sub-intention
     * @param {Array} predicate - Predicate (e.g. ['go_to', x, y])
     * @returns {Promise<*>} Sub-intention result
     */
    async subIntention(predicate) {
        const sub = new IntentionDeliberation(this.#parent, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }

    /**
     * Whether this plan applies to a predicate (override in subclass)
     * @param {...any} _predicate - Predicate elements
     * @returns {boolean}
     */
    static isApplicableTo(..._predicate) {
        return false;
    }

    /**
     * Execute the plan (override in subclass)
     * @param {...any} _predicate - Predicate elements
     * @returns {Promise<boolean>}
     */
    async execute(..._predicate) {
        throw new Error('execute() not implemented');
    }
}
