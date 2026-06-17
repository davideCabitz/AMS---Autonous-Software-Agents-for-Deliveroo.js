import { crateSpawnerTiles, crateTiles, directionalTiles, me, MOVEMENT_DURATION, moveTiming, otherAgents, socket, walkableTiles, missionConstraints, nearestAgentIsStationary } from '../context.js';
import { canEnterDir } from './directions.js';
import { createLogger } from './logger.js';

const navLog  = createLogger('nav');
const moveLog = createLogger('move');

const DIRS = [
    { dx:  1, dy:  0, dir: 'right' },
    { dx: -1, dy:  0, dir: 'left'  },
    { dx:  0, dy:  1, dir: 'up'    },
    { dx:  0, dy: -1, dir: 'down'  },
];

const BACKTRACK_PENALTY = 2;

const key = (x, y) => `${x}_${y}`;
const h   = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);


/**
 * Wait for the server's per-tile animation to complete
 * @param {number} tx - Target x (unused, kept for semantic clarity)
 * @param {number} ty - Target y (unused, kept for semantic clarity)
 * @returns {Promise<void>} Resolves after the movement duration
 */
export function waitForArrival(tx, ty) {
    return new Promise(resolve => setTimeout(resolve, MOVEMENT_DURATION));
}

/** @type {Set<string>|null} Cached walkable tile keys */
let _walkable = null;

/**
 * Walkable tile set, rebuilt if the map changed
 * @returns {Set<string>} Set of "x_y" walkable tile keys
 */
function getWalkable() {
    if (!_walkable || _walkable.size !== walkableTiles.length)
        _walkable = new Set(walkableTiles.map(t => key(t.x, t.y)));
    return _walkable;
}

/**
 * Tiles currently occupied by other agents
 * @returns {Set<string>} Set of "x_y" keys
 */
function agentKeys() {
    return new Set(otherAgents.map(a => key(Math.round(a.x), Math.round(a.y))));
}

function astar(start, goal, walkable) {
    const startKey = key(start.x, start.y);
    const goalKey  = key(goal.x,  goal.y);

    const gScore   = new Map([[startKey, 0]]);
    const fScore   = new Map([[startKey, h(start.x, start.y, goal.x, goal.y)]]);
    const cameFrom = new Map(); 
    const open     = new Map([[startKey, start]]);
    const closed   = new Set();

    while (open.size > 0) {
        let currentKey = null, lowestF = Infinity;
        for (const k of open.keys()) {
            const f = fScore.get(k) ?? Infinity;
            if (f < lowestF) { lowestF = f; currentKey = k; }
        }

        if (currentKey === goalKey) {
            const path = [];
            let k = currentKey;
            while (cameFrom.has(k)) {
                const { parentKey, dir } = cameFrom.get(k);
                path.unshift(dir);
                k = parentKey;
            }
            return path;
        }

        const cur = open.get(currentKey);
        open.delete(currentKey);
        closed.add(currentKey);

        const g      = gScore.get(currentKey);
        const parent = cameFrom.get(currentKey);

        for (const { dx, dy, dir } of DIRS) {
            const nx = cur.x + dx, ny = cur.y + dy, nk = key(nx, ny);
            if (closed.has(nk) || !walkable.has(nk)) continue;
            // Arrow tiles: skip a neighbour entered from the forbidden side (opposite
            // the arrow). Normal tiles return undefined → unrestricted.
            if (!canEnterDir(directionalTiles.get(nk), cur.x, cur.y, nx, ny)) continue;

            const penalty    = (parent && nk === parent.parentKey) ? BACKTRACK_PENALTY : 0;
            const tentativeG = g + 1 + penalty;

            if (tentativeG < (gScore.get(nk) ?? Infinity)) {
                cameFrom.set(nk, { parentKey: currentKey, dir });
                gScore.set(nk, tentativeG);
                fScore.set(nk, tentativeG + h(nx, ny, goal.x, goal.y));
                if (!open.has(nk)) open.set(nk, { x: nx, y: ny });
            }
        }
    }

    return null;
}

/**
 * A* pathfinding from start to goal over the walkable map
 * @param {{x: number, y: number}} start - Starting position
 * @param {{x: number, y: number}} goal - Goal position
 * @param {Set<string>|null} blockedKeys - Optional "x_y" tiles to treat as impassable
 * @returns {Array<string>|null} Direction strings ('up'/'down'/'left'/'right'), or null if unreachable
 */
