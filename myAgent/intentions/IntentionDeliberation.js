import { planLibrary } from '../plans/planLibrary.js';

/**
 * @class IntentionDeliberation
 * Execute one intention by trying plans from the library.
 */
export class IntentionDeliberation {
    /** @type {boolean} Stopped flag */
    #stopped = false;

    /** @type {boolean} Whether achieve() has run */
    #started = false;

    /** @type {Object|null} Currently executing plan */
    #current_plan = null;

    /** @type {Array} Predicate (e.g. ['go_to', x, y]) */
    #predicate;

    /** @type {Object} Parent intention context */
    #parent;

    /** @type {Function} Promise resolver */
    #resolveDone;

    /** @type {Function} Promise rejecter */
    #rejectDone;

    /** @type {Promise} Resolves on completion, rejects on failure */
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

    /** @type {Array} Predicate */
    get predicate() { return this.#predicate; }

    /** @type {boolean} Stopped flag */
    get stopped()   { return this.#stopped; }

    /** Stop this intention and its current plan */
    stop() {
        this.#stopped = true;
        this.#current_plan?.stop();
    }

    /** Cancel as stale, settling the completion promise for awaiters */
    cancel() {
        this.#stopped = true;
        this.#rejectDone(['stopped', ...this.#predicate]);
    }

    /**
     * Log through parent
     * @param {...any} args - Log arguments
     */
    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    /**
     * Execute by trying applicable plans in order
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

        // Reject with the most meaningful tag: 'stopped' (superseded) > first real
        // plan failure (e.g. ['no path to',x,y]) > 'no plan for'. The LLM command
        // path turns these into observations the model can act on.
        const e = wasStopped ? ['stopped', ...this.#predicate]
                : firstError ?? ['no plan for', ...this.#predicate];
        this.#rejectDone(e);
        throw e;
    }
}
