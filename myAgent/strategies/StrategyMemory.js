import { StrategyGreedy } from './StrategyGreedy.js';
import { MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN, SWITCH_MARGIN } from './Strategy.js';
import { me, parcels, CARRYING_CAPACITY } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory');

/**
 * @class StrategyMemory
 * Greedy plus persistent, decaying memory for out-of-range parcels.
 */
export class StrategyMemory extends StrategyGreedy {
    /**
     * Decide the next intention over a memory-augmented candidate pool
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const carrying  = parcels.carriedBy(me.id);
        const bankNow   = this.bankNowValue();
        const remembered = parcels.remembered();  // decay-applied snapshots

        // Merged pool (free live + remembered not live again). Mission gates
        // (maxParcelReward / maxBundleValue) exclude un-pickable parcels in both.
        let allFree = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id) && this.rememberedWorthPursuing(r)),
        ].filter(p => this.missionPickupOk(p));

        // Cheap O(n log n) pre-filter to topN by raw reward (N = capacity) before the
        // full A*-based scoring below.
        if (Number.isFinite(CARRYING_CAPACITY) && allFree.length > CARRYING_CAPACITY) {
            allFree = allFree
                .sort((a, b) => b.reward - a.reward)
                .slice(0, CARRYING_CAPACITY);
        }

        if (carrying.length > 0) {
            // Multi-pickup candidates from the full pool (no distance cap — pickupValue
            // already penalises far parcels via decay, and a cap would exclude the
            // remembered parcels we want). maxBundleValue → no multi-pickup; a mandated
            // requiredStackSize relaxes the value gate.
            const worthwhile = this.singleParcelBundles() ? [] : allFree
                .filter(p => this.isReachable(p) && this.inSafe(p))
                .map(p => ({ p, value: this.pickupValue(p) }))
                .filter(({ p, value }) => this.mustStack(carrying) || value - this.bankFirstValue(p) >= MULTI_PICKUP_MIN)
                .sort((a, b) => b.value - a.value);

            if (!this.atCapacity() && this.#shouldKeepWithMemory(currentIntent, worthwhile[0]))
                return null;
            if (!this.atCapacity() && worthwhile.length > 0) {
                const { p } = worthwhile[0];
                const tag = parcels.get(p.id) ? 'live' : 'remembered';
                log(`→ multi-pickup (${tag}) ${this.pickupDebug(p)}`);
                return ['go_pick_up', p.x, p.y, p.id];
            }

            // Stack mission incomplete and nothing worth grabbing: keep accumulating
            // (explore toward spawners) instead of delivering early.
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

        // Empty-hand: best from full merged pool.
        const best = allFree
            .filter(p => this.isReachable(p) && this.inSafe(p))
            .map(p => ({ p, value: this.pickupValue(p) }))
            .filter(({ value }) => value - bankNow >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];

        if (best) {
            if (this.#shouldKeepWithMemory(currentIntent, best)) return null;
            const tag = parcels.get(best.p.id) ? 'live' : 'remembered';
            log(`→ go_pick_up (${tag}) ${this.pickupDebug(best.p)}`);
            return ['go_pick_up', best.p.x, best.p.y, best.p.id];
        }

        return this.exploreIfIdle(currentIntent);
    }

    /**
     * Pickup-commitment hysteresis extended to remembered targets. The base
     * shouldKeepCurrentPickup() queries only parcels.get(curId), returning undefined
     * for a remembered parcel and losing the SWITCH_MARGIN protection.
     */
    #shouldKeepWithMemory(currentIntent, candidate) {
        if (!currentIntent || currentIntent[0] !== 'go_pick_up') return false;
        const curId = currentIntent[3];
        // Live map first, then memory — mirrors #isValid().
        const cur = parcels.get(curId) ?? parcels.getRemembered(curId);
        if (!cur || cur.carriedBy) return false;
        if (!this.isReachable(cur)) return false;
        if (!candidate || candidate.p.id === curId) return true;
        return candidate.value - this.pickupValue(cur) < SWITCH_MARGIN;
    }
}
