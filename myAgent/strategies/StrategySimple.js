import { Strategy } from './Strategy.js';
import { me, parcels } from '../context.js';

/**
 * Simple strategy: deliver as soon as carrying anything; otherwise pick the best
 * free parcel by reward / distance.
 */
export class StrategySimple extends Strategy {
    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);

        if (carrying.length > 0) {
            this.idleWaitStart = null;
            const target = this.nearestDelivery();
            if (target) {
                console.log(`[simple] → go_deliver to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        const best = parcels.free()
            .map(p => ({ ...p, score: this.scoreOf(p) }))
            .sort((a, b) => b.score - a.score)[0];

        if (best) {
            this.idleWaitStart = null;
            console.log(`[simple] → go_pick_up ${best.id} score:${best.score.toFixed(2)}`);
            return ['go_pick_up', best.x, best.y, best.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
