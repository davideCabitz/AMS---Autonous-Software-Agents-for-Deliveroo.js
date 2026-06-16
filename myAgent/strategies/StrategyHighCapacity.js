import { StrategyLookAhead } from './StrategyLookAhead.js';
import { buildSpawnerGroups } from '../beliefs/SpawnerGroups.js';
import {
    me, parcels, spawnerTiles, walkableTiles, deliveryTiles,
    OBSERVATION_DISTANCE, CARRYING_CAPACITY, missionConstraints,
} from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('highcap');

// Max walkable-path steps for two spawners to merge into one group (same value
// the stochastic strategy uses, so group shapes match across strategies).
const D_CLUSTER = 2;
// Dry-spell timeout: with no eligible parcel sensed for this long, the agent
// stops camping the current group and either hops to a neighbour or banks.
export const PATIENCE_MS = 3000;
// Max A* path length for an en-route detour (parcel or speculative group visit)
// while travelling to a delivery with spare capacity.
export const DETOUR_MAX_TILES = 5;
// Soft load floor: at or above this fraction of capacity a patience expiry
// banks the load instead of hopping to another group.
const MIN_LOAD_FRACTION = 0.6;
// Extra tiles above the direct farm route that a delivery detour may add and
// still be considered "on the way" to the farm group.
const ENROUTE_DELIVERY_SLACK = 3;
// A hop while carrying is viable only when the decay it inflicts on the load
// stays below this fraction of the carried reward.
const HOP_MAX_LOSS_FRACTION = 0.25;
// En-route farm switch: while walking to the chosen farm group, re-target a
// different group only when its yield-per-distance score (count / A* dist from the
// CURRENT position) beats the committed group's by at least this factor. The
// margin (>1) is hysteresis — it stops two comparable groups from flip-flopping
// the farm target every tick as the agent moves between them.
const FARM_SWITCH_MARGIN = 1.3;

/**
 * Strategy for high-capacity maps (CARRYING_CAPACITY > 5).
 *
 * LookAhead weighs every pickup against banking now, so it delivers with small
 * loads — wasted trips when the hold is large. This strategy farms instead:
 *
 *  FARM    — head to the spawner group with the most cells (ties broken by A*
 *            distance) and greedily pick up every positive-value parcel there,
 *            skipping LookAhead's bank-first comparison while below capacity.
 *  HOP     — when no eligible parcel has been seen for PATIENCE_MS, move to the
 *            best other group (count / A* distance), unless the load is already
 *            ≥ MIN_LOAD_FRACTION of capacity or the hop's decay cost is too
 *            high — then bank instead.
 *  DELIVER — at capacity, go straight to the nearest escapable delivery. With
 *            spare capacity, detour to parcels OR unvisited spawner groups
 *            within DETOUR_MAX_TILES of the current position (speculative —
 *            no sensed parcel required); an empty group is marked visited for
 *            the rest of the trip and delivery resumes. After banking, groups
 *            are re-ranked and the cycle restarts at FARM.
 *
 * Inherits the value model, pathLen, parcel memory and hysteresis from
 * StrategyLookAhead; eligibility filters (reachable, safe-region) are
 * unchanged — only the ranking/commitment logic differs. Falls back to plain
 * LookAhead behaviour on maps with no spawner groups.
 */
export class StrategyHighCapacity extends StrategyLookAhead {
    /** Heartbeat so the patience timer fires even with no sensing events. */
    tickIntervalMs = 500;

    /** @type {Array<Array<{x:number,y:number}>>|null} lazily built group list */
    #groups = null;
    /** Index of the group currently being farmed (null = re-rank on next use). */
    #farmIdx = null;
    /** @type {'farm'|'deliver'} */
    #phase = 'farm';
    /** Timestamp of the last tick that saw at least one eligible parcel. */
    #lastParcelTs = Date.now();
    /** Patrol waypoints covering the farm group's spawners with sensing discs. */
    #patrol = [];
    /** Index of the waypoint currently being walked to. */
    #patrolIdx = 0;
    /** Group the patrol was built for (rebuilt when the farm group changes). */
    #patrolGroupIdx = null;
    /** Whether the agent was inside the farm group's sensing area last tick. */
    #wasAtFarm = false;
    /** Group we just hopped AWAY from because it went dry. Excluded from en-route
     *  farm switching (it's still nearby, so its score is high) until the agent
     *  reaches a farm group, so a dry group can't immediately pull us back. */
    #hopFromIdx = null;
    /** Group indices already speculatively visited during the current delivery trip. */
    #visitedDetours = new Set();
    /** Signature of the allowedSpawnerTiles constraint the groups were built
     *  under — a restrict_exploration mission applied mid-run rebuilds them. */
    #groupsSig = null;

