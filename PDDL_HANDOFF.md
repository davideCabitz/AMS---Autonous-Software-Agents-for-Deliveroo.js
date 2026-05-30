# PDDL Crate-Pushing — Project Context & Handoff Notes

> Purpose of this file: a self-contained brief you can paste into a future Claude
> session so it has the full picture of the project, the current PDDL bug, the
> open design questions, and the agreed direction — without re-reading every file.
>
> Last updated: 2026-05-29.

---

## 1. What the project is

A **BDI (Belief–Desire–Intention) autonomous agent** for the *Deliveroo.js* game
(University of Trento, "Autonomous Software Agents" course). The agent connects to
a game server over a socket, senses parcels/agents/tiles, and must **pick up
parcels and carry them to delivery tiles to score points**. Parcel rewards decay
over time, so timing matters.

The game map is a grid of tiles. Tile types (from the SDK `IOTile`):

| type   | meaning                              |
|--------|--------------------------------------|
| `'0'`  | wall (not walkable)                  |
| `'1'`  | parcel spawner                       |
| `'2'`  | delivery tile                        |
| `'3'`  | plain walkable                       |
| `'4'`  | base                                 |
| `'5'`  | **crate sliding tile**               |
| `'5!'` | **crate spawner**                    |
| arrows | directional one-way tiles            |

**Crates** are Sokoban-style movable obstacles. You push a crate by walking into
it; it slides one tile ahead *if* the tile beyond is free and is itself a crate
zone tile. Crates can block the only path between the agent and a parcel/delivery.
**The entire reason PDDL exists in this project is to plan crate pushes that free
a blocked path** — nothing else. Normal navigation uses A*.

---

## 2. Tech stack

- Node.js, ES modules (`"type": "module"`).
- `@unitn-asa/deliveroo-js-sdk` — game client socket.
- `@unitn-asa/pddl-client` — `onlineSolver(domain, problem)` (calls a remote
  PDDL planner) and a `Beliefset` helper.
- Run with `npm start` (→ `node myAgent/agent.js`). Server expected at
  `http://localhost:8080`; token comes from `.env` (dotenv).

---

## 3. Repository map (file by file)

```
myAgent/
  agent.js                         Entry point. Wires sensing → strategy → intentions.
  context.js                       Shared singletons + all socket event handlers.
  beliefs/
    Me.js                          Agent's own id/position/score.
    Parcels.js                     Map of sensed parcels (sync/free/carriedBy).
  intentions/
    IntentionRevision.js           Base BDI loop: runs intention_queue[0] to completion.
    IntentionRevisionReplace.js    push(): newest intention replaces (stops) the current one.
    IntentionRevisionRevise.js     Alt revision policy (not currently used).
    IntentionDeliberation.js       Picks the first applicable Plan for a predicate and runs it.
  plans/
    PlanBase.js                    Base class: stop(), subIntention(), isApplicableTo().
    planLibrary.js                 Ordered list of plan classes (selection order!).
    GoPickUp.js                    go_pick_up → subIntention(go_to) → emitPickup().
    GoDeliver.js                   go_deliver → subIntention(go_to) → emitPutdown().
    GoExplore.js                   go_explore → subIntention(go_to).
    AStarMove.js                   go_to via A* (navigateTo). The default mover.
    PddlMove.js                    go_to via PDDL solver when crates block the path.
  utils/
    astar.js                       astar(), findRoute(), navigateTo() (live A* walker).
    distance.js                    Manhattan distance helper.

domain-deliveroo.pddl              Static PDDL domain (move + push actions).
problem-deliveroo.pddl             PDDL problem TEMPLATE with {{placeholders}}.
```

---

## 4. Execution flow (how an intention becomes movement)

1. **Sensing** → `agent.js` `socket.onYou` / `socket.onSensing` fire on every
   server tick. They update beliefs (`me`, `parcels`) and call
   `optionsGeneration()`.
2. **Strategy** (`optionsGeneration` → `strategyGreedy` is the active one) decides
   the single best option and calls `myAgent.push([intent, x, y, id?])`.
   - Intents produced: `go_pick_up`, `go_deliver`, `go_explore`.
3. **Intention revision** (`IntentionRevisionReplace.push`) replaces the running
   intention with the new one (stops the old). The base loop in
   `IntentionRevision.loop()` always runs `intention_queue[0]` to completion.
4. **Deliberation** (`IntentionDeliberation.achieve`) walks `planLibrary` in order
   and runs the **first** plan whose `isApplicableTo(...predicate)` is true. If a
   plan throws, it logs `plan failed <Name>` and tries the next one.
5. **Plans**: `GoPickUp`/`GoDeliver`/`GoExplore` all delegate movement to a
   `go_to` **sub-intention**, which itself goes back through deliberation and is
   handled by `PddlMove` or `AStarMove`.

`planLibrary` order (in [myAgent/plans/planLibrary.js](myAgent/plans/planLibrary.js)):

```js
[GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove]
```

So for a `go_to` predicate, **PddlMove is tried before AStarMove**. The intent is:
PddlMove handles `go_to` only when a crate genuinely blocks the route; otherwise
it declines and the cheap AStarMove runs.

