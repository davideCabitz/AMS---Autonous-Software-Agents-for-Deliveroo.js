import { Strategy } from './Strategy.js';
import { me, spawnerTiles, walkableTiles } from '../context.js';
import { distance } from '../utils/distance.js';

// Re-evaluate the explore target at least this often, even while committed.
const EXPLORE_COMMIT_MS    = 4000;
// If the agent's tile hasn't changed for this long it's stuck (blocked / bounced) → give up the target.
const EXPLORE_STALL_MS     = 1500;
// How long a given-up target stays excluded before it can be chosen again.
const EXPLORE_BLACKLIST_MS = 5000;

/**
 * Exploration-only strategy for maps with (near-)zero sensing — e.g. the chaotic
 * maze where OBSERVATION_DISTANCE <= 1. With no sensing the parcel-belief model is
 * useless (sensing.parcels is empty), so this strategy does not reason about
 * parcels at all this pass: it just keeps the agent wandering between spawners.
 *
 * The point of this class is to fix the "target lock" problem: the base
 * exploreIfIdle keeps a go_explore target forever, so a blind agent that gets
 * displaced or blocked aims at a stale tile indefinitely. Here the commitment is
 * bounded by two signals that work without sensing:
 *   - a time-box (EXPLORE_COMMIT_MS): re-pick periodically regardless;
 *   - physical-movement stall (EXPLORE_STALL_MS): if the agent's tile stops
 *     changing it's stuck, so blacklist the target briefly and pick another.
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
