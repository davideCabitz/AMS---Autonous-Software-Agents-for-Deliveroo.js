import { StrategyMemory } from './StrategyMemory.js';
import { MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN, SWITCH_MARGIN } from './Strategy.js';
import {
    me, parcels, CARRYING_CAPACITY, missionConstraints,
    spawnerTiles, OBSERVATION_DISTANCE,
} from '../context.js';
import { buildSpawnerGroups } from '../beliefs/SpawnerGroups.js';
import { getWalkable } from '../utils/astar.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lookahead');
const patrolLog = createLogger('patrol-idle');

// Value band for the look-ahead decisions, in reward points:
//  - the paired tour must beat taking the greedy parcel solo by ≥ this to bother
//    collecting a second parcel at all;
//  - one visit order must beat the other by ≥ this to win outright on value;
//    within the band the two orders are treated as a tie and broken by distance
//    (shorter total tour first → grab the nearer parcel first). The distance
//    tie-break is what gives sane ordering on low/no-decay maps, where the decay
//    term can't separate the two orderings on value alone.
const LOOKAHEAD_MARGIN = 1;

// ─── idle group-patrol (anti-camping) ─────────────────────────────────────────
const IDLE_D_CLUSTER         = 2;     // matches HighCapacity D_CLUSTER (identical group shapes)
const IDLE_PATIENCE_MS       = 3000;  // sparse-map: patrol a dry group this long before leaving
const IDLE_MAX_WAYPOINTS     = 6;     // matches HighCapacity patrol cap
// Sparsity gate: patrol-and-wait only when the map has at most this many spawner
// TILES total (waiting for a respawn is then the only way to get parcels). Above
// this the map is "dense" — plenty of spawners spread around — so idle = move to
// the next unvisited group's centroid immediately instead of camping. We gate on
// total spawner-TILE count, not group COUNT: a long row of adjacent spawners
// merges into ONE group, so a count-of-groups gate misfires (sees few groups and
// camps) even when parcels are abundant elsewhere on the map.
const IDLE_PATROL_MAX_SPAWNERS = 12;

/**
 * @class StrategyLookAhead
 * 2-step look-ahead on pickup pairs + idle group patrol with spawner clustering
 *
 *   me → C → G → delivery     vs     me → G → C → delivery
 *   value = (R + reward_C + reward_G) − (n+2)·ρ·(d1 + d2 + d3)
 *
 * mirroring the decay model of pickupValue() with two new parcels instead of one.
 * The agent detours to C first only when the pair beats taking G solo and the
 * C-first order wins (by value, or by a shorter total tour within LOOKAHEAD_MARGIN).
 * Crucially there is NO geometric "on the way" gate: under decay the longer-travel
 * order is already the lower-value one, so a nearby parcel in the OPPOSITE direction
 * from G is now grabbed first whenever doing so genuinely shortens the tour — the
 * exact case the first cut wrongly excluded. G stays in the pool (live or remembered)
 * and is selected naturally on the next deliberation.
 *
 * Plug-and-play: no existing strategy is modified. Requires
 * parcels.enableMemory() before running, exactly like StrategyMemory.
 */
export class StrategyLookAhead extends StrategyMemory {
    /** @type {number} Heartbeat so the idle patience timer fires even with no sensing event.
     *  HighCapacity also sets 500; a subclass field initializer runs after this
     *  one and wins, so its value is preserved */
    tickIntervalMs = 500;

    /** @type {Array<Array<{x: number, y: number}>>|null} Lazily built spawner groups */
    _idleGroups = null;

    /** @type {string|null} Signature of allowedSpawnerTiles the groups were built under */
    _idleGroupsSig = null;

    /** @type {number|null} Index of the group currently being idle-patrolled (sparse path) */
    _idlePatrolGroupIdx = null;

    /** @type {Array<{x: number, y: number}>} Waypoint loop for the current idle group */
    _idlePatrol = [];

