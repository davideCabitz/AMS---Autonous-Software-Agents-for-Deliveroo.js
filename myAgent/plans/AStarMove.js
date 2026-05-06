import { PlanBase }    from './PlanBase.js';
import { navigateTo }  from '../utils/astar.js';

export class AStarMove extends PlanBase {
    static isApplicableTo(intent) { return intent === 'go_to'; }

    async execute(intent, x, y) {
        await navigateTo(x, y, () => this.stopped);
        return true;
    }
}
