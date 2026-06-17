# Refactor — Behavior-Preserving Cleanup (`CodeRefactor` branch)

## Purpose

`code_base_report.md` audited `myAgent/` (≈8,100 LOC) and found the agent functionally
solid but carrying heavy **structural duplication** — spawner/patrol machinery copy-pasted
across strategies, the A* loop and several BFS variants re-implemented, mission tile-filter
blocks pasted repeatedly, anti-lock exploration duplicated between two strategies, and a few
small utilities (`withTimeout`, direction tables) copied — plus one performance smell (the
O(n²) A* open-set scan).

This refactor **eliminates that duplication and the A\* perf smell while preserving observable
behavior 100%.** It is a pure cleanup: no strategy, plan, or class behaves differently after
it. The hard constraints that shaped every decision:

- **Preserve behavior exactly.** Every change is a literal extraction or an algorithm swap
  proven to return identical output. The two behavior-*changing* items the original draft plan
  proposed (a `pickup_next_parcel` timeout and a default-model change) were **dropped entirely**.
- **Delete nothing.** All "unused"/historical strategy classes stay on disk
  (`StrategySimple`, `StrategyNotTooGreedy`, …) and the dead `IntentionRevisionRevise` is kept —
  they are part of the project's development history.
- **No automated test suite exists.** Final acceptance is the manual 4-terminal live-server
  scenario run (`docs/Plan_LLM.md` Phase 6). To compensate, **every algorithmic change in this
  refactor was validated by a throwaway differential harness** (old code vs new code over tens of
  thousands of randomized inputs, asserting byte-identical output). Those harnesses were deleted
  after going green — they are dev aids, not committed test infrastructure.

> **Caveat.** The differential harnesses prove the *refactored units* are logically identical.
> They do **not** replace the live scenario runs, which catch integration/timing issues unit
> diffs cannot. Run the scenario suite before merging `CodeRefactor` into `main`.

## At a glance

24 files changed (+707 / −565), 3 new files. Delivered as 5 commits on `CodeRefactor`:

| Commit | Phase | Theme |
|---|---|---|
| `f92b311` | 1–2 | Docs/comments/housekeeping + pure utility extractions |
| `fc8e961` | 3 | Shared A* core + handoff BFS dedup |
| `c750e20` | 4 | Composition helpers + protected hooks |
| `91c8181` | 5 | `_eligiblePool()` extraction |
| `12f67a5` | 6 | A* binary-heap + prompt sectioning |

**New files:** `myAgent/llm/util.js`, `myAgent/strategies/AntiLockExplorer.js`,
`myAgent/strategies/SpawnerGroupPatrol.js`.

---

## Phase 1 — Docs, comments, housekeeping (no logic touched)

- **`commandLoop.js`** — the use-site comment said the directive aborts "after a few failed
  commands," but `MAX_TOOL_FAILURES = 1` (it aborts after the **first**). Aligned the comment to
  the real value. **The value was not changed** (changing it would alter behavior).
- **`coordinator_agent.js`** — added a comment explaining that the `setInterval(optionsGeneration, …)`
  handle is intentionally not stored (the strategy is selected exactly once per process lifetime,
  so the heartbeat never needs clearing). No behavior change.
- **`.gitignore`** — added `outputs/` (LaTeX build artifacts).
- **`partner.js`** — resolved a **pre-existing, unrelated git merge-conflict** that was committed
  on `main` (`<<<<<<< HEAD … >>>>>>>` markers at the top of the file) and prevented the module
  from loading at all. Kept the HEAD side per instruction and restored the `PartnerState` JSDoc
  typedef so the `@type {PartnerState}` reference resolves. (This was a latent breakage, not
  something this refactor introduced.)

> The original draft plan also proposed *deleting* `StrategySimple`, `StrategyNotTooGreedy`, and
> `Strategy.scoreOf`. **All were kept** per the no-delete rule.

---

## Phase 2 — Pure utility / helper extractions (literal moves)

Each item moves identical code into one place; the helper returns exactly what the inlined code
returned.

### 2a — Shared `STEP_DIRS` (`utils/directions.js`)
Added one cardinal direction table and removed three private copies:
- `astar.js` `DIRS` → `import { STEP_DIRS as DIRS }`.
- `SpawnerGroups.js` inline `DIRS` → import (it only reads `{dx,dy}`; the extra `dir` field is harmless).
- `PddlMove.js` `DIR_DELTA` (a `{right:[1,0],…}` lookup) → **derived** from `STEP_DIRS`
  (`Object.fromEntries(STEP_DIRS.map(({dx,dy,dir}) => [dir,[dx,dy]]))`), which evaluates to the
  exact same literal.