    /** @type {number} Index of the waypoint being walked to */
    _idlePatrolIdx = 0;

    /** @type {number} Timestamp the patience window started (reset on group arrival + pickup) */
    _idlePatrolTs = 0;

    /** @type {Set<string>|null} Tiles of a just-abandoned group, excluded from the next explore selection */
    _idleLeftGroupKeys = null;

    /** @type {Set<number>} Dense path: group indices already visited this idle cycle */
    _idleVisitedGroups = new Set();

    /**
     * Decide next intention using the 2-step pickup look-ahead over the merged
     * live + remembered parcel pool
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying   = parcels.carriedBy(me.id);
        const bankNow    = this.bankNowValue();
        const remembered = parcels.remembered();

        // Same merged candidate pool as StrategyMemory: free live parcels plus
        // remembered ones that are not live again, pre-screened to topN by raw
        // reward when capacity is finite.
        let allFree = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id) && this.rememberedWorthPursuing(r)),
        ].filter(p => this.missionPickupOk(p));   // mission gates: maxParcelReward / maxBundleValue
        if (Number.isFinite(CARRYING_CAPACITY) && allFree.length > CARRYING_CAPACITY) {
            allFree = allFree
                .sort((a, b) => b.reward - a.reward)
                .slice(0, CARRYING_CAPACITY);
        }
        const eligible = allFree.filter(p => this.isReachable(p) && this.inSafe(p));

        if (carrying.length > 0) {
            // A maxStackSize CAP bounds the bundle: once carrying ≥ cap (stackFull)
            // we must stop picking up and deliver, otherwise the value-based gate
            // keeps grabbing parcels past the cap ("deliver 2 at a time" delivered 4).
            // maxBundleValue / a cap of 1 (singleParcelBundles) forbid a second parcel
            // outright. Either way → no more pickups this trip. (An "at least N" mission
            // sets no cap, so it keeps stacking past N — that is intended.)
            const noMorePickups = this.singleParcelBundles() || this.stackFull(carrying);
            // While below the requiredStackSize FLOOR, mustStack relaxes the value gate
            // (the floor must be reached even when a marginal parcel isn't "worth it").
            const worthwhile = noMorePickups ? [] : eligible
                .map(p => ({ p, value: this.pickupValue(p) }))
                .filter(({ p, value }) => this.mustStack(carrying) || value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
                .sort((a, b) => b.value - a.value);

            // When the NEXT pickup would hit the cap (so it's the last one), take the
            // best SINGLE parcel (ranked by pickupValue) — the two-parcel look-ahead
            // would optimise a 2-pickup tour we won't make, so it could pick a worse
            // first stop. Otherwise use the look-ahead pairing.
            const lastPickupBeforeCap = missionConstraints.maxStackSize != null
                && carrying.length === missionConstraints.maxStackSize - 1;
            const choice = (!this.atCapacity() && worthwhile.length > 0)
                ? (lastPickupBeforeCap
                    ? { p: worthwhile[0].p, value: worthwhile[0].value, via: 'direct' }
                    : this.#chooseTarget(worthwhile, carrying.length))
                : undefined;
            // When no further pickup is allowed we must NOT keep an in-flight extra
            // pickup: #shouldKeep(_, undefined) would otherwise return true for any
            // pending go_pick_up and the agent would overshoot the stack. Skip the
            // hysteresis so the next branch delivers what we already hold.
            if (!noMorePickups && !this.atCapacity() && this.#shouldKeep(currentIntent, choice))
                return null;
            if (choice) {
                this.#logChoice('multi-pickup', choice);
                return ['go_pick_up', choice.p.x, choice.p.y, choice.p.id];
            }

            // Stack mission not yet complete and nothing in sight worth grabbing:
            // keep accumulating (explore towards spawners) instead of delivering early.
            if (!this.stackReady(carrying)) {
                log(`stack incomplete (${carrying.length} carried) — hunting more parcels`);
                return this.exploreIfIdle(currentIntent);
            }

            if (this.betterDelivery(currentIntent)) return null;
            const target = this.nearestEscapableDelivery();
            if (target) {
                log(`→ go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
            log('no reachable delivery — repositioning');
        }

        // Empty-hand: rank by the standard cost function, then look ahead.
        const ranked = eligible
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value);

        if (ranked.length > 0) {
            // Two-parcel look-ahead picks the best FIRST STOP of a two-pickup tour,
            // which can be a parcel that is only good because a second parcel lies
            // beyond it. With a cap of one ("deliver one at a time", maxStackSize===1)
            // the agent carries exactly one parcel, so that pairing is wrong — take
            // the greedy best SINGLE parcel (ranked[0]), the one BDI would pick in
            // observation range.
            const choice = missionConstraints.maxStackSize === 1
                ? { p: ranked[0].p, value: ranked[0].value, via: 'direct' }
                : this.#chooseTarget(ranked, carrying.length);
            if (this.#shouldKeep(currentIntent, choice)) return null;
            this.#logChoice('go_pick_up', choice);
            return ['go_pick_up', choice.p.x, choice.p.y, choice.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }

    /**
     * Pick the next pickup target. Starts from the greedy winner G of the standard
     * cost-function ranking, then asks a sharper question: if the agent is going to
     * collect two parcels anyway, which order is better — and is a different parcel
     * the right FIRST stop?
     *
     * For each complementary candidate C it scores both full tours by the same decay
     * model as pickupValue() extended to two new parcels:
     *   me → C → G → delivery   vs   me → G → C → delivery
     *   value = (R + r_C + r_G) − (n+2)·ρ·(d1 + d2 + d3)
     * The best-paired C is kept; the agent commits to a near-first detour only when
     * that pair beats taking G solo (so a worthless second parcel is never chased)
     * AND the C-first order wins — on value by LOOKAHEAD_MARGIN, or, within that
     * band, by a shorter total tour. There is deliberately no geometric "on the
     * way" gate: under decay the longer order is already the lower-value one, so an
     * opposite-direction parcel that is genuinely cheaper to grab first is no longer
     * wrongly excluded. `ranked` has already passed the cost-function thresholds, so
     * the look-ahead never resurrects a parcel the base scoring rejected.
     *
     * @param {{p:object,value:number}[]} ranked  candidates, best first
     * @param {number} nCarried                   parcels currently carried
     * @returns {{p:object,value:number,via:'direct'|'lookahead',second?:object,legs?:object}}
     */
    #chooseTarget(ranked, nCarried) {
        const greedy = ranked[0];
        const direct = { p: greedy.p, value: greedy.value, via: 'direct' };
        // The paired plan commits to two pickups — need room for both.
        const roomForTwo = !Number.isFinite(CARRYING_CAPACITY)
            || nCarried + 2 <= CARRYING_CAPACITY;
        if (!roomForTwo || ranked.length < 2) return direct;

