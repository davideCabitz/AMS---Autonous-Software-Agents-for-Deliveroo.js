import { StrategyLookAhead } from './StrategyLookAhead.js';
import { buildSpawnerGroups } from '../beliefs/SpawnerGroups.js';
import {
    me, parcels, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, missionConstraints,
} from '../context.js';
import { distance } from '../utils/distance.js';

// Max Euclidean distance (tiles) for two spawners to be considered neighbours.
// 1 = only directly adjacent (touching) spawners merge — prevents false chaining
// on grid maps where spawners are 2 tiles apart in rows/columns.
const D_CLUSTER  = 2;
// Sliding window: how many past group choices to remember.
const WINDOW_SIZE = 5;
// How much to penalise distance when computing group weights.
// α=1.5 → the farthest group gets weight 1/(1+1.5)≈0.4 vs 1.0 for the nearest.
const ALPHA = 1.5;
// How much to penalise a group that was chosen recently.
// β=3 → one recent choice roughly halves the weight.
const BETA = 3.0;

/**
 * Extends StrategyLookAhead with probabilistic group-based exploration.
 *
 * Spawner tiles are clustered into spatial groups at first use (static map
 * geometry, built once).  At each idle deliberation the agent samples a group
 * from a distribution that:
 *
 *   weight(G) = 1 / (1 + α·normDist(G) + β·recentCount(G))
 *
 * where normDist is distance to the group's nearest reachable spawner
 * normalised to [0,1] across all active groups, and recentCount is how many
 * of the last WINDOW_SIZE choices targeted that group.
 *
 * Properties guaranteed by the formula:
 *  - Every group always has a positive weight → no starvation.
 *  - Distance is relative (normalised), so a far group is penalised only
 *    *compared to* the nearest one, not absolutely zeroed out.
 *  - Recency penalty decays naturally as the window slides forward — a group
 *    chosen 5 decisions ago gets no penalty at all.
 *
 * Edge cases:
 *  - 0 or 1 group  → falls back to parent StrategyLookAhead.exploreIfIdle().
 *  - All groups unreachable → returns null (parent fallback).
 *  - Mission zone constraint (allowedSpawnerTiles) → applied before grouping.
 *  - Stack-accumulation mission (requiredStackSize) → current tile excluded.
 *
 * Toggle with EXPLORE_MODE=stochastic in the environment (see selectStrategy).
 */
export class StrategyLookAheadStochastic extends StrategyLookAhead {
    /** @type {Array<Array<{x:number,y:number}>>|null} lazily built group list */
    #groups        = null;
    /** Ring buffer of recently chosen group indices (length ≤ WINDOW_SIZE). */
    #recentChoices = [];

    // ── group initialisation ────────────────────────────────────────────────

