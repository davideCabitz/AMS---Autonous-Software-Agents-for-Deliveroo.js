# PDDL Crate-Pushing — Project Context & Handoff Notes

> Purpose of this file: a self-contained brief you can paste into a future Claude
> session so it has the full picture of the project, the PDDL crate subsystem,
> the design decisions taken, and the remaining open questions — without
> re-reading every file.
>
> Last updated: 2026-06-11.

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

## 6. Crate tracking — current state (RESOLVED, was "PDDL never runs")

The original 2026-05 bug (PddlMove never selected because it was gated on
empty `sensing.crates`, while A* looped into unsensed crates) is fixed.
`crateTiles` (live crate positions) is now maintained from **three sources**:

1. **Sensing events** — `sensing.crates` within `observation_distance`
   (log: `[sensing] crates in range: [...]`), handled in `context.js`.
2. **Inference on block** — if a move fails onto a tile that is a known crate
   zone (`crateSpawnerTiles`), `navigateTo` infers an unsensed crate there
   ([astar.js](myAgent/utils/astar.js), log: `[nav] inferred crate at ...`).
   Non-zone blocks (other agents) are NOT added — only transient `agentBlocked`.
3. **Cleanup** — walking onto a tile listed in `crateTiles` removes the stale
   entry (`[nav] walked through ... removed stale crate entry`); PddlMove clears
   a crate's old tile after a successful push (`[pddl] cleared old crate`).

`crateSpawnerTiles` (static, from map load) holds **both** tile types `'5'`
(free crate zone) and `'5!'` (crate spawner) — this is the set of tiles a crate
can ever sit on, and matches the PDDL `(pushable t)` facts exactly.

Known residual limit: a crate outside sensing range is invisible to scoring and
navigation until sensed or inferred-by-collision; A* may initially route
"through" it and only learn the truth on arrival (this is by design — see the
2026-06-11 stuck-explore episode in §11).

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

## 8. Push-aware scoring (`pathLen`) — added 2026-06-11

The strategy layer prices every option (pickup, delivery, explore target) with
`Strategy.pathLen(from, to)` ([Strategy.js](myAgent/strategies/Strategy.js)).
On crate maps this MUST agree with the physics PDDL plans against, or the
strategy commits to goals the planner can't (or shouldn't) reach. Two failure
modes were hit and fixed on 2026-06-11:

- **Too optimistic** (original): when crates blocked all routes, the estimate
  was "crate-ignoring route + 2 steps per crate crossed", assuming every crate
  is always pushable. On `crates_one_way` this made the agent pick delivery
  `(4,9)` reachable only by shoving a crate into a wall, instead of the
  delivery just past the feasible bottom-right corridor.
- **Too pessimistic** (first fix attempt): simulating pushes along the shortest
  route and *banning the crate tile* on failure. Push legality is
  direction-specific — banning the tile also killed routes that circle a
  pocket and push the same crate from the legal side, so reachable spawners
  were priced `Infinity` and exploration froze.

Current model — `pushAwareCost(from, to, crateKeys, blockedKeys)` in
[astar.js](myAgent/utils/astar.js):

- A* where an edge **into a tile occupied by a crate** is legal only if the
  tile one beyond it (same direction) is a crate-zone tile
  (`crateSpawnerTiles`), walkable, crate-free, and arrow-legal — the same rule
  as the PDDL `push*` actions (`(free dest) ∧ (pushable dest)`).
- Such an edge costs **3** (step + reposition + push) instead of 1.
- Optimistic about the pushed crate's NEW position (not re-added as an
  obstacle): `pathLen` is a scoring estimate, the exact push sequence is
  PddlMove's job. Consequence: a cost can be slightly underestimated, but a
  push-feasible target is never priced `Infinity`.

`pathLen` flow: crate-free `findRoute` first (exact, what AStarMove walks);
if crates block everything, `pushAwareCost` (log: `[pathlen] ... push-aware
cost=N`); `Infinity` only when no push-feasible route exists at all.
`nearestEscapableDelivery` logs the full ranked candidate list
(`[delivery] candidates from (x,y): ...`) whenever crates are present.

---

## 9. Answered questions (were open, resolved by testing)

1. **Do `'5'`/`'5!'` tiles always hold a crate?** No. `'5!'` spawns with a
   crate; `'5'` is a free sliding zone. Live occupancy comes from
   `crateTiles` (sensing + inference), never assumed from the map.
2. **Push destination rule (confirmed on `crates_one_way`):** a crate can be
   pushed ONLY onto an adjacent free crate-zone tile (`'5'` or `'5!'`), never
   onto plain `'3'` tiles. This is what makes one-way passages possible, and
   both the PDDL domain and `pushAwareCost` encode it.
3. **Sensing:** the server does emit `sensing.crates` within
   `observation_distance`. Crates outside range are handled by inference (§6).
4. **Pushing via `emitMove`:** confirmed — a push is a normal successful
   directional move; PddlMove's `#runPlan` needs no special casing.
5. **A* crate policy:** `navigateTo` treats current `crateTiles` as walls and
   recomputes per step; when they wall off the goal, control flips to PddlMove
   via its `isApplicableTo` (crate-free route absent, crate-ignoring route
   present).

---

## 10. Remaining open questions

1. **Pushed-crate occupancy in scoring:** `pushAwareCost` doesn't model the
   pushed crate's new position as an obstacle for the rest of the same route.
   Fine as an estimate; revisit only if a map shows systematic underpricing.
2. **`'crate'` socket event** (`'create' | 'dispose'`): still not subscribed.
   Would give ground-truth crate lifecycle beyond sensing range if ever needed.
3. **One-way pockets and strategy:** on `crates_one_way` the agent can enter a
   region whose return passage requires a specific push approach. Scoring now
   prices this correctly, but no strategy-level guard prevents entering a
   pocket whose exit cost is very high (cf. `safeTargetSet` for directional
   mazes — a crate-aware analogue may be worth it).

---

## 11. Recent change log (so future sessions aren't surprised)

- **2026-06-11:** `pathLen` fallback rewritten twice (see §8): first to a
  simulate-and-ban scheme (reverted — direction-blind banning froze exploration
  on `crates_one_way`), then to the current push-aware A* (`pushAwareCost` in
  `astar.js`, edge cost 3 for legal pushes onto free crate-zone tiles).
  `simulatePushes` (intermediate helper) removed. Added `[pathlen]` and
  `[delivery]` debug logs.
- **2026-06-11:** Confirmed on map `crates_one_way` that crates are pushable
  only onto free crate-zone tiles (`'5'`/`'5!'`), and that `crateSpawnerTiles`
  + PDDL `(pushable)` + `pushAwareCost` all share that one zone set.
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