---

## 5. The PDDL subsystem (current state)

### 5.1 Domain — [domain-deliveroo.pddl](domain-deliveroo.pddl)

- `:strips` only. **Action costs were removed** (per user request 2026-05-29) —
  the planner now finds *any* valid plan, not the cheapest.
- Predicates: `tile, delivery, agent, me, crate, at, free, pushable,
  right/left/up/down` (4 directional adjacency relations).
- Actions:
  - `right/left/up/down` — step onto an adjacent `free` tile.
  - `pushRight/Left/Up/Down` — agent at `myPos`, crate at `cratePos` (adjacent in
    that direction), pushes it to `destPos` (one further) **iff** `destPos` is
    `(free)` AND `(pushable)`. Agent ends on the crate's old tile.

### 5.2 Problem — [problem-deliveroo.pddl](problem-deliveroo.pddl)

A **template** with six placeholders, substituted at runtime by
`PddlMove.#buildProblem()` via simple `.replace()`:

| placeholder        | filled with                                              |
|--------------------|----------------------------------------------------------|
| `{{OBJECTS}}`      | `me` + crate ids + all tile ids (from beliefset)         |
| `{{MY_TILE}}`      | agent's current tile `t<x>_<y>`                          |
| `{{CRATE_FACTS}}`  | `(crate c..) (at c.. t..)` for each crate                |
| `{{TOPOLOGY_FACTS}}`| `beliefset.toPddlString()` (tiles + adjacency + delivery)|
| `{{FREE_FACTS}}`   | `(free t..)` per crate-free walkable tile, `(pushable t..)` per crate-zone tile |
| `{{GOAL_TILE}}`    | the target tile                                          |

> Naming convention: PDDL object names must start with a letter, so tiles are
> `t<x>_<y>` and crates `c<x>_<y>`. `rawKey` = the un-prefixed `<x>_<y>` form,
> used only as an internal A* / Set key.

### 5.3 PddlMove — [myAgent/plans/PddlMove.js](myAgent/plans/PddlMove.js)

- `isApplicableTo(intent, x, y)`: returns true only if
  `intent === 'go_to'` AND `mapHasCrates` AND `crateTiles.length > 0` AND a
  crate-free A* route does **not** exist but a route ignoring crates does.
- `execute`: loop up to `MAX_REPLANS` times — build problem from current state,
  call `onlineSolver`, run the returned plan step by step (`#runPlan`), replan if
  a step is blocked mid-execution.
- Push/move actions both map to a single directional `emitMove` (you push by
  walking into the crate).

### 5.4 Beliefset (topology) — built in [context.js](myAgent/context.js) `socket.onMap`

On every map event, a fresh `Beliefset` is populated with `tile`, `delivery`, and
`right/left/up/down` adjacency facts for all walkable tiles. This is the static
graph the planner walks.

---

## 6. THE BUG: PDDL never runs (observed 2026-05-29)

### Symptom

Console shows the agent trying to reach a spawner (e.g. `0,5`), A* repeatedly
hitting `[nav] blocked at 4_5` and `[nav] blocked at 7_2`, recomputing, and
looping forever. **No PDDL log line ever appears.** `plan failed AStarMove
['stopped']` and `no plan for go_to ...` show up as the strategy churns.

### Root cause chain

