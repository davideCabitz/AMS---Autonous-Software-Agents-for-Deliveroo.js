import { StrategyHighCapacity } from './StrategyHighCapacity.js';
import { me, parcels, CARRYING_CAPACITY, OBSERVATION_DISTANCE, PARCEL_REWARD_AVG } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('rush');

// Manual delivery cap when the server reports infinite capacity — "full" must mean
// something for the farm→bank cycle to ever bank.
export const RUSH_INFINITE_CAP = 10;
// Pickup quality bar: avg ≤ 30 → avg − RUSH_REWARD_MARGIN; avg > 30 → fixed
// RUSH_HIGH_AVG_FLOOR (so high-avg maps never discard valuable parcels).
export const RUSH_REWARD_MARGIN   = 10;
export const RUSH_HIGH_AVG_FLOOR  = 20;

/**
 * @class StrategyHighCapacityRush
 * Abundance maps: high capacity + fast spawn + high population → fill and bank
 * straight. Inherits the FARM filling, 3s patience HOP, and bank fallback.
 */
export class StrategyHighCapacityRush extends StrategyHighCapacity {
    /**
     * Configure the inherited cycle for abundance maps: concrete delivery cap (10
     * when capacity is infinite) and no speculative detours
     */
    constructor() {
        super({
            deliveryCap:       Number.isFinite(CARRYING_CAPACITY) ? CARRYING_CAPACITY : RUSH_INFINITE_CAP,
            detoursEnabled:    false,
            opportunisticPickup: true,
        });
    }

    /**
     * Minimum reward a parcel must have to be worth picking up. While a
     * requiredStackSize mission still needs parcels (mustStack), the bar drops so the
     * mandated stack fills even with parcels the filter would discard.
     * @returns {number} Reward threshold (-Infinity while a stack must be filled)
     */
    _rewardBar() {
        if (this.mustStack(parcels.carriedBy(me.id))) return -Infinity;
        return PARCEL_REWARD_AVG > 30
            ? RUSH_HIGH_AVG_FLOOR
            : PARCEL_REWARD_AVG - RUSH_REWARD_MARGIN;
    }

    /**
     * Delivery pickup policy: only in-sensing-range parcels (no off-route detour)
     * meeting the quality bar, closest first (least disruptive)
     * @param {Array<Object>} eligible - Candidate parcels
     * @returns {{p: Object, value: number, d: number}|undefined} Closest qualifying pickup, or undefined
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
     * Abandon an in-flight pickup whose parcel decayed below the bar, then defer to
     * the inherited cycle
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        // Mid-trip abandonment: if the target parcel has decayed below the bar, drop
        // it and let the patrol/patience logic take over.
        if (currentIntent?.[0] === 'go_pick_up') {
            const p = parcels.get(currentIntent[3]);
            if (p && !p.carriedBy && p.reward < this._rewardBar()) {
                log(`abandon below-bar parcel id=${p.id} reward=${p.reward} < bar=${this._rewardBar()}`);
                return this.exploreIfIdle(null); // force re-deliberation
            }
        }
        return super.decide(currentIntent);
    }

    /**
     * FARM pickup policy: accept only parcels at/above the quality bar and go for the
     * CLOSEST (A*) — with abundant spawns this fills the hold faster than chasing
     * marginally better ones. Nothing qualifies ⇒ keep patrolling (patience decides).
     * @param {Array<Object>} eligible - Candidate parcels
     * @returns {{p: Object, value: number, d: number}|undefined} Closest good parcel, or undefined
     */
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

    /**
     * Below-bar parcels don't reset the dry-spell timer — a group spawning only
     * trash must still trigger a hop after PATIENCE_MS
     * @param {Object} parcel - Parcel sighted
     * @returns {boolean} True if the parcel meets the reward bar
     */
    _countsForPatience(parcel) {
        return parcel.reward >= this._rewardBar();
    }
}
