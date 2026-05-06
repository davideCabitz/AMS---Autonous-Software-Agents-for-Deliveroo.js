import { PlanBase } from './PlanBase.js';
import { socket }   from '../context.js';

export class GoDeliver extends PlanBase {
    static isApplicableTo(intent) { return intent === 'go_deliver'; }

    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];
        await socket.emitPutdown();
        return true;
    }
}
