# Crate Obstacle System

Crates are Sokoban-style movable obstacles that can block the agent's path to parcels and delivery tiles. This document describes how the system detects, tracks, and plans around them.

---

## 1. The Problem

The game map has yellow tiles (`type '5!'` = crate spawner, `type '5'` = crate sliding tile). Crates spawn on these tiles and can be pushed by the agent walking into them — but only onto another free crate-zone tile adjacent in the push direction. A crate sitting on the only corridor between the agent and its goal makes navigation impossible with pure A*.

---

## 2. Map-Time Initialisation (`context.js` `onMap`)

On map load, two static arrays are populated once:

| Array | Content |
|---|---|
| `crateSpawnerTiles` | All tiles with `type '5!'` or `'5'` — the yellow crate-zone tiles |
| `walkableTiles` | All non-wall walkable tiles; crate-zone tiles are **always** included even if the server marks `walkable: false` (the PDDL planner must know about them) |

`mapHasCrates = crateSpawnerTiles.length > 0` gates the entire crate system. If the map has no crate tiles, no crate-related code runs.

The PDDL **beliefset** (static map topology) is also rebuilt here: for every walkable tile, `tile`, `delivery`, and four directional adjacency facts (`right`, `left`, `up`, `down`) are declared. Crate-zone tiles participate in this graph, so the planner can reason about navigating to push positions and pushing destinations.

---

## 3. Live Crate Tracking (`context.js`)

`crateTiles[]` holds the **current known positions of crates** on the map. It has three population sources, in priority order:

### Source 1 — Server events (most reliable)
```
socket.on('crate', (action, { x, y }) => ...)
```
The server fires `'create'` when a crate appears and `'dispose'` when it moves away or is destroyed. These events are global (not limited by observation range). When they fire, `crateTiles` is updated immediately.

**Limitation:** This server version does not always fire these events reliably.

### Source 2 — Sensing (additive, range-limited)
```
socket.onSensing(sensing => ...)
```
`sensing.crates` lists crates within observation distance. On each tick, newly sensed crates are **merged into** `crateTiles` (not cleared and replaced). Clearing was tried and caused a loop: inferred crates outside sensing range were wiped each tick, allowing A* to re-route through them.

Removal from `crateTiles` does **not** happen from sensing. Only server dispose events or successful navigation through a tile remove entries.

### Source 3 — Physical collision inference (fallback)
When `navigateTo` calls `emitMove` and the move fails at an intermediate tile:
- If the blocked tile is in `crateSpawnerTiles` → a crate is definitely there (only crates block crate-zone tiles) → add to `crateTiles`, log `[nav] inferred crate at X_Y`
- Otherwise → add to `agentBlocked` (temporary: another agent, etc.), replan A*

**Critical constraint:** Only crate-zone tiles trigger the crate inference. Adding any blocked tile to `crateTiles` was tried and caused the FF planner error `goal can be simplified to FALSE` — because tiles blocked by other agents (e.g. the goal tile itself) were marked as crates, removing their `(free t)` fact and making the goal provably unreachable.

### Cleanup — Stale crate removal
When `emitMove` **succeeds** and the agent moves onto a tile that was in `crateTiles`:
```js
const staleIdx = crateTiles.findIndex(c => key(c.x, c.y) === movedKey);
if (staleIdx !== -1) crateTiles.splice(staleIdx, 1);
```
This handles the case where a PDDL plan pushed a crate away from position X, but `crateTiles` still had X as a crate. When the agent walks through X later, the stale entry is removed.

---

## 4. A\* Navigation with Crate Awareness (`astar.js`)

`navigateTo` treats crates as walls on every planning iteration:

```js
// Rebuilt every while-loop iteration (not once at the top)
const crateSet    = new Set(crateTiles.map(c => key(c.x, c.y)));
const baseWalkable = crateSet.size > 0
    ? new Set([...getWalkable()].filter(k => !crateSet.has(k)))
    : getWalkable();
```

Rebuilding on every iteration (not once at the start of navigation) ensures that newly inferred crates take effect on the very next A* call, without needing to restart navigation.

**Two-tier blocking:**

| Type | Handler | Lifetime |
|---|---|---|
| Crate | `crateTiles` | Permanent until physically verified gone |
| Other agent / temp | `agentBlocked` | Cleared on every successful move |

When A* finds no path even with only crate exclusion → throws `['no path to', x, y]` → `AStarMove` fails → `PddlMove` is attempted.

---

## 5. PDDL Plan Library Order (`planLibrary.js`)

```js
[GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove]
```

`PddlMove` is checked **before** `AStarMove` for every `go_to` sub-intention. The `isApplicableTo` check is a cheap local A* decision, not a solver call:

```
1. No map crate tiles, or crateTiles empty → false (instant, AStarMove runs)
2. A crate-free path exists → false (AStarMove handles it cheaply)
3. No crate-free path, but topological path exists → true → PDDL solver called
```

This means `PddlMove` fires immediately when a crate is detected as blocking, before `AStarMove` even tries. This is important because `AStarMove` with crate-exclusion would throw "no path" and the greedy strategy might replace the intention before `AStarMove` can fail — causing the "looping without planning" symptom.

---

## 6. PDDL Domain (`domain-deliveroo.pddl`)

