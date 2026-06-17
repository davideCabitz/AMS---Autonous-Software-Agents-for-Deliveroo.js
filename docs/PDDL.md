# PDDL — Crate-Push & Mission Planning

PDDL serves two roles:

1. **Crate-push planning (always on).** Sokoban-style crate pushes to free a path blocked by crates. Normal navigation is A*; the online solver is invoked only when A* cannot find any crate-free path to the goal.
2. **Mission path-planning (opt-in, env-gated).** For two LLM-accepted missions, the navigation can be handed to the PDDL solver instead of A*, gated by env flags and with A* as an automatic fallback. See [Mission layer](#mission-layer-llm-accepted-goals) below.

Both roles share the same domain, solver, beliefset, `pddl.busy` lock, and `PddlMove` executor.

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
| `(near t)` | `t` is a gather-mission candidate tile (see [Mission layer](#mission-layer-llm-accepted-goals)) |
| `(gathered a)` | `a` has reached some `(near)` tile — the gather goal |

Actions: `right`, `left`, `up`, `down` (walk on free tiles) and `pushRight`, `pushLeft`, `pushUp`, `pushDown` (walk into a crate tile, requiring the destination to be a free pushable tile). A fifth action, `reachGatherSpot`, is a no-op marker used only by the gather mission to make the goal quantifier-free (see Mission layer). Action costs have been stripped — the solver optimises only for plan length.

---

## PddlMove — the PDDL plan executor

**File:** [myAgent/plans/PddlMove.js](myAgent/plans/PddlMove.js)

### Trigger condition — isApplicableTo

```
PddlMove.isApplicableTo(intent, x, y)
```

Requires `intent === 'go_to'`, then matches either path:

**Mission path** (`#isMissionGoTo(x,y)` — env-gated): the goal is an LLM-accepted mission target (see [Mission layer](#mission-layer-llm-accepted-goals)). Applies as long as `findRoute(me, {x,y})` is reachable — **no crates required**.

**Crate path** (original): applies only when ALL hold:
1. `mapHasCrates === true` (the map has crate infrastructure)
2. `crateTiles.length > 0` (at least one crate is currently tracked)
3. `findRoute(me, {x,y}, crateKeys)` returns `null` — no crate-free path exists
4. `findRoute(me, {x,y})` returns non-null — the goal IS reachable if crates can move

If neither matches, `AStarMove` handles the `go_to`. If a mission-path solve fails, `IntentionDeliberation` falls through to `AStarMove` (always applicable to `go_to`) — the transparent fallback.

### Execution — execute / runToGoal

`execute()` is a thin wrapper over `runToGoal(goalTile)`, which runs the planning loop:

1. Calls `#buildProblem(goalTile)` to construct the PDDL problem from live world state:
   - Objects: `me`, all crate ids `c<x>_<y>`, all tile names `t<x>_<y>`.
   - Init: agent position, crate positions and `(at)` facts, tile adjacency from `beliefset`, `(pushable)` facts for crate-zone tiles, and `(free)` facts for every walkable tile **not** occupied by a crate **or another agent** (`otherAgents` tiles are marked not-free so a replan routes around a blocker; our own tile is never excluded).
   - Goal: `(at me goalTile)`.
2. Calls `onlineSolver(domain, problem)` (external HTTP call to the PDDL solver service).
3. Sets `pddl.busy = true` to prevent intention replacement during execution.
4. Runs `#runPlan(plan)`, which returns a status — `'done'`, `'crate'`, or `'agent'`:
   - Each step translates `action` name → direction via `ACTION_DIR`.
   - Walk steps: checks for newly-sensed crates on the planned tile before moving.
   - Push steps: walks into the crate tile, then tracks the crate's new position (`me + 2·Δ`).
   - After each successful move: removes stale crate entries, records timing, does opportunistic pickup of any free parcel on the new tile.
   - If `emitMove` returns falsy mid-plan, it classifies the blocker: an `otherAgents` tile on the next step → `'agent'` (transient); otherwise → `'crate'`.
5. Replan policy based on status:
   - `'done'` but not at goal → throws `['pddl-plan-incomplete']`.
   - `'crate'` → counts against `MAX_REPLANS = 6` (a structural crate dead-end eventually gives up with `['pddl-too-many-replans']`).
   - `'agent'` → **does not consume** the replan budget: pauses `AGENT_YIELD_MS` (so the blocker can move) and replans toward the **same goal**, bounded only by `this.stopped` (intention superseded) and `AGENT_BLOCK_TIMEOUT_MS`. A goal tile that is momentarily agent-occupied (solver returns no plan) is treated the same way.

`pddl.busy` is always released in a `finally` block, even when a step throws. The agent-block behaviour gives the PDDL path parity with the A* navigator, which already yields-and-retries around agents.

---

## Mission layer (LLM-accepted goals)

PDDL can finalize the navigation for two LLM-accepted missions, instead of A*. This is **opt-in per mission** and **always falls back to A*** on any solver failure, so enabling it never breaks a mission.

### Env flags

| Flag | Mission | What PDDL does |
|---|---|---|
| `PDDL_GOTO=1` | "go to (x,y) for N points" | Path-plans the route to the coordinate. |
| `PDDL_GATHER=1` | `gather_near` — keep both agents within distance D of (x,y) | **Selects** the coordinator's tile (the planner picks among the distance-D candidates) and path-plans to it. |

Off by default (`'1'` enables; anything else / unset disables). Read in [context.js](myAgent/context.js) as `pddlGoto` / `pddlGather`. The flags are independent.

### How a `go_to` becomes PDDL-eligible

`PddlMove.#isMissionGoTo(x,y)` matches the goal against a small piece of shared state on the `pddl` object (mirroring the `pddl.busy` convention):

- **`PDDL_GOTO`** matches either:
  - `missionConstraints.oneShotBonus` — the persistent acceptance record when the LLM applies the goal via `apply_mission {"oneShotBonus":…}` (the BDI then weighs it against parcel work via `Strategy.bonusDiversion`, which emits `['go_to', x, y]`); **or**
  - `pddl.gotoTarget` — a short-lived `{x,y}` the `go_to` command tool sets when the LLM runs the instruction as a **direct command** (the common case: the ReAct loop calls `go_to(11,9)` rather than `apply_mission`).
- **`PDDL_GATHER`** does not use a `pddl.*` target. Instead `gather_near` calls `PddlMove.runToGatherSpot(nearKeys)` directly (dynamic import), letting the **planner choose** the coordinator's tile — see below.

For `PDDL_GOTO`, the short-lived `pddl.gotoTarget` is set immediately before the navigation command and cleared in a `finally` once the move settles.

#### Gather: PDDL chooses the tile

For `PDDL_GATHER`, tile selection itself moves into PDDL rather than being grounded in JS:

- `gather_near` still enumerates the distance-D ring, filters to tiles reachable by the coordinator, and excludes the worker's chosen tile — but it hands the **whole candidate set** to the planner instead of picking one. The worker's leg still goes through `sendOrder` deterministically (single-agent PDDL).
- `#buildProblem({ nearKeys })` tags each candidate tile with a `(near t)` fact and sets the goal to `(gathered me)`. The domain's `reachGatherSpot` marker action has precondition `(and (at me ?t) (near ?t))` and effect `(gathered me)` — so the existential "reach *some* candidate" lives in the action precondition, keeping the goal quantifier-free (the STRIPS backend cannot express a quantified/disjunctive goal directly).
- The planner picks the shortest-to-reach candidate and commits via `reachGatherSpot` (a no-op at execution — `#runPlan` skips it, as `ACTION_DIR` has no entry). `runToGatherSpot` detects arrival when the agent stands on any `near` tile, and shares `runToGoal`'s crate-vs-agent replan policy.
- On any solver failure, `gather_near` falls back to walking to JS's pre-computed `tileB` via A* — so enabling the flag never costs reachability.

### Files touched

- [context.js](myAgent/context.js) — `pddlGoto` / `pddlGather` flags; `pddl.gotoTarget` field (go-to only).
- [domain-deliveroo.pddl](domain-deliveroo.pddl) — `(near ?t)` / `(gathered ?a)` predicates and the `reachGatherSpot` marker action (gather tile-selection).
- [myAgent/plans/PddlMove.js](myAgent/plans/PddlMove.js) — `#isMissionGoTo`, widened `isApplicableTo`, `runToGoal`, `runToGatherSpot`, `#buildProblem({goalTile|nearKeys})`, agent-block replan.
- [myAgent/llm/commandTools.js](myAgent/llm/commandTools.js) — `go_to` sets `pddl.gotoTarget`; `gather_near` hands the candidate ring to `runToGatherSpot` (lazy import) with A* fallback.

The crate-push role and the existing mission code paths are untouched when the flags are off.

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

`PddlMove` is functional. The **crate-push** role is rarely triggered in practice because crate maps are uncommon in the challenge scenarios; its trigger requires `crateTiles.length > 0`, now correctly seeded from the static map (`'5!'` tiles) rather than relying exclusively on sensing — fixing the earlier bug where `crateTiles` was always empty. Known remaining gap: a crate on a `'5!'` tile moved before sensing covers it leaves a stale seed, self-corrected by dispose events and walk-through cleanup on first contact.

The **mission** role (`PDDL_GOTO` / `PDDL_GATHER`) triggers on any map regardless of crates, but only when the matching flag is set and the LLM has accepted the mission. With the flags unset (the default), behaviour is identical to before — navigation is A*.
