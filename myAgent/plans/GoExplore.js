import { PlanBase } from './PlanBase.js';

/**
 * @class GoExplore
 * Navigate to exploration target
 */
export class GoExplore extends PlanBase {
    /**
     * Check if exploration applies
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_explore'; }

    /**
     * Navigate to spawner for exploration
     * @param {string} intent - 'go_explore'
     * @param {number} x - Spawner x coordinate
     * @param {number} y - Spawner y coordinate
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        return true;
    }
}