    #initGroups() {
        if (this.#groups !== null) return;
        if (spawnerTiles.length === 0) { this.#groups = []; return; }
        this.#groups = buildSpawnerGroups(spawnerTiles, D_CLUSTER);
        console.log(
            `[stochastic] built ${this.#groups.length} group(s) from ` +
            `${spawnerTiles.length} spawner tiles: ` +
            this.#groups
                .map((g, i) => `G${i}[${g.map(t => `${t.x},${t.y}`).join(' ')}]`)
                .join(' | ')
        );
    }

    // ── main override ───────────────────────────────────────────────────────

    exploreIfIdle(currentIntent) {
        this.#initGroups();

        // With 0 or 1 group there is nothing for group-level sampling to do —
        // delegate entirely to the parent's deterministic logic.
        if (!this.#groups || this.#groups.length <= 1)
            return super.exploreIfIdle(currentIntent);

        // ── early exits (mirrors Strategy.exploreIfIdle) ────────────────────
        if (currentIntent) {
            const [intent, tx, ty] = currentIntent;

            if (intent === 'go_pick_up' || intent === 'go_deliver') {
                // Productive work started — reset both the stochastic window
                // and the parent's ping-pong fields.
                this.#recentChoices  = [];
                this._lastExploreKey = null;
                this._prevExploreKey = null;
                return null;
            }

            if (intent === 'go_explore' && distance(me, { x: tx, y: ty }) >= OBSERVATION_DISTANCE)
                return null;
        }

        const needMoreParcels = missionConstraints.requiredStackSize != null
            && parcels.carriedBy(me.id).length < missionConstraints.requiredStackSize;

        // ── build eligible spawner set ───────────────────────────────────────
        // Apply mission zone constraint first.
        const zonedPool = (missionConstraints.allowedSpawnerTiles?.size > 0)
            ? spawnerTiles.filter(t =>
                missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`)
              )
            : spawnerTiles;
        const basePool = zonedPool.length > 0 ? zonedPool : spawnerTiles;

        // Keep only reachable tiles; prefer the sustainable-loop region.
        const reachable = basePool.filter(t => this.isReachable(t));
        if (reachable.length === 0) return null;

        const safe   = reachable.filter(t => this.inSafe(t));
        const usable = safe.length > 0 ? safe : reachable;

        // Prefer spawners outside current sensing range (new ground).
        const outOfRange = usable.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const candidates = outOfRange.length > 0 ? outOfRange : usable;

        // When accumulating a required stack, skip the tile we are standing on.
        const hereKey = `${Math.round(me.x)}_${Math.round(me.y)}`;
        const filtered = (needMoreParcels
            ? candidates.filter(t => `${t.x}_${t.y}` !== hereKey)
            : candidates
        );
        const eligiblePool = filtered.length > 0 ? filtered : candidates;
        const eligibleSet  = new Set(eligiblePool.map(t => `${t.x}_${t.y}`));

        // ── map groups to their eligible nearest spawner ─────────────────────
        const activeGroups = this.#groups
            .map((spawners, idx) => {
                const eligible = spawners.filter(t => eligibleSet.has(`${t.x}_${t.y}`));
                if (eligible.length === 0) return null;
                // Nearest eligible spawner in this group by A* path length.
                const best = eligible
                    .map(t => ({ t, d: this.pathLen(me, t) }))
                    .sort((a, b) => a.d - b.d)[0];
                // Keep the full spawner list for coverage-target calculation.
                return { idx, spawners, nearest: best.t, dist: best.d };
            })
            .filter(Boolean);

        if (activeGroups.length === 0) return super.exploreIfIdle(currentIntent);

        // Only one group has reachable eligible tiles — skip sampling.
        if (activeGroups.length === 1) {
            const target = this.#bestCoverageTarget(activeGroups[0]);
            this.#commitTarget(target);
            console.log(`[stochastic] single active group → (${target.x},${target.y})`);
            return ['go_explore', target.x, target.y];
        }

        // ── probabilistic group selection ────────────────────────────────────
        const maxDist = Math.max(...activeGroups.map(g => g.dist));

        const weights = activeGroups.map(g => {
            const normDist    = maxDist > 0 ? g.dist / maxDist : 0;
            const recentCount = this.#recentChoices.filter(i => i === g.idx).length;
            return 1 / (1 + ALPHA * normDist + BETA * recentCount);
        });

        const totalWeight = weights.reduce((s, w) => s + w, 0);

        // Weighted random sample.
        let r      = Math.random() * totalWeight;
        let chosen = activeGroups[activeGroups.length - 1]; // fallback: last group
        for (let j = 0; j < activeGroups.length; j++) {
            r -= weights[j];
            if (r <= 0) { chosen = activeGroups[j]; break; }
        }

        const target = this.#bestCoverageTarget(chosen);

        // Diagnostics — shows each group's distance, recency count, and probability.
        const diag = activeGroups.map((g, j) => {
            const recentCount = this.#recentChoices.filter(i => i === g.idx).length;
            return `G${g.idx}(d=${g.dist} r=${recentCount} p=${(weights[j] / totalWeight * 100).toFixed(1)}%)`;
        }).join(' ');
        console.log(`[stochastic] ${diag} → G${chosen.idx} coverage=(${target.x},${target.y})`);

        this.#commitTarget(target);
        this.#recentChoices.push(chosen.idx);
        if (this.#recentChoices.length > WINDOW_SIZE) this.#recentChoices.shift();

        return ['go_explore', target.x, target.y];
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Best tile to navigate to so the agent senses as much of the group as
     * possible in one visit.
     *
     * Fast path: if every spawner in the group is already within
     * OBSERVATION_DISTANCE (Euclidean) of the nearest eligible spawner, just
     * go there — no extra movement needed.
     *
     * Slow path: find the walkable tile that maximises the number of group
     * spawners within OBSERVATION_DISTANCE.  The search space is limited to
     * the group's bounding box expanded by OBSERVATION_DISTANCE; isReachable
     * (A*) is called only on the top-K geometrically best candidates to keep
     * the per-deliberation cost low.
     */
    #bestCoverageTarget(group) {
        const { spawners, nearest } = group;
        if (spawners.length === 1) return nearest;

        // Fast path: nearest spawner already covers all group members.
        const allCoveredByNearest = spawners.every(s => {
            const dx = s.x - nearest.x, dy = s.y - nearest.y;
            return Math.sqrt(dx * dx + dy * dy) <= OBSERVATION_DISTANCE;
        });
        if (allCoveredByNearest) return nearest;

        // Bounding box of all group spawners, expanded by the sensing radius.
        const xs = spawners.map(s => s.x), ys = spawners.map(s => s.y);
        const minX = Math.min(...xs) - OBSERVATION_DISTANCE;
        const maxX = Math.max(...xs) + OBSERVATION_DISTANCE;
        const minY = Math.min(...ys) - OBSERVATION_DISTANCE;
        const maxY = Math.max(...ys) + OBSERVATION_DISTANCE;

        // Score every walkable tile in the box: covered spawners DESC, then
        // Euclidean distance to agent ASC as a tie-break.  isReachable (A*)
        // is intentionally deferred — we check only the top-K below.
        const scored = walkableTiles
            .filter(t => t.x >= minX && t.x <= maxX && t.y >= minY && t.y <= maxY)
            .map(t => {
                const covered = spawners.filter(s => {
                    const dx = s.x - t.x, dy = s.y - t.y;
                    return Math.sqrt(dx * dx + dy * dy) <= OBSERVATION_DISTANCE;
                }).length;
                const dx = t.x - me.x, dy = t.y - me.y;
                return { t, covered, approxDist: Math.sqrt(dx * dx + dy * dy) };
            })
            .sort((a, b) => b.covered - a.covered || a.approxDist - b.approxDist);

        if (scored.length === 0) return nearest;

        // Verify reachability (A*) only for the best candidates to cap cost.
        const TOP_K = 10;
        for (const { t, covered } of scored.slice(0, TOP_K)) {
            if (this.isReachable(t)) {
                if (covered < spawners.length) {
                    console.log(`[stochastic] partial coverage: ${covered}/${spawners.length} spawners from (${t.x},${t.y})`);
                }
                return t;
            }
        }

        return nearest; // all top-K unreachable — fall back to nearest spawner
    }

    /** Keep the parent's key fields in sync so any code that reads them is safe. */
    #commitTarget(tile) {
        const key = `${tile.x}_${tile.y}`;
        this._prevExploreKey = this._lastExploreKey;
        this._lastExploreKey = key;
    }
}
