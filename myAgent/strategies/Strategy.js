import {
    me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, DECAY_STEPS_PER_REWARD
} from '../context.js';
import { distance } from '../utils/distance.js';

export const MIN_DELIVERY_REWARD = 5;
export const IDLE_WAIT_MS        = 2000; // IDLE time the agent waits on a spawner hoping a parcel appears

/**
 * Base class for option-generation strategies.
 *
 * A strategy is a pure decider: given the predicate of the currently-pursued
 * intention (or null), `decide()` returns the next option to push as a predicate
 * array, or `null` to keep the current intention running. The agent does the
 * actual `push` — strategies never touch the intention queue directly.
 *
 * Per-strategy mutable state lives on the instance (no module globals), so
 * switching strategy at runtime can never leak state between them.
 */
export class Strategy {
    /** Exploration wait timer (set while idling on a spawner tile). */
    idleWaitStart = null;

    /**
     * Re-deliberation cadence in ms, owned by the agent loop. 0 = no heartbeat
     * (rely purely on sensing/you events). Strategies that can idle without an
     * event to wake them (e.g. blind, stationary after a pickup) override this.
     */
    tickIntervalMs = 0;

    /**
     * @param {Array|null} _currentIntent predicate of the current intention, e.g. ['go_deliver', x, y]
     * @returns {Array|null} predicate to push, or null to keep the current intention
     */
    decide(_currentIntent) { return null; }

    // ─── shared helpers ──────────────────────────────────────────────────────

    nearestDelivery(from = me) {
        return [...deliveryTiles].sort((a, b) => distance(from, a) - distance(from, b))[0];
    }

    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /** Estimated reward still available once this parcel is carried to delivery. */
    estimatedRewardAtDelivery(parcel) {
        const toParcel   = distance(me, parcel);
        const delTile    = this.nearestDelivery(parcel);
        const toDelivery = delTile ? distance(parcel, delTile) : Infinity;
        return parcel.reward - Math.ceil((toParcel + toDelivery) / DECAY_STEPS_PER_REWARD);
    }

    /**
     * Exploration used by the sensing-based strategies when there's nothing worth
     * picking up or delivering. Waits briefly on a spawner for a spawn (only when
     * the sensing area is large enough to ever detect one), otherwise heads to the
     * nearest out-of-range spawner (or walkable tile).
     *
     * @param {Array|null} currentIntent
     * @returns {Array|null}
     */
    exploreIfIdle(currentIntent) {
        if (currentIntent) {
            const [intent, tx, ty] = currentIntent;

            if (intent === 'go_pick_up' || intent === 'go_deliver') {
                this.idleWaitStart = null;
                return null;
            }

            if (intent === 'go_explore' && distance(me, { x: tx, y: ty }) > OBSERVATION_DISTANCE) {
                this.idleWaitStart = null;
                return null;
            }
        }

        // On a spawner tile — wait IDLE_WAIT_MS for a parcel to potentially spawn.
        // Skip the wait entirely when the sensing area is too small to ever detect a parcel.
        const onSpawner = spawnerTiles.some(
            t => Math.round(me.x) === t.x && Math.round(me.y) === t.y
        );

        if (onSpawner && OBSERVATION_DISTANCE > 1) {
            if (this.idleWaitStart === null) {
                this.idleWaitStart = Date.now();
                console.log('[explore] on spawner — waiting 2 s for parcel to appear');
                return null;
            }
            if (Date.now() - this.idleWaitStart < IDLE_WAIT_MS) return null;
        }

        this.idleWaitStart = null;

        const pool       = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        const outOfRange = pool.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const candidates = outOfRange.length > 0 ? outOfRange : pool;

        const target = [...candidates].sort((a, b) => distance(me, a) - distance(me, b))[0];
        if (target) {
            console.log(`[explore] → out-of-range spawner ${target.x},${target.y} dist:${distance(me, target)}`);
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
