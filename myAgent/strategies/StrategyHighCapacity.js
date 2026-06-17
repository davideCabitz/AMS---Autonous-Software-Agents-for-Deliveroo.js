import { StrategyLookAhead } from './StrategyLookAhead.js';
import { buildGroupsWithSig, spawnerConstraintSig, buildCentroidPatrol } from './SpawnerGroupPatrol.js';
import {
    me, parcels, OBSERVATION_DISTANCE, CARRYING_CAPACITY, missionConstraints,
} from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('highcap');

// Max walkable-path steps for two spawners to merge into one group (matches the
// stochastic strategy, so group shapes agree across strategies).
const D_CLUSTER = 2;
// Dry-spell timeout: no eligible parcel sensed for this long → hop or bank.
export const PATIENCE_MS = 3000;
// Max A* length for an en-route detour (parcel or speculative group) while delivering.
export const DETOUR_MAX_TILES = 5;
// Soft load floor: at/above this fraction of capacity, a patience expiry banks.
const MIN_LOAD_FRACTION = 0.6;
// Extra tiles over the direct farm route a delivery detour may add and still be
// "on the way".
const ENROUTE_DELIVERY_SLACK = 3;
// A hop while carrying is viable only if its decay stays below this fraction of reward.
const HOP_MAX_LOSS_FRACTION = 0.25;
// En-route farm switch: re-target only when another group's yield-per-distance
// (count / A* dist from CURRENT position) beats the committed one by this factor.
// The >1 margin is hysteresis against flip-flopping between comparable groups.
const FARM_SWITCH_MARGIN = 1.3;
// Patrol-waypoint cap per group so the sweep stays snappy on big groups.
const MAX_WAYPOINTS = 6;

/**
 * @class StrategyHighCapacity
 * High-capacity maps: farm a spawner group, deliver in bulk. The farm→bank cycle:
 *
 *  FARM    — head to the group with the most cells (ties by A* distance) and grab
 *            every positive-value parcel, skipping the bank-first gate below capacity.
 *  HOP     — after PATIENCE_MS with no eligible parcel, move to the best other group
 *            (count / A* dist), unless the load is ≥ MIN_LOAD_FRACTION of capacity or
 *            the hop's decay is too high — then bank.
 *  DELIVER — at capacity, go to the nearest escapable delivery. With spare capacity,
 *            detour to parcels OR unvisited groups within DETOUR_MAX_TILES
 *            (speculative); an empty group is marked visited and delivery resumes.
 *            After banking, groups re-rank and the cycle restarts at FARM.
 *
 * Inherits the value model, pathLen, memory and hysteresis from StrategyLookAhead;
 * eligibility filters are unchanged — only ranking/commitment differs. Falls back to
 * plain LookAhead on maps with no spawner groups.
 */
export class StrategyHighCapacity extends StrategyLookAhead {
    /** @type {number} Heartbeat so the patience timer fires even with no sensing events */
    tickIntervalMs = 500;

    /** @type {Array<Array<{x: number, y: number}>>|null} Lazily built group list */
    #groups = null;

    /** @type {number|null} Index of the group currently being farmed (null = re-rank on next use) */
    #farmIdx = null;

    /** @type {'farm'|'deliver'} Current phase of the farm→bank cycle */
    #phase = 'farm';

    /** @type {number} Timestamp of the last tick that saw at least one eligible parcel */
    #lastParcelTs = Date.now();

    /** @type {Array<{x: number, y: number}>} Patrol waypoints covering the farm group's spawners with sensing discs */
    #patrol = [];

    /** @type {number} Index of the waypoint currently being walked to */
    #patrolIdx = 0;

    /** @type {number|null} Group the patrol was built for (rebuilt when the farm group changes) */
    #patrolGroupIdx = null;

    /** @type {boolean} Whether the agent was inside the farm group's sensing area last tick */
    #wasAtFarm = false;

