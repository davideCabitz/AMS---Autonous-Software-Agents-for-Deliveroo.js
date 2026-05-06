import { PlanBase } from './PlanBase.js';
import { socket } from '../context.js';

export class GoPickUp extends PlanBase {
    static isApplicableTo(intent) {
        return intent === 'go_pick_up';
    }

    async execute(intent, x, y, id) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];
        await socket.emitPickup();
        return true;
    }
}