export function findRoute(start, goal, blockedKeys = null) {
    const s = { x: Math.round(start.x), y: Math.round(start.y) };
    const g = { x: Math.round(goal.x),  y: Math.round(goal.y) };

    // Non-finite coords (an unresolved parcel/agent sighting) make the heuristic NaN,
    // which crashes astar's open-set selection. Treat as unreachable — the clean
    // failure every caller already handles.
    if (![s.x, s.y, g.x, g.y].every(Number.isFinite)) return null;

    const blocked = agentKeys();
    if (blockedKeys) for (const k of blockedKeys) blocked.add(k);
    blocked.delete(key(s.x, s.y)); // never block where we stand

    let walkable = getWalkable();
    if (blocked.size > 0)
        walkable = new Set([...walkable].filter(k => !blocked.has(k)));

    return astar(s, g, walkable);
}

/**
 * Whether goal is structurally reachable from start, ignoring other agents
 * @param {{x: number, y: number}} start - Starting position
 * @param {{x: number, y: number}} goal - Goal position
 * @returns {boolean} True if a path exists with agents ignored (walls/arrows respected)
 */
export function reachableIgnoringAgents(start, goal) {
    const s = { x: Math.round(start.x), y: Math.round(start.y) };
    const g = { x: Math.round(goal.x),  y: Math.round(goal.y) };
    if (![s.x, s.y, g.x, g.y].every(Number.isFinite)) return false;

    let walkable = getWalkable();
    // Honour mission avoidTiles (a hard ban), but NOT other agents.
    const avoid = missionConstraints.avoidTiles;
    if (avoid?.size > 0) {
        walkable = new Set([...walkable].filter(k => !avoid.has(k)));
        walkable.add(key(s.x, s.y)); // never block where we stand
    }
    return astar(s, g, walkable) != null;
}

/**
 * Cost to reach goal pushing crates (crate tiles passable only via legal pushes)
 * @param {{x: number, y: number}} from - Starting position
 * @param {{x: number, y: number}} to - Goal position
 * @param {Set<string>} crateKeys - "x_y" tiles occupied by crates
 * @param {Set<string>|null} blockedKeys - Optional extra impassable tiles (avoidTiles)
 * @returns {number} Total path cost in steps, or Infinity if unreachable
 */
export function pushAwareCost(from, to, crateKeys, blockedKeys = null) {
    const s = { x: Math.round(from.x), y: Math.round(from.y) };
    const goalKey = key(Math.round(to.x), Math.round(to.y));
    const startKey = key(s.x, s.y);

    const walkable = getWalkable();
    const zones   = new Set(crateSpawnerTiles.map(t => key(t.x, t.y)));
    const crates  = new Set(crateKeys);
    const blocked = agentKeys();
    if (blockedKeys) for (const k of blockedKeys) blocked.add(k);
    blocked.delete(startKey);

    const passable = k => walkable.has(k) && !blocked.has(k);

    const gScore = new Map([[startKey, 0]]);
    const fScore = new Map([[startKey, h(s.x, s.y, Math.round(to.x), Math.round(to.y))]]);
    const open   = new Map([[startKey, s]]);
    const closed = new Set();

    while (open.size > 0) {
        let currentKey = null, lowestF = Infinity;
        for (const k of open.keys()) {
            const f = fScore.get(k) ?? Infinity;
            if (f < lowestF) { lowestF = f; currentKey = k; }
        }

        if (currentKey === goalKey) return gScore.get(currentKey);

        const cur = open.get(currentKey);
        open.delete(currentKey);
        closed.add(currentKey);
        const g = gScore.get(currentKey);

        for (const { dx, dy } of DIRS) {
            const nx = cur.x + dx, ny = cur.y + dy, nk = key(nx, ny);
            if (closed.has(nk) || !passable(nk)) continue;
            if (!canEnterDir(directionalTiles.get(nk), cur.x, cur.y, nx, ny)) continue;

            let stepCost = 1;
            if (crates.has(nk)) {
                // Entering a crate tile pushes the crate one tile onward.
                const px = nx + dx, py = ny + dy, pk = key(px, py);
                if (!zones.has(pk) || !passable(pk) || crates.has(pk)
                    || !canEnterDir(directionalTiles.get(pk), nx, ny, px, py))
                    continue; // push impossible from this side
                stepCost = 3;
            }

            const tentativeG = g + stepCost;
            if (tentativeG < (gScore.get(nk) ?? Infinity)) {
                gScore.set(nk, tentativeG);
                fScore.set(nk, tentativeG + h(nx, ny, Math.round(to.x), Math.round(to.y)));
                if (!open.has(nk)) open.set(nk, { x: nx, y: ny });
            }
        }
    }
    return Infinity;
}