        // Best complementary parcel to pair with G, scoring both visit orders.
        let best = null;
        for (const { p: c } of ranked.slice(1)) {
            const cFirst = this.#tourValue(c, greedy.p);   // me → C → G → delivery
            const gFirst = this.#tourValue(greedy.p, c);   // me → G → C → delivery
            if (!cFirst || !gFirst) continue;
            const pairBest = Math.max(cFirst.value, gFirst.value);
            if (!best || pairBest > best.pairBest) best = { c, cFirst, gFirst, pairBest };
        }
        if (!best) return direct;

        // Only collect a second parcel when the pair beats taking G solo.
        if (best.pairBest < greedy.value + LOOKAHEAD_MARGIN) return direct;

        // Same two parcels — decide order. Value wins outright by the margin;
        // within the band, the shorter total tour goes first (→ nearer parcel).
        const { cFirst, gFirst, c } = best;
        const dv = cFirst.value - gFirst.value;
        const goNear = dv >= LOOKAHEAD_MARGIN
            || (Math.abs(dv) < LOOKAHEAD_MARGIN && cFirst.dist <= gFirst.dist);
        if (goNear)
            return { p: c, second: greedy.p, value: cFirst.value, via: 'lookahead', legs: cFirst.legs };
        return direct; // greedy-first order: head to G now, grab C next deliberation
    }

    /**
     * Value and total length of the tour me → first → second → delivery, with the
     * same decay model as pickupValue() extended to two new parcels:
     *   (R + r_first + r_second) − (n+2)·ρ·(d1 + d2 + d3)
     * `dist` (d1+d2+d3) is returned for the order tie-break. Returns null when any
     * leg is unreachable (Infinite), so the pair is silently dropped.
     */
    #tourValue(first, second) {
        const d1 = this.pathLen(me, first);
        const d2 = this.pathLen(first, second);
        const del = this.nearestDelivery(second);
        const d3  = del ? this.pathLen(second, del) : Infinity;
        const dist = d1 + d2 + d3;
        if (!Number.isFinite(dist)) return null;

        const carried = parcels.carriedBy(me.id);
        const n = carried.length;
        const R = carried.reduce((s, p) => s + p.reward, 0);
        const value = (R + first.reward + second.reward)
            - (n + 2) * this.decayRate() * dist;
        return { value, dist, legs: { d1, d2, d3 } };
    }

    /**
     * Hysteresis covering live + remembered targets, replicated from
     * StrategyMemory.#shouldKeepWithMemory (private there, so not inheritable),
     * with one look-ahead twist: when the chained plan's SECOND stop is the
     * current target, switching to the near parcel is a re-ordering of the same
     * trip, not a change of destination — allow it without the SWITCH_MARGIN
     * @param {Array|null} currentIntent - Current intention predicate
     * @param {{p: Object, value: number, via?: string, second?: Object}|undefined} choice - Candidate pickup
     * @returns {boolean} True to keep the current pickup target
     */
    #shouldKeep(currentIntent, choice) {
        if (!currentIntent || currentIntent[0] !== 'go_pick_up') return false;
        const curId = currentIntent[3];
        const cur = parcels.get(curId) ?? parcels.getRemembered(curId);
        if (!cur || cur.carriedBy) return false;
        if (!this.isReachable(cur)) return false;
        if (!choice || choice.p.id === curId) return true;
        if (choice.via === 'lookahead' && choice.second?.id === curId) return false;
        return choice.value - this.pickupValue(cur) < SWITCH_MARGIN;
    }

    /**
     * Emit a diagnostic log line for the chosen pickup (chained or direct)
     * @param {string} label - Log label (e.g. 'go_pick_up', 'multi-pickup')
     * @param {{p: Object, value: number, via?: string, second?: Object, legs?: Object}} choice - Chosen pickup
     * @returns {void}
     */
    #logChoice(label, choice) {
        if (choice.via === 'lookahead') {
            const { d1, d2, d3 } = choice.legs;
            log(`→ ${label} detour first=${choice.p.id} (r=${choice.p.reward}) `
                + `then=${choice.second.id} (r=${choice.second.reward}) `
                + `d(me→near)=${d1} d(near→greedy)=${d2} d(greedy→delivery)=${d3} `
                + `chainValue=${choice.value.toFixed(1)}`);
        } else {
            const tag = parcels.get(choice.p.id) ? 'live' : 'remembered';
            log(`→ ${label} (${tag}) ${this.pickupDebug(choice.p)}`);
        }
    }

    // ── idle group-patrol (anti-camping) ──────────────────────────────────────

    /**
     * Idle behaviour that replaces the base single-tile ping-pong with a
     * spawner-group-aware policy:
     *   - SPARSE map (≤ IDLE_PATROL_MAX_SPAWNERS spawner tiles total): patrol the
     *     whole group the agent is standing on as a smooth waypoint loop for
     *     IDLE_PATIENCE_MS, then leave to a spawner OUTSIDE it. Waiting for a
     *     respawn is worth it here.
     *   - DENSE map (more spawner tiles): never camp — head straight to the CENTROID
     *     tile of the nearest unvisited group so the agent crosses the middle of each
     *     cluster and harvests, sweeping group→group. Gating on tile COUNT (not group
     *     count) is deliberate: a row of adjacent spawners merges into one group, so a
     *     group-count gate would wrongly treat a parcel-rich map as sparse and camp.
     * Falls back to the base ranking (super.exploreIfIdle) whenever there is no
     * group to act on, so HighCapacity's degenerate fallbacks are unaffected
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to keep current / stay idle
     */
    exploreIfIdle(currentIntent) {
        this._initIdleGroups();

        // Productive work in flight → no longer idle: drop all patrol/visited state
        // and defer to the base (which also resets _lastExploreKey on these intents).
        if (currentIntent && (currentIntent[0] === 'go_pick_up' || currentIntent[0] === 'go_deliver')) {
            this._idlePatrolTs = 0;
            this._idlePatrolGroupIdx = null;
            this._idleLeftGroupKeys = null;
            this._idleVisitedGroups.clear();
            return super.exploreIfIdle(currentIntent);
        }

        // Non-spawner map (no groups) → unchanged base behaviour.
        if (!this._idleGroups || this._idleGroups.length === 0)
            return super.exploreIfIdle(currentIntent);

        const dense = spawnerTiles.length > IDLE_PATROL_MAX_SPAWNERS;
        const now   = Date.now();

        if (dense) {
            // Mark the group we're sitting on as visited so we don't re-pick it,
            // then move to the next unvisited group's centroid.
            const here = this._idleGroupHere();
            if (here >= 0) this._idleVisitedGroups.add(here);
            const step = this._nextUnvisitedGroup(currentIntent);
            if (step) return step;
            return super.exploreIfIdle(currentIntent);
        }

        // ── sparse map: patrol-and-wait ──
        const here = this._idleGroupHere();
        if (here >= 0) {
            // (Re)start the patience window when arriving on a new group.
            if (this._idlePatrolGroupIdx !== here || this._idlePatrolTs === 0) {
                this._idlePatrolTs = now;
                this._idleLeftGroupKeys = null;
            }
            if (now - this._idlePatrolTs < IDLE_PATIENCE_MS) {
                const step = this._idlePatrolStep(here, currentIntent);
                if (step !== null || currentIntent?.[0] === 'go_explore') return step;
                // group had no reachable waypoint → fall through to ranking
            } else {
                // Patience expired: leave to a spawner OUTSIDE this group.
                this._idleLeftGroupKeys = new Set(this._idleGroups[here].map(t => `${t.x}_${t.y}`));
                patrolLog(`G${here} dry ${IDLE_PATIENCE_MS}ms → leaving to explore outside group`);
                this._idlePatrolTs = 0;
                this._idlePatrolGroupIdx = null;
            }
        }

        return this._exploreOutsideLeftGroup(currentIntent);
    }

    /**
     * Lazily build (and cache) spawner groups for idle patrol, rebuilding when the
     * allowedSpawnerTiles constraint changes. Mirrors HighCapacity#initGroups
     * @returns {void}
     */
    _initIdleGroups() {
        const sig = missionConstraints.allowedSpawnerTiles?.size > 0
            ? [...missionConstraints.allowedSpawnerTiles].sort().join('|') : '';
        if (this._idleGroups !== null && sig === this._idleGroupsSig) return;
        this._idleGroupsSig = sig;
        this._idlePatrolGroupIdx = null;
        if (spawnerTiles.length === 0) { this._idleGroups = []; return; }
        const pool = this._allowedSpawnerPool(spawnerTiles);
        const walkableSet = getWalkable();
        this._idleGroups = buildSpawnerGroups(pool, walkableSet, IDLE_D_CLUSTER);
        patrolLog(`built ${this._idleGroups.length} group(s) from ${pool.length} spawner tiles`);
    }

    /**
     * Index of the reachable group with a tile within OBSERVATION_DISTANCE of the
     * agent (the group it is "idle on"), or -1. Mirrors HighCapacity#isAtFarm
     * @returns {number} Group index, or -1 if not idle on any group
     */
    _idleGroupHere() {
        if (!this._idleGroups) return -1;
        for (let i = 0; i < this._idleGroups.length; i++) {
            if (this._idleGroups[i].some(t => distance(me, t) <= OBSERVATION_DISTANCE && this.isReachable(t)))
                return i;
        }
        return -1;
    }

    /** Nearest tile of `group` from the agent, ranked by exploreCost (A* path
     *  length plus the Case-6 competitor camping penalty) rather than plain
     *  pathLen. This is what keeps idle multi-agent spreading alive: a group whose
     *  nearest tile is camped by a competitor loses a near-tie, so two of our own
     *  agents don't both sweep to the same cluster. Degrades to plain pathLen when
     *  no agents are sensed (otherAgentDistTo → Infinity). `dist` stays Infinite
     *  for an unreachable group, so callers' Number.isFinite filters still hold
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {{tile: {x: number, y: number}|null, dist: number}} Nearest tile and its explore cost
     */
    _nearestGroupTile(group) {
        let best = { tile: null, dist: Infinity };
        for (const t of group) {
            const d = this.exploreCost(t);
            if (d < best.dist) best = { tile: t, dist: d };
        }
        return best;
    }

    /**
     * The group tile nearest the group's centroid. The raw centroid can land on a
     * wall between spawners, so snap to the closest actual (walkable) group tile —
     * guarantees the agent crosses the MIDDLE of the cluster, not just its edge
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {{x: number, y: number}} Group tile nearest the centroid
     */
    _groupCentroidTile(group) {
        const cx = group.reduce((s, t) => s + t.x, 0) / group.length;
        const cy = group.reduce((s, t) => s + t.y, 0) / group.length;
        let best = group[0], bestD = Infinity;
        for (const t of group) {
            const d = (t.x - cx) ** 2 + (t.y - cy) ** 2;
            if (d < bestD) { bestD = d; best = t; }
        }
        return best;
    }

    /**
     * Centroid-angle clockwise waypoint loop. Port of HighCapacity#buildPatrol
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {Array<{x: number, y: number}>} Ordered patrol waypoints
     */
    _buildIdlePatrol(group) {
        if (group.length === 1) return [group[0]];
        if (group.length === 2) return [...group];
        const cx = group.reduce((s, t) => s + t.x, 0) / group.length;
        const cy = group.reduce((s, t) => s + t.y, 0) / group.length;
        const byAngle = [...group].sort((a, b) =>
            Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
        if (byAngle.length <= IDLE_MAX_WAYPOINTS) return byAngle;
        const step = byAngle.length / IDLE_MAX_WAYPOINTS;
        return Array.from({ length: IDLE_MAX_WAYPOINTS },
            (_, i) => byAngle[Math.round(i * step) % byAngle.length]);
    }

    /**
     * Issue the next patrol waypoint for a group (rebuilds patrol on group change,
     * starts at the nearest waypoint, advances on arrival). Port of the #goFarm
     * patrol body
     * @param {number} groupIdx - Index of the group to patrol
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_explore', x, y], or null to keep walking / nothing reachable
     */
    _idlePatrolStep(groupIdx, currentIntent) {
        if (this._idlePatrolGroupIdx !== groupIdx) {
            this._idlePatrol = this._buildIdlePatrol(this._idleGroups[groupIdx]);
            this._idlePatrolGroupIdx = groupIdx;
            // Start at the cheapest waypoint by exploreCost, not raw pathLen, so the
            // entry point shifts off a competitor-camped tile (Case-6 anti-camping).
            let bestI = 0, bestD = Infinity;
            for (let i = 0; i < this._idlePatrol.length; i++) {
                const d = this.exploreCost(this._idlePatrol[i]);
                if (d < bestD) { bestD = d; bestI = i; }
            }
            this._idlePatrolIdx = bestI;
            patrolLog(`idle patrol G${groupIdx}: ${this._idlePatrol.length} wp `
                + this._idlePatrol.map(t => `(${t.x},${t.y})`).join(' '));
        }
        const cur = this._idlePatrol[this._idlePatrolIdx];
        if (Math.round(me.x) === cur.x && Math.round(me.y) === cur.y)
            this._idlePatrolIdx = (this._idlePatrolIdx + 1) % this._idlePatrol.length;

        for (let tries = 0; tries < this._idlePatrol.length; tries++) {
            const target = this._idlePatrol[this._idlePatrolIdx];
            if (this.isReachable(target)) {
                if (currentIntent?.[0] === 'go_explore'
                        && currentIntent[1] === target.x && currentIntent[2] === target.y)
                    return null;                     // already walking there
                patrolLog(`idle patrol G${groupIdx} → wp ${this._idlePatrolIdx + 1}/${this._idlePatrol.length} (${target.x},${target.y})`);
                return ['go_explore', target.x, target.y];
            }
            this._idlePatrolIdx = (this._idlePatrolIdx + 1) % this._idlePatrol.length;
        }
        return null;   // nothing reachable in this group
    }

    /**
     * Dense path: head to the centroid tile of the nearest unvisited group. When
     * all groups are visited, clear the set and restart the sweep
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_explore', x, y], or null while walking / nothing to do
     */
    _nextUnvisitedGroup(currentIntent) {
        let cands = this._idleGroups
            .map((g, idx) => ({ idx, ...this._nearestGroupTile(g) }))
            .filter(e => Number.isFinite(e.dist) && !this._idleVisitedGroups.has(e.idx));
        if (cands.length === 0) {
            // Swept every group — restart, excluding the one we're on so we move.
            this._idleVisitedGroups.clear();
            const here = this._idleGroupHere();
            cands = this._idleGroups
                .map((g, idx) => ({ idx, ...this._nearestGroupTile(g) }))
                .filter(e => Number.isFinite(e.dist) && e.idx !== here);
            if (cands.length === 0) return null;
        }
        const pick = cands.sort((a, b) => a.dist - b.dist)[0];
        const centroid = this._groupCentroidTile(this._idleGroups[pick.idx]);

        // Already sensing the chosen group's centre → mark visited, re-deliberate.
        if (distance(me, centroid) <= OBSERVATION_DISTANCE) {
            this._idleVisitedGroups.add(pick.idx);
            return null;
        }
        // Already walking toward it → keep going.
        if (currentIntent?.[0] === 'go_explore'
                && currentIntent[1] === centroid.x && currentIntent[2] === centroid.y)
            return null;
        patrolLog(`dense (#spawners=${spawnerTiles.length}>${IDLE_PATROL_MAX_SPAWNERS}) → G${pick.idx} centroid (${centroid.x},${centroid.y})`);
        return ['go_explore', centroid.x, centroid.y];
    }

    /**
     * Call super.exploreIfIdle but exclude a just-abandoned group's tiles so the
     * next target is the next-nearest spawner OUTSIDE that group
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to stay idle
     */
    _exploreOutsideLeftGroup(currentIntent) {
        const left = this._idleLeftGroupKeys;
        if (!left || left.size === 0) return super.exploreIfIdle(currentIntent);
        this._idleExcludeKeys = left;
        const result = super.exploreIfIdle(currentIntent);
        this._idleExcludeKeys = null;
        return result;
    }
}
