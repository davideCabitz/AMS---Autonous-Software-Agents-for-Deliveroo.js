import { Strategy } from './Strategy.js';
import { me, parcels } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('simple');

/**
 * @class StrategySimple
 * Deliver immediately when carrying, else pick the best free parcel.
 */
export class StrategySimple extends Strategy {
    /**
     * Decide the next intention
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);

        if (carrying.length > 0) {
            const target = this.nearestDelivery();
            if (target) {
                log(`→ go_deliver to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        const best = parcels.free()
            .map(p => ({ ...p, score: this.scoreOf(p) }))
            .sort((a, b) => b.score - a.score)[0];

        if (best) {
            log(`→ go_pick_up ${best.id} score:${best.score.toFixed(2)}`);
            return ['go_pick_up', best.x, best.y, best.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
