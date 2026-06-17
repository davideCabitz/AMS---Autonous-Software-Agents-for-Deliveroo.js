# Beliefs and Context

`context.js` is the shared singleton for the entire agent. Every module imports from it; nothing writes to it except the socket event handlers and the modules that own specific state. This document covers every exported symbol and all four belief classes.

---

## context.js — exported symbols

**File:** [myAgent/context.js](myAgent/context.js)

### Socket and identity

| Export | Type | Description |
|---|---|---|
| `socket` | DjsClient | The live socket connection. `DjsConnect()` is called at module load, so the `TOKEN` env var must be set before this module is imported (see `launch.js`). Reconnects automatically on `'io server disconnect'`. |
| `me` | Me | Agent's own position and score. |
| `role` | `'coordinator'|'worker'` | Set by `launch.js` via `process.env.AGENT_ROLE` before import. |
| `runtime` | `{strategy: Strategy|null}` | Holds the selected strategy instance after first `optionsGeneration` call. Shared so `handoff.js` can drive parcel acquisition with the same strategy. |

### Map geometry (populated once in `onMap`)

| Export | Type | Description |
|---|---|---|
| `deliveryTiles` | `{x,y}[]` | Red delivery tiles. |
| `spawnerTiles` | `{x,y}[]` | Green parcel-spawner tiles. |
| `walkableTiles` | `{x,y}[]` | All non-wall tiles (crate-zone tiles always included even when `walkable:false`). |
| `crateSpawnerTiles` | `{x,y}[]` | Static crate infrastructure tiles (`type '5!'` / `'5'`). |
| `mapHasCrates` | `boolean` | True if any crate infrastructure exists. Cascade gate: when false, crate sensing and `PddlMove` are entirely skipped. |
| `directionalTiles` | `Map<"x_y", arrow>` | Arrow tiles (`'↑'|'→'|'↓'|'←'`). Populated from `walkableTiles` in `onMap`. Used by A* and the PDDL edge generator to enforce one-way entry. |
| `usableDeliverySet` | `Set<"x_y">` | Deliveries in the sustainable pick-up→deliver loop (greatest-fixpoint BFS). |
| `safeTargetSet` | `Set<"x_y">` | All tiles from which a usable delivery is reachable. Gates pickups and exploration so the agent never commits to a zone it can't escape. |
| `beliefset` | `Beliefset` | PDDL beliefset rebuilt on each `onMap`. Contains tile adjacency and delivery facts. |

### Live state (updated every sensing event)

| Export | Type | Description |
|---|---|---|
| `parcels` | Parcels | Live parcel map with optional memory. |
| `crateTiles` | `{x,y}[]` | Currently known crate positions. Three sources: (1) `'crate'` socket events (global, authoritative), (2) `onSensing` merge-additive pass, (3) physical-collision inference in `navigateTo` (only for `crateSpawnerTile` blocks). Removal only via dispose events or walking through. |
| `otherAgents` | `{x,y}[]` | Other agents currently sensed (excluding self). Fully replaced each sensing event — stale positions must not linger. Used as A* obstacles. |

### Server config constants (set once in `onConfig`)

`OBSERVATION_DISTANCE`, `MOVEMENT_DURATION`, `CARRYING_CAPACITY`, `DECAY_INTERVAL_MS`, `PARCEL_GENERATION_MS`, `PARCELS_MAX`, `PARCEL_REWARD_AVG`, `DECAY_STEPS_PER_REWARD`.

The `onConfig` handler normalises two server shapes (nested `config.GAME.*` vs flat `config.*`) and resets `moveTiming.msPerTile` to the server's `movement_duration` whenever config changes.

### moveTiming — EMA-tracked real ms per tile

```
moveTiming.msPerTile   — starts at MOVEMENT_DURATION, converges to real pace
moveTiming.record(ms)  — called after every successful emitMove
moveTiming.decayPerTile() — msPerTile / DECAY_INTERVAL_MS (0 when parcels never decay)
```

Samples above `10 × MOVEMENT_DURATION` are discarded as outliers (long stalls). Used by the cost function's `decayRate()`. See [cost-function.md](cost-function.md).

### Control gates

| Export | Type | Description |
|---|---|---|
| `pddl` | `{busy: boolean}` | `true` while `PddlMove` is executing a plan. Blocks `push` and `commandAndAwait`. |
| `directive` | `{active, aborted}` | `active=true` while the LLM command layer holds control. Blocks `optionsGeneration`. `aborted=true` signals `runDirective` to exit immediately. |
| `trafficLight` | `{red: boolean}` | `true` during the "red light" phase of a red/green-light mission. Blocks `optionsGeneration`, all LLM commands, and all worker orders. |
| `lightMission` | `{active: boolean}` | Armed by `start_light_mission` tool. Live STOP/GO signals are ignored until this is `true`. |
| `manualHold` | `{active: boolean}` | Persistent position hold set by the LLM `hold()` tool. Unlike `directive.active`, persists across directives until `release_hold()`. Cleared also by an abort. |

