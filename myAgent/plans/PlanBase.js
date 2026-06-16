import { IntentionDeliberation } from '../intentions/IntentionDeliberation.js';

/**
 * @class PlanBase
 * Base class for executable plans (BDI plan library)
 */
export class PlanBase {
    /** @type {boolean} Whether this plan has been stopped */
    #stopped = false;

    /** @type {Array<IntentionDeliberation>} Sub-intentions spawned by this plan */
    #sub_intentions = [];

    /** @type {Object} Parent intention context */
    #parent;

    /**
     * @param {Object} parent - Parent intention object
     */
    constructor(parent) {
        this.#parent = parent;
    }

    /** @type {boolean} True if plan execution has been stopped */
    get stopped() {
        return this.#stopped;
    }

    /**
     * Stop this plan and all its sub-intentions
     */
    stop() {
        this.#stopped = true;
        for (const sub of this.#sub_intentions) sub.stop();
    }

    /**
     * Log message through parent intention
     * @param {...any} args - Log arguments
     */
    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    /**
     * Create and execute a sub-intention
     * @param {Array} predicate - Intention predicate (e.g., ['go_to', x, y])
     * @returns {Promise<*>} Result of sub-intention execution
     */
    async subIntention(predicate) {
        const sub = new IntentionDeliberation(this.#parent, predicate);
        this.#sub_intentions.push(sub);
        return sub.achieve();
    }

    /**
     * Check if this plan applies to the given predicate
     * @param {...any} _predicate - Intention predicate elements
     * @returns {boolean} False (must override in subclass)
     */
    static isApplicableTo(..._predicate) {
        return false;
    }

    /**
     * Execute the plan
     * @param {...any} _predicate - Intention predicate elements
     * @returns {Promise<boolean>}
     */
    async execute(..._predicate) {
        throw new Error('execute() not implemented');
    }
}
