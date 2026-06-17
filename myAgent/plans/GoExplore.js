import { PlanBase } from './PlanBase.js';

/**
 * @class GoExplore
 * Navigate to an exploration target (a spawner).
 */
export class GoExplore extends PlanBase {
    /**
     * Applies to go_explore
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_explore'; }

    /**
     * Navigate to the spawner at (x, y)
     * @param {string} intent - 'go_explore'
     * @param {number} x - Spawner x
     * @param {number} y - Spawner y
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        return true;
    }
}