/**
 * Reverse BFS: all tiles from which at least one goal is reachable
 * @param {Array<{x: number, y: number}>} goals - Goal tiles to reach
 * @returns {Set<string>} "x_y" tiles with a path to at least one goal
 */
export function tilesThatReach(goals) {
    const walkable = getWalkable();
    const seen  = new Set();
    const queue = [];

    for (const gt of goals) {
        const gx = Math.round(gt.x), gy = Math.round(gt.y), gk = key(gx, gy);
        if (walkable.has(gk) && !seen.has(gk)) {
            seen.add(gk);
            queue.push({ x: gx, y: gy });
        }
    }

    // Index-based queue (avoids O(n) shift). For a known-good tile v, predecessor
    // u = v − Δ is good iff the forward edge u→v is legal (v's arrow permits entry from u).
    for (let i = 0; i < queue.length; i++) {
        const v = queue[i];
        const vKey = key(v.x, v.y);
        for (const { dx, dy } of DIRS) {
            const ux = v.x - dx, uy = v.y - dy, uk = key(ux, uy);
            if (seen.has(uk) || !walkable.has(uk)) continue;
            if (!canEnterDir(directionalTiles.get(vKey), ux, uy, v.x, v.y)) continue;
            seen.add(uk);
            queue.push({ x: ux, y: uy });
        }
    }
        return seen;
}

/**
 * BFS: all tiles reachable from start (crates as walls, agents/walls/arrows respected)
 * @param {{x: number, y: number}} start - Starting position
 * @returns {Set<string>} "x_y" keys reachable from start
 */
export function reachableFrom(start) {
    const s = { x: Math.round(start.x), y: Math.round(start.y) };
    const startKey = key(s.x, s.y);
    const walkable = getWalkable();
    const blocked  = agentKeys();
    // Crates count as walls (matches navigateTo's plain A*), else a push-only tile
    // would be reported as freely reachable.
    for (const c of crateTiles) blocked.add(key(Math.round(c.x), Math.round(c.y)));
    blocked.delete(startKey);                 // never block where we stand

    const seen  = new Set([startKey]);
    const stack = [s];
    while (stack.length) {
        const cur = stack.pop();
        for (const { dx, dy } of DIRS) {
            const nx = cur.x + dx, ny = cur.y + dy, nk = key(nx, ny);
            if (seen.has(nk) || !walkable.has(nk) || blocked.has(nk)) continue;
            if (!canEnterDir(directionalTiles.get(nk), cur.x, cur.y, nx, ny)) continue;
            seen.add(nk);
            stack.push({ x: nx, y: ny });
        }
    }
    return seen;
}

const GOAL_BLOCKED_WAIT_MS  = 500;
const GOAL_BLOCKED_MAX_WAIT = 6;

// Case 5 (anti-deadlock): after re-blocking on the SAME non-goal agent tile this many
// times in one navigateTo, try a yield — a random step to a free neighbour + pause —
// to break a mutual block (two agents facing off). Random breaks the symmetry; allow
// a few attempts before falling back to the throw.
const DEADLOCK_REBLOCK_MAX = 3;
const YIELD_MAX_ATTEMPTS    = 3;
const YIELD_PAUSE_MS        = 400;

/**
 * Try to break a mutual deadlock by stepping to a random free neighbour
 * @param {string} blockedTile - "x_y" of the blocking tile (never yield onto it)
 * @param {Set<string>} agentBlocked - "x_y" keys currently blocking movement
 * @returns {Promise<void>}
 */
