import { Strategy, MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN } from './Strategy.js';
import { me, parcels, spawnerTiles, OBSERVATION_DISTANCE } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('not-too-greedy');

// extra tiles past OBSERVATION_DISTANCE within which an unseen spawner triggers a detour
const DETOUR_SPAWNER_MAX_DIST = 5;

/**
 * @class StrategyNotTooGreedy
 * Greedy with a one-time detour to a spawner just outside sensing range.
 */
export class StrategyNotTooGreedy extends Strategy {
    /** @type {boolean} Whether a detour has been made this trip */
    #detourDone = false;

    /**
     * Decide the next intention
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);
        const bankNow  = this.bankNowValue(); // value A: deliver current load now

        if (carrying.length === 0) this.#detourDone = false;

        // Free, in-range, reachable parcels whose pickup nets ≥ MIN_DELIVERY_REWARD
        // over delivering now (ΔB = B(p) − A), ranked by value B(p).
        const worthwhileInRange = parcels.free()
            .filter(p => distance(me, p) <= OBSERVATION_DISTANCE && this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ p, value }) => value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
            .sort((a, b) => b.value - a.value);

        if (carrying.length > 0) {
            // Hysteresis: while there's room, keep the current pickup as long as it's
            // valid and not clearly beaten — prevents flip-flopping.
            if (!this.atCapacity() && this.shouldKeepCurrentPickup(currentIntent, worthwhileInRange[0]))
                return null;
            // Only consider another pickup if there's still room.
            if (!this.atCapacity() && worthwhileInRange.length > 0) {
                const { p } = worthwhileInRange[0];
                log(`→ multi-pickup ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            // One-time detour to the closest spawner just outside sensing range
            // (#detourDone prevents re-entering this block for the rest of the trip).
            if (!this.#detourDone) {
                const nearbyUnseenSpawner = spawnerTiles
                    .filter(t =>
                        distance(me, t) >  OBSERVATION_DISTANCE &&
                        distance(me, t) <= OBSERVATION_DISTANCE + DETOUR_SPAWNER_MAX_DIST
                    )
                    .sort((a, b) => distance(me, a) - distance(me, b))[0];

                if (nearbyUnseenSpawner) {
                    this.#detourDone = true;
                    log(`→ detour to nearby spawner ${nearbyUnseenSpawner.x},${nearbyUnseenSpawner.y} dist:${distance(me, nearbyUnseenSpawner).toFixed(1)}`);
                    return ['go_explore', nearbyUnseenSpawner.x, nearbyUnseenSpawner.y];
                }
            }

            // While the detour go_explore is still running, don't replace it yet.
            if (this.#detourDone && currentIntent?.[0] === 'go_explore') return null;

            const target = this.nearestEscapableDelivery();
            if (target) {
                log(`→ go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
            // No delivery reachable — explore/idle to reposition until a path opens.
            log('no reachable delivery — repositioning');
        }

        const best = parcels.free()
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
