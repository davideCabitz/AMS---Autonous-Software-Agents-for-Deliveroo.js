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
 * @class StrategyHurry
 * Spawner-dense map strategy: persistent frontier sweep with visited set
 */
export class StrategyHurry extends StrategyGreedy {
    /** @type {number} Re-deliberation interval for stall detection */
    tickIntervalMs = 100;

    /** @type {string|null} "x_y" key of current frontier target */
    #commitKey   = null;

    /** @type {number} Timestamp when committed to the current target */
    #commitSince = 0;

    /** @type {{x: number, y: number}|null} Last observed agent tile */
    #lastPos     = null;

    /** @type {number} Timestamp when the agent tile last changed */
    #lastMoved   = 0;

    /** @type {Set<string>} "x_y" of spawners observed this sweep (persistent coverage memory) */
    #visited     = new Set();

    /** @type {Map<string, number>} "x_y" → expiry timestamp for stuck/unreachable targets */
    #blacklist   = new Map();

    /**
     * Persistent frontier sweep: keep heading to the nearest unobserved spawner,
     * with stall detection and a coverage-memory visited set
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to keep current / stay idle
     */
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