    /** @type {number|null} Group just hopped away from (dry); excluded from en-route
     *  farm switching until a farm is reached, so it can't immediately pull us back */
    #hopFromIdx = null;

    /** @type {Set<number>} Group indices speculatively visited this delivery trip */
    #visitedDetours = new Set();

    /** @type {string|null} allowedSpawnerTiles signature the groups were built under
     *  (a mid-run restrict_exploration rebuilds them) */
    #groupsSig = null;

    // ── constructor config (set once, not virtual) ───────────────────────────

    /** @type {number} Carried count that triggers the DELIVER phase */
    #deliveryCap;

    /** @type {boolean} Whether speculative group visits are allowed during delivery */
    #detoursEnabled;

    /** @type {boolean} Whether parcels may be picked up while en route to delivery */
    #opportunisticPickup;

    /**
     * @param {{deliveryCap?: number, detoursEnabled?: boolean, opportunisticPickup?: boolean}} [cfg] - Strategy configuration
     * @param {number} [cfg.deliveryCap] - Carried count that triggers DELIVER (default: CARRYING_CAPACITY)
     * @param {boolean} [cfg.detoursEnabled] - Allow speculative group visits during delivery (default: true)
     * @param {boolean} [cfg.opportunisticPickup] - Allow picking up parcels while en route to delivery (default: true)
     */
    constructor({ deliveryCap = CARRYING_CAPACITY, detoursEnabled = true, opportunisticPickup = true } = {}) {
        super();
        this.#deliveryCap      = deliveryCap;
        this.#detoursEnabled   = detoursEnabled;
        this.#opportunisticPickup = opportunisticPickup;
    }

