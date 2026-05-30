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

        // Parcels in sensing range still worth picking up
        const worthwhileInRange = parcels.free()
            .filter(p =>
                distance(me, p) <= OBSERVATION_DISTANCE &&
                this.estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD
            )
            .sort((a, b) => this.scoreOf(b) - this.scoreOf(a));

        if (carrying.length > 0) {
            this.idleWaitStart = null;
            if (worthwhileInRange.length > 0) {
                const next = worthwhileInRange[0];
                console.log(`[greedy] → multi-pickup ${next.id} est:${this.estimatedRewardAtDelivery(next).toFixed(1)}`);
                return ['go_pick_up', next.x, next.y, next.id];
            }

            const target = this.nearestDelivery();
            if (target) {
                console.log(`[greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        const best = parcels.free()
            .filter(p => this.estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD)
            .sort((a, b) => this.scoreOf(b) - this.scoreOf(a))[0];

        if (best) {
            this.idleWaitStart = null;
            console.log(`[greedy] → go_pick_up ${best.id} score:${this.scoreOf(best).toFixed(2)} est:${this.estimatedRewardAtDelivery(best).toFixed(1)}`);
            return ['go_pick_up', best.x, best.y, best.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
