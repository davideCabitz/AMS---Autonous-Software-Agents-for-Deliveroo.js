import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';
import { pddl } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('intention');

/**
 * @class IntentionRevisionReplace
 * Replacing intention revision: interrupt current, respect PDDL locks, support LLM commands
 */
export class IntentionRevisionReplace extends IntentionRevision {
    /**
     * Push intention, replacing current if different (respects PDDL lock)
     * @param {Array} predicate - Intention predicate
     * @returns {Promise<void>}
     */
    async push(predicate) {
        const last = this.intention_queue.at(-1);

        // Never interrupt the same intention.
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        // Never interrupt a PDDL plan mid-execution. Once the solver has returned a
        // plan and the agent is executing it (pddl.busy), any new intention is queued
        // but the current plan runs to completion first.
        if (pddl.busy) {
            log(`PDDL plan in progress — deferring: ${predicate.join(' ')}`);
            return;
        }

        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);

        if (last) last.stop();
    }

    /**
     * LLM command path: execute intention and await completion
     * @param {Array} predicate - Intention predicate (e.g., ['go_to', x, y])
     * @returns {Promise<*>} Resolves on completion; rejects ['busy'|'stopped'|'no plan for', ...]
     */
    async commandAndAwait(predicate) {
        if (pddl.busy) return Promise.reject(['busy', ...predicate]);

        const last = this.intention_queue.at(-1);
        const intention = new IntentionDeliberation(this, predicate);
        this.intention_queue.push(intention);
        if (last) last.stop();

        return intention.completion;
    }

    /**
     * Stop the currently executing intention (respects PDDL lock)
     * @returns {boolean} True if halted, false if PDDL plan is in progress
     */
    haltCurrent() {
        if (pddl.busy) return false;
        const last = this.intention_queue.at(-1);
        if (last) last.stop();
        return true;
    }
}
