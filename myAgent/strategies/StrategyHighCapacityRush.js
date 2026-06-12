import { StrategyHighCapacity } from './StrategyHighCapacity.js';
import { me, parcels, CARRYING_CAPACITY, OBSERVATION_DISTANCE, PARCEL_REWARD_AVG } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('rush');

// Manual delivery cap used when the server reports infinite carrying capacity:
// "full" has to mean something for the farm→bank cycle to ever bank.
export const RUSH_INFINITE_CAP = 10;
// Quality bar for pickups:
//   avg ≤ 30  →  bar = avg − RUSH_REWARD_MARGIN   (relative to map average)
//   avg  > 30  →  bar = RUSH_HIGH_AVG_FLOOR        (fixed floor when avg is high,
//                   so the agent never discards actually-valuable parcels)
export const RUSH_REWARD_MARGIN   = 10;
export const RUSH_HIGH_AVG_FLOOR  = 20;

/**
 * Variant of StrategyHighCapacity for abundance maps: high capacity AND fast
 * parcel spawning (generation interval ≤ 1s) AND a high population cap
 * (PARCELS_MAX ≥ 10). Parcels are so plentiful that detour/early-banking logic
 * only wastes movement — the score-maximising loop is to fill the hold
 * completely and then go straight to delivery.
 *
 * Only the two parent hooks are overridden:
 *  - the delivery cap is the real capacity, or RUSH_INFINITE_CAP (10) when the
 *    capacity is infinite;
 *  - en-route detours (parcel or speculative group visits) are disabled, so
 *    once the cap is reached the delivery run is a straight line.
 *
 * FARM greedy filling, the 3s patience HOP between groups, and the no-viable-hop
 * bank fallback (so a dried-up map can't deadlock the agent) are all inherited.
 */
export class StrategyHighCapacityRush extends StrategyHighCapacity {
    /** Minimum reward a parcel must currently have to be worth picking up. */
    _rewardBar() {
        return PARCEL_REWARD_AVG > 30
            ? RUSH_HIGH_AVG_FLOOR
            : PARCEL_REWARD_AVG - RUSH_REWARD_MARGIN;
    }

    _deliveryCap() {
        return Number.isFinite(CARRYING_CAPACITY) ? CARRYING_CAPACITY : RUSH_INFINITE_CAP;
    }

    _detoursEnabled() {
        return false; // no speculative group visits during delivery
    }

    _opportunisticPickupEnabled() {
        return true; // pick up qualifying parcels seen while walking to delivery
    }

    /**
     * Delivery pickup policy: only parcels already within sensing range
     * (no off-route detour) that meet the quality bar. Sorted by closest first
     * so the agent grabs the least disruptive one and keeps moving.
     */
    _pickDeliveryTarget(eligible) {
        const minReward = this._rewardBar();
        return eligible
            .filter(p => p.reward >= minReward && distance(me, p) <= OBSERVATION_DISTANCE)
            .map(p => ({ p, value: this.pickupValue(p), d: this.pathLen(me, p) }))
            .filter(({ value, d }) => value > 0 && Number.isFinite(d))
            .sort((a, b) => a.d - b.d)[0];
    }

    /**
     * Pickup policy: instead of greedily chasing the best-value parcel, accept
     * ONLY parcels whose reward is ≥ (map average spawn reward − RUSH_REWARD_MARGIN)
     * and go for the CLOSEST one (A* path length). With abundant spawns this
     * fills the hold faster than crossing the area for marginally better
     * parcels. Below-bar parcels are never taken — when nothing qualifies the
     * agent keeps patrolling and the patience timer decides hop/bank.
     */
    decide(currentIntent) {
        // Mid-trip abandonment: if we're walking to a parcel that has decayed
        // below the bar, drop it and let the patrol/patience logic take over.
        if (currentIntent?.[0] === 'go_pick_up') {
            const p = parcels.get(currentIntent[3]);
            if (p && !p.carriedBy && p.reward < this._rewardBar()) {
                log(`abandon below-bar parcel id=${p.id} reward=${p.reward} < bar=${this._rewardBar()}`);
                return this.exploreIfIdle(null); // force re-deliberation
            }
        }
        return super.decide(currentIntent);
    }

    _pickFarmTarget(eligible) {
        const minReward = this._rewardBar();
        const good = eligible
            .filter(p => p.reward >= minReward)
            .map(p => ({ p, value: this.pickupValue(p), d: this.pathLen(me, p) }))
            .filter(({ value, d }) => value > 0 && Number.isFinite(d))
            .sort((a, b) => a.d - b.d);
        if (good.length > 0) {
            log(`nearest-good pickup: id=${good[0].p.id} reward=${good[0].p.reward} (bar=${this._rewardBar()}) d=${good[0].d}`);
            return good[0];
        }
        return undefined;
    }

    /** Below-bar parcels don't reset the dry-spell timer either — a group
     *  spawning only trash must still trigger a hop after PATIENCE_MS. */
    _countsForPatience(parcel) {
        return parcel.reward >= this._rewardBar();
    }
}
