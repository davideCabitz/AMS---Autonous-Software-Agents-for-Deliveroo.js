import { StrategyGreedy } from './StrategyGreedy.js';
import { me, spawnerTiles, walkableTiles, OBSERVATION_DISTANCE } from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('hurry');

// Give up the current frontier target if no progress for this long (blocked).
const EXPLORE_STALL_MS     = 1500;
// Safety cap on a single target (in case it's never observed nor reached).
const EXPLORE_COMMIT_MS    = 4000;
// How long an unreachable/stalled target stays excluded before being retried.
const EXPLORE_BLACKLIST_MS = 5000;

/**
 * Same pickup/deliver behaviour as StrategyGreedy (decide() is inherited), but it
 * never waits on a spawner — when idle it sweeps the map. For maps with a very high
 * spawner-to-walkable ratio (most tiles are spawners), where touring beats waiting.
 *
 * Coverage works by a persistent frontier sweep:
 *   - Every spawner currently within sensing is marked `#visited` for the whole
 *     sweep (we've observed that area). This is the key difference from the base
 *     exploreIfIdle / a short-TTL blacklist: without persistent memory the local
 *     spawners keep becoming selectable again, so the agent oscillates in one
 *     region instead of moving on.
 *   - The next target is the nearest *unvisited* (i.e. not-yet-sensed) spawner, so
 *     the frontier always advances toward unobserved ground — other rows, the far
 *     side of the map, etc. When everything is visited the set resets (new sweep).
 *   - Commitment holds until the target is observed (enters sensing); a movement
 *     stall (blocked) or a timeout drops it onto a short-TTL blacklist to retry
 *     later. Persistent `#visited` is what prevents the OBS-boundary ping-pong.
 *
 * (StrategyBlind has its own, simpler coverage; per request it's left as-is.)
 */
export class StrategyHurry extends StrategyGreedy {
    // Needs the loop to keep re-deliberating so the movement-stall escape can fire
    // even when the agent is blocked and producing no movement events.
    tickIntervalMs = 100;

    #commitKey   = null;        // "x_y" of the current frontier target
    #commitSince = 0;           // when we committed to it
    #lastPos     = null;        // last observed agent tile
    #lastMoved   = 0;           // when the agent tile last changed
    #visited     = new Set();   // "x_y" of spawners observed this sweep (persistent)
    #blacklist   = new Map();   // "x_y" -> expiry timestamp (only for stuck/unreachable)

    exploreIfIdle(currentIntent) {
        // A pickup/deliver currently running takes priority — let it finish.
        if (currentIntent && (currentIntent[0] === 'go_pick_up' || currentIntent[0] === 'go_deliver')) {
            return null;
        }

        const now = Date.now();

        // Track physical movement (drives the stall detector).
        const px = Math.round(me.x), py = Math.round(me.y);
        if (!this.#lastPos || this.#lastPos.x !== px || this.#lastPos.y !== py) {
            this.#lastPos   = { x: px, y: py };
            this.#lastMoved = now;
        }

        // Coverage memory: every spawner currently within sensing counts as observed.
        for (const t of spawnerTiles) {
            if (distance(me, t) <= OBSERVATION_DISTANCE) this.#visited.add(`${t.x}_${t.y}`);
        }

        // Expire stall-blacklist entries.
        for (const [k, exp] of this.#blacklist) if (exp <= now) this.#blacklist.delete(k);

        // Stay committed to the current frontier target until it's been observed
        // (entered sensing), unless we've stalled (blocked) or timed out.
        if (currentIntent && currentIntent[0] === 'go_explore') {
            const [, tx, ty] = currentIntent;
            const key = `${tx}_${ty}`;
            if (this.#commitKey !== key) { this.#commitKey = key; this.#commitSince = now; }

            const observed = this.#visited.has(key);
            const stalled  = now - this.#lastMoved   >= EXPLORE_STALL_MS;
            const timedOut = now - this.#commitSince >= EXPLORE_COMMIT_MS;

            if (!observed && !stalled && !timedOut) return null; // keep heading to it

            if (stalled || timedOut) {
                log(`giving up target ${key} (${stalled ? 'stalled' : 'timeout'}) — re-selecting`);
                this.#blacklist.set(key, now + EXPLORE_BLACKLIST_MS);
            }
            this.#commitKey = null;
        }

        // Pick the nearest spawner not yet observed this sweep (skip blacklisted /
        // our tile). Reachability is NOT checked per tile here — doing an A* search
        // for each of the 895+ spawner tiles on a large map blocks the event loop
        // for ~15 seconds and breaks navigation. Unreachable targets are handled by
        // the stall detector (gives up after EXPLORE_STALL_MS and blacklists the tile).
        const pool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        const here = `${px}_${py}`;
        let candidates = pool.filter(t => {
            const k = `${t.x}_${t.y}`;
            return !this.#visited.has(k) && !this.#blacklist.has(k) && k !== here;
        });

        // Whole frontier observed → start a fresh sweep.
        if (candidates.length === 0) {
            this.#visited.clear();
            candidates = pool.filter(t => {
                const k = `${t.x}_${t.y}`;
                return !this.#blacklist.has(k) && k !== here;
            });
        }

        // Prefer frontier tiles in the sustainable-loop region (don't sweep into a
        // one-way trap); fall back to all candidates if none are safe.
        const safe = candidates.filter(t => this.inSafe(t));
        if (safe.length > 0) candidates = safe;

        // Sort by Manhattan distance (O(1) per comparison) rather than A* path length.
        // Exact path cost is unnecessary here — closest unvisited tile is a good enough
        // heuristic, and avoids the O(n²·A*) cost that stalls the event loop.
        const target = [...candidates].sort((a, b) => distance(me, a) - distance(me, b))[0];
        if (target) {
            this.#commitKey   = `${target.x}_${target.y}`;
            this.#commitSince = now;
            log(`→ go_explore ${target.x},${target.y} dist:${distance(me, target).toFixed(1)}`);
            return ['go_explore', target.x, target.y];
        }
        return null;
    }
}
