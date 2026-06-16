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

// ─── competitor-awareness (Phase 1) ──────────────────────────────────────────
// contestFactor discounts a parcel's value by an estimated win-probability vs.
// the nearest competitor racing us to it. Probabilistic, never a hard exclude: a
// misread competitor self-corrects next tick.
//   delta = theirDist − ourDist  (positive ⇒ we're closer)
// CONTEST_K     — tiles of lead that decide the win-probability (delta ≥ +K ⇒ 1,
//                 delta ≤ −K ⇒ floor, delta = 0 ⇒ ~0.5).
// CONTEST_FLOOR — minimum multiplier; a contested parcel is DEPRIORITIZED, never
//                 inverted (keeps value ≥ 0 so it can't fight MIN_DELIVERY_REWARD /
//                 bankFirst gates illogically).
// CONTEST_DEADBAND — |delta| within this counts as a clean tie, so 1-tile
//                 competitor jitter can't swing the score and re-introduce the
//                 flip-flop that SWITCH_MARGIN exists to prevent.
const CONTEST_K        = 3;
const CONTEST_FLOOR    = 0.15;
const CONTEST_DEADBAND = 1;
// Case 6: additive path-length penalty for an explore/wait spawner that already has
// a sensed agent on/adjacent to it, so we don't camp a spawner a competitor owns.
// Additive (not a filter) — a camped spawner is still chosen if it's the only
// reachable one. Sized like EXPLORE_NEARBY_MARGIN: enough to lose a near-tie, not
// enough to send us across the map.
const SPAWNER_CAMP_PENALTY = EXPLORE_NEARBY_MARGIN;

// ─── remembered-parcel pursuit cap ────────────────────────────────────────────
// A remembered (out-of-sensing) parcel is abandoned once it is more than this many
// A* tiles from the agent's CURRENT position: chasing it back across the map (e.g.
// a forced directional-tile loop) costs more than it's worth. The absolute tile cap
// is the load-bearing gate on low/no-decay maps, where decayRate≈0 makes pickupValue's
// distance term vanish and a far parcel looks as good as a near one.
const MAX_REMEMBERED_DETOUR_TILES   = 20;
const REMEMBERED_MAX_DECAY_FRACTION = 0.5;  // also abandon if decay would eat >50% of its reward

/**
 * @class Strategy
 * Base class for parcel delivery strategies (pure decision-makers)
 */
export class Strategy {
    /** @type {string|null} Key "x_y" of current go_explore target */
    _lastExploreKey = null;

    /** @type {string|null} Key "x_y" of previous go_explore target (ping-pong prevention) */
    _prevExploreKey = null;

    /** @type {Set<string>|null} Spawner keys to exclude from next exploration (idle group patrol) */
    _idleExcludeKeys = null;

    /** @type {number} Milliseconds between re-deliberation ticks (0 = event-driven only) */
    tickIntervalMs = 0;

    /**
     * Decide the next intention to push given the current one
     * @param {Array|null} _currentIntent - Current intention predicate (e.g., ['go_deliver', x, y])
     * @returns {Array|null} Predicate to push, or null to keep current intention
     */
    decide(_currentIntent) { return null; }

    // ─── shared helpers ──────────────────────────────────────────────────────

