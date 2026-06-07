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

        // Free parcels in sensing range, A*-reachable, whose pickup nets at least
        // MIN_DELIVERY_REWARD over just delivering now (ΔB = B(p) − A). Unreachable
        // parcels are dropped so they can never be selected. Ranked by value B(p).
        const worthwhileInRange = parcels.free()
            .filter(p => distance(me, p) <= OBSERVATION_DISTANCE && this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value);

        if (carrying.length > 0) {
            this.idleWaitStart = null;
            // Hysteresis: while there's room, stick with the current pickup as long
            // as it's still valid and not clearly beaten — prevents flip-flopping
            // between pick-up and deliver each tick.
            if (!this.atCapacity() && this.shouldKeepCurrentPickup(currentIntent, worthwhileInRange[0]))
                return null;
            // Only consider another pickup if there's still room to carry it.
            if (!this.atCapacity() && worthwhileInRange.length > 0) {
                const { p } = worthwhileInRange[0];
                console.log(`[greedy] → multi-pickup ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            const target = this.nearestEscapableDelivery();
            if (target) {
                console.log(`[greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
            // No delivery currently reachable (agents/crates wall every route). Fall
            // through to explore/idle to reposition until a path opens, instead of
            // committing to an unreachable delivery and spinning.
            console.log('[greedy] no reachable delivery — repositioning');
        }

        const best = parcels.free()
            .filter(p => this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];

        if (best) {
            this.idleWaitStart = null;
            // Hysteresis: keep heading to the current target unless clearly beaten.
            if (this.shouldKeepCurrentPickup(currentIntent, best)) return null;
            console.log(`[greedy] → go_pick_up ${this.pickupDebug(best.p)}`);
            return ['go_pick_up', best.p.x, best.p.y, best.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
