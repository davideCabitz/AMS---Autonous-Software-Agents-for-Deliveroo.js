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
     * Per-tile delivery reward multiplier from the active Level-2 mission
     * (deliveryMultipliers): e.g. 5 for "5× pts in (x,y)", 0 for "0 pts in (x,y)".
     * Defaults to 1 (no scaling) when no such mission is active, so every caller
     * below is an exact no-op until a multiplier mission arrives. Coords are
     * rounded to match the integer "x_y" keys built in applyMissionConfig.
     */
    deliveryScale(tile) {
        return missionConstraints.deliveryMultipliers
            ?.get(`${Math.round(tile.x)}_${Math.round(tile.y)}`) ?? 1;
    }

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
            // Prefer higher reward multiplier, then nearer. With no multiplier
            // mission every scale is 1 ⇒ the first term is 0 ⇒ pure nearest (unchanged).
            .sort((a, b) => (this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len))[0]?.d;
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
    /**
     * Effective cost of delivering at tile `d` from `from`: the A* path length
     * plus a congestion penalty when a competitor sits on/adjacent to the zone, so
     * a congested-but-near zone loses to a clear slightly-farther one. Additive,
     * not a filter — the zone is still selectable if it's the only option.
     * Reuses SWITCH_MARGIN as the penalty: a zone is "worth detouring around"
     * exactly when an alternative beats it by the switch threshold. Degrades to
     * plain pathLen when no agents are sensed (otherAgentDistTo → Infinity).
     */
    deliveryCost(from, d) {
        const base = this.pathLen(from, d);
        if (!Number.isFinite(base)) return base;
        const near = otherAgentDistTo(d);
        const pen  = Number.isFinite(near) && near <= 1 ? SWITCH_MARGIN : 0;
        return base + pen;
    }

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

    /**
     * Margin-gated, congestion-aware keep-or-switch for the active go_deliver
     * target. Returns true to KEEP the current target. Replaces the inline
     * `currentIntent[0]==='go_deliver' && isReachable(...)` keep-current check.
     *
     * Switching must beat the current target by more than SWITCH_MARGIN tiles of
     * effective (congestion-adjusted) cost — the same anti-ping-pong threshold as
     * pickups. This lets us (a) abandon a now-congested zone for a clear one, and
     * (b) revert to the originally-nearer zone once a competitor steps aside — but
     * a competitor oscillating in a doorway can't make us flip (it never wins the
     * full margin). Falls back to the old "keep while reachable" when no
     * alternative exists, and to recompute when the current target is unreachable.
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

    /** True when `n` is a count the agent must never DELIVER at ("deliver N =
     *  penalty"). At capacity we can't pick up more to escape it, so the ban is
     *  lifted there — delivering the forbidden count beats never delivering at all. */
    stackForbidden(n) {
        if (!(missionConstraints.forbiddenStackSizes?.size > 0)) return false;
        if (n >= CARRYING_CAPACITY) return false;        // can't grow the stack to escape
        return missionConstraints.forbiddenStackSizes.has(n);
    }

    /** Delivery gate. forbiddenStackSizes → never deliver while carrying a banned
     *  count (e.g. exactly 2). maxBundleValue → deliver one cheap parcel at a time
     *  (the sum of a single filtered parcel is always ≤ the threshold, so every
     *  delivery earns the bonus). requiredStackSize → only deliver once the
     *  stack is complete. Otherwise deliver whenever it's worthwhile. */
    stackReady(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        if (missionConstraints.maxBundleValue != null) return carrying.length >= 1;
        if (missionConstraints.requiredStackSize != null)
            return carrying.length >= missionConstraints.requiredStackSize;
        return true;
    }

    /** True while the agent must keep picking up rather than deliver: a
     *  requiredStackSize mission still below its floor, OR we're holding a
     *  forbidden count and must grab one more to escape it (e.g. carrying 2 when
     *  delivering 2 is penalised → go find a 3rd). Relaxes the value-based
     *  multi-pickup gates (a mandated pickup must happen even when the marginal
     *  parcel isn't "worth it" by the decay model). */
    mustStack(carrying) {
        if (this.stackForbidden(carrying.length)) return true;
        return missionConstraints.requiredStackSize != null
            && carrying.length < missionConstraints.requiredStackSize;
    }

    /** True when the bundle CAP is reached (carrying ≥ maxStackSize): the agent must
     *  stop picking up and deliver. Only "exactly N" / "only when carrying N" missions
     *  set a cap; "at least N" leaves maxStackSize null so the agent may keep stacking.
     *  Without this the multi-pickup gates grab past N — "deliver 2 at a time" delivered
     *  3–4. Complements mustStack() (which forces pickups while below the floor).
     *  A forbidden count is never "full" — we must be free to pick up to escape it. */
    stackFull(carrying) {
        if (this.stackForbidden(carrying.length)) return false;
        return missionConstraints.maxStackSize != null
            && carrying.length >= missionConstraints.maxStackSize;
    }

    /** True when the active mission forbids carrying a second parcel, so the
     *  multi-pickup gates collapse to single-parcel bundles:
     *   - maxBundleValue: a second parcel could push the bundle total over the cap.
     *   - maxStackSize === 1: "deliver exactly one at a time" — the cap is one parcel,
     *     so never grab another before delivering.
     *  (a cap ≥ 2 still stacks normally via mustStack/stackReady/stackFull.) */
    singleParcelBundles() {
        return missionConstraints.maxBundleValue != null
            || missionConstraints.maxStackSize === 1;
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
        const R   = carried.reduce((sum, p) => sum + p.reward, 0);
        const del = this.nearestDelivery(me);
        const d0  = del ? this.pathLen(me, del) : Infinity;
        // Reward is scaled by the chosen delivery tile's multiplier (1× by default).
        const scale = del ? this.deliveryScale(del) : 1;
        return scale * R - n * this.decayRate() * d0;
    }

    /**
     * Net value of diverting to the active one-shot bonus (missionConstraints.
     * oneShotBonus), expressed in the SAME units as bankNowValue/pickupValue so the
     * literal `+points` competes with parcel income inside the agent's own cost
     * function — the cross-layer coordination this feature exists for.
     *
     *   bonusNet = points − n·ρ·dist(me → bonus)
     *
     * The only cost charged is the decay the detour inflicts on the n parcels we
     * already carry (we delay banking them by dist tiles). The literal points are
     * a one-shot reward, not scaled by any delivery multiplier. Returns null when
     * no bonus is active or the tile is unreachable, so callers skip it cleanly.
     * Caller compares this against the best parcel option (pickupValue/bankNow) and
     * only diverts when the bonus wins — see decide() in the sensing strategies.
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
     * Shared front-door called once per tick (coordinator_agent.optionsGeneration)
     * BEFORE the strategy's own decide(), so every strategy is bonus-aware with no
     * per-subclass edits. Returns a ['go_to', x, y] predicate to divert to the
     * active oneShotBonus, or null to let normal parcel deliberation proceed.
     *
     * The bonus diverts only when its net value (bonusGoalValue, in parcel-income
     * units) beats what the agent would otherwise bank now by more than
     * SWITCH_MARGIN — the same anti-ping-pong threshold pickups use. Once the agent
     * is standing on the bonus tile we stop diverting (let it deliver/resume), so a
     * per-agent bonus is collected by arrival and the field can be dropped by the
     * mission layer. With no oneShotBonus this is a null-returning no-op.
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
     * Win-probability multiplier in [CONTEST_FLOOR, 1] for racing the nearest
     * competitor to `parcel`. 1 when uncontested (no agents, or we're clearly
     * closer); → CONTEST_FLOOR when a competitor is clearly closer. `ourDist` is
     * passed in (already computed by the caller) to avoid a redundant pathLen.
     *
     * Backward-compat: with no agents sensed, otherAgentDistTo → Infinity ⇒ 1, so
     * pickupValue is unchanged. This is the invariant the unit suite asserts.
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
     * Value B(p) — reward banked if we detour to pick up `parcel` and then deliver
     * the whole load. Accounts for the extra decay the detour inflicts on every
     * already-carried parcel plus the new one (both legs of the trip).
     *   B(p) = (R + reward_p)·contestFactor − (n+1)·ρ·(d1 + d2)
     * with d1 = dist(me, p), d2 = dist(p, D_p). The reward term is scaled by the
     * estimated win-probability vs. competitors; the decay penalty is left intact
     * so a contested parcel is deprioritized but value never inverts negative.
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
    /**
     * Ranking cost for an explore spawner: A* path length plus a Case-6 camping
     * penalty when a competitor sits on/adjacent to it. Used as the single sort key
     * so the sort, tie-grouping, and chosen target all agree. Degrades to plain
     * pathLen when no agents are sensed (otherAgentDistTo → Infinity).
     */
    exploreCost(t) {
        const base = this.pathLen(me, t);
        if (!Number.isFinite(base)) return base;
        const near = otherAgentDistTo(t);
        return base + (Number.isFinite(near) && near <= 1 ? SPAWNER_CAMP_PENALTY : 0);
    }

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