    /**
     * Run the FARM / HOP / DELIVER cycle; falls back to LookAhead with no groups
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        this.#initGroups();
        if (this.#groups.length === 0) return super.decide(currentIntent);

        const carrying = parcels.carriedBy(me.id);
        const now = Date.now();

        // Load banked → fresh cycle: re-rank groups, reset trip state.
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

        // Mission gates: maxBundleValue → "full" at 1; requiredStackSize → don't enter
        // DELIVER before the stack is complete (stackReady), like the other strategies.
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

        // Patience counts only while sensing the farm area: a far group can take
        // longer than PATIENCE_MS to walk to, and counting travel as a dry spell
        // made the agent hop between groups without ever arriving.
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
     * Which parcel to grab opportunistically while delivering. Base policy: best
     * pickupValue within DETOUR_MAX_TILES. Subclasses may tighten the filter.
     * @param {Array<Object>} eligible - Candidate parcels
     * @returns {{p: Object, value: number}|undefined} Best detour pickup, or undefined
     */
    _pickDeliveryTarget(eligible) {
        return eligible
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ p, value }) => value > 0 && this.pathLen(me, p) <= DETOUR_MAX_TILES)
            .sort((a, b) => b.value - a.value)[0];
    }

    /**
     * Whether a sighted parcel resets the patience timer. Subclasses with a quality
     * bar exclude parcels they'd never take, so trash spawns can't keep camping a dry group.
     * @param {Object} _parcel - Parcel sighted
     * @returns {boolean} True if it resets the patience timer
     */
    _countsForPatience(_parcel) {
        return true;
    }

    /**
     * FARM pickup policy: which eligible parcel to go for next. Default: best
     * positive pickupValue (greedy on value, no bank-first gate).
     * @param {Array<Object>} eligible - Candidate parcels
     * @returns {{p: Object, value: number}|undefined} Best farm pickup, or undefined
     */
    _pickFarmTarget(eligible) {
        return eligible
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value > 0)
            .sort((a, b) => b.value - a.value)[0];
    }

    // ── groups ───────────────────────────────────────────────────────────────

    /**
     * Lazily build (and cache) groups, rebuilding when allowedSpawnerTiles changes
     * @returns {void}
     */
    #initGroups() {
        // Rebuild whenever allowedSpawnerTiles changes (restrict_exploration can
        // arrive mid-run), not just on first use.
        const sig = spawnerConstraintSig();
        if (this.#groups !== null && sig === this.#groupsSig) return;
        this.#groupsSig = sig;
        this.#farmIdx = null;
        this.#patrolGroupIdx = null;
        this.#visitedDetours.clear();
        this.#groups = buildGroupsWithSig(D_CLUSTER).groups;
        const poolLen = this.#groups.reduce((s, g) => s + g.length, 0);
        log(`built ${this.#groups.length} group(s) from ${poolLen} spawner tiles: `
            + this.#groups.map((g, i) => `G${i}(n=${g.length})`).join(' '));
    }

    /**
     * Nearest tile of a group, by A* path length
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {{tile: {x: number, y: number}|null, dist: number}} Nearest tile and its path cost
     */
    #nearestTile(group) {
        let best = { tile: null, dist: Infinity };
        for (const t of group) {
            const d = this.pathLen(me, t);
            if (d < best.dist) best = { tile: t, dist: d };
        }
        return best;
    }

    /**
     * Yield-per-distance score of a group from the current position (count / A*
     * dist). Same score #bestNeighbourGroup uses, so farm/switch/hop agree on "best".
     * @param {{count: number, dist: number}} e - Group entry with cell count and path distance
     * @returns {number} Yield-per-distance score
     */
    #farmScore(e) {
        return e.count / Math.max(1, e.dist);
    }

    /**
     * Group to farm, by yield-per-distance (NOT raw count, which would lock onto the
     * single biggest group even across the map). Cached in #farmIdx, but while
     * travelling we re-evaluate from the CURRENT position: as the agent nears another
     * large group its score climbs, and once it beats the committed group's by
     * FARM_SWITCH_MARGIN we switch. Re-evaluation stops once at the farm (#isAtFarm).
     * @returns {number|null} Index of the group to farm, or null if none reachable
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

        // En-route switch: not yet at the committed group and another now scores
        // clearly higher → re-target. The just-hopped-from (dry) group is excluded
        // until we reach a farm, so it can't immediately pull us back.
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
     * Nearest delivery tile at most ENROUTE_DELIVERY_SLACK extra tiles off the direct
     * route to `farmTarget`, or null. Condition: dist(me→D)+dist(D→farm) ≤ dist(me→farm)+SLACK.
     * @param {{x: number, y: number}} farmTarget - Farm waypoint being headed to
     * @returns {{x: number, y: number}|null} Nearest qualifying delivery tile, or null
     */
    #enRouteDelivery(farmTarget) {
        // With a deliveryMultipliers mission, skip this nearest-tile shortcut (it
        // ignores the multiplier and could short-bank at a 1×/0× tile) and defer to
        // the multiplier-aware nearestEscapableDelivery. No-op without such a mission.
        if (missionConstraints.deliveryMultipliers?.size > 0) return null;
        const directDist = this.pathLen(me, farmTarget);
        if (!Number.isFinite(directDist)) return null;
        // allowedDeliveryTiles mission: only approved tiles qualify.
        const tiles = this._allowedDeliveryPool();
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

    /**
     * Whether a spawner of the current farm group is within sensing range (arrived)
     * @returns {boolean}
     */
    #isAtFarm() {
        const idx = this.#farmIdx;
        if (idx === null || !this.#groups[idx]) return false;
        return this.#groups[idx].some(t => distance(me, t) <= OBSERVATION_DISTANCE);
    }

    // ── FARM movement ────────────────────────────────────────────────────────

    /**
     * Walk the patrol loop across the farm group, banking en route if a delivery
     * tile is nearly on the way
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} go_explore / go_deliver predicate, or null while walking
     */
    #goFarm(currentIntent) {
        const idx = this.#selectFarmGroup();
        if (idx === null) return this.exploreIfIdle(currentIntent);

        // (Re)build the patrol when the farm group changed, starting nearest the agent.
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

        // Patrol: keep moving so every spawner cell passes through sensing range
        // while waiting for spawns.
        if (Math.round(me.x) === this.#patrol[this.#patrolIdx].x
                && Math.round(me.y) === this.#patrol[this.#patrolIdx].y)
            this.#patrolIdx = (this.#patrolIdx + 1) % this.#patrol.length;

        for (let tries = 0; tries < this.#patrol.length; tries++) {
            const target = this.#patrol[this.#patrolIdx];
            if (this.isReachable(target)) {
                if (currentIntent?.[0] === 'go_explore'
                        && currentIntent[1] === target.x && currentIntent[2] === target.y)
                    return null;
                // En-route delivery: if carrying and a delivery tile is ≤
                // ENROUTE_DELIVERY_SLACK off the path, deliver now — the farm index
                // is kept so the agent resumes the same group after banking.
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
     * Centroid-angle clockwise patrol loop for the group, capped at MAX_WAYPOINTS
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {Array<{x: number, y: number}>} Ordered patrol waypoints
     */
    #buildPatrol(group) {
        return buildCentroidPatrol(group, MAX_WAYPOINTS);
    }

    // ── HOP / bank decision ──────────────────────────────────────────────────

    /**
     * After a dry spell: hop to the best neighbour group, or bank (gated by mission
     * stack rules)
     * @param {Array|null} currentIntent - Current intention predicate
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {Array|null} Next intention, or null while walking
     */
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
        // stackReady: a requiredStackSize mission forbids banking a short stack —
        // keep hunting instead of delivering early.
        if (carrying.length > 0 && this.stackReady(carrying)) {
            this.#phase = 'deliver';
            // Current group is dry — don't speculatively revisit it en route.
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
     * Best other group by count/distance. While carrying, viable only if its decay
     * loss stays under HOP_MAX_LOSS_FRACTION of the carried reward (else null → bank).
     * @param {Array<Object>} carrying - Parcels currently carried
     * @returns {{idx: number, count: number, tile: {x: number, y: number}|null, dist: number}|null} Best hop target, or null
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

    /**
     * Deliver the load, optionally detouring for opportunistic pickups and
     * speculative unvisited-group visits
     * @param {Array|null} currentIntent - Current intention predicate
     * @param {boolean} allowPickup - Allow opportunistic pickups en route
     * @param {boolean} allowSpeculative - Allow speculative nearby-group visits
     * @param {Array<Object>} eligible - Candidate parcels for opportunistic pickup
     * @returns {Array|null} Next intention, or null while walking
     */
    #deliver(currentIntent, allowPickup, allowSpeculative, eligible) {
        // 1. Opportunistic pickup: qualifying parcel already in view.
        if (allowPickup) {
            const near = this._pickDeliveryTarget(eligible);
            if (near) {
                if (this.shouldKeepCurrentPickup(currentIntent, near)) return null;
                log(`DELIVER pickup ${this.pickupDebug(near.p)}`);
                return ['go_pick_up', near.p.x, near.p.y, near.p.id];
            }
        }

        // 2. Speculative group visit: go_explore an unvisited nearby group.
        if (allowSpeculative) {
            if (currentIntent?.[0] === 'go_explore') {
                // Mid-detour: keep going until in reach; a parcel sensed on the way
                // is caught by check 1 above.
                if (distance(me, { x: currentIntent[1], y: currentIntent[2] }) > 1) return null;
                // Arrived, nothing eligible — fall through and resume delivery.
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

    /**
     * Eligible parcels: free live + worth-pursuing remembered, passing mission gates,
     * reachable, and in the sustainable-loop region
     * @returns {Array<Object>} Eligible parcels
     */
    #eligibleParcels() {
        const remembered = parcels.remembered();
        const all = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id) && this.rememberedWorthPursuing(r)),
        ];
        // missionPickupOk: maxParcelReward / maxBundleValue ceilings.
        return all.filter(p => this.missionPickupOk(p) && this.isReachable(p) && this.inSafe(p));
    }
}
