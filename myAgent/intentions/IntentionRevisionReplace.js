import { IntentionRevision } from './IntentionRevision.js';
import { IntentionDeliberation } from './IntentionDeliberation.js';
import { pddl } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('intention');

export class IntentionRevisionReplace extends IntentionRevision {
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
     * LLM command path. Pushes a predicate as the agent's next intention and
     * returns a promise that resolves when THAT intention finishes (loop() runs
     * its single achieve(), which settles intention.completion). Unlike push(),
     * it bypasses the autonomous-only guards (same-predicate / go_deliver chain)
     * so a chat directive always executes and always settles its promise — but it
     * still respects pddl.busy so an in-flight crate macro-plan isn't corrupted.
     * @param {Array} predicate e.g. ['go_to', x, y]
     * @returns {Promise<*>} resolves on completion; rejects ['busy'|'stopped'|'no plan for', ...]
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
     * Stop whatever intention is currently executing so the agent holds its
     * position. Used by the LLM `wait` tool to make "don't move for N seconds"
     * actually hold still (the autonomy gate only blocks NEW pushes, not the
     * intention already running). Respects pddl.busy so a crate macro-plan is
     * not yanked mid-execution.
     * @returns {boolean} true if it halted, false if a PDDL plan blocked it
     */
    haltCurrent() {
        if (pddl.busy) return false;
        const last = this.intention_queue.at(-1);
        if (last) last.stop();
        return true;
    }
}
