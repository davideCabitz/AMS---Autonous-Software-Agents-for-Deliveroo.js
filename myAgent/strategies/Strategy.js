import {
    me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, moveTiming
} from '../context.js';
import { distance } from '../utils/distance.js';
import { findRoute } from '../utils/astar.js';

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
     * @param {Array|null} _currentIntent predicate of the current intention, e.g. ['go_deliver', x, y]
     * @returns {Array|null} predicate to push, or null to keep the current intention
     */
    decide(_currentIntent) { return null; }

    // ─── shared helpers ──────────────────────────────────────────────────────

    /**
     * Delivery tile reachable with the shortest A* route from `from` (the real
     * number of tiles walked, walls/crates/arrows respected), NOT the closest by
     * straight-line Manhattan. Unreachable tiles fall back to Manhattan so a tile
     * is always returned even when no route exists.
     */
    nearestDelivery(from = me) {
        return [...deliveryTiles]
            .sort((a, b) => this.pathLen(from, a) - this.pathLen(from, b))[0];
    }

    /** Naive reward-per-distance ratio. Used only by StrategySimple. */
    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /**
     * Reward lost per parcel per tile travelled (0 when parcels never decay).
     * Derived from the *measured* real time per tile, not the optimistic
     * MOVEMENT_DURATION: decay is wall-clock based, and the move loop throttles
     * each step (server move + extra sleep + latency), so a tile really costs
     * ~2·MOVEMENT_DURATION. moveTiming converges to the true pace as we move.
     */
    decayRate() {
        return moveTiming.decayPerTile();
    }

    /**
     * Travel cost in tiles between two points: the length of the A* route the
     * agent would actually walk (direction-aware, walls/crates excluded), NOT the
     * straight-line Manhattan distance. Falls back to Manhattan only when no route
     * exists (so the scoring never silently treats an unreachable target as free).
     */
    pathLen(from, to) {
        const route = findRoute(from, to);
        return route ? route.length : distance(from, to);
    }

    /**
     * Value A — reward banked by delivering the currently-carried load right now.
     * All n carried parcels decay over the trip to the nearest delivery.
     *   A = R − n·ρ·dist(me, D_me)
     * Returns 0 when carrying nothing (there's nothing to "deliver now").
     */
    bankNowValue() {
        const carried = parcels.carriedBy(me.id);
        const n = carried.length;
        if (n === 0) return 0;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const del = this.nearestDelivery(me);
        const d0  = del ? this.pathLen(me, del) : Infinity;
        return R - n * this.decayRate() * d0;
    }

    /**
     * Value B(p) — reward banked if we detour to pick up `parcel` and then deliver
     * the whole load. Accounts for the extra decay the detour inflicts on every
     * already-carried parcel plus the new one (both legs of the trip).
     *   B(p) = (R + reward_p) − (n+1)·ρ·(d1 + d2)
     * with d1 = dist(me, p), d2 = dist(p, D_p).
     */
    pickupValue(parcel) {
        const carried = parcels.carriedBy(me.id);
        const n   = carried.length;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const d1  = this.pathLen(me, parcel);
        const del = this.nearestDelivery(parcel);
        const d2  = del ? this.pathLen(parcel, del) : Infinity;
        return (R + parcel.reward) - (n + 1) * this.decayRate() * (d1 + d2);
    }

    /** Net gain of a pickup over delivering now: ΔB = B(p) − A. */
    pickupGain(parcel) {
        return this.pickupValue(parcel) - this.bankNowValue();
    }

    /**
     * Human-readable breakdown of a pickup decision, for debugging the scoring.
     * Shows the parcel→delivery distance (d2) explicitly so it's clear how much
     * the delivery leg costs in the value/gain.
     */
    pickupDebug(parcel) {
        const carried = parcels.carriedBy(me.id);
        const n   = carried.length;
        const d1  = this.pathLen(me, parcel);
        const del = this.nearestDelivery(parcel);
        const d2  = del ? this.pathLen(parcel, del) : Infinity;
        const rho = this.decayRate();
        return `id=${parcel.id} reward=${parcel.reward} carrying=${n} `
             + `d(me→parcel)=${d1} d(parcel→delivery)=${d2} `
             + `delivery=${del ? `${del.x},${del.y}` : 'none'} `
             + `msPerTile=${moveTiming.msPerTile.toFixed(0)} decayRate=${rho.toFixed(3)} `
             + `value=${this.pickupValue(parcel).toFixed(1)} `
             + `gain=${this.pickupGain(parcel).toFixed(1)} (threshold=${MIN_DELIVERY_REWARD})`;
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
