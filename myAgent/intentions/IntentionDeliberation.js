import { planLibrary } from '../plans/planLibrary.js';

/**
 * @class IntentionDeliberation
 * Execute a single intention by trying plans from the library
 */
export class IntentionDeliberation {
    /** @type {boolean} Whether execution has been stopped */
    #stopped = false;

    /** @type {boolean} Whether achieve() has been called */
    #started = false;

    /** @type {Object|null} Currently executing plan instance */
    #current_plan = null;

    /** @type {Array} Intention predicate (e.g., ['go_to', x, y]) */
    #predicate;

    /** @type {Object} Parent intention context */
    #parent;

    /** @type {Function} Promise resolver */
    #resolveDone;

    /** @type {Function} Promise rejecter */
    #rejectDone;

    /** @type {Promise} Resolves when intention completes, rejects on failure */
    completion;

    /**
     * @param {Object} parent - Parent intention context
     * @param {Array} predicate - Intention predicate
     */
    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
        this.completion = new Promise((resolve, reject) => {
            this.#resolveDone = resolve;
            this.#rejectDone  = reject;
        });
        // Don't crash the process if nobody awaits a rejected completion.
        this.completion.catch(() => {});
    }

    /** @type {Array} Intention predicate */
    get predicate() { return this.#predicate; }

    /** @type {boolean} Whether this intention has been stopped */
    get stopped()   { return this.#stopped; }

    /**
     * Stop this intention and its current plan
     */
    stop() {
        this.#stopped = true;
        this.#current_plan?.stop();
    }

    /**
     * Cancel intention due to staleness (settles completion promise for awaiters)
     */
    cancel() {
        this.#stopped = true;
        this.#rejectDone(['stopped', ...this.#predicate]);
    }

    /**
     * Log message through parent
     * @param {...any} args - Log arguments
     */
    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    /**
     * Execute this intention by trying applicable plans
     * @returns {Promise<*>} Plan result
     */
    async achieve() {
        if (this.#started) return false;
        this.#started = true;

        let firstError = null;
        let wasStopped = false;

        for (const PlanClass of planLibrary) {
            if (this.#stopped) { const e = ['stopped', ...this.#predicate]; this.#rejectDone(e); throw e; }

            if (PlanClass.isApplicableTo(...this.#predicate)) {
                this.#current_plan = new PlanClass(this.#parent);
                try {
                    const result = await this.#current_plan.execute(...this.#predicate);
                    this.#resolveDone(result);
                    return result;
                } catch (err) {
                    this.log('plan failed', PlanClass.name, err);
                    const tag = Array.isArray(err) ? err[0] : err;
                    if (tag === 'stopped')   wasStopped = true;
                    else if (!firstError)    firstError = err;
                }
            }
        }

        // Reject with the most meaningful tag. A 'stopped' plan means the
        // intention was superseded — keep that signal (the loop silences it).
        // Otherwise relay the first real plan failure (e.g. ['no path to',x,y])
        // instead of masking everything as 'no plan for': the LLM command path
        // turns these tags into observations the model can actually act on.
        const e = wasStopped ? ['stopped', ...this.#predicate]
                : firstError ?? ['no plan for', ...this.#predicate];
        this.#rejectDone(e);
        throw e;
    }
}
