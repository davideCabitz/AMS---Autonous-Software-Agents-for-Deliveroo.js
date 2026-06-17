import {
    me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles, crateTiles,
    OBSERVATION_DISTANCE, moveTiming, CARRYING_CAPACITY,
    usableDeliverySet, safeTargetSet, missionConstraints,
    otherAgentDistTo, nearestAgentId, isAgentMovingToward,
} from '../context.js';
import { distance } from '../utils/distance.js';
import { findRoute, pushAwareCost, reachableIgnoringAgents } from '../utils/astar.js';
import { createLogger } from '../utils/logger.js';

const exploreLog  = createLogger('explore');
const deliveryLog = createLogger('delivery');
const pathlenLog  = createLogger('pathlen');
const contestLog  = createLogger('contest');

export const MIN_DELIVERY_REWARD = 5;
// Max extra tiles tolerated for an alternative to the excluded spawner; beyond
// (prevLen + margin) the exclusion is skipped so the agent doesn't cross the map.
const EXPLORE_NEARBY_MARGIN = 4;
// Gate for a second parcel while carrying: trigger whenever multi-pickup beats
// bank-first. Lower than MIN_DELIVERY_REWARD because this compares two delivery
// trips, not pickup vs. nothing.
export const MULTI_PICKUP_MIN = 0;
// A different pickup must beat the CURRENT target by this much to abandon the trip.
// Without it, parcels crossing in/out of the worthwhile set each tick make the agent
// flip between pick-up and deliver (physical back-and-forth).
export const SWITCH_MARGIN = 5;

// ─── competitor-awareness (Phase 1) ──────────────────────────────────────────
// contestFactor discounts a parcel's value by an estimated win-probability vs. the
// nearest competitor. Probabilistic, never a hard exclude (a misread self-corrects).
//   delta = theirDist − ourDist  (positive ⇒ we're closer)
// CONTEST_K        — lead in tiles deciding win-probability (≥+K ⇒ 1, ≤−K ⇒ floor).
// CONTEST_FLOOR    — min multiplier; a contested parcel is deprioritized, never < 0.
// CONTEST_DEADBAND — |delta| within this is a tie, so 1-tile jitter can't swing it.
const CONTEST_K        = 3;
const CONTEST_FLOOR    = 0.15;
const CONTEST_DEADBAND = 1;
// Case 6: additive penalty for an explore/wait spawner with a sensed agent on/next
// to it, so we don't camp a competitor's spawner. Additive (still chosen if it's the
// only reachable one); sized like EXPLORE_NEARBY_MARGIN.
const SPAWNER_CAMP_PENALTY = EXPLORE_NEARBY_MARGIN;

// ─── remembered-parcel pursuit cap ────────────────────────────────────────────
// Abandon a remembered parcel beyond this many A* tiles from CURRENT position. This
// absolute cap is load-bearing on low/no-decay maps, where decayRate≈0 makes a far
// parcel look as good as a near one.
const MAX_REMEMBERED_DETOUR_TILES   = 20;
const REMEMBERED_MAX_DECAY_FRACTION = 0.5;  // also abandon if decay would eat >50% of reward

/**
 * @class Strategy
 * Base class for parcel-delivery strategies (pure decision-makers).
 */
export class Strategy {
    /** @type {string|null} Key "x_y" of current go_explore target */
    _lastExploreKey = null;

    /** @type {string|null} Key "x_y" of previous go_explore target (ping-pong prevention) */
    _prevExploreKey = null;

    /** @type {Set<string>|null} Spawner keys to exclude from next exploration (idle group patrol) */
    _idleExcludeKeys = null;

    /** @type {number} Ms between re-deliberation ticks (0 = event-driven only) */
    tickIntervalMs = 0;

    /**
     * Decide the next intention to push given the current one
     * @param {Array|null} _currentIntent - Current intention predicate (e.g. ['go_deliver', x, y])
     * @returns {Array|null} Predicate to push, or null to keep the current intention
     */
    decide(_currentIntent) { return null; }

    // ─── shared helpers ──────────────────────────────────────────────────────

