import { PlanBase } from './PlanBase.js';

export class GoPickUp extends PlanBase {
    static isApplicableTo(intent) {
        return intent === 'go_pick_up';
    }

    async execute(intent, x, y, id, socket) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y, socket]);
        if (this.stopped) throw ['stopped'];
        await socket.emitPickup();
        return true;
    }
}
