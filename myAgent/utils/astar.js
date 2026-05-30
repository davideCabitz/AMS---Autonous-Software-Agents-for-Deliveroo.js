import { me, socket, walkableTiles, crateTiles, crateSpawnerTiles, directionalTiles, moveTiming } from '../context.js';
import { canEnterDir } from './directions.js';

const DIRS = [
    { dx:  1, dy:  0, dir: 'right' },
    { dx: -1, dy:  0, dir: 'left'  },
    { dx:  0, dy:  1, dir: 'up'    },
    { dx:  0, dy: -1, dir: 'down'  },
];

const BACKTRACK_PENALTY = 2;

const key = (x, y) => `${x}_${y}`;
const h   = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);

let _walkable = null;
function getWalkable() {
    // Rebuild if null or if walkableTiles changed (map reload).
    if (!_walkable || _walkable.size !== walkableTiles.length)
        _walkable = new Set(walkableTiles.map(t => key(t.x, t.y)));
    return _walkable;
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
            // Arrow tiles: skip a neighbour we'd enter from the forbidden side
            // (opposite the arrow). Normal tiles return undefined -> unrestricted.
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
 * Path (array of directions) from start to goal over the walkable map, optionally
 * treating `blockedKeys` (a Set of "x_y") as impassable. Returns null if no path.
 * Used by PddlMove to decide whether a crate actually blocks the route (so the
 * online solver is only contacted when pushing is genuinely required).
 */
export function findRoute(start, goal, blockedKeys = null) {
    let walkable = getWalkable();
    if (blockedKeys && blockedKeys.size > 0)
        walkable = new Set([...walkable].filter(k => !blockedKeys.has(k)));
    return astar(
        { x: Math.round(start.x), y: Math.round(start.y) },
        { x: Math.round(goal.x),  y: Math.round(goal.y) },
        walkable
    );
}

const GOAL_BLOCKED_WAIT_MS  = 500;
const GOAL_BLOCKED_MAX_WAIT = 6;

export async function navigateTo(targetX, targetY, stoppedFn) {
    const goal    = { x: Math.round(targetX), y: Math.round(targetY) };
    const goalKey = key(goal.x, goal.y);
    const agentBlocked  = new Set();
    let goalBlockedCount = 0;

    while (Math.round(me.x) !== goal.x || Math.round(me.y) !== goal.y) {
        if (stoppedFn()) throw ['stopped'];

        // Rebuild crate exclusion on every iteration: a new crate may have entered
        // sensing range or been reported via event since the last step.
        // Crates are treated as walls; when they block all routes A* returns null
        // and we throw 'no path to', letting PddlMove take over.
        const crateSet    = new Set(crateTiles.map(c => key(Math.round(c.x), Math.round(c.y))));
        const baseWalkable = crateSet.size > 0
            ? new Set([...getWalkable()].filter(k => !crateSet.has(k)))
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

            const tStep  = Date.now();
            const result = await socket.emitMove(dir);
            if (result) {
                me.x = result.x;
                me.y = result.y;
                agentBlocked.clear();
                goalBlockedCount = 0;
                // If we moved onto a tile that was in crateTiles, the crate is gone
                // (was pushed or was a stale inference). Remove it so A* can use the tile again.
                const movedKey = key(Math.round(result.x), Math.round(result.y));
                const staleIdx = crateTiles.findIndex(c => key(Math.round(c.x), Math.round(c.y)) === movedKey);
                if (staleIdx !== -1) {
                    crateTiles.splice(staleIdx, 1);
                    console.log(`[nav] walked through ${movedKey} — removed stale crate entry`);
                }
                // Measure the real wall-clock cost of one successful tile
                // (emitMove resolves only when the server completes the move,
                // plus network latency) so the scoring's decay rate reflects how
                // fast the agent actually travels. Movement pacing is governed by
                // the server's movement_duration, not a client-side sleep.
                moveTiming.record(Date.now() - tStep);
            } else {
                const { dx, dy } = DIRS.find(d => d.dir === dir);
                const bk = key(Math.round(me.x) + dx, Math.round(me.y) + dy);

                if (bk === goalKey) {
                    // In this case we implemented that if an agent is blocking a tile, we wait and retry (maybe the agent will move). Otherwise we replan trying to go around it
                    goalBlockedCount++;
                    if (goalBlockedCount >= GOAL_BLOCKED_MAX_WAIT)
                        throw ['goal blocked', goal.x, goal.y];
                    console.log(`[nav] goal ${bk} blocked — waiting (${goalBlockedCount}/${GOAL_BLOCKED_MAX_WAIT})`);
                    await new Promise(r => setTimeout(r, GOAL_BLOCKED_WAIT_MS));
                } else {
                    agentBlocked.add(bk);
                    // Only infer a crate if the blocked tile is a known crate zone tile.
                    // Any other block (other agents, temporary obstacles) goes into
                    // agentBlocked only — adding them to crateTiles would mark the tile
                    // as having a crate, suppressing (free t) and breaking PDDL goals.
                    const isKnownCrateZone = crateSpawnerTiles.some(t => key(t.x, t.y) === bk);
                    if (isKnownCrateZone && !crateTiles.some(c => key(Math.round(c.x), Math.round(c.y)) === bk)) {
                        const [bx, by] = bk.split('_').map(Number);
                        crateTiles.push({ x: bx, y: by });
                        console.log(`[nav] inferred crate at ${bk} — crateTiles: ${crateTiles.length}`);
                    } else {
                        console.log(`[nav] blocked at ${bk} — recomputing path`);
                    }
                }
                break;
            }
        }
    }
}