    // ── constructor config (set once, not virtual) ───────────────────────────
    #deliveryCap;
    #detoursEnabled;
    #opportunisticPickup;

    /**
     * @param {object} [cfg]
     * @param {number}  [cfg.deliveryCap]        Carried count that triggers DELIVER. Default: CARRYING_CAPACITY.
     * @param {boolean} [cfg.detoursEnabled]     Allow speculative group visits during delivery. Default: true.
     * @param {boolean} [cfg.opportunisticPickup] Allow picking up parcels while en route to delivery. Default: true.
     */
    constructor({ deliveryCap = CARRYING_CAPACITY, detoursEnabled = true, opportunisticPickup = true } = {}) {
        super();
        this.#deliveryCap      = deliveryCap;
        this.#detoursEnabled   = detoursEnabled;
        this.#opportunisticPickup = opportunisticPickup;
    }

    decide(currentIntent) {
        this.#initGroups();
        if (this.#groups.length === 0) return super.decide(currentIntent);

        const carrying = parcels.carriedBy(me.id);
        const now = Date.now();

        // Load banked → fresh farming cycle: re-rank groups, reset trip state.
        if (this.#phase === 'deliver' && carrying.length === 0) {
            this.#phase   = 'farm';
            this.#farmIdx = null;
            this.#hopFromIdx = null;
            this.#visitedDetours.clear();
            this.#lastParcelTs = now;
            log('load banked → FARM, groups re-ranked');
        }

        const eligible = this.#eligibleParcels();
        if (eligible.some(p => this._countsForPatience(p))) this.#lastParcelTs = now;

        // Mission gates (LLM layer): maxBundleValue → single-parcel trips, so the
        // hold is "full" at 1; requiredStackSize → never enter DELIVER before the
        // stack is complete (stackReady), exactly like the other strategies.
        const effectiveCap = this.singleParcelBundles() ? 1 : this.#deliveryCap;
        if (carrying.length >= effectiveCap && this.stackReady(carrying)) {
            this.#phase = 'deliver';
            return this.#deliver(currentIntent, false, false, eligible);
        }

        if (this.#phase === 'deliver')
            return this.#deliver(
                currentIntent,
                this.#opportunisticPickup && !this.singleParcelBundles(),
                this.#detoursEnabled,
                eligible,
            );

        // ── FARM: grab the next parcel (selection policy is a subclass hook) ──
        if (eligible.length > 0) {
            const choice = this._pickFarmTarget(eligible);
            if (choice) {
                if (this.shouldKeepCurrentPickup(currentIntent, choice)) return null;
                log(`FARM pickup ${this.pickupDebug(choice.p)}`);
                return ['go_pick_up', choice.p.x, choice.p.y, choice.p.id];
            }
        }

        // The patience timer counts only while actually sensing the farm area:
        // a far group can take longer than PATIENCE_MS just to walk to, and
        // counting travel as a dry spell made the agent hop back and forth
        // between groups without ever arriving at either.
        const atFarm = this.#isAtFarm();
        if (atFarm && !this.#wasAtFarm) this.#lastParcelTs = now; // just arrived
        this.#wasAtFarm = atFarm;

        // Dry spell over the patience window → hop or bank.
        if (atFarm && now - this.#lastParcelTs >= PATIENCE_MS)
            return this.#hopOrBank(currentIntent, carrying);

        return this.#goFarm(currentIntent);
    }

    // ── subclass hooks ───────────────────────────────────────────────────────

    /**
     * Which parcel to pick up opportunistically while delivering. Base policy:
     * best pickupValue within DETOUR_MAX_TILES A* path. Subclasses may tighten
     * the filter (quality bar, in-sight only, etc.).
     * Returns {p, value} or undefined.
     */
    _pickDeliveryTarget(eligible) {
        return eligible
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ p, value }) => value > 0 && this.pathLen(me, p) <= DETOUR_MAX_TILES)
            .sort((a, b) => b.value - a.value)[0];
    }

