# Codebase Analysis Report — AMS Deliveroo Autonomous Agent

**Date:** 2026-06-16
**Scope:** `myAgent/**` (8,098 LOC across 43 JS modules) — the BDI + LLM agent system.
**Method:** Full read of every source module under `myAgent/`, plus entry points
(`multiple_run.js`, `launch.js`). No code was modified — this is analysis only.
**Lenses applied (as requested):** code duplication, design patterns, readability &
naming. Bugs/correctness, performance, and dead code are reported alongside.

> Note on the lens docs: [docs/code_duplication_detenction.md](docs/code_duplication_detenction.md)
> (filename typo: *detenction* → *detection*) and [docs/readability_and_naming.md](docs/readability_and_naming.md)
> are **empty**. Only [docs/design_patterns.md](docs/design_patterns.md) carried instructions
> (1–10 severity scale, exact citations, drop-in snippets, mark unverifiable claims). This
> report follows that contract for all three lenses.

---

## 0. Executive summary

The codebase is **functionally rich, heavily documented, and battle-tested live** — the
comment quality is exceptional and the BDI/LLM separation is genuinely clean. The dominant
problem is **structural duplication in the strategy hierarchy and the navigation/BFS layer**,
caused by a deep inheritance chain where private methods can't be shared, so they were
copy-pasted (the code comments literally say *"Port of HighCapacity#buildPatrol"* and
*"replicated from StrategyMemory.#shouldKeepWithMemory (private there, so not inheritable)"*).

| # | Finding | Lens | Severity |
|---|---------|------|----------|
| 1 | Spawner-group / patrol machinery copy-pasted across 3 strategies | Duplication / Patterns | **9** |
| 2 | `decide()` skeleton re-implemented in 4 strategies (no Template Method) | Duplication / Patterns | **8** |
| 3 | `allowedDeliveryTiles` / `allowedSpawnerTiles` filter block pasted 6–7× | Duplication | **7** |
| 4 | Anti-lock exploration (commit/blacklist/stall) duplicated Blind↔Hurry | Duplication | **7** |
| 5 | A* has no priority queue (O(n²)); whole A* loop duplicated in `pushAwareCost` | Patterns / Perf | **7** |
| 6 | BFS-over-walkable re-implemented 5+ times; `walkableSet` rebuilt 9× | Duplication / Perf | **6** |
| 7 | `pickup_next_parcel` can busy-wait forever (no timeout) | Bug/Risk | **6** |
| 8 | `withTimeout` ×3 and `describeFailure` ×2 copy-pasted | Duplication | **5** |
| 9 | Dead code: `IntentionRevisionRevise`, `StrategySimple`, `StrategyNotTooGreedy` | Dead code | **5** |
| 10 | `context.js` is a 461-line god-module (config+map+crates+competitor math) | Patterns / Readability | **5** |
| 11 | Naming collisions: `go_pickup`/`go_pick_up`, two `nearestDelivery()` | Naming | **4** |
| 12 | Stale comments (`MAX_TOOL_FAILURES` "a few" = 1) + doc drift | Readability | **3** |

**Strengths worth preserving:** the Strategy pattern itself, the plan library
(`planLibrary.js`) as a clean chain, the belief/desire/intention separation, the
backward-compatibility discipline (every mission gate degrades to a no-op), and the
genuinely outstanding inline documentation.

---

## 1. Code Duplication

### 1.1 — Spawner-group + patrol machinery duplicated across 3 strategies — **Severity 9**

The single largest duplication. The "cluster spawners into groups, build an angular patrol
loop, walk the waypoints" machinery exists in **three** classes with near-identical bodies,
acknowledged in the comments themselves.

