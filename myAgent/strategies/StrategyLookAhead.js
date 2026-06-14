import { StrategyMemory } from './StrategyMemory.js';
import { MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN, SWITCH_MARGIN } from './Strategy.js';
import { me, parcels, CARRYING_CAPACITY } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lookahead');

// Value band for the look-ahead decisions, in reward points:
//  - the paired tour must beat taking the greedy parcel solo by ≥ this to bother
//    collecting a second parcel at all;
//  - one visit order must beat the other by ≥ this to win outright on value;
//    within the band the two orders are treated as a tie and broken by distance
//    (shorter total tour first → grab the nearer parcel first). The distance
//    tie-break is what gives sane ordering on low/no-decay maps, where the decay
//    term can't separate the two orderings on value alone.
const LOOKAHEAD_MARGIN = 1;

/**
 * Extends StrategyMemory with a 2-step look-ahead on pickup selection.
 *
 * StrategyMemory (like StrategyGreedy) scores each parcel in isolation with
 * pickupValue(), so a high-reward distant parcel (P_greedy) wins even when a
 * decent parcel (P_near) sits a couple of tiles away, almost on the route. The
 * agent walks straight past it and never comes back.
 *
 * This strategy keeps the exact candidate pool, filters and thresholds of
 * StrategyMemory (live + remembered parcels, MULTI_PICKUP_MIN / MIN_DELIVERY_REWARD
 * gates, safe-region and reachability checks). It diverges only after the greedy
 * winner G is known: when there is room to carry two, it pairs G with the best
 * complementary parcel C and scores BOTH visit orders as full tours, all distances
 * via A* (pathLen):
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
    decide(currentIntent) {
        const carrying   = parcels.carriedBy(me.id);
        const bankNow    = this.bankNowValue();
        const remembered = parcels.remembered();

        // Same merged candidate pool as StrategyMemory: free live parcels plus
        // remembered ones that are not live again, pre-screened to topN by raw
        // reward when capacity is finite.
        let allFree = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id)),
        ].filter(p => this.missionPickupOk(p));   // mission gates: maxParcelReward / maxBundleValue
        if (Number.isFinite(CARRYING_CAPACITY) && allFree.length > CARRYING_CAPACITY) {
            allFree = allFree
                .sort((a, b) => b.reward - a.reward)
                .slice(0, CARRYING_CAPACITY);
        }
        const eligible = allFree.filter(p => this.isReachable(p) && this.inSafe(p));

        if (carrying.length > 0) {
            // maxBundleValue missions skip multi-pickup entirely (single-parcel
            // bundles); a mandated requiredStackSize relaxes the value gate (the
            // stack must be filled even at marginal value).
            const worthwhile = this.singleParcelBundles() ? [] : eligible
                .map(p => ({ p, value: this.pickupValue(p) }))
                .filter(({ p, value }) => this.mustStack(carrying) || value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
                .sort((a, b) => b.value - a.value);

            const choice = (!this.atCapacity() && worthwhile.length > 0)
                ? this.#chooseTarget(worthwhile, carrying.length)
                : undefined;
            if (!this.atCapacity() && this.#shouldKeep(currentIntent, choice))
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
            const choice = this.#chooseTarget(ranked, carrying.length);
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
     * trip, not a change of destination — allow it without the SWITCH_MARGIN.
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
}
