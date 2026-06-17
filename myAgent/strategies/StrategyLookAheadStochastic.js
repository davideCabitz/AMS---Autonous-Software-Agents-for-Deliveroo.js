import { StrategyLookAhead } from './StrategyLookAhead.js';
import { buildGroups } from './SpawnerGroupPatrol.js';
import {
    me, parcels, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, missionConstraints,
} from '../context.js';
import { distance } from '../utils/distance.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('stochastic');

// Max walkable-path steps for two spawners to be neighbours.
const D_CLUSTER  = 2;
// Sliding window: how many past group choices to remember.
const WINDOW_SIZE = 5;
// Distance penalty weight. α=1.5 → farthest group ~0.4 vs 1.0 for nearest.
const ALPHA = 1.5;
// Recency penalty weight. β=3 → one recent choice roughly halves the weight.
const BETA = 3.0;

/**
 * @class StrategyLookAheadStochastic
 * LookAhead with probabilistic group sampling: weight = 1 / (1 + α·normDist +
 * β·recentCount), where normDist is the [0,1]-normalised distance to the group's
 * nearest reachable spawner and recentCount is its hits in the last WINDOW_SIZE choices.
 *
 * Every group keeps a positive weight (no starvation); distance is relative (a far
 * group is penalised only vs. the nearest); recency decays as the window slides.
 *
 * Edge cases: 0/1 group or all unreachable → parent fallback; allowedSpawnerTiles
 * applied before grouping; requiredStackSize → current tile excluded.
 */
export class StrategyLookAheadStochastic extends StrategyLookAhead {
    /** @type {Array<Array<{x: number, y: number}>>|null} Lazily built group list */
    #groups        = null;

    /** @type {Array<number>} Ring buffer of recently chosen group indices (length ≤ WINDOW_SIZE) */
    #recentChoices = [];

    // ── group initialisation ────────────────────────────────────────────────

    /**
     * Lazily build (and cache) spawner groups for sampling
     * @returns {void}
     */
    #initGroups() {
        if (this.#groups !== null) return;
        this.#groups = buildGroups(D_CLUSTER);
        log(
            `built ${this.#groups.length} group(s) from ` +
            `${spawnerTiles.length} spawner tiles: ` +
            this.#groups
                .map((g, i) => `G${i}[${g.map(t => `${t.x},${t.y}`).join(' ')}]`)
                .join(' | ')
        );
    }

    // ── main override ───────────────────────────────────────────────────────

    /**
     * Idle exploration via weighted random group sampling (distance + recency); falls
     * back to the parent's deterministic logic with ≤ 1 group
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Exploration predicate, or null to keep current / stay idle
     */
    exploreIfIdle(currentIntent) {
        this.#initGroups();

        // With ≤ 1 group there's nothing to sample — delegate to the parent.
        if (!this.#groups || this.#groups.length <= 1)
            return super.exploreIfIdle(currentIntent);

        // ── early exits (mirrors Strategy.exploreIfIdle) ────────────────────
        if (currentIntent) {
            const [intent, tx, ty] = currentIntent;

            if (intent === 'go_pick_up' || intent === 'go_deliver') {
                // Productive work started — reset the window and the parent's fields.
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
        // Mission zone constraint (full set if it filters to nothing reachable).
        const basePool = this._allowedSpawnerPool();

        // Reachable only; prefer the sustainable-loop region.
        const reachable = basePool.filter(t => this.isReachable(t));
        if (reachable.length === 0) return null;

        const safe   = reachable.filter(t => this.inSafe(t));
        const usable = safe.length > 0 ? safe : reachable;

        // Prefer spawners outside current sensing (new ground).
        const outOfRange = usable.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
        const candidates = outOfRange.length > 0 ? outOfRange : usable;

        // When accumulating a stack, skip our own tile.
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
                // Nearest eligible spawner by A* path length.
                const best = eligible
                    .map(t => ({ t, d: this.pathLen(me, t) }))
                    .sort((a, b) => a.d - b.d)[0];
                // Keep the full list for coverage-target calculation.
                return { idx, spawners, nearest: best.t, dist: best.d };
            })
            .filter(Boolean);

        if (activeGroups.length === 0) return super.exploreIfIdle(currentIntent);

        // Only one group has reachable eligible tiles — skip sampling.
        if (activeGroups.length === 1) {
            const target = this.#bestCoverageTarget(activeGroups[0]);
            this.#commitTarget(target);
            log(`single active group → (${target.x},${target.y})`);
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
        log(`${diag} → G${chosen.idx} coverage=(${target.x},${target.y})`);

        this.#commitTarget(target);
        this.#recentChoices.push(chosen.idx);
        if (this.#recentChoices.length > WINDOW_SIZE) this.#recentChoices.shift();

        return ['go_explore', target.x, target.y];
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Tile that senses as much of the group as possible in one visit. Fast path: if
     * every spawner is within OBSERVATION_DISTANCE of the nearest eligible spawner, go
     * there. Slow path: the walkable tile (within the group's bbox + sensing radius)
     * maximising covered spawners; A* checked only on the top-K geometric candidates.
     * @param {{spawners: Array<{x: number, y: number}>, nearest: {x: number, y: number}}} group - Active group with its nearest eligible spawner
     * @returns {{x: number, y: number}} Tile maximising sensed coverage
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

        // Score walkable tiles in the box: covered spawners DESC, then distance ASC.
        // isReachable (A*) is deferred — checked only on the top-K below.
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

        // Verify reachability (A*) only for the best candidates.
        const TOP_K = 10;
        for (const { t, covered } of scored.slice(0, TOP_K)) {
            if (this.isReachable(t)) {
                if (covered < spawners.length) {
                    log(`partial coverage: ${covered}/${spawners.length} spawners from (${t.x},${t.y})`);
                }
                return t;
            }
        }

        return nearest; // all top-K unreachable — fall back to nearest spawner
    }

    /**
     * Keep the parent's explore-key fields in sync so any code that reads them is safe
     * @param {{x: number, y: number}} tile - Newly committed explore target
     * @returns {void}
     */
    #commitTarget(tile) {
        const key = `${tile.x}_${tile.y}`;
        this._prevExploreKey = this._lastExploreKey;
        this._lastExploreKey = key;
    }
}
