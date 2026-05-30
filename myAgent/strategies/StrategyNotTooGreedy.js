import { Strategy, MIN_DELIVERY_REWARD } from './Strategy.js';
import { me, parcels, spawnerTiles, OBSERVATION_DISTANCE } from '../context.js';
import { distance } from '../utils/distance.js';

// extra tiles beyond OBSERVATION_DISTANCE within which a nearby unseen spawner triggers a detour
const DETOUR_SPAWNER_MAX_DIST = 5;

/**
 * Like greedy, but before delivering it does a one-time detour to peek at the
 * closest spawner just outside sensing range. Useful on wide maps where a second
 * spawner sits just beyond the sensing radius. `#detourDone` is per-trip state
 * (reset whenever the agent is empty-handed).
 */
export class StrategyNotTooGreedy extends Strategy {
    #detourDone = false;

    decide(currentIntent) {
        const carrying = parcels.carriedBy(me.id);
        const bankNow  = this.bankNowValue(); // value A: deliver current load now

        if (carrying.length === 0) this.#detourDone = false;

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
                console.log(`[not-too-greedy] → multi-pickup ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            // One-time detour: peek at the closest spawner just outside sensing range.
            // #detourDone prevents re-entering this block for the rest of the delivery trip.
            if (!this.#detourDone) {
                const nearbyUnseenSpawner = spawnerTiles
                    .filter(t =>
                        distance(me, t) >  OBSERVATION_DISTANCE &&
                        distance(me, t) <= OBSERVATION_DISTANCE + DETOUR_SPAWNER_MAX_DIST
                    )
                    .sort((a, b) => distance(me, a) - distance(me, b))[0];

                if (nearbyUnseenSpawner) {
                    this.#detourDone = true;
                    console.log(`[not-too-greedy] → detour to nearby spawner ${nearbyUnseenSpawner.x},${nearbyUnseenSpawner.y} dist:${distance(me, nearbyUnseenSpawner).toFixed(1)}`);
                    return ['go_explore', nearbyUnseenSpawner.x, nearbyUnseenSpawner.y];
                }
            }

            // If the detour go_explore is still running, don't replace it with go_deliver yet.
            if (this.#detourDone && currentIntent?.[0] === 'go_explore') return null;

            const target = this.nearestDelivery();
            if (target) {
                console.log(`[not-too-greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        const best = parcels.free()
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];

        if (best) {
            this.idleWaitStart = null;
            console.log(`[not-too-greedy] → go_pick_up ${this.pickupDebug(best.p)}`);
            return ['go_pick_up', best.p.x, best.p.y, best.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }
}