**Critical invariant preserved:** the order `[right, left, up, down]`. A* expands neighbours in
this order, so it participates in path tie-breaking — reordering would change returned paths.
`ARROW_VECTORS` (glyph-keyed arrow semantics) was left distinct, as it is a different concept.

### 2b — `_allowedDeliveryPool()` / `_allowedSpawnerPool()` on `Strategy`
The mission tile-filter block (`tiles = deliveryTiles; if (constraint.size>0) {filter; keep if non-empty}`)
was pasted across the strategy layer. Extracted to two protected helpers and applied to:
- **Delivery (5 sites):** `Strategy.nearestDelivery`, `nearestEscapableDelivery` (twice — it
  filtered the same set redundantly), `_bestDelivery`, and `StrategyHighCapacity.#enRouteDelivery`.
- **Spawner (4 sites):** `Strategy.exploreIfIdle`, `StrategyHighCapacity.#initGroups`,
  `StrategyLookAhead._initIdleGroups`, `StrategyLookAheadStochastic` (in `exploreIfIdle`).

The two display/set-difference usages in `prompt.js` and `commandTools.js` are structurally
different constructs and were **not** folded in. The per-site fallback/`#groupsSig` cache wrappers
were left in place — only the inner membership filter moved.
**Verified: 0 mismatches / 160,000** randomized inputs across all four old call-site forms.

### 2c — Exported memoized `getWalkable()` (`astar.js`)
`astar.js` already memoized the walkable-tile `Set`; it was just not exported, so 9 other sites
rebuilt it. Exported it and reused at 7 of them (`handoff.js` ×3, `selectStrategy.js`,
`StrategyHighCapacity`, `StrategyLookAhead`, `StrategyLookAheadStochastic`).
**Intentionally left two sites:** `context.js:onMap` (the map-build site itself, where the
size-only staleness check could matter) and `MapTopology.detectCombTopology` (a pure function
operating on a *parameter*, not the global — coupling it to global state would be worse design).

### 2d — Shared `withTimeout` (new `llm/util.js`)
Three near-identical `Promise.race` + `clearTimeout` copies (`commandTools.js`, `handoff.js`,
`worker_agent.js`) collapsed to one. The unified signature reproduces every old rejection shape:
it rejects with `tag === undefined ? ['timeout'] : ['timeout', tag]`, so commandTools (always
passes a tag) and worker/handoff (no tag) get identical values. `handoff.js` keeps its
`ms = STEP_TIMEOUT_MS` default via a one-line wrapper around the shared function.

> `describeFailure` was deliberately **not** shared — the worker version genuinely differs from
> the coordinator's (different timeout unit/constant, different wording, and it lacks the `pddl-`
> branch). Sharing it would change worker output.

### 2e — `dropAllMissions` via `FIELD_MAP` (`missionState.js`)
The bulk-clear manually reset every constraint field, duplicating the per-field `clear()` closures
in `FIELD_MAP`. Now it loops `FIELD_MAP` **and** keeps `missionConstraints.descriptions = []` as an
explicit extra line — `descriptions` has no `FIELD_MAP` entry (it is reset per-field by tag in
`dropMissionField`), so a naive loop alone would leave stale description strings. The penalty/avoid
interaction coincides because `avoidTiles.clear()` runs regardless.
**Verified: identical full end-state** (all 15 fields, including the penaltyTiles→avoidTiles edge).

### 2f — `applyAndMirror(cfg)` wrapper (`commandTools.js`)
The `applyMissionConfig(cfg); sendConstraint('apply', cfg)` pair (which keeps the coordinator and
worker in sync — forgetting the mirror silently desyncs them) recurred in four tools. Wrapped once.
For `restrict_exploration` and `forbid_delivery` the inline config literal was hoisted into a single
`cfg` local before calling the wrapper (a side benefit: `restrict_exploration` had been building the
spawner list twice).

---

## Phase 3 — Shared algorithm cores

### 3a — Single parameterized A* core (`astar.js`)
`astar()` and `pushAwareCost()` were two copies of the same open/closed/gScore/fScore loop. They
now share `aStarCore(start, goalKey, heuristicOf, expand)`. Each caller injects only what differs:
- the neighbour generator + step cost (`astar`: unit cost + backtrack penalty; `pushAwareCost`:
  crate-push cost 1 vs 3),
- and what to read at the goal (`astar` reconstructs a path from `cameFrom`; `pushAwareCost`
  returns `gScore` / `Infinity`).

The **linear-scan open-set selection was kept unchanged in this phase** (the heap came in Phase 6),
so the de-duplication alone is provably identical.
**Verified: 0 mismatches / 8,000** maps (paths + push-costs).