async function tryYield(blockedTile, agentBlocked) {
    const cx = Math.round(me.x), cy = Math.round(me.y);
    const here = key(cx, cy);
    const crateSet = new Set(crateTiles.map(c => key(Math.round(c.x), Math.round(c.y))));
    const walkable = getWalkable();

    // Any free, arrow-legal, unoccupied neighbour except the blocking tile.
    const candidates = DIRS
        .map(({ dx, dy, dir }) => ({ x: cx + dx, y: cy + dy, dir }))
        .filter(({ x, y }) => {
            const k = key(x, y);
            return k !== here && k !== blockedTile
                && walkable.has(k) && !crateSet.has(k)
                && !agentBlocked.has(k) && !agentKeys().has(k)
                && canEnterDir(directionalTiles.get(k), cx, cy, x, y);
        });

    if (candidates.length === 0) {
        // Nowhere to step (1-wide dead-end facing the blocker): pause and let the loop
        // retry — the other agent may yield or move on.
        navLog('yield: no free neighbour — pausing in place');
        await new Promise(r => setTimeout(r, YIELD_PAUSE_MS));
        return;
    }

    // Random pick breaks the symmetry that makes two facing agents re-collide.
    const step = candidates[Math.floor(Math.random() * candidates.length)];
    navLog(`yield: random step ${step.dir} to (${step.x},${step.y}) to break deadlock`);
    const ok = await socket.emitMove(step.dir);
    if (ok) await waitForArrival(step.x, step.y);
    await new Promise(r => setTimeout(r, YIELD_PAUSE_MS));
}

/**
 * Navigate to a target tile with deadlock detection and replan-on-obstacle
 * @param {number} targetX - Target x
 * @param {number} targetY - Target y
 * @param {Function} stoppedFn - Returns true if navigation should stop
 * @returns {Promise<void>}
 */
