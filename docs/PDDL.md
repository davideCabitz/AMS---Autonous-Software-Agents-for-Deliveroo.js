# PDDL — Crate-Push Planning

PDDL is used for exactly one purpose: planning Sokoban-style crate pushes to free a path blocked by crates. Normal navigation is A*. The online solver is only invoked when A* cannot find any crate-free path to the goal.

---

## Domain

**File:** [domain-deliveroo.pddl](domain-deliveroo.pddl)

The domain models a tile grid with movable crates. Key predicates:

| Predicate | Meaning |
|---|---|
| `(tile t)` | `t` is a valid tile |
| `(delivery t)` | `t` is a delivery tile |
| `(agent a)` | `a` is an agent |
| `(at obj t)` | object is at tile `t` |
| `(free t)` | tile `t` is not occupied by a crate |
| `(pushable t)` | `t` is a crate-zone tile (valid push destination) |
| `(crate c)` | `c` is a crate |
| `(right/left/up/down t1 t2)` | adjacency in each direction |

Actions: `move-right`, `move-left`, `move-up`, `move-down` (walk on free tiles) and `push-right`, `push-left`, `push-up`, `push-down` (walk into a crate tile, requiring the destination to be a free pushable tile). Action costs have been stripped — the solver optimises only for plan length.

---

## PddlMove — the PDDL plan executor

**File:** [myAgent/plans/PddlMove.js](myAgent/plans/PddlMove.js)

### Trigger condition — isApplicableTo

```
PddlMove.isApplicableTo(intent, x, y)
```

Returns `true` only when ALL of the following hold:
1. `intent === 'go_to'`
2. `mapHasCrates === true` (the map has crate infrastructure)
3. `crateTiles.length > 0` (at least one crate is currently tracked)
4. `findRoute(me, {x,y}, crateKeys)` returns `null` — no crate-free path exists
5. `findRoute(me, {x,y})` returns non-null — the goal IS reachable if crates can move

If a crate-free path exists, `AStarMove` handles it. If the goal is unreachable even ignoring crates, neither plan can help; `IntentionDeliberation` throws `['no path to', x, y]`.

### Execution — execute

Runs up to `MAX_REPLANS = 6` planning attempts:

1. Calls `#buildProblem(goalTile)` to construct the PDDL problem from live world state:
   - Objects: `me`, all crate ids `c<x>_<y>`, all tile names `t<x>_<y>`.
   - Init: agent position, crate positions and `(at)` facts, tile adjacency from `beliefset`, `(free)` facts for crate-free tiles, `(pushable)` facts for crate-zone tiles.
   - Goal: `(at me goalTile)`.
2. Calls `onlineSolver(domain, problem)` (external HTTP call to the PDDL solver service).
3. Sets `pddl.busy = true` to prevent intention replacement during execution.
4. Runs `#runPlan(plan)`:
   - Each step translates `action` name → direction via `ACTION_DIR`.
   - Walk steps: checks for newly-sensed crates on the planned tile before moving.
   - Push steps: walks into the crate tile, then tracks the crate's new position (`me + 2·Δ`).
   - After each successful move: removes stale crate entries, records timing, does opportunistic pickup of any free parcel on the new tile.
   - If `emitMove` returns falsy mid-plan → `blocked = true`; breaks to replan.
5. If the goal is reached, returns `true`. If blocked, replans from current state. After `MAX_REPLANS` failed replans, throws `['pddl-too-many-replans']`.

`pddl.busy` is always released in a `finally` block, even when a step throws.

---

## pushAwareCost

**File:** [myAgent/utils/astar.js](myAgent/utils/astar.js) — `pushAwareCost(from, to, crateKeys, blockedKeys?)`

A* variant that treats crate tiles as enterable only via a legal push. Step costs:
- Normal walkable tile: 1
- Crate tile (legal push possible): 3 (1 for the step + 2 penalty for the push)
- Crate tile where push is illegal (no free pushable tile behind it, or arrow violation): not expanded (skipped)

Returns the total path cost, or `Infinity` if unreachable.

Used by `Strategy.pathLen` as a cost estimate when no crate-free route exists. It is an **estimate** only — the actual execution uses the PDDL solver. `pushAwareCost` feeds the parcel-value scoring so the agent can de-prioritise targets that require expensive crate pushes.

---

## Crate tracking — three sources

1. **`socket.on('crate', action, {x,y})`** — authoritative global events from the server. `'create'` adds to `crateTiles`; `'dispose'` removes. These fire regardless of observation range.
2. **`onSensing` merge-additive pass** — when `sensing.crates` contains tiles not already in `crateTiles`, they are added. Existing inferred entries are never cleared here (clearing them causes blocked→infer→clear→blocked loops for crates outside sensing range).
3. **Physical-collision inference in `navigateTo`** — when `emitMove` returns falsy on a known `crateSpawnerTile`, a crate is inferred there and added to `crateTiles`. Only fires on crate-zone tiles; other blocks go into `agentBlocked`.

Initial seed: on `onMap`, `crateSpawnerTiles` of type `'5!'` (spawner tiles that start the game with a crate) are seeded into `crateTiles`. Stale seeds are self-correcting on first contact.

---

## Current status

`PddlMove` is functional but rarely triggered in practice because crate maps are uncommon in the challenge scenarios. The trigger requires `crateTiles.length > 0`, which is now correctly seeded from the static map (`'5!'` tiles) rather than relying exclusively on sensing — fixing the earlier bug where `crateTiles` was always empty.

The known remaining gap: if a crate on a `'5!'` tile is moved before sensing range covers it, the seed position is stale. This is self-correcting: dispose events and walk-through cleanup remove the stale entry on first contact.
