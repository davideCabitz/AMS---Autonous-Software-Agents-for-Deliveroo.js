import { planLibrary } from '../plans/planLibrary.js';

export class IntentionDeliberation {
    #stopped = false;
    #started = false;
    #current_plan = null;
    #predicate;
    #parent;
    #resolveDone;
    #rejectDone;

    /* Resolves with the plan result when achieve() succeeds, rejects with the
     * thrown tag (['stopped',...] / ['no plan for',...]) otherwise. Used only by
     * the LLM command path (IntentionRevisionReplace.commandAndAwait) to await a
     * specific pushed intention; the autonomous loop never reads it. */
    completion;

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

    get predicate() { return this.#predicate; }
    get stopped()   { return this.#stopped; }

    stop() {
        this.#stopped = true;
        this.#current_plan?.stop();
    }

    log(...args) {
        this.#parent?.log?.('\t', ...args);
    }

    async achieve() {
        if (this.#started) return false;
        this.#started = true;

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
                }
            }
        }

        const e = ['no plan for', ...this.#predicate];
        this.#rejectDone(e);
        throw e;
    }
}
