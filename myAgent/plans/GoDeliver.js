import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

/**
 * @class GoDeliver
 * Navigate to delivery zone and drop all carried parcels
 */
export class GoDeliver extends PlanBase {
    /**
     * Check if delivery applies
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_deliver'; }

    /**
     * Navigate to delivery zone and drop parcels
     * @param {string} intent - 'go_deliver'
     * @param {number} x - Delivery zone x coordinate
     * @param {number} y - Delivery zone y coordinate
     * @returns {Promise<boolean>}
     */
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
