import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

/**
 * @class GoPickUp
 * Navigate to a parcel and pick it up.
 */
export class GoPickUp extends PlanBase {
    /**
     * Applies to go_pick_up
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_pick_up'; }

    /**
     * Navigate to (x, y) and pick up parcel id
     * @param {string} intent - 'go_pick_up'
     * @param {number} x - Parcel x
     * @param {number} y - Parcel y
     * @param {string} id - Parcel ID
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y, id) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];

        // Apply the result to beliefs at once: on blind maps no sensing follows the
        // pickup, so the belief would stay stale and the agent re-pick forever.
        const picked = await socket.emitPickup();
        if (picked && picked.length > 0) parcels.setCarriedBy(id, me.id); // now carrying
        else                              parcels.remove(id);             // already gone
        return true;
    }
}
