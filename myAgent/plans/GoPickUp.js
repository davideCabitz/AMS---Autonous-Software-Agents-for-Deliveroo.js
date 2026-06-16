import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

/**
 * @class GoPickUp
 * Navigate to parcel and pick it up
 */
export class GoPickUp extends PlanBase {
    /**
     * Check if pickup applies
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_pick_up'; }

    /**
     * Navigate to parcel and pick up
     * @param {string} intent - 'go_pick_up'
     * @param {number} x - Parcel x coordinate
     * @param {number} y - Parcel y coordinate
     * @param {string} id - Parcel ID
     * @returns {Promise<boolean>}
     */
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