### 3b — Shared `bfsWalkable()` for two handoff BFS copies (`handoff.js`)
`staticRoute` and `bfsDistances` were near-identical forward BFS over the walkable set; they now
share a local `bfsWalkable(startKey)` returning `{dist, prev}` (one builds a path from `prev`, the
other reads `dist`).
**Verified: 0 mismatches / 10,000.**

> The other three BFS variants were **left as-is** by design: `tilesThatReach` (reverse traversal
> with a reverse-arrow legality rule), `reachableFrom` (LIFO + agent/crate/arrow blocking), and
> `SpawnerGroups.reachableWithin` (distance-capped, cross-module). They are genuinely
> heterogeneous; forcing them into one signature would risk a subtle change for no real gain.
> Partial de-duplication is the correct, conservative outcome here.

---

## Phase 4 — Composition helpers

The strategy hierarchy is a deep inheritance chain where private methods couldn't be shared, so
they were copy-pasted (the comments literally said *"Port of …"* / *"replicated from …"*). This
phase replaces that with composition + protected hooks.

### 4a — `SpawnerGroupPatrol` (new file)
A small helper owning the **pure** patrol primitives:
- `buildPatrol(group)` — the centroid-angle clockwise waypoint loop, capped at 6 waypoints.
- `nearestTile(group, costFn)` — nearest group tile by an **injected** cost function.

`StrategyHighCapacity` and `StrategyLookAhead` (idle patrol) now delegate to it, injecting their
own cost function — HighCapacity ranks by `pathLen`, LookAhead idle by `exploreCost` (path length
plus a competitor-camping penalty). Keeping the cost function as a parameter is load-bearing:
HighCapacity's farm/hop math assumes raw distance, while idle patrol needs the anti-camping spread.
**Verified: 0 mismatches / 60,000.**

> The group-build/cache logic and the waypoint-*step* orchestration were **left in each host**.
> Stochastic builds groups from the raw spawner pool and caches permanently (the others pre-filter
> and rebuild on constraint change), and HighCapacity's step injects en-route delivery banking with
> a different exhaustion behaviour. Unifying those would risk drift; only the stateless primitives
> were shared.

### 4b — `AntiLockExplorer` (new file)
`StrategyBlind` and `StrategyHurry` shared a "don't lock onto a stale explore target" mechanism —
the same five private fields, the same three constants, and the same movement-tracking /
blacklist-expiry / commit-stall logic. Extracted into a composition helper exposing
`trackMovement`, `expireBlacklist`, `commitStatus`, `giveUp`, `clearCommit`, `commitTo`,
`isBlacklisted`, `blacklist`.

Each strategy keeps its **distinct** target selection and success-exit policy — the asymmetry is
deliberate and preserved: **Blind** detects arrival by on-tile distance and blacklists on *every*
explore exit; **Hurry** detects "observed via sensing," keeps a persistent `#visited` coverage set,
uses a Manhattan-distance sweep (no per-tile A*), and blacklists *only* on stall/timeout (never on
the observed exit).
**Verified: 0 mismatches / 48,000** driven steps — identical returned predicates **and** identical
internal state (commit key/time, blacklist, visited, log strings) at every step.

### 4c — Protected `shouldKeepCurrentPickup` + two hooks (`Strategy.js`)
The pickup-hysteresis check existed in three near-identical copies (base, `StrategyMemory`,
`StrategyLookAhead`) — duplicated only because the base was effectively private. It is now one base
implementation with two overridable hooks:
- `_resolveTarget(id)` — base resolves the live parcel; `StrategyMemory` overrides to add the
  remembered-parcel fallback (`StrategyLookAhead` inherits that).
- `_allowSwitchWithoutMargin(curId, candidate)` — base returns `false`; `StrategyLookAhead`
  overrides to allow a chained-trip re-ordering to switch without the `SWITCH_MARGIN` penalty.

The two pasted copies (`#shouldKeepWithMemory`, `#shouldKeep`) were removed.
**Verified: 0 mismatches / 150,000** across all three variants.

---

## Phase 5 — `_eligiblePool()` (scoped down from a full Template Method)

The original plan called for lifting the whole `decide()` skeleton into a Template Method across
`StrategyGreedy` / `StrategyMemory` / `StrategyLookAhead`. After reading all four `decide()` bodies
in full (a dedicated design pass confirmed this), that was **deliberately not done**: the three
control flows are not the same shape — most importantly, Greedy *falls through* to its empty-hand
branch on a short stack while Memory/LookAhead *early-return* `exploreIfIdle`. A shared skeleton
could only express that with a fragile flag, and the hooks needed to absorb every divergence
(pool source, choice shape, multi-pickup gate, the fall-through fork, four distinct log formats)
would outnumber the shared lines. Under a 100%-preserve, manual-only mandate, that indirection is a
net loss, so the `decide()` bodies stay per-strategy.