Uses `:strips` (no action costs for solver speed). Key predicates:

| Predicate | Meaning |
|---|---|
| `(free ?t)` | No crate currently on tile `?t` |
| `(pushable ?t)` | A crate is legally allowed to land on `?t` (crate-zone tiles only) |
| `(crate ?c)` | Object `?c` is a crate |
| `(at ?x ?t)` | Agent or crate `?x` is at tile `?t` |

**Move actions** (`right/left/up/down`): require `(free ?to)` — the agent cannot step onto a tile that has a crate.

**Push actions** (`pushRight/Left/Up/Down`): the agent is behind the crate in the push direction. The crate slides one tile forward if `(free ?destPos)` AND `(pushable ?destPos)`. Both agent and crate positions update; `(free)` is toggled accordingly.

Crates can **only** be pushed to crate-zone tiles (`pushable`). Regular walkable tiles, delivery tiles, and parcel spawner tiles are never `pushable`. This matches the game's physics.

---

## 7. PDDL Problem Construction (`PddlMove.js` `#buildProblem`)

Built as an inline string (not from a file template — template files caused a "first-occurrence replacement only" bug where comment-line placeholders consumed `.replace()` calls before the actual PDDL body lines).

Key sections:

```
(:objects  me  <crate-ids>  <all-tile-ids-from-beliefset>)
(:init
  (me me) (agent me) (at me <current-tile>)
  (crate c<x>_<y>) (at c<x>_<y> t<x>_<y>)   ← one per entry in crateTiles
  <beliefset topology: tile, delivery, right/left/up/down facts>
  (free t<x>_<y>)     ← for every walkable tile NOT in crateSet
  (pushable t<x>_<y>) ← for every tile in crateSpawnerTiles
)
(:goal (at me <goal-tile>))
```

Naming convention: PDDL names must start with a letter (the solver tokenises leading digits as numbers). Tiles: `t<x>_<y>`. Crates: `c<x>_<y>`. Raw `<x>_<y>` form is only used internally for A* Set keys.

The diagnostic log lines printed before each solver call:
```
[pddl] crates: [...]             ← what crateTiles contains
[pddl] crate zones (pushable):   ← crateSpawnerTiles positions
[pddl] free pushable targets:    ← valid push destinations (empty crate-zone tiles)
[pddl] goal: tX_Y | me: tX_Y
```
If `free pushable targets: []`, the solver will always return no plan — the crate cannot be pushed anywhere.

---

## 8. PDDL Execution (`PddlMove.js` `execute` + `#runPlan`)

1. Build problem from **current** state (agent position, crate positions).
2. Call `onlineSolver` — remote HTTP call to `solver.planning.domains:5001` (~1–2 s).
3. If no plan returned: throw `['pddl-no-plan']` → AStarMove fallback.
4. Set `pddl.busy = true` — blocks `IntentionRevisionReplace` from stopping the intention mid-plan.
5. Execute each step via `emitMove(dir)`. Both walk and push actions are a single directional move (the game pushes a crate automatically when the agent walks into it).
6. If a step is physically blocked (new unforeseen crate appeared) → `return true` (needs replan) → loop back to step 1 with fresh state (up to `MAX_REPLANS = 6` times).
7. Set `pddl.busy = false` in `finally` — always released, even on error.

---

## 9. Intention Protection (`IntentionRevisionReplace.js`)

```js
if (pddl.busy) {
    console.log('[intention] PDDL plan in progress — deferring: ...');
    return;
}
```

Once a plan is being executed (`pddl.busy = true`), the greedy strategy's `go_pick_up` or `go_deliver` pushes are silently dropped until the plan finishes. This prevents the agent from abandoning a 20-step push-and-navigate plan the moment a parcel appears on the map.

---

## 10. Known Limitations and Open Issues

### `ff: goal can be simplified to FALSE`
The FF planner reports this when the goal is provably unreachable. Root cause: the goal tile was added to `crateTiles` (marking it as a crate), so `(free t_goal)` was never declared, and no move action can land there. This happens when a non-crate-zone tile (e.g. the goal tile itself, blocked temporarily by another agent) is incorrectly inferred as a crate.

**Current fix:** inference only adds tiles in `crateSpawnerTiles`. Non-crate-zone blocks go to `agentBlocked` only.

**Remaining risk:** if a crate spawns at a tile that is not detected in `crateSpawnerTiles` (due to server tile-type format mismatch), it cannot be inferred via physical collision.

### `socket.on('crate')` reliability
On some server configurations, the `'crate'` create/dispose events do not fire. The system falls back to sensing + physical inference. If neither works, `crateTiles` stays empty and `PddlMove.isApplicableTo` returns false, falling back to `AStarMove` looping.

### Stale `crateTiles` after a push
After PDDL pushes a crate from X to Y: if neither socket events nor the "walked-through" cleanup remove X from `crateTiles`, A* continues to avoid X (now free). This causes suboptimal paths but not crashes. The next time the agent walks through X, the stale entry is cleaned up.

### `mapHasCrates` detection
Crate-zone tile types checked: `t.crateSpawner`, `'5!'`, `'5'`, `5`. If the server uses a different format, `mapHasCrates` stays `false` and all crate logic is bypassed. The sensing fallback (`sensing.crates?.length > 0`) can recover this at runtime.
