# Navigation

All pathfinding lives in [myAgent/utils/astar.js](myAgent/utils/astar.js) and [myAgent/utils/directions.js](myAgent/utils/directions.js). The PDDL crate-push fallback is documented separately in [PDDL.md](PDDL.md).

---

## Directional tiles

**File:** [myAgent/utils/directions.js](myAgent/utils/directions.js)

`STEP_DIRS` is the canonical cardinal-direction table `[{dx,dy,dir}, ...]` in the fixed order `[right, left, up, down]`. This order participates in A* tie-breaking: reordering it would change returned paths. All three former per-file copies (in `astar.js`, `SpawnerGroups.js`, `PddlMove.js`) now import from here.

Arrow tiles are one-way: entering from the opposite direction is illegal. `canEnterDir(arrowType, fromX, fromY, toX, toY)` returns false when the step would violate the arrow. It is called in every A* neighbour expansion and in the PDDL edge generator.

`ARROW_VECTORS` maps glyph → `{dx,dy}` for the arrow's forward direction. It is a semantically different table and kept distinct from `STEP_DIRS`.

---

## A* — findRoute

**File:** [myAgent/utils/astar.js](myAgent/utils/astar.js) — `findRoute(start, goal, blockedKeys?)`

Returns an array of direction strings `['right', 'up', ...]` or `null` if unreachable.

The search is backed by `aStarCore`, which uses a **binary min-heap open set** ordered by `(f ascending, seq ascending)`. `seq` is the tile's first-discovery order, reproducing the old linear scan's "lowest f, earliest-inserted on ties" choice exactly — paths are byte-identical to the pre-refactor version. Complexity: O(n log n) vs the former O(n²).

Each call:
1. Rounds start/goal to integers. Returns `null` on non-finite coordinates.
2. Builds the blocked set from `agentKeys()` (current `otherAgents` snapshot) plus `blockedKeys`.
3. Filters `getWalkable()` to exclude blocked tiles.
4. Runs `astar(start, goal, walkable)` where each neighbour expansion:
   - Checks `walkable.has(nk)`.
   - Calls `canEnterDir(directionalTiles.get(nk), ...)` to reject one-way violations.
   - Adds a `BACKTRACK_PENALTY = 2` when the step immediately reverses into the grandparent tile.

### getWalkable()

Memoised: rebuilds the `Set<"x_y">` only when `walkableTiles.length` changes (i.e. on a map change). Exported and reused by `handoff.js`, `selectStrategy.js`, and several strategies to avoid redundant set construction.

---

## navigateTo

`navigateTo(targetX, targetY, stoppedFn)` — the step loop used by all executable plans.

1. Rounds target to integer tile.
2. Each iteration: rebuilds the blocked set (crates + agents + `avoidTiles`) and calls `astar` to get the full path to the goal.
3. If no path found: first retries without the `agentBlocked` accumulator (clearing it), then throws `['no path to', x, y]` so `PddlMove` or re-deliberation can take over.
4. Walks the path step by step via `socket.emitMove(dir)`:
   - **Successful move**: waits for `waitForArrival`, records timing in `moveTiming`, clears `agentBlocked`, removes any stale crate entry on the tile just entered.
   - **Crate on planned step**: detected before `emitMove`; breaks to recompute.
   - **Goal blocked**: waits up to `GOAL_BLOCKED_MAX_WAIT = 6` × 500 ms. If the blocking agent is stationary (`nearestAgentIsStationary`), throws `['goal blocked', x, y]` immediately (Case 3 anti-deadlock).
   - **Other block**: adds the tile to `agentBlocked`. On known crate zones infers a crate into `crateTiles`. Otherwise increments `reblockCount`; after `DEADLOCK_REBLOCK_MAX = 3` re-blocks, attempts a random yield step (Case 5 anti-deadlock, up to `YIELD_MAX_ATTEMPTS = 3` times).
5. Calls `stoppedFn()` before each step and at the top of each iteration; throws `['stopped']` immediately if true.

### waitForArrival

```js
waitForArrival(tx, ty)  // resolves after MOVEMENT_DURATION ms
```

The `emitMove` ack fires mid-transition; waiting for `MOVEMENT_DURATION` prevents overlapping moves that cause diagonal drift. `me` is updated by the authoritative `onYou` event independently.

---

## reachableIgnoringAgents

`reachableIgnoringAgents(start, goal)` — checks if `goal` is structurally reachable from `start`, ignoring other agents but respecting walls, arrows, and `avoidTiles`.

Used in `Strategy.nearestEscapableDelivery` to distinguish "no safe delivery because the map is a dead-end" from "safe delivery exists but an agent is blocking it right now". The second case returns `undefined` (hold and retry next tick) instead of diving into a trap.

---

## tilesThatReach

`tilesThatReach(goals)` — reverse BFS: for each goal tile, find all tiles from which it is reachable via legal forward moves. An entry tile `u` is legal for goal tile `v` if the forward edge `u→v` satisfies `canEnterDir`.

Used in `context.js:onMap` to compute `safeTargetSet` and `usableDeliverySet`. Run on static geometry only.

---

## reachableFrom

`reachableFrom(start)` — forward LIFO BFS (DFS-order, O(|walkable|)) from `start`, treating agents and crates as walls, respecting arrows.

Used by the `get_map_info` LLM tool to filter the set of delivery/spawner tiles the LLM is told about to only those it can actually reach from its current position.

---

## Trap avoidance

See [beliefs-and-context.md](beliefs-and-context.md) §"Trap avoidance" for the greatest-fixpoint algorithm and `safeTargetSet`/`usableDeliverySet` semantics.

The strategy layer applies trap avoidance in two places:
- `exploreIfIdle`: prefers tiles in `safeTargetSet` when choosing an explore target.
- `nearestEscapableDelivery`: delivers to `usableDeliverySet` tiles when possible; falls back to trap tiles only when no sustainable delivery is structurally reachable.
