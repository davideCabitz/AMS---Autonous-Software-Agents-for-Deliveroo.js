import { StrategyMemory } from './StrategyMemory.js';
import { MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN, SWITCH_MARGIN } from './Strategy.js';
import {
    me, parcels, CARRYING_CAPACITY, missionConstraints,
    spawnerTiles, OBSERVATION_DISTANCE,
} from '../context.js';
import { buildGroupsWithSig, spawnerConstraintSig, buildCentroidPatrol } from './SpawnerGroupPatrol.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lookahead');
const patrolLog = createLogger('patrol-idle');

// Value band for look-ahead decisions, in reward points: the paired tour must beat
// taking the greedy parcel solo by ≥ this to collect a second at all; one visit order
// must beat the other by ≥ this to win on value, else the shorter total tour goes
// first (the distance tie-break gives sane ordering on low/no-decay maps).
const LOOKAHEAD_MARGIN = 1;

// ─── idle group-patrol (anti-camping) ─────────────────────────────────────────
const IDLE_D_CLUSTER         = 2;     // matches HighCapacity D_CLUSTER
const IDLE_PATIENCE_MS       = 3000;  // sparse-map: patrol a dry group this long before leaving
const IDLE_MAX_WAYPOINTS     = 6;     // matches HighCapacity patrol cap
// Sparsity gate: patrol-and-wait only at or below this many spawner TILES total
// (respawn-waiting is then the only source of parcels). Above this the map is dense,
// so idle = move to the next unvisited group's centroid. Gated on TILE count, not
// group COUNT: a row of adjacent spawners merges into one group, which would misfire.
const IDLE_PATROL_MAX_SPAWNERS = 12;

/**
 * @class StrategyLookAhead
 * 2-step pickup-pair look-ahead plus idle group patrol with spawner clustering.
 *
 *   me → C → G → delivery     vs     me → G → C → delivery
 *   value = (R + reward_C + reward_G) − (n+2)·ρ·(d1 + d2 + d3)
 *
 * mirroring pickupValue()'s decay model with two new parcels. The agent detours to C
 * first only when the pair beats G solo and the C-first order wins (by value, or by a
 * shorter total tour within LOOKAHEAD_MARGIN). There is NO geometric "on the way"
 * gate: under decay the longer order is already lower-value, so an opposite-direction
 * parcel is grabbed first when it shortens the tour. G stays in the pool for next time.
 *
 * Plug-and-play. Requires parcels.enableMemory() before running, like StrategyMemory.
 */
export class StrategyLookAhead extends StrategyMemory {
    /** @type {number} Heartbeat so the idle patience timer fires without sensing events
     *  (a subclass field initializer runs after this and wins, so its value is kept) */
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
     * Decide the next intention via the 2-step look-ahead over the merged live +
     * remembered parcel pool
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying   = parcels.carriedBy(me.id);
        const bankNow    = this.bankNowValue();
        const remembered = parcels.remembered();

        // Same merged pool as StrategyMemory (free live + remembered not live again),
        // pre-screened to topN by raw reward when capacity is finite.
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

        // Grab-underfoot pre-empt: a free parcel on our own tile is free to take and
        // ends the trip-reordering flip-flop that otherwise has two near-symmetric
        // tour orders swap the first stop every cycle (neither parcel ever reached,
        // see #shouldKeep's line-249 free-reorder bypass). Pickup is one tick; no tour
        // can beat it. Gated by the same value floor as a normal pickup.
        const underfoot = eligible
            .filter(p => distance(me, p) === 0)
            .map(p => ({ p, gain: this.pickupGain(p) }))
            .filter(({ gain }) => gain >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.gain - a.gain)[0];
        if (underfoot && !this.stackFull(carrying)) {
            log(`→ go_pick_up underfoot ${underfoot.p.id} gain:${underfoot.gain.toFixed(1)}`);
            return ['go_pick_up', underfoot.p.x, underfoot.p.y, underfoot.p.id];
        }

