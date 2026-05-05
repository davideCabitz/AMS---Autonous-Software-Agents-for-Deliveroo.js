import { PlanBase } from './PlanBase.js';

export class GoDeliver extends PlanBase {
    static isApplicableTo(intent) {
        return intent === 'go_deliver';
    }

    // Delivery happens automatically when stepping onto a delivery tile.
    async execute(intent, x, y, socket) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y, socket]);
        return true;
    }
}
