import { Strategy, MIN_DELIVERY_REWARD } from './Strategy.js';
import { me, parcels, spawnerTiles, walkableTiles } from '../context.js';
import { distance } from '../utils/distance.js';

// Re-evaluate the explore target at least this often, even while committed.
const EXPLORE_COMMIT_MS    = 4000;
// If the agent's tile hasn't changed for this long it's stuck (blocked / bounced) → give up the target.
const EXPLORE_STALL_MS     = 1500;
// How long a given-up target stays excluded before it can be chosen again.
const EXPLORE_BLACKLIST_MS = 5000;

/**
 * Strategy for blind / (near-)zero-sensing maps — e.g. the chaotic maze, or any
 * map reporting OBSERVATION_DISTANCE in -1..1, where the agent senses only the
 * parcel(s) on its own tile. The static map (tiles, spawners, delivery zones,
 * walkability) is fully known from onMap regardless of sensing, so navigation and
 * delivery work normally; only parcel/agent visibility is limited.
 *
 * Behaviour:
 *   - Grab what we step on: if standing on a parcel worth carrying (cost
 *     heuristic), pick it up — even while already carrying, since blind sightings
 *     are scarce. Then deliver to the nearest known delivery tile.
 *   - Otherwise wander between spawners to discover parcels, using the anti-lock
 *     exploration below.
 *
 * Anti-lock exploration fixes the "target lock" problem (the base exploreIfIdle
 * keeps a go_explore target forever, so a displaced/blocked blind agent aims at a
 * stale tile indefinitely). The commitment is bounded by signals that work
 * without sensing:
 *   - a time-box (EXPLORE_COMMIT_MS): re-pick periodically regardless;
 *   - physical-movement stall (EXPLORE_STALL_MS): if the agent's tile stops
 *     changing it's stuck, so blacklist the target briefly and pick another;
 *   - on arrival, blacklist the reached tile briefly so exploration fans out
 *     instead of ping-ponging between the two closest spawners.
 * Manhattan progress toward the target is deliberately NOT used — in a maze it is
 * misleading (the agent routes around walls, so distance can plateau/grow while
 * genuine path progress is being made).
 */
export class StrategyBlind extends Strategy {
    #commitKey   = null;        // "x_y" of the current explore target
    #commitSince = 0;           // when we committed to it
    #lastPos     = null;        // last observed agent tile
    #lastMoved   = 0;           // when the agent tile last changed
    #blacklist   = new Map();   // "x_y" -> expiry timestamp

    decide(currentIntent) {
        const now = Date.now();

        // Track physical movement (drives the stall detector).
        const px = Math.round(me.x), py = Math.round(me.y);
        if (!this.#lastPos || this.#lastPos.x !== px || this.#lastPos.y !== py) {
            this.#lastPos   = { x: px, y: py };
            this.#lastMoved = now;
        }

        // ── Grab what we step on, then deliver ──────────────────────────────
        // Blind agents sense parcels only on their own tile, so pickup is purely
        // opportunistic. Grab a parcel under us if it's worth carrying (cost
        // heuristic at distance 0 = reward minus decay over the trip to the
        // nearest known delivery) — even while already carrying, since sightings
        // are scarce. Both branches reset the explore commitment.
        const onTileParcel = parcels.free()
            .filter(p => distance(me, p) === 0 && this.estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD)
            .sort((a, b) => this.scoreOf(b) - this.scoreOf(a))[0];
        if (onTileParcel) {
            this.#commitKey = null;
            console.log(`[blind] → go_pick_up ${onTileParcel.id} est:${this.estimatedRewardAtDelivery(onTileParcel).toFixed(1)}`);
            return ['go_pick_up', onTileParcel.x, onTileParcel.y, onTileParcel.id];
        }

        if (parcels.carriedBy(me.id).length > 0) {
            const target = this.nearestDelivery();
            if (target) {
                this.#commitKey = null;
                console.log(`[blind] → go_deliver to ${target.x},${target.y}`);
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
                this.#blacklist.set(key, now + EXPLORE_BLACKLIST_MS);
                this.#commitKey = null;
            } else {
                if (this.#commitKey !== key) {
                    this.#commitKey   = key;
                    this.#commitSince = now;
                }
                const timedOut = now - this.#commitSince >= EXPLORE_COMMIT_MS;
                const stalled  = now - this.#lastMoved   >= EXPLORE_STALL_MS;
                if (!timedOut && !stalled) return null; // keep going

                console.log(`[blind] giving up target ${key} (${stalled ? 'stalled' : 'timeout'}) — re-selecting`);
                this.#blacklist.set(key, now + EXPLORE_BLACKLIST_MS);
                this.#commitKey = null;
            }
        }

        // Drop expired blacklist entries.
        for (const [k, exp] of this.#blacklist) if (exp <= now) this.#blacklist.delete(k);

        // Pick a new target: prefer spawners, never the current tile, skip blacklisted.
        const pool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        const candidates = pool.filter(t =>
            !this.#blacklist.has(`${t.x}_${t.y}`) && !(t.x === px && t.y === py)
        );
        const pickFrom = candidates.length > 0 ? candidates : pool;

        const target = [...pickFrom].sort((a, b) => distance(me, a) - distance(me, b))[0];
        if (target) {
            this.#commitKey   = `${target.x}_${target.y}`;
            this.#commitSince = now;
            console.log(`[blind] → go_explore ${target.x},${target.y} dist:${distance(me, target)}`);
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
