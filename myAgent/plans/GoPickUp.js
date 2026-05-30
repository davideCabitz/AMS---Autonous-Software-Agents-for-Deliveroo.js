import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

export class GoPickUp extends PlanBase {
    static isApplicableTo(intent) { return intent === 'go_pick_up'; }

    async execute(intent, x, y, id) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];

        // Apply the result to beliefs immediately: on blind maps no sensing event
        // follows the (stationary) pickup, so the belief would otherwise stay stale
        // — the agent would re-pick the same parcel forever and never deliver.
        const picked = await socket.emitPickup();
        if (picked && picked.length > 0) parcels.setCarriedBy(id, me.id); // now carrying
        else                              parcels.remove(id);             // already gone
        return true;
    }
}
