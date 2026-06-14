import { StrategyGreedy } from './StrategyGreedy.js';
import { MIN_DELIVERY_REWARD, MULTI_PICKUP_MIN, SWITCH_MARGIN } from './Strategy.js';
import { me, parcels, CARRYING_CAPACITY } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory');

/**
 * Extends StrategyGreedy with a persistent parcel memory: high-value parcels that
 * exit the sensing zone are kept in belief memory (managed by Parcels.sync) and
 * remain eligible targets until their decayed reward hits zero, another agent picks
 * them up, or a better candidate appears.
 *
 * BDI separation is preserved:
 *   - Beliefs: Parcels.#memory is written exclusively by sync() / remove()
 *     (perception / plan-outcome), never by this strategy.
 *   - Desires: decide() reads beliefs and returns a predicate — it never writes.
 *   - Intentions: IntentionRevision.#isValid() checks getRemembered() so an
 *     intention for a remembered parcel stays valid while the agent travels.
 *
 * Backward compatibility: enableMemory() must be called (by selectStrategy) before
 * this strategy runs. All existing strategies are unaffected.
 */
export class StrategyMemory extends StrategyGreedy {
    decide(currentIntent) {
        const carrying  = parcels.carriedBy(me.id);
        const bankNow   = this.bankNowValue();
        const remembered = parcels.remembered();  // current-reward snapshots, decay applied

        // Build merged candidate pool (free live + remembered that aren't live again).
        // Mission gates (maxParcelReward / maxBundleValue) exclude parcels that may
        // never be picked up, for live and remembered candidates alike.
        let allFree = [
            ...parcels.free(),
            ...remembered.filter(r => !parcels.get(r.id)),
        ].filter(p => this.missionPickupOk(p));

        // Pre-filter to topN by raw reward when carrying capacity is finite.
        // This is a cheap O(n log n) screen; the full A*-based scoring runs next.
        // N = CARRYING_CAPACITY matches the user requirement "topN where N = agent.capacity".
        if (Number.isFinite(CARRYING_CAPACITY) && allFree.length > CARRYING_CAPACITY) {
            allFree = allFree
                .sort((a, b) => b.reward - a.reward)
                .slice(0, CARRYING_CAPACITY);
        }

        if (carrying.length > 0) {
            // Multi-pickup candidates from full pool — no OBSERVATION_DISTANCE cap.
            // pickupValue() naturally penalises far parcels through the decay term;
            // an artificial distance filter would exclude the remembered parcels we
            // specifically want to pursue. maxBundleValue missions skip multi-pickup
            // entirely (single-parcel bundles); a mandated requiredStackSize relaxes
            // the value gate (the stack must be filled even at marginal value).
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

            // Stack mission not yet complete and no parcel in sight worth grabbing:
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
     * Hysteresis for pickup commitment, extended to cover remembered targets.
     * The base shouldKeepCurrentPickup() calls parcels.get(curId) only — it returns
     * undefined for a remembered parcel, losing the SWITCH_MARGIN protection.
     */
    #shouldKeepWithMemory(currentIntent, candidate) {
        if (!currentIntent || currentIntent[0] !== 'go_pick_up') return false;
        const curId = currentIntent[3];
        // Check live map first, then memory — mirrors the #isValid() pattern.
        const cur = parcels.get(curId) ?? parcels.getRemembered(curId);
        if (!cur || cur.carriedBy) return false;
        if (!this.isReachable(cur)) return false;
        if (!candidate || candidate.p.id === curId) return true;
        return candidate.value - this.pickupValue(cur) < SWITCH_MARGIN;
    }
}
