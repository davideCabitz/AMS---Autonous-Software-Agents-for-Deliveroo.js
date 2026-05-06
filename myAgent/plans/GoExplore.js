import { PlanBase } from './PlanBase.js';

export class GoExplore extends PlanBase {
    static isApplicableTo(intent) {
        return intent === 'go_explore';
    }

    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        return true;
    }
}