### missionConstraints

The full set of active Level-2 mission constraints. All fields default to null/empty (= no constraint). See [mission-system.md](mission-system.md) for field semantics and lifecycle.

### Competitor-awareness helpers

Four exported functions consume the private `agentHistory` map (id → `{x, y, vx, vy, lastSeen}`):

| Function | Returns | Used in |
|---|---|---|
| `otherAgentDistTo(tile)` | Min A* distance from any sensed agent to `tile`; Infinity if none. Manhattan pre-filter (`AGENT_DIST_MANH_GATE = 8`) bounds A* calls per tick. Special-cases `manh===0` → 0 without calling A*. | `Strategy.contestFactor`, `Strategy.deliveryCost`, `Strategy.exploreCost` |
| `nearestAgentId(tile)` | Id of the nearest sensed agent by Manhattan distance. | `Strategy.contestFactor` |
| `isAgentMovingToward(id, tile)` | True if `agentId`'s velocity vector has positive dot product with bearing to `tile`. | `Strategy.contestFactor` (softens penalty for non-racing agents) |
| `nearestAgentIsStationary(tile)` | True when the nearest agent has zero velocity (Case 3 in `navigateTo`). | `navigateTo` (abort goal-blocked wait early) |

Ids not re-sensed within `AGENT_STALE_MS = 2000 ms` are pruned from the history.

---

## Me

**File:** [myAgent/beliefs/Me.js](myAgent/beliefs/Me.js)

Stores the agent's own authenticated state.

- `rawX`, `rawY` — fractional in-transit position from `onYou`.
- `x`, `y` — rounded integer tile coordinates (used everywhere for pathfinding).
- `score` — current score.
- `id` — socket id, set on first `onYou`. `isReady` becomes true once id and position are known.

Updated by `me.update(data)` called in `coordinator_agent.js:socket.onYou`.

---

## Parcels

**File:** [myAgent/beliefs/Parcels.js](myAgent/beliefs/Parcels.js)

Maintains two stores:

- `#map` — live parcels currently in sensing range. Replaced/merged each `sync()`.
- `#memory` — remembered parcels that have left sensing range (only enabled when `enableMemory()` is called by a memory-capable strategy). `#ignored` — permanently excluded parcel ids (set by `ignore(id)` when the coordinator drops a parcel for the worker; excluded from all queries).

Key methods:

| Method | Description |
|---|---|
| `sync(raw, myId)` | Merges server parcel data into `#map`; decays remembered parcels' rewards; removes expired memories. |
| `free()` | Returns parcels in `#map` that are not carried and not ignored. |
| `carriedBy(id)` | Returns parcels in `#map` carried by the given agent id. |
| `get(id)` | Looks up a live parcel by id. |
| `remembered()` | Returns parcels in `#memory` not currently in `#map`. |
| `getRemembered(id)` | Looks up a specific remembered parcel (used by `IntentionRevision.#isValid`). |
| `ignore(id)` | Permanently excludes a parcel from all queries (used by `handoff.js` after the coordinator drops a parcel for the worker). |
| `enableMemory()` | Activates the `#memory` store; called by `StrategyMemory` and its descendants. |

---

## SpawnerGroups

**File:** [myAgent/beliefs/SpawnerGroups.js](myAgent/beliefs/SpawnerGroups.js)

Union-Find spatial clustering of spawner tiles. Used by `StrategyLookAheadStochastic` to partition the map into groups and explore them round-robin.

`reachableWithin(start, radius)` — BFS over walkable tiles bounded by a Manhattan distance cap. Returns the set of tile keys reachable from `start` within `radius` steps.

---

## MapTopology

**File:** [myAgent/beliefs/MapTopology.js](myAgent/beliefs/MapTopology.js)

Static map analysis run once after `onMap`. Currently detects "comb" topology (a map with many parallel corridors branching off a single spine) to inform strategy selection in `selectStrategy.js`.

---

## Trap avoidance (greatest-fixpoint BFS)

Computed once in `onMap`. The algorithm:

1. Start with all spawners and all deliveries.
2. Find all tiles from which any delivery is reachable (`tilesThatReach(deliveries)`). Keep only spawners in that set → `newSpawn`.
3. Find all tiles from which any spawner in `newSpawn` is reachable. Keep only deliveries in that set → `newDeliv`.
4. Repeat until stable (no change in both sets).

Result: `usableDeliverySet` = deliveries in a sustainable loop; `safeTargetSet` = tiles from which at least one usable delivery is reachable.

Fallback: if no sustainable delivery exists (whole map is a trap), `safeTargetSet` defaults to `tilesThatReach(all deliveries)` so the agent still functions.

Uses only static geometry (walls + arrows); agents and crates are excluded so the verdict can't flicker between ticks.