    /**
     * Get delivery reward multiplier at tile (from mission config)
     * @param {{x: number, y: number}} tile - Tile position
     * @returns {number} Multiplier (1 = no scaling, or mission multiplier)
     */
    deliveryScale(tile) {
        return missionConstraints.deliveryMultipliers
            ?.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

    /**
     * Find nearest A*-reachable delivery tile
     * @param {{x: number, y: number}} from - Starting position (default: agent position)
     * @returns {{x: number, y: number}|undefined} Nearest reachable delivery, or undefined if none
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
            // Prefer higher reward multiplier, then nearer. With no multiplier
            // mission every scale is 1 ⇒ the first term is 0 ⇒ pure nearest (unchanged).
            .sort((a, b) => (this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len))[0]?.d;
    }

    /**
     * Check if tile is in sustainable pick-up→deliver region (trap-avoidance)
     * @param {{x: number, y: number}} tile - Tile to check
     * @returns {boolean}
     */
    inSafe(tile) {
        return safeTargetSet.has(`${Math.round(tile.x)}_${Math.round(tile.y)}`);
    }

    /**
     * Effective cost of delivering at tile (path + congestion penalty)
     * @param {{x: number, y: number}} from - Starting position
     * @param {{x: number, y: number}} d - Delivery tile
     * @returns {number} Cost in tiles (path + penalty for nearby agents)
     */
    deliveryCost(from, d) {
        const base = this.pathLen(from, d);
        if (!Number.isFinite(base)) return base;
        const near = otherAgentDistTo(d);
        const pen  = Number.isFinite(near) && near <= 1 ? SWITCH_MARGIN : 0;
        return base + pen;
    }

    /**
     * Find nearest delivery in sustainable loop, with trap-avoidance logic
     * @param {{x: number, y: number}} from - Starting position (default: agent position)
     * @returns {{x: number, y: number}|undefined} Delivery tile, or undefined if all unreachable
     */
    nearestEscapableDelivery(from = me) {
        let tiles = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles = f;
        }
        const reachable = [...tiles]
            .map(d => ({ d, len: this.deliveryCost(from, d) }))
            .filter(({ len }) => Number.isFinite(len))
            // Multiplier-priority then nearest (no-op without a deliveryMultipliers
            // mission); a 0× tile sorts last and is taken only as a fallback below.
            .sort((a, b) => (this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len));
        if (crateTiles.length > 0)
            deliveryLog(`candidates from (${Math.round(from.x)},${Math.round(from.y)}): `
                + reachable.map(({ d, len }) => `(${d.x},${d.y})=${len}${usableDeliverySet.has(`${d.x}_${d.y}`) ? '' : '·unusable'}`).join(' '));
        if (reachable.length === 0) return undefined;
        const usable = reachable.filter(({ d }) => usableDeliverySet.has(`${d.x}_${d.y}`));
        if (usable.length > 0) return this._pickDelivery(usable).d; // safe zone reachable now

        // No SAFE (usable) zone reachable right now — every reachable zone is a trap.
        // Before diving into one, distinguish WHY the safe zones are unreachable:
        //   • structurally one-way (a real dead-end map)  → must use the trap,
        //   • or just a competitor standing in the corridor (transient)  → WAIT.
        // findRoute treats agents as walls, so an agent-blocked safe zone looks
        // identical to a walled-off one; reachableIgnoringAgents asks the static
        // question. If a usable zone is structurally reachable but blocked now, hold
        // the load (return undefined → the strategies' "no reachable delivery →
        // reposition/idle" branch) and retry next tick instead of entering a trap we
        // can't escape. Only fall back to the trap when NO usable zone exists at all.
        let tiles2 = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles2.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles2 = f;
        }
        const safeBlocked = tiles2.some(d =>
            usableDeliverySet.has(`${d.x}_${d.y}`) && reachableIgnoringAgents(from, d));
        if (safeBlocked) {
            deliveryLog(`safe delivery exists but is agent-blocked — holding, NOT entering a trap`);
            return undefined;
        }
        return this._pickDelivery(reachable).d;   // genuinely all-traps → last resort
    }

    // ─── deliveryMultipliers (Level-2 bonus-tile missions) ───────────────────
    // "Deliver in (x,y) for 5× pts" makes some delivery tiles worth more. The
    // multiplier scales the banked reward at that tile, so the agent both ROUTES
    // deliveries to the bonus tile (nearestEscapableDelivery → _pickDelivery) and
    // VALUES its carried load higher when a bonus tile is reachable (the value
    // functions). With no such mission every tile is ×1, so all of this collapses
    // to the historical nearest-tile behaviour exactly.

    /**
     * Get delivery multiplier at tile
     * @param {{x: number, y: number}} tile - Tile position
     * @returns {number} Multiplier (1 = no mission scaling)
     */
    deliveryMultiplierAt(tile) {
        const m = missionConstraints.deliveryMultipliers;
        if (!(m?.size > 0)) return 1;
        return m.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

    /**
     * Best delivery tile for carrying load R over n parcels (considers multipliers)
     * @param {{x: number, y: number}} from - Starting position
     * @param {number} R - Total reward of load
     * @param {number} n - Number of parcels in load
     * @returns {{d: {x: number, y: number}, len: number}|undefined} Best delivery and path cost
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
     * Pick best delivery from reachable pool (considering multipliers and load value)
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
     * Check if current delivery target should be kept or replaced
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {boolean} True to keep current delivery target
     */
    betterDelivery(currentIntent) {
        if (currentIntent?.[0] !== 'go_deliver') return false;
        const cur = { x: currentIntent[1], y: currentIntent[2] };
        if (!this.isReachable(cur)) return false;        // current gone → recompute
        const alt = this.nearestEscapableDelivery();
        if (!alt) {
            // nearestEscapableDelivery returned nothing. Two cases:
            //   • current target is a SAFE (usable) zone → genuinely nothing better,
            //     keep heading there.
            //   • current target is a TRAP and we got undefined because a safe zone
            //     is agent-blocked (the wait case) → do NOT keep driving into the
            //     trap; recompute so the caller takes the hold/idle branch instead.
            return usableDeliverySet.has(`${cur.x}_${cur.y}`);
        }
        const curCost = this.deliveryCost(me, cur);
        const altCost = this.deliveryCost(me, alt);
        // Keep unless the alternative wins by MORE than the margin.
        return (curCost - altCost) <= SWITCH_MARGIN;
    }

    /**
     * Simple reward-per-distance score (used by StrategySimple only)
     * @param {Object} parcel - Parcel object
     * @returns {number} Score
     */
    scoreOf(parcel) {
        return parcel.reward / Math.max(1, distance(me, parcel));
    }

    /**
     * Check if agent has reached carrying capacity
     * @returns {boolean}
     */
    atCapacity() {
        return parcels.carriedBy(me.id).length >= CARRYING_CAPACITY;
    }

    // ─── mission-constraint gates (Level-2 persistent missions) ──────────────
    // Shared here so EVERY strategy enforces them — previously only Greedy/Blind
    // filtered maxParcelReward and only Greedy gated requiredStackSize, so the
    // default LookAhead/Memory strategies silently ignored those missions.

    /**
     * Check if mission constraints allow picking up this parcel
     * @param {Object} parcel - Parcel to check
     * @returns {boolean}
     */
    missionPickupOk(parcel) {
        if (missionConstraints.maxParcelReward != null
            && parcel.reward > missionConstraints.maxParcelReward) return false;
        if (missionConstraints.maxBundleValue != null
            && parcel.reward > missionConstraints.maxBundleValue) return false;
        return true;
    }

    /**
     * Check if parcel count is forbidden for delivery
     * @param {number} n - Number of parcels in stack
     * @returns {boolean}
     */
    stackForbidden(n) {
        if (!(missionConstraints.forbiddenStackSizes?.size > 0)) return false;
        if (n >= CARRYING_CAPACITY) return false;        // can't grow the stack to escape
        return missionConstraints.forbiddenStackSizes.has(n);
    }

    /**
     * Check if stack is ready for delivery (passes mission gates)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    stackReady(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        if (missionConstraints.maxBundleValue != null) return carrying.length >= 1;
        if (missionConstraints.requiredStackSize != null)
            return carrying.length >= missionConstraints.requiredStackSize;
        return true;
    }

    /**
     * Check if agent must continue picking up (not yet full for mission)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    mustStack(carrying) {
        if (this.stackForbidden(carrying.length)) return true;
        return missionConstraints.requiredStackSize != null
            && carrying.length < missionConstraints.requiredStackSize;
    }

    /**
     * Check if stack has reached mission cap (must deliver now)
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {boolean}
     */
    stackFull(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        return missionConstraints.maxStackSize != null
            && carrying.length >= missionConstraints.maxStackSize;
    }

    /**
     * Check if mission forces single-parcel deliveries
     * @returns {boolean}
     */
    singleParcelBundles() {
        return missionConstraints.maxBundleValue != null
            || missionConstraints.maxStackSize === 1;
    }

    /**
     * Get parcel decay rate (reward lost per tile traveled)
     * @returns {number} Decay per tile (measured from actual movement timing)
     */
    decayRate() {
        return moveTiming.decayPerTile();
    }

    /**
     * Get A*-path cost accounting for crate pushing
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

        // Crate-free path: accurate — what A* navigation can actually walk.
        const freePath = findRoute(from, to, crateBlocked);
        if (freePath) return freePath.length;

        // All routes blocked by crates — target needs PDDL. Push-aware cost.
        const cost = pushAwareCost(from, to, crateSet, avoid);
        pathlenLog(`(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)}) push-aware cost=${cost}`);
        return cost;
    }

    /**
     * Check if position is currently reachable via A*
     * @param {{x: number, y: number}} to - Position to check
     * @returns {boolean}
     */
    isReachable(to) {
        return Number.isFinite(this.pathLen(me, to));
    }

    /**
     * Check if current pickup target should be kept
     * @param {Array|null} currentIntent - Current intention predicate
     * @param {{p: Object, value: number}|undefined} candidate - Best new pickup option
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
     * Value of delivering current load immediately
     * @returns {number} Value in reward units (0 when carrying nothing)
     */
    bankNowValue() {
        const carried = parcels.carriedBy(me.id);
        const n = carried.length;
        if (n === 0) return 0;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const del = this.nearestDelivery(me);
        const d0  = del ? this.pathLen(me, del) : Infinity;
        // Reward is scaled by the chosen delivery tile's multiplier (1× by default).
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
     * Check if agent should divert to one-shot bonus goal
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_to', x, y] to divert, or null to continue
     */
    bonusDiversion(currentIntent) {
        const b = missionConstraints.oneShotBonus;
        if (!b) return null;
        // Already there — arrival earns it; don't re-issue go_to and stall on-tile.
        if (Math.round(me.x) === b.x && Math.round(me.y) === b.y) return null;
        const net = this.bonusGoalValue();
        if (net == null) return null;                 // unreachable → ignore
        // Compare against the best the agent would otherwise do this tick: bank the
        // current load now (0 when empty-handed). A positive, margin-beating net
        // means the literal bonus is worth more than continuing the parcel loop.
        const baseline = this.bankNowValue();
        if (net - baseline <= SWITCH_MARGIN) return null;
        // Hysteresis: if we're already heading to the bonus tile, keep going.
        if (currentIntent?.[0] === 'go_to'
            && currentIntent[1] === b.x && currentIntent[2] === b.y) return null;
        return ['go_to', b.x, b.y];
    }

    /**
     * Multiplier for parcel value based on competition intensity
     * @param {Object} parcel - Parcel to evaluate
     * @param {number} ourDist - Our distance to parcel (pre-computed)
     * @returns {number} Multiplier in [CONTEST_FLOOR, 1]
     */
    contestFactor(parcel, ourDist) {
        const their = otherAgentDistTo(parcel);
        if (!Number.isFinite(their)) return 1;                 // no contender
        const our = Number.isFinite(ourDist) ? ourDist : this.pathLen(me, parcel);
        let delta = their - our;                               // >0 ⇒ we're closer
        // Deadband: small leads count as ties so 1-tile jitter doesn't move score.
        if (Math.abs(delta) <= CONTEST_DEADBAND) delta = 0;
        // Quality softener: if the nearest agent isn't actually closing on the
        // parcel, it's probably not racing us — soften the penalty it imposes.
        const id = nearestAgentId(parcel);
        if (id && !isAgentMovingToward(id, parcel)) delta += CONTEST_K / 2;
        // Discount ONLY when we're losing the race (delta < 0). If we're closer or
        // tied (delta ≥ 0) we'll win it → factor 1, no haircut. This is the fix for
        // "walked over a high-score parcel but skipped it": a parcel we're on top of
        // (ourDist≈0) is a near-certain win and must keep its full value even with a
        // competitor nearby. The penalty ramps in only as the competitor pulls ahead:
        //   delta ≥ 0 → 1 ;  delta = −K → floor ;  linear between.
        let factor = 1;
        if (delta < 0) {
            const t = Math.max(0, 1 + delta / CONTEST_K);     // delta∈[−K,0] → [0,1]
            factor = CONTEST_FLOOR + (1 - CONTEST_FLOOR) * t;  // [floor, 1)
        }
        // Only logs when a competitor is actually in contention (their is finite),
        // so the uncontested common case stays silent.
        contestLog(`parcel ${parcel.id} @${parcel.x},${parcel.y}: theirDist=${their} `
            + `ourDist=${our} delta=${delta}${id && !isAgentMovingToward(id, parcel) ? ' (not-racing)' : ''} `
            + `factor=${factor.toFixed(3)}`);
        return factor;
    }

    /**
     * Value of detouring to pick up and deliver a parcel
     * @param {Object} parcel - Parcel to evaluate
     * @returns {number} Value in reward units (accounts for competition and decay)
     */
    pickupValue(parcel) {
        const carried = parcels.carriedBy(me.id);
        const n   = carried.length;
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const d1  = this.pathLen(me, parcel);
        const del = this.nearestDelivery(parcel);
        const d2  = del ? this.pathLen(parcel, del) : Infinity;
        // The whole load is delivered at `del`, so scale its reward by that tile's
        // multiplier (1× by default ⇒ unchanged).
        const scale = del ? this.deliveryScale(del) : 1;
        return scale * (R + parcel.reward) * this.contestFactor(parcel, d1)
               - (n + 1) * this.decayRate() * (d1 + d2);
    }

    /**
     * Check if a remembered (out-of-range) parcel is worth pursuing
     * @param {Object} p - Remembered parcel (with pre-decayed reward)
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
     * Value of delivering first, then picking up parcel solo
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
        // Each leg is delivered at its own tile, so scale by that tile's multiplier
        // (1× by default): the current load at `del`, the new parcel at `del2`.
        const scale0 = this.deliveryScale(del);
        const scale2 = del2 ? this.deliveryScale(del2) : 1;
        const bankNow    = scale0 * R - n * this.decayRate() * d0;
        const valueAfter = scale2 * parcel.reward - this.decayRate() * (d0 + d3 + d4);
        return bankNow + Math.max(0, valueAfter);
    }

    /**
     * Net gain of picking up vs delivering now
     * @param {Object} parcel - Parcel to evaluate
     * @returns {number} Gain value
     */
    pickupGain(parcel) {
        return this.pickupValue(parcel) - this.bankNowValue();
    }

    /**
     * Debug string showing parcel score breakdown
     * @param {Object} parcel - Parcel to debug
     * @returns {string} Human-readable score breakdown
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
     * Ranking cost for exploration target (path + camping penalty)
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
     * Generate exploration target when idle (no worthwhile parcel work)
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to stay idle
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
        const reachableAll = pool.filter(t => this.isReachable(t));
        if (reachableAll.length === 0) return null; // nothing reachable → stay idle

        // Idle group-patrol may ask us to leave the group it just patrolled: drop
        // that group's tiles so the next target is OUTSIDE it. Fall back to the
        // full set if the exclusion would leave nothing reachable.
        const excluded  = this._idleExcludeKeys;
        const reachable = excluded
            ? (reachableAll.filter(t => !excluded.has(`${t.x}_${t.y}`)).length > 0
                ? reachableAll.filter(t => !excluded.has(`${t.x}_${t.y}`))
                : reachableAll)
            : reachableAll;

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

        // Rank by exploreCost (pathLen + Case-6 camping penalty) so a spawner a
        // competitor is sitting on loses a near-tie to a clear one.
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
            // Slide window: current becomes previous, new target becomes current.
            this._prevExploreKey = this._lastExploreKey;
            this._lastExploreKey = key;
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