| Concern | `StrategyHighCapacity.js` | `StrategyLookAhead.js` | `StrategyLookAheadStochastic.js` |
|---|---|---|---|
| group init | `#initGroups` [208](myAgent/strategies/StrategyHighCapacity.js#L208) | `_initIdleGroups` [369](myAgent/strategies/StrategyLookAhead.js#L369) | `#initGroups` [59](myAgent/strategies/StrategyLookAheadStochastic.js#L59) |
| nearest group tile | `#nearestTile` [231](myAgent/strategies/StrategyHighCapacity.js#L231) | `_nearestGroupTile` [404](myAgent/strategies/StrategyLookAhead.js#L404) | — |
| patrol build | `#buildPatrol` [403](myAgent/strategies/StrategyHighCapacity.js#L403) | `_buildIdlePatrol` [428](myAgent/strategies/StrategyLookAhead.js#L428) | — |
| patrol step | `#goFarm` body [336](myAgent/strategies/StrategyHighCapacity.js#L336) | `_idlePatrolStep` [444](myAgent/strategies/StrategyLookAhead.js#L444) | — |

The comments are explicit: `_buildIdlePatrol` is *"Port of HighCapacity#buildPatrol"*
([StrategyLookAhead.js:427](myAgent/strategies/StrategyLookAhead.js#L427)), `_idlePatrolStep`
is *"Port of the #goFarm patrol body"* ([:443](myAgent/strategies/StrategyLookAhead.js#L443)),
`_initIdleGroups` *"Mirrors HighCapacity#initGroups"* ([:368](myAgent/strategies/StrategyLookAhead.js#L368)),
`_idleGroupHere` *"Mirrors HighCapacity#isAtFarm"*. The patrol cap is even duplicated as a
constant: `MAX_WAYPOINTS = 6` ([StrategyHighCapacity.js:420](myAgent/strategies/StrategyHighCapacity.js#L420))
vs `IDLE_MAX_WAYPOINTS = 6` ([StrategyLookAhead.js:27](myAgent/strategies/StrategyLookAhead.js#L27),
commented *"matches HighCapacity patrol cap"*).

**Remediation:** extract a `SpawnerGroupPatrol` helper class (composition, not inheritance) that
owns `groups`, `buildPatrol`, `nearestTile`, `nextWaypoint`, and the `allowedSpawnerTiles`
signature/rebuild logic. Each strategy holds one instance. This collapses ~250 duplicated lines
and removes the private-method-can't-be-shared driver behind the copy-paste.

```js
// myAgent/strategies/SpawnerGroupPatrol.js  (sketch)
export class SpawnerGroupPatrol {
  #groups = null; #sig = null; #maxWaypoints;
  constructor(maxWaypoints = 6) { this.#maxWaypoints = maxWaypoints; }
  groups(d = 2) { this.#rebuildIfConstraintChanged(d); return this.#groups; }
  nearestTile(group, costFn) { /* the shared #nearestTile body */ }
  buildPatrol(group) { /* the shared angular-loop body, capped at #maxWaypoints */ }
  #rebuildIfConstraintChanged(d) { /* the shared allowedSpawnerTiles sig + buildSpawnerGroups */ }
}
```

### 1.2 — `decide()` control-flow skeleton re-implemented 4× (no Template Method) — **Severity 8**

`StrategyGreedy`, `StrategyMemory`, `StrategyLookAhead`, and `StrategyNotTooGreedy` all repeat
the same five-phase skeleton: *compute carrying+bankNow → build candidate pool → (carrying>0)
multi-pickup/stack/deliver branch → empty-hand best pickup → `exploreIfIdle` fallback.*

- [StrategyGreedy.js:15-80](myAgent/strategies/StrategyGreedy.js#L15)
- [StrategyMemory.js:25-100](myAgent/strategies/StrategyMemory.js#L25)
- [StrategyLookAhead.js:90-184](myAgent/strategies/StrategyLookAhead.js#L90)
- [StrategyNotTooGreedy.js:20-91](myAgent/strategies/StrategyNotTooGreedy.js#L20) — this one is
  almost a verbatim copy of Greedy with a detour block spliced in.

The merged-pool construction is itself duplicated 3× (free + remembered + `missionPickupOk`):
[StrategyMemory.js:33-36](myAgent/strategies/StrategyMemory.js#L33),
[StrategyLookAhead.js:98-101](myAgent/strategies/StrategyLookAhead.js#L98),
[StrategyHighCapacity.js:530-537](myAgent/strategies/StrategyHighCapacity.js#L530) (`#eligibleParcels`).

**Remediation:** lift a Template Method into `Strategy`:

```js
// Strategy.js
decide(currentIntent) {
  const carrying = parcels.carriedBy(me.id);
  if (carrying.length > 0) {
    const pick = this._chooseMultiPickup(currentIntent, carrying); if (pick !== undefined) return pick;
    const dlv  = this._chooseDelivery(currentIntent, carrying);    if (dlv  !== undefined) return dlv;
  }
  const grab = this._chooseEmptyHandPickup(currentIntent);         if (grab !== undefined) return grab;
  return this.exploreIfIdle(currentIntent);
}
_eligiblePool() { /* the free+remembered+missionPickupOk body, ONE copy */ }
```
Subclasses then override only the hooks that genuinely differ (e.g. LookAhead's `#chooseTarget`
pairing). NotTooGreedy becomes a ~15-line override instead of a 90-line clone.

### 1.3 — Mission tile-filter block pasted 6–7× — **Severity 7**

The exact block
```js
let tiles = deliveryTiles;
if (missionConstraints.allowedDeliveryTiles?.size > 0) {
    const f = tiles.filter(t => missionConstraints.allowedDeliveryTiles.has(`${t.x}_${t.y}`));
    if (f.length > 0) tiles = f;
}
```
appears **7 times** (`grep`-verified): `Strategy.nearestDelivery` [124](myAgent/strategies/Strategy.js#L124),
`nearestEscapableDelivery` [173](myAgent/strategies/Strategy.js#L173) **and again** [201](myAgent/strategies/Strategy.js#L201)
inside the same method, `_bestDelivery` [239](myAgent/strategies/Strategy.js#L239), plus
`StrategyHighCapacity.#enRouteDelivery` [308](myAgent/strategies/StrategyHighCapacity.js#L308) and
the prompt/commandTools. The `allowedSpawnerTiles` twin appears **6 times** across `Strategy.js`,
`StrategyHighCapacity.js`, `StrategyLookAhead.js`, `StrategyLookAheadStochastic.js`.

**Remediation:** two private helpers on `Strategy`:
```js
_allowedDeliveryPool() {
  const a = missionConstraints.allowedDeliveryTiles;
  if (!(a?.size > 0)) return deliveryTiles;
  const f = deliveryTiles.filter(t => a.has(`${t.x}_${t.y}`));
  return f.length ? f : deliveryTiles;
}
_allowedSpawnerPool() { /* same shape for spawnerTiles/allowedSpawnerTiles */ }
```
`nearestEscapableDelivery` alone recomputes this filter **twice** (lines 173 & 201) — a single
helper removes that redundancy too.

### 1.4 — Anti-lock exploration duplicated Blind ↔ Hurry — **Severity 7**

`StrategyBlind` and `StrategyHurry` carry an identical "don't lock onto a stale explore target"
mechanism: the same private fields (`#commitKey`, `#commitSince`, `#lastPos`, `#lastMoved`,
`#blacklist`), the same three constants (`EXPLORE_STALL_MS`, `EXPLORE_COMMIT_MS`,
`EXPLORE_BLACKLIST_MS` — 16 occurrences across the two files), and the same
movement-tracking + blacklist-expiry blocks.

- [StrategyBlind.js:42-118](myAgent/strategies/StrategyBlind.js#L42)
- [StrategyHurry.js:35-100](myAgent/strategies/StrategyHurry.js#L35)

**Remediation:** an `AntiLockExplorer` helper (composition) holding the commit/stall/blacklist
state with a `pickTarget(pool, { reached })` method. Both strategies delegate to it.

### 1.5 — Pickup-hysteresis ("shouldKeep") variants 3× — **Severity 6**

Three near-identical hysteresis checks; the duplication is *explicitly excused* in a comment as
unavoidable because the base method is `private`:

- `Strategy.shouldKeepCurrentPickup` [447](myAgent/strategies/Strategy.js#L447)
- `StrategyMemory.#shouldKeepWithMemory` [107](myAgent/strategies/StrategyMemory.js#L107)
- `StrategyLookAhead.#shouldKeep` [272](myAgent/strategies/StrategyLookAhead.js#L272) — comment:
  *"replicated from StrategyMemory.#shouldKeepWithMemory (private there, so not inheritable)"*.

**Remediation:** make the base method **protected** (`_shouldKeepCurrentPickup`) and have it call
a `_resolveTarget(id)` hook that the memory subclass overrides to add `getRemembered`. The
LookAhead "second-stop re-order" twist becomes a 2-line extension, not a full re-paste. This is
the canonical "private method forced a copy" smell — fixing the access modifier removes the cause.

### 1.6 — Navigation/BFS/A* algorithms re-implemented — **Severity 7**

- **A* main loop duplicated:** `astar()` [astar.js:75](myAgent/utils/astar.js#L75) and
  `pushAwareCost()` [astar.js:204](myAgent/utils/astar.js#L204) contain two copies of the same
  open/closed/gScore/fScore loop (the second adds push-cost edges). They should share one
  parameterized core with a pluggable `edgeCost(from,to)`.
- **BFS-over-walkable re-implemented 5+ times:** `tilesThatReach` [astar.js:272](myAgent/utils/astar.js#L272),
  `reachableFrom` [astar.js:310](myAgent/utils/astar.js#L310), `staticRoute` [handoff.js:92](myAgent/llm/handoff.js#L92),
  `bfsDistances` [handoff.js:120](myAgent/llm/handoff.js#L120), `reachableWithin` inside
  `buildSpawnerGroups` [SpawnerGroups.js:38](myAgent/beliefs/SpawnerGroups.js#L38). All are the
  same neighbour-expansion BFS over `walkableTiles`.
- **`walkableSet` rebuilt 9×:** `new Set(walkableTiles.map(t => \`${t.x}_${t.y}\`))` is constructed
  in 9 places (context, MapTopology, handoff ×3, selectStrategy, HighCapacity, LookAhead,
  Stochastic). `astar.js` already caches this via `getWalkable()` [astar.js:63](myAgent/utils/astar.js#L63)
  — but it isn't exported, so every other module rebuilds it on the hot path.

**Remediation:** export the memoized `getWalkable()` from `astar.js` and reuse it everywhere;
add a single `bfs(start, { distances?, goalSet? })` utility and have the four call sites delegate.

### 1.7 — Direction tables duplicated 3× — **Severity 4**

The four-neighbour direction table is declared independently in `astar.js`
(`DIRS` [8](myAgent/utils/astar.js#L8)), `PddlMove.js` (`DIR_DELTA` [98](myAgent/plans/PddlMove.js#L98)
and the inline `DIRS` in `buildSpawnerGroups` [SpawnerGroups.js:34](myAgent/beliefs/SpawnerGroups.js#L34)),
each with its own `{dx,dy[,dir]}` shape. `utils/directions.js` already owns `ARROW_VECTORS` —
the canonical place for a shared `STEP_DIRS` export.

### 1.8 — `withTimeout` ×3, `describeFailure` ×2 — **Severity 5**

- `withTimeout`: [commandTools.js:118](myAgent/llm/commandTools.js#L118),
  [handoff.js:62](myAgent/llm/handoff.js#L62), [worker_agent.js:24](myAgent/worker_agent.js#L24)
  — three copies of the identical `Promise.race` + `clearTimeout` helper.
- `describeFailure`: [commandTools.js:141](myAgent/llm/commandTools.js#L141) and
  [worker_agent.js:33](myAgent/worker_agent.js#L33) — the same rejection-tag→string switch (worker
  drops the `Failed:` prefix; otherwise identical).

**Remediation:** move both to a small `llm/util.js` (or `utils/`) and import. One source of truth
for failure phrasing also keeps the coordinator and worker observation strings in sync.

### 1.9 — `dropAllMissions` re-clears what `FIELD_MAP` already clears — **Severity 3**

[missionState.js:190-207](myAgent/llm/missionState.js#L190) manually resets all 14 constraint
fields, duplicating the `clear()` closures already defined in `FIELD_MAP`
[missionState.js:139-160](myAgent/llm/missionState.js#L139). It can be
`for (const [, [,, clear]] of Object.entries(FIELD_MAP)) clear();` + reset `descriptions`.
Today, adding a 15th constraint requires editing both places (drift risk).

### 1.10 — "apply locally + mirror to partner" repeated — **Severity 3**

The pair `applyMissionConfig(cfg); sendConstraint('apply', cfg);` recurs in `apply_mission`,
`restrict_exploration`, `forbid_delivery`, and `applyRoutineNet`
([commandTools.js:271-272](myAgent/llm/commandTools.js#L271),
[:600-607](myAgent/llm/commandTools.js#L600), [:670-671](myAgent/llm/commandTools.js#L670)).
A single `applyAndMirror(cfg)` wrapper would prevent a future caller from forgetting the mirror
(which would silently desync the two agents).

---

## 2. Design Patterns

### 2.1 — Strategy pattern: appropriate and mostly well-implemented — **Severity 2 (positive)**

The core **Strategy** pattern is the right choice and cleanly applied: `Strategy.decide(currentIntent)`
is a pure decider returning a predicate, the agent loop owns the push
([coordinator_agent.js:39-42](myAgent/coordinator_agent.js#L39)), per-strategy state lives on the
instance (no module globals — explicitly documented at [Strategy.js:74](myAgent/strategies/Strategy.js#L74)),
and selection is centralized in `selectStrategy()` ([selectStrategy.js:52](myAgent/strategies/selectStrategy.js#L52))
behind a clear priority order. This is textbook and should be kept.

### 2.2 — Inheritance chain too deep / fragile; favor composition — **Severity 7**

The chain is `Strategy → Greedy → Memory → LookAhead → {Stochastic, SingleParcel, HighCapacity → Rush}`
(documented in [project-architecture memory] and [Strategy.js:76]). Five levels, and **behavior is
threaded through `super.exploreIfIdle()` / `super.decide()` calls** plus field-initializer ordering
hacks (`tickIntervalMs = 500` in LookAhead, *"a subclass field initializer runs after this one and
wins"* — [StrategyLookAhead.js:69-71](myAgent/strategies/StrategyLookAhead.js#L69)). Deep inheritance
is exactly what forced the private-method copy-paste in §1.1 and §1.5.

**Recommendation:** keep `Strategy` (shared scoring/value model — that part is good), but pull the
**group-patrol** and **anti-lock explorer** behaviors into composable helpers (§1.1, §1.4) injected
into strategies. This flattens the tree and makes the shared code actually shareable. The value
functions (`pickupValue`, `bankNowValue`, `bankFirstValue`, contest factor) are fine on the base.

### 2.3 — Template Method missing for `decide()` — **Severity 8**

See §1.2 — the per-strategy `decide()` duplication is precisely the problem the **Template Method**
pattern solves. Define the invariant skeleton once on `Strategy`; expose `_chooseMultiPickup` /
`_chooseDelivery` / `_chooseEmptyHandPickup` hooks.

### 2.4 — Plan library = clean Strategy/Chain (positive) — **Severity 2 (positive)**

[planLibrary.js](myAgent/plans/planLibrary.js) + `PlanBase.isApplicableTo`/`execute`
([PlanBase.js](myAgent/plans/PlanBase.js)) + `IntentionDeliberation.achieve()` iterating the library
([IntentionDeliberation.js:56](myAgent/intentions/IntentionDeliberation.js#L56)) is a tidy
Chain-of-Responsibility. `PddlMove.isApplicableTo` returning `false` fast when no crate blocks
([PddlMove.js:46](myAgent/plans/PddlMove.js#L46)) is a good guard. No change needed.

### 2.5 — A* should use a priority queue (Strategy/data-structure) — **Severity 7**

Both `astar()` and `pushAwareCost()` select the lowest-`f` node by **linear scan over the open
set** every iteration ([astar.js:86-90](myAgent/utils/astar.js#L86),
[:224-228](myAgent/utils/astar.js#L224)) → **O(n²)**. The cost is real and already documented as a
problem: `StrategyHurry` deliberately uses Manhattan distance and skips per-tile reachability
*"doing an A\* search for each of the 895+ spawner tiles … blocks the event loop for ~15 seconds"*
([StrategyHurry.js:92-94](myAgent/strategies/StrategyHurry.js#L92)). A binary-heap open set makes
A* `O(n log n)` and removes the need for that workaround.

### 2.6 — `IntentionRevisionRevise` is a dead abstraction — **Severity 5**

[IntentionRevisionRevise.js](myAgent/intentions/IntentionRevisionRevise.js) is never imported or
instantiated (`grep`-verified — only its own definition matches). Its `#SWITCH_THRESHOLD = 0.5`
field is declared and never read. It's leftover lab scaffolding (the classic Revise-vs-Replace
exercise). See §5.

### 2.7 — `context.js` trends toward a God-module — **Severity 5**

[context.js](myAgent/context.js) (461 lines) is simultaneously: the shared-singleton belief store,
the config parser (`onConfig`), the map parser (`onMap` — walls/spawners/deliveries/crates/arrows +
PDDL beliefset build + trap-avoidance fixpoint), the crate event tracker, **and** the
competitor-awareness math (`otherAgentDistTo`, `nearestAgentId`, `isAgentMovingToward`,
`nearestAgentIsStationary` — [context.js:417-461](myAgent/context.js#L417)). The competitor helpers
and the `moveTiming` EMA are self-contained and would read better as their own modules
(`beliefs/Competitors.js`, `beliefs/MoveTiming.js`), leaving `context.js` as pure shared state +
socket wiring.

### 2.8 — Pattern verdict

- **Appropriate & correct:** Strategy (option generation), Chain (plan library), Observer (socket
  events), Singleton (shared `context` state).
- **Missing / would help:** Template Method (`decide`), Composition over the deep strategy
  inheritance, a priority-queue for A*, a shared BFS utility.
- **Over-engineered / unused:** `IntentionRevisionRevise`; the design-patterns lens doc asked about
  "payment/auth Strategy" patterns which **do not apply** to this domain (marked *Unable to verify*
  — there is no payment/auth code here; the relevant Strategy usage is option-generation, covered
  above).

---

## 3. Readability & Naming

### 3.1 — Naming collisions and inconsistencies — **Severity 4**

- **`go_pickup` (LLM tool) vs `go_pick_up` (BDI predicate)** vs `order_partner_pickup`. The tool
  `go_pickup` ([commandTools.js:286](myAgent/llm/commandTools.js#L286)) emits a `go_pick_up`
  predicate. Inconsistent verb spacing across the boundary is a recurring readability snag.
- **Two different `nearestDelivery()`**: a Strategy method using **A\*** path length
  ([Strategy.js:123](myAgent/strategies/Strategy.js#L123)) and a commandTools local helper using
  **Manhattan** distance ([commandTools.js:98](myAgent/llm/commandTools.js#L98)). Same name, different
  metric, different file — confusing when reading the LLM layer next to the strategy layer. Rename
  the helper `nearestDeliveryManhattan()`.
- **`crateTiles` vs `crateSpawnerTiles`** are easy to mix up; both are heavily used in `astar`/`PddlMove`.
  A short rename to `cratesNow` / `crateZones` would reduce mis-reads (low priority).

### 3.2 — Very large single-responsibility files — **Severity 5**

- `Strategy.js` — 803 lines, one class, ~30 methods. The value model (pickup/bank/contest) and the
  exploration logic (`exploreIfIdle`, 110 lines) could split into a mixin/helper.
- `commandTools.js` — 682 lines; the tool catalogue, parsing helpers, and the `gather_near`
  end-to-end routine (~80 lines, [commandTools.js:485-563](myAgent/llm/commandTools.js#L485)) are
  all in one module. `gather_near` is really a sibling of `handoff.js` and belongs beside it.
- `handoff.js` — 665 lines, with the core `loop()` being a single ~250-line function
  ([handoff.js:384-641](myAgent/llm/handoff.js#L384)) holding 6 numbered phases, multiple detached
  promise chains, and several closures. Correct but very hard to follow; the phases (acquire,
  plan-delivery, carry-to-meet, drop, dispatch-worker) are natural method boundaries.
- `prompt.js` — a 330-line string array literal ([prompt.js:14-352](myAgent/llm/prompt.js#L14)).
  Readable but unmaintainable as one block; consider sectioning into named constants
  (`MISSION_TAXONOMY`, `ACTION_PLAYBOOK`, `TOOL_REFERENCE`) joined at the end.

### 3.3 — Exceptional comments, but some drift / staleness — **Severity 3**

Comment quality is a genuine strength (the *why* is almost always captured). A few have drifted:

- **`MAX_TOOL_FAILURES = 1`** ([commandLoop.js:28](myAgent/llm/commandLoop.js#L28)) but the
  surrounding comments say *"after **a few** failed command attempts"* ([:27](myAgent/llm/commandLoop.js#L27))
  and *"After **a few** failed commands, give up"* ([:165](myAgent/llm/commandLoop.js#L165)). With the
  value at 1 it gives up after the **first** failure. The project-architecture memory records this as
  `MAX_TOOL_FAILURES=3` — so the constant was lowered without updating prose or notes. Confirm the
  intended value, then align the comments.
- `directives.md`/architecture note the action ceiling differently than code in places; the prompt's
  tool list and `commandTools` keys should be diffed periodically (e.g. prompt documents
  `dropMission` fields that omit `penaltyTiles`/`oneShotBonus`/the `*Net` keys present in `FIELD_MAP`).

### 3.4 — Empty lens docs / typo'd filename — **Severity 2**

[docs/code_duplication_detenction.md](docs/code_duplication_detenction.md) (typo *detenction*) and
[docs/readability_and_naming.md](docs/readability_and_naming.md) are empty. If they're meant to be
review rubrics like `design_patterns.md`, they need content; otherwise remove them. The typo should
be fixed regardless.

---

## 4. Bugs, Risks & Correctness Concerns

### 4.1 — `pickup_next_parcel` can wait indefinitely — **Severity 6**

[commandTools.js:304-325](myAgent/llm/commandTools.js#L304) releases the gate and loops
`while (!directive.aborted) { … await sleep(100) }` until a *new* carried id appears. Unlike every
other command, it does **not** go through `command()`/`withTimeout`, so on a map where no parcel is
ever reachable (or sensing stays empty) this single tool call blocks the serialized ACTION lane
forever short of an operator abort. Recommend a bounded wait (e.g. reuse `COMMAND_TIMEOUT_MS` or a
dedicated cap) that returns a `Failed:` observation so the ReAct loop can move on.

### 4.2 — `liveMeet` / `onlyReachable` run A* per walkable tile in hot loops — **Severity 6 (perf/risk)**

- `liveMeet` ([handoff.js:217-225](myAgent/llm/handoff.js#L217)) calls `findRoute(me, t)` for **every**
  walkable tile, then sorts — and it's invoked **every carry pass** of the meet loop
  ([handoff.js:544](myAgent/llm/handoff.js#L544)). On a large map this is `O(walkable × A*)` per
  iteration — the same event-loop-stall hazard §2.5 describes, now inside the handoff hot path.
- `onlyReachable` ([commandTools.js:91](myAgent/llm/commandTools.js#L91)) recomputes a full
  `reachableFrom` BFS on each `sense_*`/`get_map_info` tool call. Acceptable at LLM cadence, but it
  duplicates work the strategy layer also does.

Mitigation pairs with §2.5 (priority-queue A*) and §1.6 (one cached `getWalkable`/BFS): compute the
reachable set **once per pass** and reuse.

### 4.3 — Default model contradicts the "always gpt-4o" rule — **Severity 3**

`MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio'`
([llmClient.js:13](myAgent/llm/llmClient.js#L13)). The user rule (and `.env.example`,
`LOCAL_MODEL=gpt-4o`) require gpt-4o via the university proxy; if `LOCAL_MODEL` is ever unset the
default silently selects a non-approved local model. Low likelihood (`.env` sets it) but the default
should be `gpt-4o` (or throw on unset) to make the contract fail-safe rather than fail-silent.

### 4.4 — A* event-loop blocking on large maps — **Severity 7**

Already covered (§2.5, §4.2): the O(n²) open-set scan is the root cause of the documented 15-second
stalls and the Manhattan-distance workaround in `StrategyHurry`. This is the highest-value
*correctness-adjacent* fix because it removes a class of "agent freezes / NOMOVE starvation" symptoms
(the architecture memory lists "NOMOVE starvation" and "proxy congestion" as open issues).

### 4.5 — `setInterval(optionsGeneration, …)` is never cleared — **Severity 2**

[coordinator_agent.js:31](myAgent/coordinator_agent.js#L31) installs a heartbeat timer the first time
a strategy with `tickIntervalMs > 0` is selected and never clears it. Harmless today (strategy is
chosen once for the process lifetime), but if strategy re-selection is ever added it will leak timers.
Worth a comment or a stored handle.

---

## 5. Dead Code & Housekeeping — **Severity 5**

- **`IntentionRevisionRevise`** ([IntentionRevisionRevise.js](myAgent/intentions/IntentionRevisionRevise.js))
  — never instantiated; `#SWITCH_THRESHOLD` unused. Remove (or move to a `lab/`/`examples/` area if
  kept for teaching).
- **`StrategySimple`** and **`StrategyNotTooGreedy`** — exported from `selectStrategy.js`
  ([:21-22](myAgent/strategies/selectStrategy.js#L21)) but **never returned by `selectStrategy()`**;
  the comment says *"kept available for manual selection / future auto-rules"*
  ([:20](myAgent/strategies/selectStrategy.js#L20)). They're effectively dead in production. If
  manual selection isn't wired anywhere, retire them; `StrategyNotTooGreedy` in particular is a
  near-clone of Greedy (§1.2) and would vanish under the Template-Method refactor.
- `Strategy.scoreOf` ([Strategy.js:305](myAgent/strategies/Strategy.js#L305)) exists solely for
  `StrategySimple` (*"Used only by StrategySimple"*) — dies with it.
- `outputs/` (LaTeX build artifacts: `.aux`, `.fls`, `.fdb_latexmk`, `.log`, `.out`) are committed
  build output and should likely be `.gitignore`d.

---

## 6. Performance Summary

| Issue | Location | Impact |
|---|---|---|
| A* linear open-set scan (O(n²)) | [astar.js:86](myAgent/utils/astar.js#L86), [:224](myAgent/utils/astar.js#L224) | Event-loop stalls on large maps (documented ~15s) |
| `liveMeet` = A* × every walkable tile, per carry pass | [handoff.js:217](myAgent/llm/handoff.js#L217) | Handoff hot-loop cost on big maps |
| `walkableSet` rebuilt 9× instead of memoized | §1.6 | Repeated allocation on hot paths |
| `otherAgentDistTo` runs findRoute per sensed agent each scoring call | [context.js:417](myAgent/context.js#L417) | Bounded by `AGENT_DIST_MANH_GATE` (mitigated), still per-parcel |
| BFS re-implementations not sharing the cached walkable set | §1.6 | Minor, additive |

The single highest-leverage performance change is the **binary-heap A\*** (§2.5): it directly removes
the documented stalls and lets `StrategyHurry` drop its Manhattan workaround.

---

## 7. Prioritized Remediation Roadmap

**Do first (high value, contained):**
1. **Binary-heap A\*** + share one core between `astar`/`pushAwareCost` (§2.5, §1.6, §4.4) — removes
   stalls; enables removing the Hurry workaround.
2. **Extract `_allowedDeliveryPool` / `_allowedSpawnerPool` helpers** (§1.3) — deletes 13 pasted
   blocks, fixes the double-filter in `nearestEscapableDelivery`. Mechanical, low-risk.
3. **Bound `pickup_next_parcel`** (§4.1) and **align/verify `MAX_TOOL_FAILURES`** (§3.3) — small
   correctness fixes.

**Do next (structural, higher payoff):**
4. **`SpawnerGroupPatrol` helper** (§1.1) — collapses the three-way group/patrol copy-paste.
5. **Template-Method `decide()` + `_eligiblePool()`** (§1.2) — folds Greedy/Memory/LookAhead/
   NotTooGreedy together; `StrategyNotTooGreedy` shrinks to an override.
6. **Make `shouldKeepCurrentPickup` protected** with a `_resolveTarget` hook (§1.5) — removes the
   "private → copy" smell.
7. **`AntiLockExplorer` helper** for Blind/Hurry (§1.4).

**Housekeeping (low risk):**
8. Centralize `withTimeout` + `describeFailure` (§1.8); shared `STEP_DIRS` (§1.7);
   `dropAllMissions` via `FIELD_MAP` (§1.9); `applyAndMirror` wrapper (§1.10).
9. Delete dead code (§5); split `context.js` competitor/move-timing helpers (§2.7);
   fix the typo'd/empty lens docs (§3.4); `.gitignore` `outputs/`.

**Guardrail:** the code's backward-compat discipline (every mission gate degrades to a no-op) is a
real asset — preserve it through refactors. Each strategy refactor should be validated against the
live mission catalogue in `Plan_LLM.md` before merging, since much of this logic was tuned against
the official scorers.

---

## Appendix — Module inventory (myAgent/, by size)

| Lines | File | Role |
|---|---|---|
| 803 | strategies/Strategy.js | Base scoring/value model + exploration (large) |
| 682 | llm/commandTools.js | LLM tool catalogue (+ gather_near routine) |
| 665 | llm/handoff.js | Cross-agent handoff routine (1 huge `loop()`) |
| 539 | strategies/StrategyHighCapacity.js | Farm/hop/deliver; group machinery (dup source) |
| 535 | utils/astar.js | A*, push-aware A*, BFS variants, navigateTo |
| 519 | strategies/StrategyLookAhead.js | 2-parcel look-ahead + ported idle patrol (dup) |
| 461 | context.js | Shared state + config/map parse + competitor math |
| 437 | llm/prompt.js | System/chat prompt builders (string blocks) |
| 291 | llm/commandLoop.js | ReAct loop, classifier, conversation lane |
| 262 | strategies/StrategyLookAheadStochastic.js | Probabilistic group sampling (dup group init) |
| 252 | llm/index.js | Chat routing, abort, serialized ACTION lane |
| 242 | plans/PddlMove.js | Online PDDL crate-push planner |
| 227 | worker_agent.js | Worker BDI + partner-order handler |
| 207 | llm/missionState.js | Mission constraint apply/drop (shared) |
| 168 | beliefs/MapTopology.js | Comb-topology detector |
| 142 | llm/partner.js | Coordinator side of partner protocol |
| 141 | beliefs/Parcels.js | Live + remembered parcel beliefs |
| 136 | strategies/StrategyBlind.js | Blind-map strategy (anti-lock dup) |
| 128 | strategies/StrategyHurry.js | Spawner-dense sweep (anti-lock dup) |
| 127 | strategies/selectStrategy.js | Strategy selector |
| 117 | strategies/StrategyMemory.js | Memory-augmented greedy (decide dup) |
| 108 | strategies/StrategyHighCapacityRush.js | Abundance variant (hooks only — clean) |
| 92 | strategies/StrategyNotTooGreedy.js | Greedy clone + detour (dead / dup) |
| 84 | intentions/IntentionDeliberation.js | Plan iterator + completion promise |
| 81 | strategies/StrategyGreedy.js | Multi-pickup greedy (decide dup source) |
| 71 | beliefs/SpawnerGroups.js | Union-Find clustering |
| 66 | coordinator_agent.js | Entry point / options generation |
| 64 | intentions/IntentionRevisionReplace.js | Replace revision + commandAndAwait |
| 59 | llm/llmClient.js | OpenAI/LiteLLM client |
| 55 | intentions/IntentionRevision.js | Base intention loop |
| 52 | strategies/StrategySingleParcel.js | Single-spawner camp (clean) |
| 40 | plans/PlanBase.js | Plan base class |
| 34 | strategies/StrategySimple.js | Simple strategy (dead) |
| 33 | launch.js | Two-role launcher |
| 29 | utils/directions.js | Arrow-tile direction rules |
| 27 | utils/logger.js | Namespaced logger |
| 27 | beliefs/Me.js | Self belief (raw/rounded pos) |
| 18 | intentions/IntentionRevisionRevise.js | **Dead** (never instantiated) |
| 11 | plans/{GoPickUp,GoDeliver,GoExplore,AStarMove}.js, planLibrary.js | Plan leaves |
| 4 | utils/distance.js | Manhattan distance |
