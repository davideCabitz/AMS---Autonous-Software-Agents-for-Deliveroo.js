import {
    me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, moveTiming, CARRYING_CAPACITY,
    usableDeliverySet, safeTargetSet
} from '../context.js';
import { distance } from '../utils/distance.js';
import { findRoute } from '../utils/astar.js';

export const MIN_DELIVERY_REWARD = 5;
export const IDLE_WAIT_MS        = 2000; // IDLE time the agent waits on a spawner hoping a parcel appears
// A different pickup must beat the CURRENT target's value by at least this much to
// justify abandoning the in-progress trip. Without it, parcels crossing in/out of
// the worthwhile set each tick (decay/distance/sensing shifts) make the agent
// flip between "pick up" and "deliver" every tick → physical back-and-forth.
export const SWITCH_MARGIN       = 5;

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

    /**
     * Nearest delivery tile A*-reachable from `from` (shortest real route, walls/
     * crates/agents/arrows respected). Returns undefined when NO delivery is
     * currently reachable (e.g. other agents wall off every route) — callers must
     * handle that instead of committing to an unreachable delivery and spinning.
     */
    nearestDelivery(from = me) {
        return [...deliveryTiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            .sort((a, b) => a.len - b.len)[0]?.d;
    }

    /**
     * True when `tile` lies in the sustainable pick-up→deliver region — i.e. from it
     * a usable delivery is still reachable, so the agent won't get stranded by going
     * there. Backed by the static safeTargetSet computed once at map load. Gates
     * pickups and exploration on directional mazes. See docs/DIRECTIONAL_TRAP_AVOIDANCE.md.
     */
    inSafe(tile) {
        return safeTargetSet.has(`${Math.round(tile.x)}_${Math.round(tile.y)}`);
    }

    /**
     * Nearest A*-reachable delivery that is part of a sustainable pick-up→deliver
     * loop (in usableDeliverySet) — one the agent can still leave afterwards, so it
     * won't get trapped in a one-way pocket. Falls back to the nearest reachable
     * delivery when none is usable (all-traps map) so the agent still delivers
     * instead of freezing. Used for the actual go_deliver target; scoring keeps
     * using nearestDelivery (nearest reachable) unchanged.
     */
    nearestEscapableDelivery(from = me) {
        const reachable = [...deliveryTiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            .sort((a, b) => a.len - b.len);
        if (reachable.length === 0) return undefined;
        const usable = reachable.filter(({ d }) => usableDeliverySet.has(`${d.x}_${d.y}`));
        return (usable[0] ?? reachable[0]).d;
    }

    /** Naive reward-per-distance ratio. Used only by StrategySimple. */
    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /** True when the agent already carries the max parcels allowed (server capacity). */
    atCapacity() {
        return parcels.carriedBy(me.id).length >= CARRYING_CAPACITY;
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
     * agent would actually walk (direction-aware; walls, crates and other agents
     * excluded). Returns Infinity when no A* route exists — Manhattan is NOT used
     * as a fallback because it's unreliable for reachability and would make an
     * unreachable target look cheap (the cause of the back-and-forth looping).
     */
    pathLen(from, to) {
        const route = findRoute(from, to);
        return route ? route.length : Infinity;
    }

    /** True when an A* route from the agent to `to` currently exists. */
    isReachable(to) {
        return Number.isFinite(this.pathLen(me, to));
    }

    /**
     * Hysteresis for pickup commitment: should we keep the current go_pick_up
     * rather than switch to `candidate`? Keeps the trip stable unless the new
     * option is meaningfully better, eliminating the per-tick flip-flop that makes
     * the agent walk back and forth.
     * @param {Array|null} currentIntent  e.g. ['go_pick_up', x, y, id]
     * @param {{p:object,value:number}|undefined} candidate  the best new option
     * @returns {boolean}
     */
    shouldKeepCurrentPickup(currentIntent, candidate) {
        if (!currentIntent || currentIntent[0] !== 'go_pick_up') return false;
        const curId = currentIntent[3];
        const cur   = parcels.get(curId);
        // Drop the current target if its parcel is gone, taken, or now unreachable.
        if (!cur || cur.carriedBy || !this.isReachable(cur)) return false;
        // No alternative, or candidate IS the current target → keep going.
        if (!candidate || candidate.p.id === curId) return true;
        // Keep unless the candidate beats the current target's value by the margin.
        return candidate.value - this.pickupValue(cur) < SWITCH_MARGIN;
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

        // Only consider tiles the agent can actually A*-reach (walls/crates/agents
        // respected). Unreachable spawners are never targeted — that caused the
        // repeated re-selection of an out-of-reach tile and the back-and-forth.
        const pool       = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        const reachable  = pool.filter(t => this.isReachable(t));
        if (reachable.length === 0) return null; // nothing reachable → stay idle

        // Prefer tiles in the sustainable-loop region (don't explore into a one-way
        // trap); fall back to all reachable only if none are safe (all-traps map).
        const safe   = reachable.filter(t => this.inSafe(t));
        const usable = safe.length > 0 ? safe : reachable;

        // Prefer reachable tiles outside current sensing (new ground), else any
        // reachable tile; pick the nearest by real A* path length.
        const outOfRange = usable.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const candidates = outOfRange.length > 0 ? outOfRange : usable;

        const target = [...candidates].sort((a, b) => this.pathLen(me, a) - this.pathLen(me, b))[0];
        if (target) {
            console.log(`[explore] → reachable spawner ${target.x},${target.y} pathLen:${this.pathLen(me, target)}`);
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