1. **PddlMove is gated behind *sensed* crates.** `isApplicableTo` bails on
   `crateTiles.length === 0` ([PddlMove.js:45](myAgent/plans/PddlMove.js#L45)).
2. **`crateTiles` is only filled from `sensing.crates`** ([context.js:104](myAgent/context.js#L104)),
   which is empty in this run (no `[sensing] crates detected` line). So PddlMove
   is *never selected*; deliberation falls straight to AStarMove.
3. **A* treats crate tiles as walkable.** `walkableTiles` keeps everything except
   type `'0'` ([context.js:67-69](myAgent/context.js#L67-L69)), so the 4 crate
   tiles (`'5'`/`'5!'`) are in the walkable set. `navigateTo` routes through them,
   the server rejects the move, and it recomputes against the *same* set → the
   `blocked → recompute` infinite loop.

> Note: the map *did* detect crates — `[map] mapHasCrates=true (4 crate tiles)`.
> So `crateSpawnerTiles` (static) is correct; only the *sensed* `crateTiles` is
> empty. **This is the key realization: we already know where the crates are from
> the static map; we don't need sensing at all.**

---

## 7. What the SDK actually provides for crates (verified)

- `IOSensing.crates: IOCrate[]` where `IOCrate = { id, x, y }`. **But sensing only
  reports things within `observation_distance` (here = 5).** So the agent never
  sees a crate until it's within 5 tiles — and by then A* has already driven into
  it. This is *probably* why `crateTiles` looked empty for the failing targets.
- There is **also** a separate socket event: `'crate'` → `('create' | 'dispose',
  { x, y })`. Not currently subscribed. Could be used for ground-truth crate
  create/dispose tracking if we ever need live crate state.
- Static map tiles `'5'` (sliding) and `'5!'` (spawner) are captured at load into
  `crateSpawnerTiles` ([context.js:59-63](myAgent/context.js#L59-L63)). These are
  always known, no sensing required.

**Conclusion / decision (user, 2026-05-29):** do **not** depend on `sensing.crates`.
Treat the static crate tiles as the crate set. PDDL should engage whenever crate
infrastructure exists on the map.

---

## 8. Proposed direction (agreed with user)

User's framing, verbatim intent:

> "PDDL should be the priority strategy if even a single crateTile exists. If the
> agent is blocked near a crateTile, it's highly likely that a crate is blocking
> the agent, which should try to move it — or find a near path that puts the agent
> in a better position to push the crate and free the path."

Concretely, the changes to design/implement:

1. **Seed crates from the static map, not sensing.** Either populate `crateTiles`
   from `crateSpawnerTiles` at map load, or change `PddlMove` to use
   `crateSpawnerTiles` as the crate set. (Caveat: `'5'`/`'5!'` are *tiles*, not
   guaranteed to currently hold a crate — see open questions.)

2. **Make A* avoid crate tiles** so it stops looping into them, OR let the
   "no crate-free route" condition flip control to PDDL. Today `walkableTiles`
   includes crate tiles, which is what causes the infinite block loop. Options:
   - Exclude crate tiles from the A* walkable set, so when a crate blocks the only
     path, A* returns "no path" and PDDL takes over.
   - Or detect "blocked at a known crate tile" inside `navigateTo` and hand off.

3. **Gate PddlMove on map crates, not sensed crates:** change the
   `crateTiles.length === 0` guard to `crateSpawnerTiles.length === 0`
   (i.e. `!mapHasCrates`), and compute `findRoute`'s blocked set from the static
   crate tiles.

4. **Push behavior:** when the only route to the goal is blocked by a crate, the
   PDDL plan should push it onto an adjacent `pushable` crate-zone tile to open the
   path. This already works *if* the problem is built with correct crate + free +
   pushable facts.

---

## 9. Open questions & doubts (resolve these next session)

1. **Do `'5'`/`'5!'` tiles always have a crate on them?** If a `'5'` sliding tile
   can be empty, modeling every crate tile as `(crate ...)` will produce wrong
   plans. Need to confirm by logging actual crate positions (subscribe to the
   `'crate'` event, or print `sensing.crates` once the agent is adjacent).

2. **Are the 4 crate tiles adjacent (a pushable line) or isolated?** A crate can
   only be pushed onto an *adjacent crate-zone* tile (`pushable` = crate-zone). If
   crate tiles are isolated, there's nowhere legal to push → solver returns no
   plan. Need the actual coordinates of all `'5'`/`'5!'` tiles and the geometry.
   (Failing targets touched `4_5` and `7_2`.)

3. **Should crates be pushable onto plain walkable tiles too?** Current domain
   restricts `pushable` to crate-zone tiles only (game physics assumption). Verify
   this matches the real server: can you push a crate onto a normal `'3'` tile?
   If yes, `pushable` should include plain walkable tiles and the model loosens.

4. **What does `emitMove` return when pushing a crate vs. when blocked?** PddlMove
   assumes a push is just a successful directional move. If the server returns a
   distinct signal (or moves you differently), `#runPlan` needs adjusting.

5. **Does the active server build emit crates in `sensing` at all, or only via the
   `'crate'` event?** Not critical given the static-tile approach, but determines
   whether we can ever track crates that move during play.

6. **Should A* permanently avoid crate tiles, or only when blocked?** Permanently
   avoiding them is simpler and safe, but may make some shortcuts unavailable when
   a crate tile is actually empty/passable.

---

## 10. Concrete next steps (suggested TODO)

- [ ] Log ground truth: subscribe to `socket` `'crate'` events and print
      `sensing.crates`; confirm whether crate tiles hold crates and where.
- [ ] Print the coordinates of all `crateSpawnerTiles` and map them out (geometry
      check for question #2).
- [ ] Change `PddlMove.isApplicableTo` to gate on `mapHasCrates` /
      `crateSpawnerTiles`, and build the crate/blocked set from static tiles.
- [ ] Decide A* policy: exclude crate tiles from `walkableTiles` (or from the A*
      set) so the block loop can't happen and PDDL gets control.
- [ ] Re-run; confirm a `[pddl]` plan is produced and the agent pushes a crate to
      free the path to `0,5`.
- [ ] Revisit `pushable` semantics once question #3 is answered.

---

## 11. Recent change log (so future sessions aren't surprised)

- **2026-05-29:** `problem-deliveroo.pddl` introduced as a placeholder *template*;
  `PddlMove.#buildProblem` switched from inline string building to template
  substitution.
- **2026-05-29:** **All action-cost logic removed** from the PDDL domain and
  problem (`:action-costs`, `(:functions (total-cost))`, every
  `(increase (total-cost) N)`, the `(= (total-cost) 0)` init fact, and the
  `(:metric minimize (total-cost))`). The planner now returns any valid plan.
- **2026-05-29:** Identified that PddlMove never triggers because it's gated on
  empty `sensing.crates`; agreed to drive crate awareness from the static map
  instead (this document).