export async function navigateTo(targetX, targetY, stoppedFn) {
    const goal    = { x: Math.round(targetX), y: Math.round(targetY) };
    const goalKey = key(goal.x, goal.y);
    const agentBlocked  = new Set();
    let goalBlockedCount = 0;
    // Case 5: per-tile re-block tally + a bounded yield budget for this navigation.
    const reblockCount  = new Map();   // blocking-agent tile "x_y" -> count
    let yieldAttempts = 0;

    while (Math.round(me.x) !== goal.x || Math.round(me.y) !== goal.y) {
        if (stoppedFn()) throw ['stopped'];

        // Rebuild crate + agent exclusion each iteration (a new one may have entered
        // sensing). Both are walls; when they block all routes A* returns null and we
        // throw 'no path to', handing over to PddlMove / re-deliberation. Never block
        // our own tile.
        const hereKey     = key(Math.round(me.x), Math.round(me.y));
        const crateSet    = new Set(crateTiles.map(c => key(Math.round(c.x), Math.round(c.y))));
        const blockSet    = new Set([...crateSet, ...agentKeys()]);
        for (const k of missionConstraints.avoidTiles) blockSet.add(k);
        blockSet.delete(hereKey);
        const baseWalkable = blockSet.size > 0
            ? new Set([...getWalkable()].filter(k => !blockSet.has(k)))
            : getWalkable();

        const effective = agentBlocked.size === 0
            ? baseWalkable
            : new Set([...baseWalkable].filter(k => !agentBlocked.has(k)));

        let path = astar({ x: Math.round(me.x), y: Math.round(me.y) }, goal, effective);

        if (!path || path.length === 0) {
            agentBlocked.clear();
            path = astar({ x: Math.round(me.x), y: Math.round(me.y) }, goal, baseWalkable);
        }

        if (!path || path.length === 0) throw ['no path to', goal.x, goal.y];

        for (const dir of path) {
            if (stoppedFn()) throw ['stopped'];
            if (Math.round(me.x) === goal.x && Math.round(me.y) === goal.y) return;

            // This step's target tile (rounded position + delta).
            const { dx: sdx, dy: sdy } = DIRS.find(d => d.dir === dir);
            const tx = Math.round(me.x) + sdx;
            const ty = Math.round(me.y) + sdy;

            // A crate sensed after this path was computed may now sit on the step.
            // Walking into it would push it without PDDL — break to recompute (a
            // 'no path to' throw then hands over to PddlMove if crates wall the goal).
            const stepKey = key(tx, ty);
            if (crateTiles.some(c => key(Math.round(c.x), Math.round(c.y)) === stepKey)) {
                navLog(`crate sensed on planned step ${stepKey} — recomputing`);
                break;
            }

            const fromX = Math.round(me.x), fromY = Math.round(me.y);
            const tStep  = Date.now();
            const result = await socket.emitMove(dir);
            if (result) {
                // Wait for actual arrival before the next step — the ack fires
                // mid-transition, so continuing immediately overlaps moves and drifts
                // diagonally.
                const ok = await waitForArrival(tx, ty);
                const took = Date.now() - tStep;
                moveLog(`${dir} (${fromX},${fromY})→(${tx},${ty}) `
                    + `${ok ? 'arrived' : 'TIMEOUT'} in ${took}ms `
                    + `now raw=(${me.rawX},${me.rawY}) tile=(${me.x},${me.y})`);

                agentBlocked.clear();
                goalBlockedCount = 0;
                // Moved onto a tile that was in crateTiles → the crate is gone (pushed
                // or stale). Remove it so A* can use the tile again.
                const movedKey = key(Math.round(me.x), Math.round(me.y));
                const staleIdx = crateTiles.findIndex(c => key(Math.round(c.x), Math.round(c.y)) === movedKey);
                if (staleIdx !== -1) {
                    crateTiles.splice(staleIdx, 1);
                    navLog(`walked through ${movedKey} — removed stale crate entry`);
                }
                // Record the real per-tile cost (incl. arrival wait) so the decay rate
                // reflects actual travel speed.
                moveTiming.record(Date.now() - tStep);
            } else {
                const { dx, dy } = DIRS.find(d => d.dir === dir);
                const bk = key(Math.round(me.x) + dx, Math.round(me.y) + dy);

                if (bk === goalKey) {
                    // Agent on the goal tile: normally wait and retry (it may pass
                    // through). Case 3: if it's stationary (parked/deadlocked), waiting
                    // is wasted — throw 'goal blocked' now so re-deliberation picks a
                    // new target.
                    const [bx, by] = bk.split('_').map(Number);
                    if (nearestAgentIsStationary({ x: bx, y: by })) {
                        navLog(`goal ${bk} blocked by STATIONARY agent — aborting wait`);
                        throw ['goal blocked', goal.x, goal.y];
                    }
                    goalBlockedCount++;
                    if (goalBlockedCount >= GOAL_BLOCKED_MAX_WAIT)
                        throw ['goal blocked', goal.x, goal.y];
                    navLog(`goal ${bk} blocked — waiting (${goalBlockedCount}/${GOAL_BLOCKED_MAX_WAIT})`);
                    await new Promise(r => setTimeout(r, GOAL_BLOCKED_WAIT_MS));
                } else {
                    agentBlocked.add(bk);
                    // Only infer a crate on a known crate-zone tile. Other blocks
                    // (agents, transient obstacles) go to agentBlocked only — pushing
                    // them into crateTiles would suppress (free t) and break PDDL goals.
                    const isKnownCrateZone = crateSpawnerTiles.some(t => key(t.x, t.y) === bk);
                    if (isKnownCrateZone && !crateTiles.some(c => key(Math.round(c.x), Math.round(c.y)) === bk)) {
                        const [bx, by] = bk.split('_').map(Number);
                        crateTiles.push({ x: bx, y: by });
                        navLog(`inferred crate at ${bk} — crateTiles: ${crateTiles.length}`);
                    } else {
                        // Case 5: count repeated blocks; after DEADLOCK_REBLOCK_MAX, one
                        // yield (random step to a free neighbour) to break a mutual block.
                        const n = (reblockCount.get(bk) ?? 0) + 1;
                        reblockCount.set(bk, n);
                        if (yieldAttempts < YIELD_MAX_ATTEMPTS && n >= DEADLOCK_REBLOCK_MAX && !isKnownCrateZone) {
                            yieldAttempts++;
                            // Reset the tally so each yield gets DEADLOCK_REBLOCK_MAX
                            // fresh re-blocks before the next try.
                            reblockCount.set(bk, 0);
                            navLog(`yield attempt ${yieldAttempts}/${YIELD_MAX_ATTEMPTS} at ${bk}`);
                            await tryYield(bk, agentBlocked);
                        } else {
                            navLog(`blocked at ${bk} — recomputing path (reblock ${n})`);
                        }
                    }
                }
                break;
            }
        }
    }
}
