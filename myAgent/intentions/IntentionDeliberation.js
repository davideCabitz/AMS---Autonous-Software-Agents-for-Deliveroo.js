import { planLibrary } from '../plans/planLibrary.js';

export class IntentionDeliberation {
    #stopped = false;
    #started = false;
    #current_plan = null;
    #predicate;
    #parent;

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
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
            if (this.#stopped) throw ['stopped', ...this.#predicate];

            if (PlanClass.isApplicableTo(...this.#predicate)) {
                this.#current_plan = new PlanClass(this.#parent);
                try {
                    return await this.#current_plan.execute(...this.#predicate);
                } catch (err) {
                    this.log('plan failed', PlanClass.name, err);
                }
            }
        }

        throw ['no plan for', ...this.#predicate];
    }
}