        if (carrying.length > 0) {
            // A maxStackSize CAP bounds the bundle: at ≥ cap (stackFull) stop picking up
            // and deliver, else the value gate overshoots ("deliver 2" delivered 4).
            // maxBundleValue / cap of 1 forbid a second parcel outright. ("at least N"
            // sets no cap and keeps stacking past N — intended.)
            const noMorePickups = this.singleParcelBundles() || this.stackFull(carrying);
            // Below the requiredStackSize FLOOR, mustStack relaxes the value gate.
            const worthwhile = noMorePickups ? [] : eligible
                .map(p => ({ p, value: this.pickupValue(p) }))
                .filter(({ p, value }) => this.mustStack(carrying) || value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
                .sort((a, b) => b.value - a.value);

            // When the NEXT pickup hits the cap (the last one), take the best SINGLE
            // parcel — the 2-parcel look-ahead would optimise a tour we won't make.
            const lastPickupBeforeCap = missionConstraints.maxStackSize != null
                && carrying.length === missionConstraints.maxStackSize - 1;
            const choice = (!this.atCapacity() && worthwhile.length > 0)
                ? (lastPickupBeforeCap
                    ? { p: worthwhile[0].p, value: worthwhile[0].value, via: 'direct' }
                    : this.#chooseTarget(worthwhile, carrying.length))
                : undefined;
            // When no further pickup is allowed, skip hysteresis — #shouldKeep(_,
            // undefined) would keep any pending go_pick_up and overshoot the stack.
            if (!noMorePickups && !this.atCapacity() && this.#shouldKeep(currentIntent, choice))
                return null;
            if (choice) {
                this.#logChoice('multi-pickup', choice);
                return ['go_pick_up', choice.p.x, choice.p.y, choice.p.id];
            }

            // Stack incomplete and nothing worth grabbing: keep accumulating (explore
            // toward spawners) instead of delivering early.
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
            // The 2-parcel look-ahead picks the best FIRST STOP of a 2-pickup tour. With
            // a cap of one (maxStackSize===1) the agent carries exactly one, so that
            // pairing is wrong — take the greedy best SINGLE parcel (ranked[0]).
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
     * Pick the next pickup target. Starts from the greedy winner G, then, if two
     * parcels will be collected anyway, scores both visit orders by pickupValue()'s
     * decay model extended to two parcels:
     *   me → C → G → delivery   vs   me → G → C → delivery
     *   value = (R + r_C + r_G) − (n+2)·ρ·(d1 + d2 + d3)
     * Commits to a near-first detour only when the best pair beats G solo (no worthless
     * second parcel) AND the C-first order wins — by value (LOOKAHEAD_MARGIN) or, within
     * the band, a shorter total tour. No geometric "on the way" gate (decay already
     * makes the longer order lower-value). `ranked` already passed the cost thresholds.
     *
     * @param {{p:object,value:number}[]} ranked  candidates, best first
     * @param {number} nCarried                   parcels currently carried
     * @returns {{p:object,value:number,via:'direct'|'lookahead',second?:object,legs?:object}}
     */
    #chooseTarget(ranked, nCarried) {
        const greedy = ranked[0];
        const direct = { p: greedy.p, value: greedy.value, via: 'direct' };
        // The paired plan needs room for two pickups.
        const roomForTwo = !Number.isFinite(CARRYING_CAPACITY)
            || nCarried + 2 <= CARRYING_CAPACITY;
        if (!roomForTwo || ranked.length < 2) return direct;

        // Best parcel to pair with G, scoring both visit orders.
        let best = null;
        for (const { p: c } of ranked.slice(1)) {
            const cFirst = this.#tourValue(c, greedy.p);   // me → C → G → delivery
            const gFirst = this.#tourValue(greedy.p, c);   // me → G → C → delivery
            if (!cFirst || !gFirst) continue;
            const pairBest = Math.max(cFirst.value, gFirst.value);
            if (!best || pairBest > best.pairBest) best = { c, cFirst, gFirst, pairBest };
        }
        if (!best) return direct;

        // Only collect a second parcel when the pair beats G solo.
        if (best.pairBest < greedy.value + LOOKAHEAD_MARGIN) return direct;

        // Decide order: value wins by the margin; within the band, shorter tour first.
        const { cFirst, gFirst, c } = best;
        const dv = cFirst.value - gFirst.value;
        const goNear = dv >= LOOKAHEAD_MARGIN
            || (Math.abs(dv) < LOOKAHEAD_MARGIN && cFirst.dist <= gFirst.dist);
        if (goNear)
            return { p: c, second: greedy.p, value: cFirst.value, via: 'lookahead', legs: cFirst.legs };
        return direct; // greedy-first: head to G now, grab C next deliberation
    }

    /**
     * Value and total length of the tour me → first → second → delivery (pickupValue()'s
     * decay model for two parcels). `dist` is returned for the order tie-break; null if
     * any leg is unreachable.
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
     * Hysteresis over live + remembered targets (replicated from
     * StrategyMemory.#shouldKeepWithMemory, private there).
     *
     * Commit anchor: the look-ahead re-scores the 2-parcel tour every cycle, and on
     * near-symmetric geometry the winning FIRST STOP can alternate. The old reorder
     * twist — "if cur is now the tour's SECOND stop, switching first-stop just re-orders
     * the same trip, allow it for free" — fired even when the two tours covered DIFFERENT
     * pairs (e.g. {C,G} this cycle vs {G,C'} next), swapping first stops endlessly so
     * neither parcel was ever reached. Removed: every switch now clears one margin gate,
     * compared like-for-like on the candidate first-stop's SOLO value (never the chain
     * value, which the second parcel's reward inflates past any margin). A genuine
     * same-trip reorder swaps two equal-ish parcels and so is held by SWITCH_MARGIN too —
     * harmless, since either order reaches the same pair.
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
        // Like-for-like margin: compare the candidate FIRST STOP's solo value against
        // cur's, never choice.value (a lookahead's chain value is inflated by the second
        // parcel's reward, so it would clear any margin and switch every cycle — the
        // flip-flop). Equal-value parcels never reach SWITCH_MARGIN, so cur is kept.
        return this.pickupValue(choice.p) - this.pickupValue(cur) < SWITCH_MARGIN;
    }

    /**
     * Diagnostic log line for the chosen pickup (chained or direct)
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
     * Idle behaviour replacing the base single-tile ping-pong with a group-aware policy:
     *   - SPARSE map (≤ IDLE_PATROL_MAX_SPAWNERS tiles): patrol the group the agent
     *     stands on as a waypoint loop for IDLE_PATIENCE_MS, then leave to a spawner
     *     OUTSIDE it (respawn-waiting is worth it).
     *   - DENSE map: never camp — head to the CENTROID of the nearest unvisited group,
     *     sweeping group→group. Gating on tile COUNT (not group count) is deliberate.
     * Falls back to super.exploreIfIdle when there is no group to act on.
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to keep current / stay idle
     */
    exploreIfIdle(currentIntent) {
        this._initIdleGroups();

        // Productive work in flight → drop all patrol/visited state and defer to base.
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
            // Mark the current group visited, then move to the next group's centroid.
            const here = this._idleGroupHere();
            if (here >= 0) this._idleVisitedGroups.add(here);
            const step = this._nextUnvisitedGroup(currentIntent);
            if (step) return step;
            return super.exploreIfIdle(currentIntent);
        }

        // ── sparse map: patrol-and-wait ──
        const here = this._idleGroupHere();
        if (here >= 0) {
            // (Re)start the patience window on arriving at a new group.
            if (this._idlePatrolGroupIdx !== here || this._idlePatrolTs === 0) {
                this._idlePatrolTs = now;
                this._idleLeftGroupKeys = null;
            }
            if (now - this._idlePatrolTs < IDLE_PATIENCE_MS) {
                const step = this._idlePatrolStep(here, currentIntent);
                if (step !== null || currentIntent?.[0] === 'go_explore') return step;
                // no reachable waypoint → fall through to ranking
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
     * Lazily build (and cache) idle-patrol groups, rebuilding when allowedSpawnerTiles changes
     * @returns {void}
     */
    _initIdleGroups() {
        const sig = spawnerConstraintSig();
        if (this._idleGroups !== null && sig === this._idleGroupsSig) return;
        this._idleGroupsSig = sig;
        this._idlePatrolGroupIdx = null;
        this._idleGroups = buildGroupsWithSig(IDLE_D_CLUSTER).groups;
        const poolLen = this._idleGroups.reduce((s, g) => s + g.length, 0);
        patrolLog(`built ${this._idleGroups.length} group(s) from ${poolLen} spawner tiles`);
    }

    /**
     * Index of the reachable group with a tile within OBSERVATION_DISTANCE (the group
     * the agent is "idle on"), or -1
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

    /** Nearest tile of `group`, ranked by exploreCost (pathLen + Case-6 camping
     *  penalty) not plain pathLen — so a competitor-camped group loses a near-tie and
     *  two of our agents don't sweep the same cluster. `dist` stays Infinite when
     *  unreachable, so callers' Number.isFinite filters hold.
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
     * Group tile nearest the centroid. The raw centroid can land on a wall, so snap to
     * the closest actual group tile — the agent crosses the MIDDLE of the cluster.
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
     * Centroid-angle clockwise waypoint loop
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {Array<{x: number, y: number}>} Ordered patrol waypoints
     */
    _buildIdlePatrol(group) {
        return buildCentroidPatrol(group, IDLE_MAX_WAYPOINTS);
    }

    /**
     * Issue the next patrol waypoint (rebuilds on group change, starts nearest,
     * advances on arrival)
     * @param {number} groupIdx - Index of the group to patrol
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_explore', x, y], or null to keep walking / nothing reachable
     */
    _idlePatrolStep(groupIdx, currentIntent) {
        if (this._idlePatrolGroupIdx !== groupIdx) {
            this._idlePatrol = this._buildIdlePatrol(this._idleGroups[groupIdx]);
            this._idlePatrolGroupIdx = groupIdx;
            // Start at the cheapest waypoint by exploreCost (not pathLen), so the entry
            // shifts off a competitor-camped tile (Case-6).
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
     * Dense path: head to the centroid of the nearest unvisited group; when all are
     * visited, clear the set and restart the sweep
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} ['go_explore', x, y], or null while walking / nothing to do
     */
    _nextUnvisitedGroup(currentIntent) {
        let cands = this._idleGroups
            .map((g, idx) => ({ idx, ...this._nearestGroupTile(g) }))
            .filter(e => Number.isFinite(e.dist) && !this._idleVisitedGroups.has(e.idx));
        if (cands.length === 0) {
            // Swept every group — restart, excluding the current one so we move.
            this._idleVisitedGroups.clear();
            const here = this._idleGroupHere();
            cands = this._idleGroups
                .map((g, idx) => ({ idx, ...this._nearestGroupTile(g) }))
                .filter(e => Number.isFinite(e.dist) && e.idx !== here);
            if (cands.length === 0) return null;
        }
        const pick = cands.sort((a, b) => a.dist - b.dist)[0];
        const centroid = this._groupCentroidTile(this._idleGroups[pick.idx]);

        // Already sensing the centre → mark visited, re-deliberate.
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
     * super.exploreIfIdle excluding a just-abandoned group's tiles, so the next target
     * is the nearest spawner OUTSIDE it
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
