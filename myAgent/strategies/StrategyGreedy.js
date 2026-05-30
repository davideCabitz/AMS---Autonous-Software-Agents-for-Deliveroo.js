import { Strategy, MIN_DELIVERY_REWARD } from './Strategy.js';
import { me, parcels, OBSERVATION_DISTANCE } from '../context.js';
import { distance } from '../utils/distance.js';

/**
 * Accumulate parcels still worth picking up within sensing range, then deliver
 * when nothing nearby is worthwhile. The intuition: it can be better to gather
 * several parcels and deliver them together before the reward decays, rather
 * than delivering immediately after each pickup.
 */
export class StrategyGreedy extends Strategy {
    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);
        const bankNow  = this.bankNowValue(); // value A: deliver current load now

        // Free parcels in sensing range whose pickup nets at least MIN_DELIVERY_REWARD
        // over just delivering now (ΔB = B(p) − A). Ranked by banked value B(p).
        const worthwhileInRange = parcels.free()
            .filter(p => distance(me, p) <= OBSERVATION_DISTANCE)
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value);

        if (carrying.length > 0) {
            this.idleWaitStart = null;
            if (worthwhileInRange.length > 0) {
                const { p } = worthwhileInRange[0];
                console.log(`[greedy] → multi-pickup ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            const target = this.nearestDelivery();
            if (target) {
                console.log(`[greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        const best = parcels.free()
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];

        if (best) {
            this.idleWaitStart = null;
            console.log(`[greedy] → go_pick_up ${this.pickupDebug(best.p)}`);
            return ['go_pick_up', best.p.x, best.p.y, best.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
