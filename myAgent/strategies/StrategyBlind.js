import { Strategy, MIN_DELIVERY_REWARD } from './Strategy.js';
import { me, parcels, spawnerTiles, walkableTiles } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';
import { AntiLockExplorer } from './AntiLockExplorer.js';

const log = createLogger('blind');

/**
 * @class StrategyBlind
 * Strategy for zero-sensing maps with anti-lock exploration and stall detection
 */
export class StrategyBlind extends Strategy {
    /** @type {number} Re-deliberation interval for blind agents (no sensing events) */
    tickIntervalMs = 100;

    /** @type {AntiLockExplorer} Commit/stall/blacklist/movement bookkeeping */
    #explorer = new AntiLockExplorer();

    /**
     * Decide next intention with anti-lock exploration
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to keep current
     */
    decide(currentIntent) {
        const now = Date.now();

        // Track physical movement (drives the stall detector).
        const px = Math.round(me.x), py = Math.round(me.y);
        this.#explorer.trackMovement(px, py, now);

        // ── Grab what we step on, then deliver ──────────────────────────────
        // Blind agents sense parcels only on their own tile, so pickup is purely
        // opportunistic. Grab a parcel under us if it's worth carrying (cost
        // heuristic at distance 0 = reward minus decay over the trip to the
        // nearest known delivery) — even while already carrying, since sightings
        // are scarce. Both branches reset the explore commitment.
        const onTileParcel = parcels.free()
            .filter(p => distance(me, p) === 0)
            .filter(p => this.missionPickupOk(p))
            .map(p => ({ p, value: this.pickupValue(p), gain: this.pickupGain(p) }))
            .filter(({ gain }) => gain >= MIN_DELIVERY_REWARD)
            .sort((a, b) => b.value - a.value)[0];
        if (onTileParcel) {
            this.#explorer.clearCommit();
            log(`→ go_pick_up ${onTileParcel.p.id} value:${onTileParcel.value.toFixed(1)} gain:${onTileParcel.gain.toFixed(1)}`);
            return ['go_pick_up', onTileParcel.p.x, onTileParcel.p.y, onTileParcel.p.id];
        }

        if (parcels.carriedBy(me.id).length > 0) {
            const target = this.nearestDelivery();
            if (target) {
                this.#explorer.clearCommit();
                log(`→ go_deliver to ${target.x},${target.y}`);
                return ['go_deliver', target.x, target.y];
            }
        }

        // While heading to a target we haven't reached yet, stay committed unless
        // we've timed out or stalled.
        if (currentIntent && currentIntent[0] === 'go_explore') {
            const [, tx, ty] = currentIntent;
            const key      = `${tx}_${ty}`;
            const reached  = distance(me, { x: tx, y: ty }) === 0;

            if (reached) {
                // Arrived: blacklist briefly so exploration fans out across the map
                // instead of ping-ponging between the two closest spawners.
                this.#explorer.blacklist(key, now);
                this.#explorer.clearCommit();
            } else {
                this.#explorer.commitTo(key, now);
                const timedOut = this.#explorer.timedOut(now);
                const stalled  = this.#explorer.stalled(now);
                if (!timedOut && !stalled) return null; // keep going

                log(`giving up target ${key} (${stalled ? 'stalled' : 'timeout'}) — re-selecting`);
                this.#explorer.blacklist(key, now);
                this.#explorer.clearCommit();
            }
        }

        // Drop expired blacklist entries.
        this.#explorer.pruneBlacklist(now);

        // Pick a new target: prefer spawners, never the current tile, skip blacklisted.
        const pool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        const candidates = pool.filter(t =>
            !this.#explorer.isBlacklisted(`${t.x}_${t.y}`) && !(t.x === px && t.y === py)
        );
        const pickFrom = candidates.length > 0 ? candidates : pool;

        const target = [...pickFrom].sort((a, b) => distance(me, a) - distance(me, b))[0];
        if (target) {
            this.#explorer.recommit(`${target.x}_${target.y}`, now);
            log(`→ go_explore ${target.x},${target.y} dist:${distance(me, target)}`);
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
