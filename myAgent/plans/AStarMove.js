import { PlanBase }    from './PlanBase.js';
import { navigateTo }  from '../utils/astar.js';

/**
 * @class AStarMove
 * Navigate to a target via A* (no crates blocking the route).
 */
export class AStarMove extends PlanBase {
    /**
     * Applies to any go_to
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_to'; }

    /**
     * Navigate to (x, y)
     * @param {string} intent - 'go_to'
     * @param {number} x - Target x
     * @param {number} y - Target y
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        await navigateTo(x, y, () => this.stopped);
        return true;
    }
}