    /**
     * Delivery tiles under the allowedDeliveryTiles constraint (full pool if the
     * filter would empty it, or no such mission)
     * @param {Array<{x: number, y: number}>} tiles - Pool to filter (default: all delivery tiles)
     * @returns {Array<{x: number, y: number}>} Allowed delivery tiles
     */
    _allowedDeliveryPool(tiles = deliveryTiles) {
        let pool = tiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = pool.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) pool = f;
        }
        // deliver_reward missions: drop tiles whose accumulated signed delivery net is
        // negative (not worth delivering at). Fall back to the unfiltered pool if every
        // candidate is net-negative so the agent is never stranded with a full load.
        const net = missionConstraints.deliveryTileNet;
        if (net?.size > 0) {
            const f = pool.filter(t => (net.get(`${t.x}_${t.y}`) ?? 0) >= 0);
            if (f.length > 0) pool = f;
        }
        return pool;
    }

    /**
     * Spawner tiles under the allowedSpawnerTiles constraint (same fall-back-if-empty
     * semantics as _allowedDeliveryPool)
     * @param {Array<{x: number, y: number}>} tiles - Pool to filter (default: all spawner tiles)
     * @returns {Array<{x: number, y: number}>} Allowed spawner tiles
     */
    _allowedSpawnerPool(tiles = spawnerTiles) {
        if (missionConstraints.allowedSpawnerTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) return f;
        }
        return tiles;
    }

    /**
     * Delivery reward multiplier at a tile (from mission config)
     * @param {{x: number, y: number}} tile - Tile position
     * @returns {number} Multiplier (1 = no scaling)
     */
    deliveryScale(tile) {
        return missionConstraints.deliveryMultipliers
            ?.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

    /**
     * Nearest A*-reachable delivery tile
     * @param {{x: number, y: number}} from - Start (default: agent position)
     * @returns {{x: number, y: number}|undefined} Nearest reachable delivery, or undefined
     */
    nearestDelivery(from = me) {
        const tiles = this._allowedDeliveryPool();
        return [...tiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            // Higher multiplier, then nearer. No multiplier mission ⇒ pure nearest.
            .sort((a, b) => (this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len))[0]?.d;
    }

    /**
     * Whether a tile is in the sustainable pickup→deliver region (trap-avoidance)
     * @param {{x: number, y: number}} tile - Tile to check
     * @returns {boolean}
     */
    inSafe(tile) {
        return safeTargetSet.has(`${Math.round(tile.x)}_${Math.round(tile.y)}`);
    }

    /**
     * Effective cost of delivering at a tile (path + congestion penalty)
     * @param {{x: number, y: number}} from - Start position
     * @param {{x: number, y: number}} d - Delivery tile
     * @returns {number} Cost in tiles (path + nearby-agent penalty)
     */
    deliveryCost(from, d) {
        const base = this.pathLen(from, d);
        if (!Number.isFinite(base)) return base;
        const near = otherAgentDistTo(d);
        const pen  = Number.isFinite(near) && near <= 1 ? SWITCH_MARGIN : 0;
        return base + pen;
    }

    /**
     * Nearest delivery in the sustainable loop, with trap-avoidance
     * @param {{x: number, y: number}} from - Start (default: agent position)
     * @returns {{x: number, y: number}|undefined} Delivery tile, or undefined if all unreachable
     */
    nearestEscapableDelivery(from = me) {
        let tiles = this._allowedDeliveryPool();
        const reachable = [...tiles]
            .map(d => ({ d, len: this.deliveryCost(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            // Multiplier-priority then nearest; a 0× tile sorts last (fallback only).
            .sort((a, b) => (this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len));
        if (crateTiles.length > 0)
            deliveryLog(`candidates from (${Math.round(from.x)},${Math.round(from.y)}): `
                + reachable.map(({ d, len }) => `(${d.x},${d.y})=${len}${usableDeliverySet.has(`${d.x}_${d.y}`) ? '' : '·unusable'}`).join(' '));
        if (reachable.length === 0) return undefined;
        const usable = reachable.filter(({ d }) => usableDeliverySet.has(`${d.x}_${d.y}`));
        if (usable.length > 0) return this._pickDelivery(usable).d; // safe zone reachable now

        // No safe zone reachable — every reachable zone is a trap. Distinguish WHY:
        // structurally one-way (must use the trap) vs. a competitor blocking the
        // corridor (transient → WAIT). findRoute treats agents as walls;
        // reachableIgnoringAgents asks the static question. If a usable zone is
        // structurally reachable but blocked now, hold the load (return undefined) and
        // retry. Only fall back to the trap when NO usable zone exists at all.
        const tiles2 = this._allowedDeliveryPool();
        const safeBlocked = tiles2.some(d =>
            usableDeliverySet.has(`${d.x}_${d.y}`) && reachableIgnoringAgents(from, d));
        if (safeBlocked) {
            deliveryLog(`safe delivery exists but is agent-blocked — holding, NOT entering a trap`);
            return undefined;
        }
        return this._pickDelivery(reachable).d;   // genuinely all-traps → last resort
    }

    // ─── deliveryMultipliers (Level-2 bonus-tile missions) ───────────────────
    // "Deliver in (x,y) for 5× pts" makes some tiles worth more. The multiplier both
    // ROUTES deliveries to the bonus tile and VALUES the carried load higher when one
    // is reachable. No mission ⇒ every tile is ×1 ⇒ historical nearest-tile behaviour.

    /**
     * Delivery multiplier at a tile
     * @param {{x: number, y: number}} tile - Tile position
     * @returns {number} Multiplier (1 = no mission scaling)
     */
    deliveryMultiplierAt(tile) {
        const m = missionConstraints.deliveryMultipliers;
        if (!(m?.size > 0)) return 1;
        return m.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

    /**
     * Best delivery tile for load R over n parcels (multiplier-aware)
     * @param {{x: number, y: number}} from - Start position
     * @param {number} R - Total load reward
     * @param {number} n - Parcels in load
     * @returns {{d: {x: number, y: number}, len: number}|undefined} Best delivery and path cost
     */
    _bestDelivery(from, R, n) {
        const tiles = this._allowedDeliveryPool();
        const reachable = [...tiles]
            .map(d => ({ d, len: this.pathLen(from, d) }))
            .filter(({ len }) => Number.isFinite(len));
        if (reachable.length === 0) return undefined;
        if (!(missionConstraints.deliveryMultipliers?.size > 0))
            return reachable.sort((a, b) => a.len - b.len)[0];
        const rho = this.decayRate();
        return reachable
            .map(o => ({ ...o, v: R * this.deliveryMultiplierAt(o.d) - n * rho * o.len }))
            .sort((a, b) => (b.v - a.v) || (a.len - b.len))[0]; // ties → nearer tile
    }

    /**
     * Best delivery from a reachable pool (multiplier- and load-value-aware)
     * @param {Array<{d: {x: number, y: number}, len: number}>} pool - Reachable deliveries
     * @returns {{d: {x: number, y: number}, len: number}}
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

    /**
     * Whether to keep the current delivery target.
     *
     * BINARY COMMITMENT: once committed to a delivery zone, keep heading there while
     * it stays REACHABLE — recompute only when fully walled off, never on a cost
     * margin. A comparative deliveryCost(cur) vs deliveryCost(alt) test on SWITCH_MARGIN
     * is unstable (both costs vary with sub-tile position and sensed competitors each
     * tick), so it flips sign and the agent shuffles without delivering. isReachable is
     * stable. See MULTI_AGENT_AWARENESS.md (Case 2 doorway-rerouting dropped on purpose).
     *
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {boolean} True to keep the current delivery target
     */
    betterDelivery(currentIntent) {
        if (currentIntent?.[0] !== 'go_deliver') return false;
        return this.isReachable({ x: currentIntent[1], y: currentIntent[2] });
    }

    /**
     * Simple reward-per-distance score (StrategySimple only)
     * @param {Object} parcel - Parcel object
     * @returns {number} Score
     */
    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /**
     * Whether the agent is at carrying capacity
     * @returns {boolean}
     */
    atCapacity() {
        return parcels.carriedBy(me.id).length >= CARRYING_CAPACITY;
    }

    // ─── mission-constraint gates (Level-2 persistent missions) ──────────────
    // Shared here so EVERY strategy enforces them (previously only Greedy/Blind
    // filtered maxParcelReward, only Greedy gated requiredStackSize).

    /**
     * Whether mission constraints allow picking up this parcel
     * @param {Object} parcel - Parcel to check
     * @returns {boolean}
     */
    missionPickupOk(parcel) {
        if (missionConstraints.maxParcelReward != null
            && parcel.reward > missionConstraints.maxParcelReward) return false;
        if (missionConstraints.maxBundleValue != null
            && parcel.reward > missionConstraints.maxBundleValue) return false;
        // "= T": never exceed T. Reject a parcel that overshoots alone or pushes the
        // carried bundle past T.
        if (missionConstraints.exactBundleValue != null) {
            const carriedTotal = parcels.carriedBy(me.id).reduce((s, p) => s + p.reward, 0);
            if (carriedTotal + parcel.reward > missionConstraints.exactBundleValue) return false;
        }
        return true;
    }

    /**
     * Whether a parcel count is forbidden for delivery
     * @param {number} n - Parcels in stack
     * @returns {boolean}
     */
    stackForbidden(n) {
        if (!(missionConstraints.forbiddenStackSizes?.size > 0)) return false;
        if (n >= CARRYING_CAPACITY) return false;        // can't grow the stack to escape
        return missionConstraints.forbiddenStackSizes.has(n);
    }

    /**
     * Whether the stack is ready to deliver (passes mission gates)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    stackReady(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        if (missionConstraints.exactBundleValue != null) {
            // "= T": deliver only when the bundle is worth EXACTLY T.
            const total = carrying.reduce((s, p) => s + p.reward, 0);
            return total === missionConstraints.exactBundleValue;
        }
        if (missionConstraints.maxBundleValue != null) return carrying.length >= 1;
        if (missionConstraints.minBundleValue != null) {
            const total = carrying.reduce((s, p) => s + p.reward, 0);
            if (total < missionConstraints.minBundleValue) return false;
        }
        if (missionConstraints.requiredStackSize != null)
            return carrying.length >= missionConstraints.requiredStackSize;
        return true;
    }

    /**
     * Whether the agent must keep picking up (not yet full for the mission)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    mustStack(carrying) {
        if (this.stackForbidden(carrying.length)) return true;
        if (missionConstraints.exactBundleValue != null) {
            // "= T": keep adding until the bundle is worth exactly T.
            const total = carrying.reduce((s, p) => s + p.reward, 0);
            if (total < missionConstraints.exactBundleValue) return true;
        }
        if (missionConstraints.minBundleValue != null) {
            const total = carrying.reduce((s, p) => s + p.reward, 0);
            if (total < missionConstraints.minBundleValue) return true;
        }
        return missionConstraints.requiredStackSize != null
            && carrying.length < missionConstraints.requiredStackSize;
    }

    /**
     * Whether the stack has hit the mission cap (must deliver now)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    stackFull(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        return missionConstraints.maxStackSize != null
            && carrying.length >= missionConstraints.maxStackSize;
    }

    /**
     * Whether a mission forces single-parcel deliveries
     * @returns {boolean}
     */
    singleParcelBundles() {
        return missionConstraints.maxBundleValue != null
            || missionConstraints.maxStackSize === 1;
    }

    /**
     * Parcel decay rate (reward lost per tile travelled)
     * @returns {number} Decay per tile (from measured movement timing)
     */
    decayRate() {
        return moveTiming.decayPerTile();
    }

    /**
     * A*-path cost, accounting for crate pushing
     * @param {{x: number, y: number}} from - Start position
     * @param {{x: number, y: number}} to - Goal position
     * @returns {number} Path cost in tiles (Infinity if unreachable)
     */
    pathLen(from, to) {
        const avoid = missionConstraints.avoidTiles.size > 0 ? missionConstraints.avoidTiles : null;

        if (crateTiles.length === 0) {
            const route = findRoute(from, to, avoid);
            return route ? route.length : Infinity;
        }

        const crateSet = new Set(crateTiles.map(c => `${Math.round(c.x)}_${Math.round(c.y)}`));
        const crateBlocked = avoid ? new Set([...crateSet, ...avoid]) : crateSet;

        // Crate-free path: what A* navigation can actually walk.
        const freePath = findRoute(from, to, crateBlocked);
        if (freePath) return freePath.length;

        // All routes crate-blocked — target needs PDDL. Push-aware cost.
        const cost = pushAwareCost(from, to, crateSet, avoid);
        pathlenLog(`(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)}) push-aware cost=${cost}`);
        return cost;
    }

    /**
     * Whether a position is currently A*-reachable
     * @param {{x: number, y: number}} to - Position to check
     * @returns {boolean}
     */
    isReachable(to) {
        return Number.isFinite(this.pathLen(me, to));
    }

    /**
     * Whether to keep the current pickup target
     * @param {Array|null} currentIntent - Current intention predicate
     * @param {{p: Object, value: number}|undefined} candidate - Best new pickup option
     * @returns {boolean}
     */
    shouldKeepCurrentPickup(currentIntent, candidate) {
        if (!currentIntent || currentIntent[0] !== 'go_pick_up') return false;
        const curId = currentIntent[3];
        const cur   = parcels.get(curId);
        // Drop if the parcel is gone, taken, or unreachable.
        if (!cur || cur.carriedBy || !this.isReachable(cur)) return false;
        // No alternative, or candidate IS the current target → keep going.
        if (!candidate || candidate.p.id === curId) return true;
        // Keep unless the candidate beats the current value by the margin.
        return candidate.value - this.pickupValue(cur) < SWITCH_MARGIN;
    }

    /**
     * Value of delivering the current load immediately
     * @returns {number} Value in reward units (0 when carrying nothing)
     */
    bankNowValue() {
        const carried = parcels.carriedBy(me.id);
        const n = carried.length;
        if (n === 0) return 0;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const del = this.nearestDelivery(me);
        const d0  = del ? this.pathLen(me, del) : Infinity;
        // Scale by the chosen tile's multiplier (1× by default).
        const scale = del ? this.deliveryScale(del) : 1;
        return scale * R - n * this.decayRate() * d0;
    }

    /**
     * Net value of detouring to collect a one-shot bonus
     * @returns {number|null} Value in reward units, or null if no bonus/unreachable
     */
    bonusGoalValue() {
        const b = missionConstraints.oneShotBonus;
        if (!b) return null;
        const d = this.pathLen(me, { x: b.x, y: b.y });
        if (!Number.isFinite(d)) return null;
        const n = parcels.carriedBy(me.id).length;
        return b.points - n * this.decayRate() * d;
    }

    /**
     * Whether to divert to the one-shot bonus goal
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_to', x, y] to divert, or null to continue
     */
    bonusDiversion(currentIntent) {
        const b = missionConstraints.oneShotBonus;
        if (!b) return null;
        // Already there — arrival earns it; don't re-issue go_to and stall.
        if (Math.round(me.x) === b.x && Math.round(me.y) === b.y) return null;
        const net = this.bonusGoalValue();
        if (net == null) return null;                 // unreachable → ignore
        // Compare against banking the current load now (0 when empty-handed): a
        // margin-beating net means the bonus beats continuing the parcel loop.
        const baseline = this.bankNowValue();
        if (net - baseline <= SWITCH_MARGIN) return null;
        // Hysteresis: already heading to the bonus tile → keep going.
        if (currentIntent?.[0] === 'go_to'
            && currentIntent[1] === b.x && currentIntent[2] === b.y) return null;
        return ['go_to', b.x, b.y];
    }

    /**
     * Value multiplier discounting a parcel by competition intensity
     * @param {Object} parcel - Parcel to evaluate
     * @param {number} ourDist - Our pre-computed distance to the parcel
     * @returns {number} Multiplier in [CONTEST_FLOOR, 1]
     */
    contestFactor(parcel, ourDist) {
        const their = otherAgentDistTo(parcel);
        if (!Number.isFinite(their)) return 1;                 // no contender
        const our = Number.isFinite(ourDist) ? ourDist : this.pathLen(me, parcel);
        let delta = their - our;                               // >0 ⇒ we're closer
        // Deadband: small leads are ties so 1-tile jitter doesn't move score.
        if (Math.abs(delta) <= CONTEST_DEADBAND) delta = 0;
        // Softener: if the nearest agent isn't closing on the parcel, it's probably
        // not racing — soften its penalty.
        const id = nearestAgentId(parcel);
        if (id && !isAgentMovingToward(id, parcel)) delta += CONTEST_K / 2;
        // Discount ONLY when losing (delta < 0); closer or tied ⇒ factor 1 (so a parcel
        // we're standing on keeps full value). Ramps in as the competitor pulls ahead:
        //   delta ≥ 0 → 1 ;  delta = −K → floor ;  linear between.
        let factor = 1;
        if (delta < 0) {
            const t = Math.max(0, 1 + delta / CONTEST_K);     // delta∈[−K,0] → [0,1]
            factor = CONTEST_FLOOR + (1 - CONTEST_FLOOR) * t;  // [floor, 1)
        }
        // Logs only when a competitor is in contention, so the common case stays silent.
        contestLog(`parcel ${parcel.id} @${parcel.x},${parcel.y}: theirDist=${their} `
            + `ourDist=${our} delta=${delta}${id && !isAgentMovingToward(id, parcel) ? ' (not-racing)' : ''} `
            + `factor=${factor.toFixed(3)}`);
        return factor;
    }

    /**
     * Value of detouring to pick up and deliver a parcel (competition + decay aware)
     * @param {Object} parcel - Parcel to evaluate
     * @returns {number} Value in reward units
     */
    pickupValue(parcel) {
        const carried = parcels.carriedBy(me.id);
        const n   = carried.length;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const d1  = this.pathLen(me, parcel);
        const del = this.nearestDelivery(parcel);
        const d2  = del ? this.pathLen(parcel, del) : Infinity;
        // Whole load delivered at `del`, so scale by its multiplier (1× by default).
        const scale = del ? this.deliveryScale(del) : 1;
        return scale * (R + parcel.reward) * this.contestFactor(parcel, d1)
               - (n + 1) * this.decayRate() * (d1 + d2);
    }

    /**
     * Whether a remembered (out-of-range) parcel is worth pursuing
     * @param {Object} p - Remembered parcel (pre-decayed reward)
     * @returns {boolean}
     */
    rememberedWorthPursuing(p) {
        const d = this.pathLen(me, p);                       // A* from current position
        if (!Number.isFinite(d)) return false;               // unreachable
        if (d > MAX_REMEMBERED_DETOUR_TILES) return false;   // too far — drop it
        const rho = this.decayRate();
        if (rho > 0 && rho * d > REMEMBERED_MAX_DECAY_FRACTION * p.reward) return false;
        return true;
    }

    /**
     * Value of delivering first, then picking up the parcel solo
     * @param {Object} parcel - Parcel to evaluate
     * @returns {number} Value in reward units (-Infinity when not carrying)
     */
    bankFirstValue(parcel) {
        const carried = parcels.carriedBy(me.id);
        if (carried.length === 0) return -Infinity;
        const del = this.nearestDelivery();
        if (!del) return -Infinity;
        const d0   = this.pathLen(me, del);
        const d3   = this.pathLen(del, parcel);
        const del2 = this.nearestDelivery(parcel);
        const d4   = del2 ? this.pathLen(parcel, del2) : Infinity;
        const n    = carried.length;
        const R    = carried.reduce((s, p) => s + p.reward, 0);
        // Each leg scaled by its tile's multiplier: current load at `del`, new at `del2`.
        const scale0 = this.deliveryScale(del);
        const scale2 = del2 ? this.deliveryScale(del2) : 1;
        const bankNow    = scale0 * R - n * this.decayRate() * d0;
        const valueAfter = scale2 * parcel.reward - this.decayRate() * (d0 + d3 + d4);
        return bankNow + Math.max(0, valueAfter);
    }

    /**
     * Net gain of picking up vs. delivering now
     * @param {Object} parcel - Parcel to evaluate
     * @returns {number} Gain value
     */
    pickupGain(parcel) {
        return this.pickupValue(parcel) - this.bankNowValue();
    }

    /**
     * Debug string of a parcel's score breakdown
     * @param {Object} parcel - Parcel to debug
     * @returns {string} Human-readable breakdown
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
     * Ranking cost for an exploration target (path + camping penalty)
     * @param {{x: number, y: number}} t - Target tile
     * @returns {number} Cost in tiles
     */
    exploreCost(t) {
        const base = this.pathLen(me, t);
        if (!Number.isFinite(base)) return base;
        const near = otherAgentDistTo(t);
        return base + (Number.isFinite(near) && near <= 1 ? SPAWNER_CAMP_PENALTY : 0);
    }

    /**
     * Exploration target when idle (no worthwhile parcel work)
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to stay idle
     */
    exploreIfIdle(currentIntent) {
        if (currentIntent) {
            const [intent, tx, ty] = currentIntent;

            // A go_deliver in flight when a requiredStackSize mission arrives must NOT
            // complete with a short stack — fall through and replace it with an explore.
            const prematureDelivery = intent === 'go_deliver'
                && this.mustStack(parcels.carriedBy(me.id));

            if ((intent === 'go_pick_up' || intent === 'go_deliver') && !prematureDelivery) {
                // Productive work started — reset explore history (no stale exclusions).
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

        // Only A*-reachable tiles — targeting unreachable spawners caused repeated
        // re-selection and back-and-forth.
        const rawPool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        // Spawner zone constraint: restrict to the allowed set if active, falling
        // back to the full pool if none are reachable.
        const zonedPool = (missionConstraints.allowedSpawnerTiles?.size > 0 && spawnerTiles.length > 0)
            ? spawnerTiles.filter(t => missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`))
            : rawPool;
        const pool      = zonedPool.length > 0 ? zonedPool : rawPool;
        const reachableAll = pool.filter(t => this.isReachable(t));
        if (reachableAll.length === 0) return null; // nothing reachable → stay idle

        // Idle group-patrol may ask us to leave the group just patrolled: drop its
        // tiles so the next target is OUTSIDE it (full set if that empties it).
        const excluded  = this._idleExcludeKeys;
        const reachable = excluded
            ? (reachableAll.filter(t => !excluded.has(`${t.x}_${t.y}`)).length > 0
                ? reachableAll.filter(t => !excluded.has(`${t.x}_${t.y}`))
                : reachableAll)
            : reachableAll;

        // Prefer the sustainable-loop region (don't explore into a one-way trap);
        // fall back to all reachable only on an all-traps map.
        const safe   = reachable.filter(t => this.inSafe(t));
        const usable = safe.length > 0 ? safe : reachable;

        // Prefer tiles outside current sensing (new ground), else any; nearest by A*.
        const outOfRange = usable.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const pool2      = outOfRange.length > 0 ? outOfRange : usable;

        // When accumulating a stack, exclude our own tile so we don't re-select the
        // same spawner and stall.
        const hereKey    = `${Math.round(me.x)}_${Math.round(me.y)}`;
        const candidates = needMoreParcels
            ? pool2.filter(t => `${t.x}_${t.y}` !== hereKey)
            : pool2;
        const baseCandidates = candidates.length > 0 ? candidates : pool2;

        // Hard-exclude the spawner committed to just before the current one
        // (_prevExploreKey) to break A→B→A ping-pong. Skipped when every alternative
        // is > EXPLORE_NEARBY_MARGIN extra tiles away (don't cross the map to avoid one).
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

        // Rank by exploreCost (pathLen + Case-6 camping penalty) so a competitor-camped
        // spawner loses a near-tie to a clear one.
        const sorted = [...finalCandidates].sort((a, b) => this.exploreCost(a) - this.exploreCost(b));
        const target = sorted[0];
        if (target) {
            const key = `${target.x}_${target.y}`;
            const shortestLen = this.exploreCost(target);
            const tied = sorted.filter(t => this.exploreCost(t) === shortestLen);
            if (tied.length > 1) {
                const tiedStr = tied.map(t => `(${t.x},${t.y})`).join(', ');
                exploreLog(`tie: ${tied.length} at pathLen=${shortestLen} — ${tiedStr} — picking (${target.x},${target.y}), prev-excluded=${this._prevExploreKey ?? 'none'}`);
            }
            exploreLog(`→ spawner (${target.x},${target.y}) pathLen:${shortestLen} prev=${this._prevExploreKey ?? 'none'} last=${this._lastExploreKey ?? 'none'}`);
            // Slide window: current → previous, new target → current.
            this._prevExploreKey = this._lastExploreKey;
            this._lastExploreKey = key;
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
