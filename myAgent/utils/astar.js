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

// Floor for the arrival timeout; the real budget scales with the measured pace.
const ARRIVAL_TIMEOUT_FLOOR_MS = 250;

/**
 * Resolve once the agent has actually arrived on tile (tx,ty), or after a
 * timeout. The server's move ack fires before the tile transition physically
 * completes (fractional in-transit coords), so issuing the next step on the ack
 * alone makes consecutive moves overlap and the agent drifts diagonally between
 * tiles. Waiting for the authoritative `onYou` position to reach the target tile
 * paces movement to the real per-tile time without a blind client-side sleep.
 *
 * Returns true if arrived, false if it timed out (caller falls through to the
 * normal blocked/replan handling rather than assuming success).
 */
export function waitForArrival(tx, ty) {
    // Use RAW coords: the move is only truly complete when the un-rounded position
    // reaches the integer target. Rounded `me.x/y` would report arrival at 60% of
    // the move (server jumps 0.6 immediately), making steps overlap → teleporting.
    const arrived = () => me.rawX === tx && me.rawY === ty;
    if (arrived()) return Promise.resolve(true);

    // Budget adapts to server speed; capped above the emitWithAck 1000ms ceiling.
    const budget = Math.min(2000, Math.max(ARRIVAL_TIMEOUT_FLOOR_MS, 2 * moveTiming.msPerTile));

    return new Promise(resolve => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearInterval(iv);
            clearTimeout(timer);
            resolve(ok);
        };
        const iv = setInterval(() => { if (arrived()) finish(true); }, 15);
        const timer = setTimeout(() => finish(false), budget);
    });
}

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

            // Target tile of this step (current rounded position + step delta).
            const { dx: sdx, dy: sdy } = DIRS.find(d => d.dir === dir);
            const tx = Math.round(me.x) + sdx;
            const ty = Math.round(me.y) + sdy;

            const fromX = Math.round(me.x), fromY = Math.round(me.y);
            const tStep  = Date.now();
            const result = await socket.emitMove(dir);
            if (result) {
                // Wait until the agent has actually arrived on the target tile
                // before issuing the next step — the ack fires mid-transition, so
                // continuing immediately overlaps moves and causes diagonal drift.
                // `me` is updated (rounded) by the authoritative onYou event.
                const ok = await waitForArrival(tx, ty);
                const took = Date.now() - tStep;
                console.log(`[move] ${dir} (${fromX},${fromY})→(${tx},${ty}) `
                    + `${ok ? 'arrived' : 'TIMEOUT'} in ${took}ms `
                    + `now raw=(${me.rawX},${me.rawY}) tile=(${me.x},${me.y})`);

                agentBlocked.clear();
                goalBlockedCount = 0;
                // If we moved onto a tile that was in crateTiles, the crate is gone
                // (was pushed or was a stale inference). Remove it so A* can use the tile again.
                const movedKey = key(Math.round(me.x), Math.round(me.y));
                const staleIdx = crateTiles.findIndex(c => key(Math.round(c.x), Math.round(c.y)) === movedKey);
                if (staleIdx !== -1) {
                    crateTiles.splice(staleIdx, 1);
                    console.log(`[nav] walked through ${movedKey} — removed stale crate entry`);
                }
                // Measure the real wall-clock cost of one successful tile, now
                // including the arrival wait, so the scoring's decay rate reflects
                // how fast the agent actually travels.
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
