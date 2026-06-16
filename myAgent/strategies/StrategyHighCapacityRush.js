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
 * @class StrategyHighCapacityRush
 * Abundance maps: high capacity + fast spawn + high population → fill and bank straight
 * FARM greedy filling, the 3s patience HOP between groups, and the no-viable-hop
 * bank fallback (so a dried-up map can't deadlock the agent) are all inherited.
 */
export class StrategyHighCapacityRush extends StrategyHighCapacity {
    constructor() {
        super({
            deliveryCap:       Number.isFinite(CARRYING_CAPACITY) ? CARRYING_CAPACITY : RUSH_INFINITE_CAP,
            detoursEnabled:    false,
            opportunisticPickup: true,
        });
    }

    /** Minimum reward a parcel must currently have to be worth picking up.
     *  mustStack (LLM layer): while a requiredStackSize mission still needs
     *  parcels, the bar is dropped — a mandated stack must be filled even
     *  with parcels the quality filter would normally discard. */
    _rewardBar() {
        if (this.mustStack(parcels.carriedBy(me.id))) return -Infinity;
        return PARCEL_REWARD_AVG > 30
            ? RUSH_HIGH_AVG_FLOOR
            : PARCEL_REWARD_AVG - RUSH_REWARD_MARGIN;
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