    /** Whether a visible parcel counts as a "sighting" that resets the patience
     *  timer. Subclasses with a quality bar exclude parcels they'd never take,
     *  so trash spawns can't keep the agent camping a dry group forever. */
    _countsForPatience(_parcel) {
        return true;
    }

    /**
     * FARM pickup policy: which eligible parcel to go for next. Default is the
     * best positive pickupValue (greedy on value, no bank-first gate). Returns
     * {p, value} (value used by the hysteresis check) or null/undefined.
     */
    _pickFarmTarget(eligible) {
        return eligible
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value > 0)
            .sort((a, b) => b.value - a.value)[0];
    }

    // ── groups ───────────────────────────────────────────────────────────────

    #initGroups() {
        // Rebuild whenever the allowedSpawnerTiles mission constraint changes
        // (restrict_exploration can arrive mid-run), not just on first use.
        const sig = missionConstraints.allowedSpawnerTiles?.size > 0
            ? [...missionConstraints.allowedSpawnerTiles].sort().join('|')
            : '';
        if (this.#groups !== null && sig === this.#groupsSig) return;
        this.#groupsSig = sig;
        this.#farmIdx = null;
        this.#patrolGroupIdx = null;
        this.#visitedDetours.clear();
        let pool = spawnerTiles;
        if (missionConstraints.allowedSpawnerTiles?.size > 0) {
            const f = spawnerTiles.filter(t => missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) pool = f;
        }
        const walkableSet = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
        this.#groups = buildSpawnerGroups(pool, walkableSet, D_CLUSTER);
        log(`built ${this.#groups.length} group(s) from ${pool.length} spawner tiles: `
            + this.#groups.map((g, i) => `G${i}(n=${g.length})`).join(' '));
    }

    /** Nearest tile of `group` from the agent, by A* path length. */
    #nearestTile(group) {
        let best = { tile: null, dist: Infinity };
        for (const t of group) {
            const d = this.pathLen(me, t);
            if (d < best.dist) best = { tile: t, dist: d };
        }
        return best;
    }

    /** Yield-per-distance score of a group from the agent's current position:
     *  cell count / A* distance. Higher = a richer and/or closer group. Matches
     *  the score #bestNeighbourGroup uses for hops, so farm selection, en-route
     *  switching and hopping all agree on what "best" means. */
    #farmScore(e) {
        return e.count / Math.max(1, e.dist);
    }

    /**
     * Group to farm, by yield-per-distance (count / A* distance) — NOT raw cell
     * count, which would always lock onto the single biggest group even when it's
     * across the map and a nearly-as-big one sits on the way.
     *
     * The chosen group is cached in #farmIdx so the agent commits to a target, but
     * while still travelling to it we re-evaluate from the CURRENT position: as the
     * agent approaches another large group its distance shrinks, its score climbs,
     * and once it beats the committed group's score by FARM_SWITCH_MARGIN we switch
     * to it. The margin is hysteresis against flip-flopping between comparable
     * groups. Re-evaluation stops once the agent is actually at the farm (#isAtFarm)
     * so it doesn't abandon a group it just arrived to patrol.
     */
    #selectFarmGroup() {
        const ranked = this.#groups
            .map((g, idx) => ({ idx, count: g.length, ...this.#nearestTile(g) }))
            .filter(e => Number.isFinite(e.dist))
            .sort((a, b) => this.#farmScore(b) - this.#farmScore(a));
        if (ranked.length === 0) return this.#farmIdx;

        if (this.#farmIdx === null) {
            this.#farmIdx = ranked[0].idx;
            log(`farm group → G${this.#farmIdx} (n=${ranked[0].count}, dist=${ranked[0].dist}, score=${this.#farmScore(ranked[0]).toFixed(2)})`);
            return this.#farmIdx;
        }

        // En-route switch: not yet at the committed group, and a different group
        // now scores clearly higher from where we are → re-target it. The group we
        // just hopped away from (dry) is excluded so it can't immediately pull us
        // back; the exclusion clears once we actually reach a farm.
        if (this.#isAtFarm()) {
            this.#hopFromIdx = null;
        } else {
            const best = ranked.find(e => e.idx !== this.#hopFromIdx);
            const cur  = ranked.find(e => e.idx === this.#farmIdx);
            if (best && best.idx !== this.#farmIdx && cur
                    && this.#farmScore(best) >= FARM_SWITCH_MARGIN * this.#farmScore(cur)) {
                log(`farm switch G${this.#farmIdx}(score=${this.#farmScore(cur).toFixed(2)}) → G${best.idx}(n=${best.count}, dist=${best.dist}, score=${this.#farmScore(best).toFixed(2)}) en route`);
                this.#farmIdx = best.idx;
            }
        }
        return this.#farmIdx;
    }

    /**
     * If a delivery tile lies at most ENROUTE_DELIVERY_SLACK extra tiles off
     * the direct route from the agent to `farmTarget`, return that delivery
     * tile (the nearest such one). Returns null when no delivery qualifies.
     *
     * Condition: dist(me→D) + dist(D→farm) ≤ dist(me→farm) + SLACK
     */
    #enRouteDelivery(farmTarget) {
        // A deliveryMultipliers mission is active: skip the nearest-tile en-route
        // shortcut (it ignores the multiplier and could short-bank at a 1×/0× tile)
        // and defer to the multiplier-aware nearestEscapableDelivery on the main
        // DELIVER path. No-op when no such mission is set.
        if (missionConstraints.deliveryMultipliers?.size > 0) return null;
        const directDist = this.pathLen(me, farmTarget);
        if (!Number.isFinite(directDist)) return null;
        // allowedDeliveryTiles mission: only constraint-approved tiles qualify.
        let tiles = deliveryTiles;
        if (missionConstraints.allowedDeliveryTiles?.size > 0) {
            const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
            if (f.length > 0) tiles = f;
        }
        const candidates = [];
        for (const d of tiles) {
            const toD   = this.pathLen(me, d);
            const dFarm = this.pathLen(d, farmTarget);
            if (Number.isFinite(toD) && Number.isFinite(dFarm)
                    && toD + dFarm <= directDist + ENROUTE_DELIVERY_SLACK)
                candidates.push({ d, toD });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.toD - b.toD);
        return candidates[0].d;
    }

    /** True when at least one spawner of the current farm group is within
     *  sensing range — i.e. the agent has arrived and is actually farming. */
    #isAtFarm() {
        const idx = this.#farmIdx;
        if (idx === null || !this.#groups[idx]) return false;
        return this.#groups[idx].some(t => distance(me, t) <= OBSERVATION_DISTANCE);
    }

    // ── FARM movement ────────────────────────────────────────────────────────

    #goFarm(currentIntent) {
        const idx = this.#selectFarmGroup();
        if (idx === null) return this.exploreIfIdle(currentIntent);

        // (Re)build the patrol when the farm group changed, starting from the
        // waypoint nearest to the agent.
        if (this.#patrolGroupIdx !== idx) {
            this.#patrol = this.#buildPatrol(this.#groups[idx]);
            this.#patrolGroupIdx = idx;
            let bestI = 0, bestD = Infinity;
            for (let i = 0; i < this.#patrol.length; i++) {
                const d = this.pathLen(me, this.#patrol[i]);
                if (d < bestD) { bestD = d; bestI = i; }
            }
            this.#patrolIdx = bestI;
            log(`FARM patrol for G${idx}: ${this.#patrol.length} waypoint(s) `
                + this.#patrol.map(t => `(${t.x},${t.y})`).join(' '));
        }

        // Patrol: keep moving across the group so every spawner
        // cell passes through sensing range while waiting for spawns.
        if (Math.round(me.x) === this.#patrol[this.#patrolIdx].x
                && Math.round(me.y) === this.#patrol[this.#patrolIdx].y)
            this.#patrolIdx = (this.#patrolIdx + 1) % this.#patrol.length;

        for (let tries = 0; tries < this.#patrol.length; tries++) {
            const target = this.#patrol[this.#patrolIdx];
            if (this.isReachable(target)) {
                if (currentIntent?.[0] === 'go_explore'
                        && currentIntent[1] === target.x && currentIntent[2] === target.y)
                    return null;
                // En-route delivery: if carrying parcels and a delivery tile lies
                // ≤ ENROUTE_DELIVERY_SLACK extra tiles off the path to the farm
                // waypoint, stop and deliver now — the farm group index is kept
                // so the agent resumes the same group after banking.
                const carried = parcels.carriedBy(me.id);
                if (carried.length > 0 && this.stackReady(carried)) {
                    const deliver = this.#enRouteDelivery(target);
                    if (deliver) {
                        log(`FARM en-route delivery to (${deliver.x},${deliver.y}) before G${idx}`);
                        this.#phase = 'deliver';
                        this.#visitedDetours.clear();
                        return ['go_deliver', deliver.x, deliver.y];
                    }
                }
                log(`FARM patrol G${idx} → waypoint ${this.#patrolIdx + 1}/${this.#patrol.length} (${target.x},${target.y})`);
                return ['go_explore', target.x, target.y];
            }
            this.#patrolIdx = (this.#patrolIdx + 1) % this.#patrol.length;
        }
        this.#farmIdx = null; // no waypoint reachable — re-rank next tick
        this.#patrolGroupIdx = null;
        return this.exploreIfIdle(currentIntent);
    }

    /**
     * Patrol waypoints for the group. The agent always keeps moving so every
     * spawner cell passes through sensing range during the dry-spell window.
     *
     * Strategy: compute the group centroid, then pick waypoints by sorting
     * spawner tiles by angle around the centroid (clockwise). This gives a
     * loop that naturally covers the spatial extent of the group regardless
     * of sensing radius. At least 2 waypoints are always returned even for a
     * single-tile group (centroid tile used twice would be a no-op, so we
     * add the nearest-to-centroid and farthest-from-centroid tiles as the two
     * extremes). The number of waypoints is capped so the patrol stays snappy.
     */
    #buildPatrol(group) {
        if (group.length === 1) return [group[0]];

        // Centroid of all group spawner tiles.
        const cx = group.reduce((s, t) => s + t.x, 0) / group.length;
        const cy = group.reduce((s, t) => s + t.y, 0) / group.length;

        // If the group has only 2 tiles just use both.
        if (group.length === 2) return [...group];

        // Sort by angle around centroid → clockwise loop.
        const byAngle = [...group].sort((a, b) =>
            Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
        );

        // Cap the patrol length so the agent doesn't spend forever on large
        // groups: keep every k-th tile so we get at most MAX_WAYPOINTS stops.
        const MAX_WAYPOINTS = 6;
        if (byAngle.length <= MAX_WAYPOINTS) return byAngle;
        const step = byAngle.length / MAX_WAYPOINTS;
        return Array.from({ length: MAX_WAYPOINTS }, (_, i) => byAngle[Math.round(i * step) % byAngle.length]);
    }

    // ── HOP / bank decision ──────────────────────────────────────────────────

    #hopOrBank(currentIntent, carrying) {
        const cap = this.#deliveryCap;
        const minLoad = Number.isFinite(cap)
            ? Math.ceil(MIN_LOAD_FRACTION * cap)
            : Infinity;
        if (carrying.length < minLoad) {
            const hop = this.#bestNeighbourGroup(carrying);
            if (hop) {
                log(`HOP G${this.#farmIdx ?? '?'} dry for ${PATIENCE_MS}ms → G${hop.idx} (n=${hop.count}, dist=${hop.dist})`);
                this.#hopFromIdx = this.#farmIdx; // don't let the dry group pull us back en route
                this.#farmIdx = hop.idx;
                this.#lastParcelTs = Date.now();
                return this.#goFarm(currentIntent);
            }
        }
        // stackReady (LLM layer): a requiredStackSize mission forbids banking a
        // short stack — keep hunting parcels instead of delivering early.
        if (carrying.length > 0 && this.stackReady(carrying)) {
            this.#phase = 'deliver';
            // The current group is dry — don't speculatively revisit it en route.
            if (this.#farmIdx !== null) this.#visitedDetours.add(this.#farmIdx);
            log(`patience expired with ${carrying.length}/${cap} carried → DELIVER`);
            return this.#deliver(
                currentIntent,
                this.#opportunisticPickup && !this.singleParcelBundles(),
                this.#detoursEnabled,
                [],
            );
        }
        if (this.mustStack(carrying))
            log(`stack ${carrying.length}/${missionConstraints.requiredStackSize} — patience expired but mission forbids banking; exploring on`);
        return this.exploreIfIdle(currentIntent);
    }

    /**
     * Best other group by count/distance score. While carrying, the hop is
     * viable only if its decay loss stays under HOP_MAX_LOSS_FRACTION of the
     * carried reward; otherwise null (→ bank instead).
     */
    #bestNeighbourGroup(carrying) {
        const best = this.#groups
            .map((g, idx) => ({ idx, count: g.length, ...this.#nearestTile(g) }))
            .filter(e => e.idx !== this.#farmIdx && Number.isFinite(e.dist))
            .sort((a, b) => b.count / Math.max(1, b.dist) - a.count / Math.max(1, a.dist))[0];
        if (!best) return null;
        if (carrying.length > 0) {
            const R    = carrying.reduce((s, p) => s + p.reward, 0);
            const loss = carrying.length * this.decayRate() * best.dist;
            if (loss > HOP_MAX_LOSS_FRACTION * R) {
                log(`hop to G${best.idx} rejected: decay loss ${loss.toFixed(1)} > ${(HOP_MAX_LOSS_FRACTION * R).toFixed(1)}`);
                return null;
            }
        }
        return best;
    }

    // ── DELIVER with en-route detours ────────────────────────────────────────

    #deliver(currentIntent, allowPickup, allowSpeculative, eligible) {
        // 1. Opportunistic parcel pickup: qualifying parcel already in view.
        if (allowPickup) {
            const near = this._pickDeliveryTarget(eligible);
            if (near) {
                if (this.shouldKeepCurrentPickup(currentIntent, near)) return null;
                log(`DELIVER pickup ${this.pickupDebug(near.p)}`);
                return ['go_pick_up', near.p.x, near.p.y, near.p.id];
            }
        }

        // 2. Speculative group visit: go_explore an unvisited nearby spawner group.
        if (allowSpeculative) {
            if (currentIntent?.[0] === 'go_explore') {
                // Mid-speculative-detour: keep going until the group is in reach;
                // a parcel sensed on the way is caught by check 1 above.
                if (distance(me, { x: currentIntent[1], y: currentIntent[2] }) > 1) return null;
                // Arrived and nothing eligible — fall through and resume delivery.
            } else {
                const spec = this.#groups
                    .map((g, idx) => ({ idx, ...this.#nearestTile(g) }))
                    .filter(e => !this.#visitedDetours.has(e.idx)
                        && e.dist > 0 && e.dist <= DETOUR_MAX_TILES)
                    .sort((a, b) => a.dist - b.dist)[0];
                if (spec) {
                    this.#visitedDetours.add(spec.idx);
                    log(`DELIVER speculative detour → G${spec.idx} (${spec.tile.x},${spec.tile.y}) dist=${spec.dist}`);
                    return ['go_explore', spec.tile.x, spec.tile.y];
                }
            }
        }

        if (this.betterDelivery(currentIntent)) return null;
        const target = this.nearestEscapableDelivery();
        if (target) {
            log(`DELIVER (${parcels.carriedBy(me.id).length}/${this.#deliveryCap}) → (${target.x},${target.y})`);
            return ['go_deliver', target.x, target.y];
        }
        log('no reachable delivery — repositioning');
        return this.exploreIfIdle(currentIntent);
    }

    // ── candidate pool (same eligibility filters as LookAhead) ──────────────

    #eligibleParcels() {
        const remembered = parcels.remembered();
        const all = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id) && this.rememberedWorthPursuing(r)),
        ];
        // missionPickupOk (LLM layer): maxParcelReward / maxBundleValue ceilings.
        return all.filter(p => this.missionPickupOk(p) && this.isReachable(p) && this.inSafe(p));
    }
}
