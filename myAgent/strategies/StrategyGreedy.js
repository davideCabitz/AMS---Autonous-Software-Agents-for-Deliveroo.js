import { Strategy, MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN } from './Strategy.js';
import { me, parcels, OBSERVATION_DISTANCE, missionConstraints } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('greedy');

/**
 * @class StrategyGreedy
 * Greedy strategy: accumulate parcels within sensing range, deliver when no nearby value
 */
export class StrategyGreedy extends Strategy {
    /**
     * Decide next intention
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);
        const bankNow  = this.bankNowValue(); // value A: deliver current load now

        // Free parcels in sensing range, A*-reachable, whose pickup nets at least
        // MIN_DELIVERY_REWARD over just delivering now (ΔB = B(p) − A). Unreachable
        // parcels are dropped so they can never be selected. Ranked by value B(p).
        // maxBundleValue missions forbid a second parcel — each delivery must be a
        // single cheap parcel so its total stays under the threshold.
        const worthwhileInRange = this.singleParcelBundles() && carrying.length > 0 ? [] : parcels.free()
            .filter(p => this.missionPickupOk(p))
            .filter(p => distance(me, p) <= OBSERVATION_DISTANCE && this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            // A mandated stack (requiredStackSize) must be filled even when the
            // marginal parcel isn't "worth it" by the decay model alone.
            .filter(({ p, value }) => this.mustStack(carrying) || value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
            .sort((a, b) => b.value - a.value);

        if (carrying.length > 0) {
            // Hysteresis: while there's room, stick with the current pickup as long
            // as it's still valid and not clearly beaten — prevents flip-flopping
            // between pick-up and deliver each tick.
            if (!this.atCapacity() && this.shouldKeepCurrentPickup(currentIntent, worthwhileInRange[0]))
                return null;
            // Only consider another pickup if there's still room to carry it.
            if (!this.atCapacity() && worthwhileInRange.length > 0) {
                const { p } = worthwhileInRange[0];
                log(`→ multi-pickup ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            const stackOk = this.stackReady(carrying);
            if (stackOk) {
                // Hysteresis: keep heading to the current delivery tile unless a
                // clearer/closer zone beats it by the switch margin (congestion-aware).
                if (this.betterDelivery(currentIntent)) return null;
                const target = this.nearestEscapableDelivery();
                if (target) {
                    log(`→ go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                    return ['go_deliver', target.x, target.y];
                }
                // No delivery currently reachable (agents/crates wall every route). Fall
                // through to explore/idle to reposition until a path opens, instead of
                // committing to an unreachable delivery and spinning.
                log('no reachable delivery — repositioning');
            } else {
                log(`stack ${carrying.length}/${missionConstraints.requiredStackSize} — need more parcels`);
            }
        }

        const best = parcels.free()
            .filter(p => this.missionPickupOk(p))
            .filter(p => this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];

        if (best) {
            // Hysteresis: keep heading to the current target unless clearly beaten.
            if (this.shouldKeepCurrentPickup(currentIntent, best)) return null;
            log(`→ go_pick_up ${this.pickupDebug(best.p)}`);
            return ['go_pick_up', best.p.x, best.p.y, best.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