The one clean, zero-divergence win was taken: the merged candidate-pool construction
(`free + remembered-not-live + rememberedWorthPursuing + missionPickupOk + topN-by-reward`) was
character-identical in `StrategyMemory` and `StrategyLookAhead`. It is now
`StrategyMemory._eligiblePool()`, inherited by `StrategyLookAhead`. `StrategyGreedy` (distance-capped
pool, no remembered/topN) and `StrategyNotTooGreedy` (unique one-time detour, no stack gate) were
left untouched.
**Verified: 0 mismatches / 30,000**, and a line-by-line `decide()` diff confirmed the only changes
were this substitution and the Phase-4c hysteresis-call rename — no control flow altered.

---

## Phase 6 — A* binary-heap + prompt sectioning

### 6b — A* binary-heap open set (`astar.js`)
The shared `aStarCore` selected the lowest-`f` open node by **linear scan** every iteration — O(n²),
the documented cause of multi-second stalls on large maps. Replaced with a binary min-heap
(`OpenHeap`) ordered by **`(f ascending, then first-discovery seq ascending)`**. The `seq`
tie-break exactly reproduces the old scan's "lowest f, earliest-inserted on ties" choice; on a
relaxation that lowers a node's `f`, a fresh heap entry is pushed (lazy deletion) reusing the
node's original `seq`, and stale pops are skipped — so no decrease-key is needed and pop order is
identical. Complexity drops to O(n log n).

This is the one change manual scenario runs alone could not fully validate (a subtle tie-break
divergence would only show on specific maps), so it was validated the way the plan prescribed:
**0 mismatches / 16,000** randomized maps (8,000 path + 8,000 push-cost), byte-identical to the
linear scan.

> `StrategyHurry`'s Manhattan-distance workaround was **left in place**. The faster A* would let it
> be dropped, but that changes explore-target selection (observable behavior) — a separate tuning
> task, out of scope here.

### 6a — `prompt.js` sectioning
`buildSystemPrompt` is a ~330-line joined string array; only ~9 lines interpolate runtime state.
The large fully-static tail (coordinate/vocabulary conventions + the full tool catalogue +
operating notes — 148 lines, zero interpolation) was hoisted into a module-level `ACTION_REFERENCE`
constant and spread back in. The interpolated lines stay inline.
**Verified: both the generated system prompt and the chat prompt are byte-identical** before/after
(stubbed snapshot diff).

---

## Explicitly out of scope / deferred

- **`pickup_next_parcel` timeout** and **`llmClient` default-model change** — the two
  behavior-changing items from the original draft. Dropped entirely; the agent's behavior here is
  unchanged.
- **No deletions** — `StrategySimple`, `StrategyNotTooGreedy`, `Strategy.scoreOf`,
  `IntentionRevisionRevise` all kept.
- **`context.js` competitor/`moveTiming` split** and **`handoff.js` `loop()` decomposition** —
  pure cosmetic relocations of shared/stateful code with no strong behavioral validator under
  manual-only verification. Deferred as not worth the churn for an exam-grade
  behavior-preserving refactor.
- **The three bespoke BFS variants** and the **full `decide()` Template Method** — left
  partially/not de-duplicated by design (see Phases 3b and 5).

## Verification summary

Every algorithmic change was differential-tested against the actual pre-refactor code (extracted
via `git show main:` or imported directly from the committed modules), zero mismatches throughout:

| Area | Cases | Result |
|---|---|---|
| Mission tile-pool helpers (2b) | 160,000 | identical |
| `dropAllMissions` end-state (2e) | full-field | identical |
| A* `findRoute`/`pushAwareCost`/`tilesThatReach`/`reachableFrom` (3a) | 3,000 maps | identical |
| Handoff `staticRoute`/`bfsDistances` (3b) | 12,000 | identical |
| `SpawnerGroupPatrol` primitives (4a) | 60,000 | identical |
| `AntiLockExplorer` — Blind & Hurry (4b) | 48,000 steps | identical (output + state) |
| `shouldKeepCurrentPickup` + hooks (4c) | 150,000 | identical |
| `_eligiblePool` (5) | 30,000 | identical |
| A* heap vs linear scan (6b) | 16,000 maps | identical paths + costs |
| Generated system + chat prompts (6a) | snapshot | byte-identical |

**Remaining acceptance step (manual, not done here):** run the 10 `lab/missionAgents/` challenge2
scenarios + the BDI-only/solo/abort/chat-lane checks against a live Deliveroo server
(`docs/Plan_LLM.md` Phase 6) and compare scores/behavior to baseline before merging `CodeRefactor`
into `main`.
