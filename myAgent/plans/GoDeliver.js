import { PlanBase }        from './PlanBase.js';
import { socket, me, parcels } from '../context.js';

/**
 * @class GoDeliver
 * Navigate to the delivery zone and drop all carried parcels.
 */
export class GoDeliver extends PlanBase {
    /**
     * Applies to go_deliver
     * @param {string} intent - Intention type
     * @returns {boolean}
     */
    static isApplicableTo(intent) { return intent === 'go_deliver'; }

    /**
     * Navigate to the delivery zone and drop parcels
     * @param {string} intent - 'go_deliver'
     * @param {number} x - Delivery zone x
     * @param {number} y - Delivery zone y
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];

        // Clear delivered parcels from beliefs at once: on blind maps no sensing
        // follows, so the agent would otherwise think it's still carrying and re-deliver.
        const dropped = await socket.emitPutdown();
        if (dropped && dropped.length > 0)
            for (const p of parcels.carriedBy(me.id)) parcels.remove(p.id);
        return true;
    }
}
