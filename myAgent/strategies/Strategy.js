import {
    me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles, crateTiles,
    OBSERVATION_DISTANCE, moveTiming, CARRYING_CAPACITY,
    usableDeliverySet, safeTargetSet, missionConstraints,
} from '../context.js';
import { distance } from '../utils/distance.js';
import { findRoute, pushAwareCost } from '../utils/astar.js';
import { createLogger } from '../utils/logger.js';

const exploreLog  = createLogger('explore');
const deliveryLog = createLogger('delivery');
const pathlenLog  = createLogger('pathlen');

export const MIN_DELIVERY_REWARD = 5;
// Max extra tiles tolerated when choosing an alternative to the excluded spawner.
// If every alternative is farther than (prevLen + margin), the exclusion is skipped
// so the agent doesn't waste time crossing the map to avoid a nearby tile.
const EXPLORE_NEARBY_MARGIN = 4;
// Gate for adding a second parcel while already carrying: trigger whenever
// multi-pickup strictly beats bank-first. Intentionally lower than
// MIN_DELIVERY_REWARD (which filters out near-worthless empty-hand pickups)
// because here we're comparing two delivery trips, not pickup vs. nothing.
export const MULTI_PICKUP_MIN = 0;
// A different pickup must beat the CURRENT target's value by at least this much to
// justify abandoning the in-progress trip. Without it, parcels crossing in/out of
// the worthwhile set each tick (decay/distance/sensing shifts) make the agent
// flip between "pick up" and "deliver" every tick → physical back-and-forth.
export const SWITCH_MARGIN = 5;

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
    /** Key "x_y" of the spawner currently committed to via go_explore. */
    _lastExploreKey = null;

    /** Key "x_y" of the spawner committed to just before _lastExploreKey.
     *  Hard-excluded on the next selection to prevent ping-pong. */
    _prevExploreKey = null;

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
        let tiles = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles = f;
        }
        return [...tiles]
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
        let tiles = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles = f;
        }
        const reachable = [...tiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            .sort((a, b) => a.len - b.len);
        if (crateTiles.length > 0)
            deliveryLog(`candidates from (${Math.round(from.x)},${Math.round(from.y)}): `
                + reachable.map(({ d, len }) => `(${d.x},${d.y})=${len}${usableDeliverySet.has(`${d.x}_${d.y}`) ? '' : '·unusable'}`).join(' '));
        if (reachable.length === 0) return undefined;
        const usable = reachable.filter(({ d }) => usableDeliverySet.has(`${d.x}_${d.y}`));
        const pool   = usable.length > 0 ? usable : reachable;   // both sorted nearest-first
        return this._pickDelivery(pool).d;
    }

    // ─── deliveryMultipliers (Level-2 bonus-tile missions) ───────────────────
    // "Deliver in (x,y) for 5× pts" makes some delivery tiles worth more. The
    // multiplier scales the banked reward at that tile, so the agent both ROUTES
    // deliveries to the bonus tile (nearestEscapableDelivery → _pickDelivery) and
    // VALUES its carried load higher when a bonus tile is reachable (the value
    // functions). With no such mission every tile is ×1, so all of this collapses
    // to the historical nearest-tile behaviour exactly.

    /** Delivery reward multiplier for `tile` (1 when no deliveryMultipliers mission). */
    deliveryMultiplierAt(tile) {
        const m = missionConstraints.deliveryMultipliers;
        if (!(m?.size > 0)) return 1;
        return m.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

    /**
     * Best delivery {d,len} from `from` for a load of total reward `R` over `n`
     * parcels. Default (no multipliers): the nearest reachable allowed tile —
     * identical to nearestDelivery. With a deliveryMultipliers mission: the tile
     * maximizing banked value R·mult(tile) − n·ρ·len, so a 5× tile is chosen when
     * its bonus outweighs the extra travel decay. Respects allowedDeliveryTiles.
     * @returns {{d:object, len:number}|undefined}
     */
    _bestDelivery(from, R, n) {
        let tiles = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles = f;
        }
        const reachable = [...tiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len));
        if (reachable.length === 0) return undefined;
        if (!(missionConstraints.deliveryMultipliers?.size > 0))
            return reachable.sort((a, b) => a.len - b.len)[0];
        const rho = this.decayRate();
        return reachable
            .map(o => ({ ...o, v: R * this.deliveryMultiplierAt(o.d) - n * rho * o.len }))
            .sort((a, b) => (b.v - a.v) || (a.len - b.len))[0]; // ties → the nearer tile
    }

    /**
     * Pick the delivery tile from an already-reachable, nearest-first `pool`
     * ({d,len} entries). Default: the nearest (pool[0]). With a deliveryMultipliers
     * mission: the entry maximizing R·mult − n·ρ·len for the currently carried
     * load, so the actual go_deliver target prefers a reachable bonus tile.
     */
    _pickDelivery(pool) {
        if (!(missionConstraints.deliveryMultipliers?.size > 0)) return pool[0];
        const carried = parcels.carriedBy(me.id);
        const R   = carried.reduce((s, p) => s + p.reward, 0) || 1;
        const n   = carried.length || 1;
        const rho = this.decayRate();
        const valueOf = e => R * this.deliveryMultiplierAt(e.d) - n * rho * e.len;
        return [...pool].sort((a, b) => (valueOf(b) - valueOf(a)) || (a.len - b.len))[0];
    }

    /** Naive reward-per-distance ratio. Used only by StrategySimple. */
    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /** True when the agent already carries the max parcels allowed (server capacity). */
    atCapacity() {
        return parcels.carriedBy(me.id).length >= CARRYING_CAPACITY;
    }

    // ─── mission-constraint gates (Level-2 persistent missions) ──────────────
    // Shared here so EVERY strategy enforces them — previously only Greedy/Blind
    // filtered maxParcelReward and only Greedy gated requiredStackSize, so the
    // default LookAhead/Memory strategies silently ignored those missions.

    /** False when a mission excludes picking `parcel` up: reward above the
     *  maxParcelReward ceiling, or above maxBundleValue (a parcel that can never
     *  be part of a qualifying ≤-threshold delivery must not be collected). */
    missionPickupOk(parcel) {
        if (missionConstraints.maxParcelReward != null
            && parcel.reward > missionConstraints.maxParcelReward) return false;
        if (missionConstraints.maxBundleValue != null
            && parcel.reward > missionConstraints.maxBundleValue) return false;
        return true;
    }

    /** Delivery gate. maxBundleValue → deliver one cheap parcel at a time (the
     *  sum of a single filtered parcel is always ≤ the threshold, so every
     *  delivery earns the bonus). requiredStackSize → only deliver once the
     *  stack is complete. Otherwise deliver whenever it's worthwhile. */
    stackReady(carrying) {
        if (missionConstraints.maxBundleValue != null) return carrying.length >= 1;
        if (missionConstraints.requiredStackSize != null)
            return carrying.length >= missionConstraints.requiredStackSize;
        return true;
    }

    /** True while a requiredStackSize mission still needs more parcels — used to
     *  relax the value-based multi-pickup gates (a mandated stack must be filled
     *  even when the marginal parcel isn't "worth it" by the decay model). */
    mustStack(carrying) {
        return missionConstraints.requiredStackSize != null
            && carrying.length < missionConstraints.requiredStackSize;
    }

    /** True when a maxBundleValue mission forbids carrying a second parcel
     *  (multi-pickup could push the bundle total over the threshold). */
    singleParcelBundles() {
        return missionConstraints.maxBundleValue != null;
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
     * Travel cost in tiles between two points, crate-aware.
     *
     * First tries a crate-free A* path (what navigateTo can actually walk).
     * If crates block all routes, falls back to a push-aware A*
     * (pushAwareCost): entering a crate tile is allowed only via a legal push
     * (destination must be a free crate-zone tile, matching the PDDL model)
     * and costs 3 instead of 1. Push legality is direction-specific, so a
     * crate approachable from the wrong side doesn't poison routes that circle
     * around and push it from the right one. Returns Infinity when no
     * push-feasible route exists — targets behind a dead-end push are never
     * selected as nearest.
     */
    pathLen(from, to) {
        const avoid = missionConstraints.avoidTiles.size > 0 ? missionConstraints.avoidTiles : null;

        if (crateTiles.length === 0) {
            const route = findRoute(from, to, avoid);
            return route ? route.length : Infinity;
        }

        const crateSet = new Set(crateTiles.map(c => `${Math.round(c.x)}_${Math.round(c.y)}`));
        const crateBlocked = avoid ? new Set([...crateSet, ...avoid]) : crateSet;

        // Crate-free path: accurate — what A* navigation can actually walk.
        const freePath = findRoute(from, to, crateBlocked);
        if (freePath) return freePath.length;

        // All routes blocked by crates — target needs PDDL. Push-aware cost.
        const cost = pushAwareCost(from, to, crateSet, avoid);
        pathlenLog(`(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)}) push-aware cost=${cost}`);
        return cost;
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
        const R    = carried.reduce((sum, p) => sum + p.reward, 0);
        const best = this._bestDelivery(me, R, n);
        const d0   = best ? best.len : Infinity;
        const mult = best ? this.deliveryMultiplierAt(best.d) : 1;
        return R * mult - n * this.decayRate() * d0;
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
        const n     = carried.length;
        const R     = carried.reduce((sum, p) => sum + p.reward, 0);
        const loadR = R + parcel.reward;
        const d1    = this.pathLen(me, parcel);
        const best  = this._bestDelivery(parcel, loadR, n + 1);
        const d2    = best ? best.len : Infinity;
        const mult  = best ? this.deliveryMultiplierAt(best.d) : 1;
        return loadR * mult - (n + 1) * this.decayRate() * (d1 + d2);
    }

    /**
     * Value of the bank-first alternative: deliver the current load immediately
     * at the nearest delivery D, then pick up `parcel` as a solo trip.
     *   A_first = (R − n·ρ·d0) + max(0, reward_p − ρ·(d0 + d3 + d4))
     * d0 = A* dist(me → D)              [same as bankNow denominator]
     * d3 = A* dist(D → parcel)          [extra call: cost of reaching parcel from D]
     * d4 = A* dist(parcel → D')         [same as d2 in pickupValue]
     *
     * Multi-pickup is only justified when pickupValue(p) > bankFirstValue(p).
     * Returns -Infinity when not carrying (comparison collapses to pickupValue > -Inf
     * which is always true, but worthwhileInRange is only used when carrying > 0).
     */
    bankFirstValue(parcel) {
        const carried = parcels.carriedBy(me.id);
        if (carried.length === 0) return -Infinity;
        const n    = carried.length;
        const R    = carried.reduce((s, p) => s + p.reward, 0);
        const best1 = this._bestDelivery(me, R, n);          // bank the current load
        if (!best1) return -Infinity;
        const d0    = best1.len;
        const mult1 = this.deliveryMultiplierAt(best1.d);
        const d3    = this.pathLen(best1.d, parcel);         // from that delivery to the parcel
        const best2 = this._bestDelivery(parcel, parcel.reward, 1); // solo-deliver the new parcel
        const d4    = best2 ? best2.len : Infinity;
        const mult2 = best2 ? this.deliveryMultiplierAt(best2.d) : 1;
        const bankNow    = R * mult1 - n * this.decayRate() * d0;
        const valueAfter = parcel.reward * mult2 - this.decayRate() * (d0 + d3 + d4);
        return bankNow + Math.max(0, valueAfter);
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

            // A go_deliver that was already in flight when a requiredStackSize
            // mission arrived must NOT run to completion with a short stack:
            // fall through and pick an explore target that replaces it.
            const prematureDelivery = intent === 'go_deliver'
                && this.mustStack(parcels.carriedBy(me.id));

            if ((intent === 'go_pick_up' || intent === 'go_deliver') && !prematureDelivery) {
                // Productive work started — reset explore history so the next
                // exploration cycle has no stale exclusions.
                this._lastExploreKey = null;
                this._prevExploreKey = null;
                return null;
            }

            if (intent === 'go_explore' && distance(me, { x: tx, y: ty }) >= OBSERVATION_DISTANCE) {
                return null;
            }
        }

        const needMoreParcels = missionConstraints.requiredStackSize != null
            && parcels.carriedBy(me.id).length < missionConstraints.requiredStackSize;

        // Only consider tiles the agent can actually A*-reach (walls/crates/agents
        // respected). Unreachable spawners are never targeted — that caused the
        // repeated re-selection of an out-of-reach tile and the back-and-forth.
        const rawPool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        // Apply spawner zone constraint: if active, restrict exploration targets to
        // the allowed set (e.g. left-half spawners only). Fall back to the full pool
        // if none of the allowed tiles happen to be reachable.
        const zonedPool = (missionConstraints.allowedSpawnerTiles?.size > 0 && spawnerTiles.length > 0)
            ? spawnerTiles.filter(t => missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`))
            : rawPool;
        const pool      = zonedPool.length > 0 ? zonedPool : rawPool;
        const reachable = pool.filter(t => this.isReachable(t));
        if (reachable.length === 0) return null; // nothing reachable → stay idle

        // Prefer tiles in the sustainable-loop region (don't explore into a one-way
        // trap); fall back to all reachable only if none are safe (all-traps map).
        const safe   = reachable.filter(t => this.inSafe(t));
        const usable = safe.length > 0 ? safe : reachable;

        // Prefer reachable tiles outside current sensing (new ground), else any
        // reachable tile; pick the nearest by real A* path length.
        const outOfRange = usable.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const pool2      = outOfRange.length > 0 ? outOfRange : usable;

        // When accumulating a stack: exclude the tile we're already on so we don't
        // re-select the same spawner and stall in place.
        const hereKey    = `${Math.round(me.x)}_${Math.round(me.y)}`;
        const candidates = needMoreParcels
            ? pool2.filter(t => `${t.x}_${t.y}` !== hereKey)
            : pool2;
        const baseCandidates = candidates.length > 0 ? candidates : pool2;

        // Hard-exclude the spawner committed to just before the current one
        // (_prevExploreKey) to break A→B→A ping-pong. The exclusion is skipped
        // when every alternative would require travelling more than
        // EXPLORE_NEARBY_MARGIN extra tiles — avoids sending the agent across
        // the whole map just to avoid a nearby tile.
        let finalCandidates = baseCandidates;
        if (this._prevExploreKey) {
            const without = baseCandidates.filter(t => `${t.x}_${t.y}` !== this._prevExploreKey);
            if (without.length === 0) {
                exploreLog(`prev=${this._prevExploreKey} is only option — forced revisit`);
            } else {
                const prevTile    = baseCandidates.find(t => `${t.x}_${t.y}` === this._prevExploreKey);
                const prevLen     = prevTile ? this.pathLen(me, prevTile) : Infinity;
                const nearestAlt  = Math.min(...without.map(t => this.pathLen(me, t)));
                if (nearestAlt <= prevLen + EXPLORE_NEARBY_MARGIN) {
                    finalCandidates = without;
                } else {
                    exploreLog(`skip-exclude ${this._prevExploreKey}: nearest alt ${nearestAlt} vs ${prevLen} (+${nearestAlt - prevLen} > margin ${EXPLORE_NEARBY_MARGIN})`);
                }
            }
        }

        const sorted = [...finalCandidates].sort((a, b) => this.pathLen(me, a) - this.pathLen(me, b));
        const target = sorted[0];
        if (target) {
            const key = `${target.x}_${target.y}`;
            const shortestLen = this.pathLen(me, target);
            const tied = sorted.filter(t => this.pathLen(me, t) === shortestLen);
            if (tied.length > 1) {
                const tiedStr = tied.map(t => `(${t.x},${t.y})`).join(', ');
                exploreLog(`tie: ${tied.length} at pathLen=${shortestLen} — ${tiedStr} — picking (${target.x},${target.y}), prev-excluded=${this._prevExploreKey ?? 'none'}`);
            }
            exploreLog(`→ spawner (${target.x},${target.y}) pathLen:${shortestLen} prev=${this._prevExploreKey ?? 'none'} last=${this._lastExploreKey ?? 'none'}`);
            // Slide window: current becomes previous, new target becomes current.
            this._prevExploreKey = this._lastExploreKey;
            this._lastExploreKey = key;
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
