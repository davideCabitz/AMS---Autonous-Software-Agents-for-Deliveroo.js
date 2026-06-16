import { PlanBase }    from './PlanBase.js';
import { navigateTo }  from '../utils/astar.js';

/**
 * @class AStarMove
 * Navigate to target using A* pathfinding (no obstacles blocking)
 */
export class AStarMove extends PlanBase {
    /**
     * Check if A* navigation applies (always yes for go_to)
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_to'; }

    /**
     * Execute A* navigation
     * @param {string} intent - 'go_to'
     * @param {number} x - Target x coordinate
     * @param {number} y - Target y coordinate
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        await navigateTo(x, y, () => this.stopped);
        return true;
    }
}
