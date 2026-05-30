import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

export class GoDeliver extends PlanBase {
    static isApplicableTo(intent) { return intent === 'go_deliver'; }

    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];

        // Clear delivered parcels from beliefs right away; otherwise (blind, no
        // following sensing event) the agent thinks it's still carrying and would
        // re-deliver forever — the freeze in reverse.
        const dropped = await socket.emitPutdown();
        if (dropped && dropped.length > 0)
            for (const p of parcels.carriedBy(me.id)) parcels.remove(p.id);
        return true;
    }
}
