# Refactor Plan — Remove Duplication & Fix Risks Without Breaking Behavior

## Context

`code_base_report.md` found the `myAgent/` codebase (8,098 LOC) is functionally solid but carries heavy structural duplication — spawner-group/patrol machinery copy-pasted across 3 strategies, the `decide()` skeleton re-implemented 4×, mission tile-filter blocks pasted 6–7×, anti-lock exploration duplicated Blind↔Hurry, the A* loop duplicated, BFS re-implemented 5×, and several utilities (`withTimeout`, `describeFailure`) copied — plus a few risks (an unbounded wait, an O(n²) A*).

The goal is to **eliminate the duplication and fix the risks while preserving observable agent behavior**. The hard constraint shaping everything: there are no automated tests (verified — no runner, no CI; the "unit suite" referenced in Strategy.js comments does not exist). The only regression check is **manual**: running the 10 lab/missionAgents/challenge2/ scenarios against a live Deliveroo server and watching output (per docs/Plan_LLM.md Phase 6).

Decisions locked with the user:
- Manual verification only (no new test infrastructure)
- Cover the full 9-item roadmap sequenced low→high risk
- The A* rewrite must break ties identically to the current linear scan so returned paths are byte-identical

## Guiding Principles

**Behavior-preserving by construction.** Almost every change is a literal extraction — moving identical code into a shared helper that returns the same value. No logic is altered. The few items that do change behavior are isolated and called out explicitly (§ "Behavior-changing items").

**One concern per branch.** We are on main; each phase goes on its own branch and is merged only after its manual verification passes. Phases are independently revertible.

**Risk-ordered.** Phases run lowest→highest behavioral sensitivity, so confidence compounds.

**Preserve the backward-compat discipline.** Every mission gate currently degrades to a no-op when no mission is active — keep that property through every extraction.

**Keep the old path runnable for diffing** where output must match exactly (A*, prompt strings).

## Verification Protocol (Manual — Applied After Every Phase)

### Baseline (do once, Phase 0, before any change)
Following docs/Plan_LLM.md Phase 6, run the 4-terminal setup (Deliveroo server, `npm run start:coordinator`, `npm run start:worker`, `node lab/missionAgents/start.js`) across all 10 challenge2 scenarios (26c2_1…26c2_10) and record observed scores/behaviors. Also capture:
- BDI-only mode (no LITELLM_API_KEY)
- Solo mode (no worker)
- A stdin directive
- An abort keyword
- A chat-lane question

This recording is the reference for every later comparison.

### After Each Phase
Re-run the scenario subset that exercises the changed code and compare to baseline (same scores, same qualitative behavior). Coverage map:

| Changed area | Scenarios that exercise it |
|---|---|
| A* / pathfinding (all movement) | all 10; especially handoff 26c2_8, gather 26c2_10, any trap map |
| Mission helpers (_allowedDeliveryPool, dropAllMissions, applyAndMirror) | 26c2_4 avoid, 26c2_5 stack, 26c2_6 forbid, 26c2_7 bundle |
| decide() Template Method | all pickup/deliver scenarios |
| SpawnerGroupPatrol | exploration/farm-heavy maps (high-capacity) |
| AntiLockExplorer (Blind/Hurry) | NOT covered by challenge2 (obs_distance 10) — needs a blind map + a spawner-dense map; see Phase 4 note |
| Partner/worker utils (withTimeout, describeFailure) | 26c2_8 handoff, 26c2_10 gather, halt/resume |

Additionally (Phase 6): a throwaway differential harness (see Phase 6) — not committed test infrastructure, a one-off dev script — that asserts old vs new A* return identical paths.

---

## Phase 0 — Baseline & Branch Prep (No Code Change)

1. Capture the baseline recording above.
2. Create a working branch off main. Each subsequent phase branches from the merged result.

---

## Phase 1 — Dead Code, Docs, Trivial Safety (Lowest Risk)

Pure removals/comment fixes — no behavioral logic touched.

### Delete dead code
After a confirming grep that nothing imports them at runtime:

- `myAgent/intentions/IntentionRevisionRevise.js` (never instantiated).
- `myAgent/strategies/StrategySimple.js` + `myAgent/strategies/StrategyNotTooGreedy.js` (exported but never returned by `selectStrategy()`), plus the two re-export lines in `selectStrategy.js:21-22` and `Strategy.scoreOf` (`Strategy.js:305`, "Used only by StrategySimple").
  - **Bonus:** this removes one of the four `decide()` clones before Phase 5, shrinking that surface.

### Docs/housekeeping

- Fix the `docs/code_duplication_detenction.md` typo and the two empty lens docs (fill or remove).
- Add `outputs/` (LaTeX artifacts) to `.gitignore`.
- **Comment alignment, not value change:** `MAX_TOOL_FAILURES = 1` (`commandLoop.js:28`) — align the "a few"/"3" prose to the actual value 1. **Do not change the value** (that would alter behavior); if the user later wants 3 restored, that is a separate decision.
- **setInterval handle** (`coordinator_agent.js:31`) — store the returned id / add a clarifying comment (no behavior change).

### Verify
Smoke-run coordinator+worker boot, BDI-only mode, one parcel cycle. Confirm strategy selection still resolves (none of the deleted strategies were selectable).

---

## Phase 2 — Pure Utility/Helper Extractions (No Behavior Change, Isolated)

Each item is a literal move; the extracted helper returns exactly what the inlined code did.

### STEP_DIRS in `myAgent/utils/directions.js`
Single `{dx,dy,dir}` table; import from `astar.js`, `PddlMove.js`, `SpawnerGroups.js` (report §1.7).
- **Critical:** preserve the exact order `[right, left, up, down]` — A* neighbour-expansion order participates in path tie-breaking, so the order must be byte-identical to today's `DIRS`.

### `_allowedDeliveryPool()` / `_allowedSpawnerPool()` on Strategy
Replace the 6–7 / 6 pasted filter blocks in `Strategy.js` (incl. the double-filter inside `nearestEscapableDelivery`) and `StrategyHighCapacity.#enRouteDelivery`. Filtering once ≡ filtering twice, so output is identical.

### Shared `withTimeout` + `describeFailure` → new `myAgent/llm/util.js`
(report §1.8). Cover all three `withTimeout` signatures (default ms / required tag / no default) with one signature; parameterize `describeFailure`'s `Failed:` prefix (worker omits it). Import in `commandTools.js`, `handoff.js`, `worker_agent.js`.

### Export memoized `getWalkable()` from `astar.js`
Reuse at the 9 new `Set(walkableTiles…)` sites (report §1.6) — identical set contents, fewer allocations. Leave `astar.js`'s own invalidation logic as-is.

### `dropAllMissions` via FIELD_MAP iteration
(`missionState.js:190`, report §1.9) — confirm `FIELD_MAP` covers exactly the same 14 fields, then loop its `clear()` closures + reset descriptions. Same end state.

### `applyAndMirror(cfg)` wrapper
For the repeated `applyMissionConfig(cfg); sendConstraint('apply', cfg)` pair in `commandTools.js` (report §1.10) — identical calls, one place.

### Verify
Mission scenarios 26c2_4/5/6/7 (constraint paths), 26c2_8 handoff (utils), plus a generic pickup/deliver run (walkable-set + delivery-pool paths).

---

## Phase 3 — Shared Algorithm Cores (Low–Moderate Risk, Behavior-Preserving)

Sets up Phase 6 and removes the largest algorithm duplication. Migrate one caller at a time, verifying each, because the variants have subtle semantic differences.

### Single Parameterized A* Core
Shared by `astar()` and `pushAwareCost()` (`astar.js:75`, `:204`, report §1.6/§2.5) — one loop with a pluggable `edgeCost(from,to)` / neighbour generator; push-aware passes the crate-edge cost. **Keep the linear-scan open-set selection unchanged in this phase** (the heap is Phase 6) so behavior is provably identical; this phase only de-duplicates the loop body.

### Generic `bfs(start, {neighbours, output})`
For the 5 BFS copies (`tilesThatReach`, `reachableFrom`, `staticRoute`, `bfsDistances`, `reachableWithin`). These differ (reverse-arrow legality, distance-map vs reachable-set, agent/crate blocking), so parameterize by neighbour predicate + output mode and migrate cautiously. **If any caller's semantics are too bespoke to fit cleanly** (e.g. `tilesThatReach`'s reverse-edge arrow rule), **leave it rather than risk a subtle change** — partial dedup is acceptable.

### Verify
Full movement coverage — all scenarios, with extra attention to crate maps (push-aware path) and any directional/trap map (`tilesThatReach`/`reachableFrom`).

---

## Phase 4 — Structural Dedup Via Composition (Moderate Risk, Behavior-Preserving)

The core of the report (§1.1, §1.4, §1.5, §2.2). Composition helpers injected into strategies; parameterize by the bits that differ so each strategy keeps its exact behavior. One strategy at a time.

### SpawnerGroupPatrol Helper
(report §1.1) owning group-init (+`allowedSpawnerTiles` signature rebuild), `nearestTile`, `buildPatrol`, waypoint-step. Migrate `StrategyHighCapacity`, `StrategyLookAhead` (idle patrol), `StrategyLookAheadStochastic` (group init). **Parameterize the cost function** — HighCapacity ranks by pathLen, LookAhead's idle patrol by exploreCost; the helper must take it as an argument so neither strategy's selection changes.

### AntiLockExplorer Helper
For the commit/stall/blacklist/movement-tracking shared by `StrategyBlind` and `StrategyHurry` (report §1.4). **Extract only the shared mechanism**; keep each strategy's distinct target selection (Blind: on-tile grab + distance-0 reached; Hurry: persistent #visited sweep + reachability skip) in place.
- **Verification note:** challenge2 maps don't trigger Blind/Hurry (obs_distance 10), so this step needs a blind map (obs_distance ≤1) and a spawner-dense map run separately, or it ships behind extra scrutiny.

### Make `shouldKeepCurrentPickup` Protected
(`_shouldKeepCurrentPickup`) with a `_resolveTarget(id)` hook (report §1.5); `StrategyMemory`/`StrategyLookAhead` override the hook (add `getRemembered`, the look-ahead second-stop branch) instead of re-pasting. **Preserve each variant's exact predicate.**

### Verify
Farm/high-capacity scenarios (SpawnerGroupPatrol); blind + dense maps (AntiLockExplorer); all pickup scenarios (shouldKeep) — confirm no new flip-flopping / camping vs baseline.

---

## Phase 5 — `decide()` Template Method (Highest Dedup Sensitivity, Behavior-Preserving)

Report §1.2/§2.3. Lift the 5-phase skeleton into `Strategy.decide()` with hooks `_chooseMultiPickup` / `_chooseDelivery` / `_chooseEmptyHandPickup` + a shared `_eligiblePool()`. Migrate only `StrategyGreedy`, `StrategyMemory`, `StrategyLookAhead` (`NotTooGreedy` already deleted in Phase 1). `StrategyHighCapacity`/`Rush` override `decide()` wholesale and stay untouched; `StrategyBlind`/`SingleParcel` have bespoke `decide()` and stay untouched. **The gate ordering (hysteresis → stackReady/betterDelivery → mustStack → explore) must be byte-identical per strategy** — diff each migrated `decide()` against its original logic path before running.

### Verify
The full scenario suite, with side-by-side comparison to baseline scores for the pickup/deliver/stack scenarios (26c2_5, 26c2_7 especially).

---

## Phase 6 — A* Priority Queue (Performance; Behavior-Preserving by Identical Tie-Break)

Report §2.5/§4.4. Replace the linear open-set scan in the Phase-3 shared core with a binary min-heap.

### Tie-Break Preservation (The Crux)
Assign each node a monotonic `seq` at first insertion (mirrors the current Map insertion order the linear scan relies on). Heap order = `(f asc, seq asc)`. On relaxation that lowers a node's `f`, use decrease-key keeping the original `seq` (or lazy-deletion that re-pushes with the same stored `seq` and skips stale pops). This makes the pop order — and therefore the reconstructed path — identical to today's "lowest f, earliest-inserted on ties."

### Differential Verification (One-Off, Discardable)
A scratch script that loads each of the 10 challenge2 maps, runs the OLD and NEW A* over exhaustive (or many random) start/goal pairs, and asserts identical path arrays. **This is the only reliable way to catch a subtle tie-break divergence under manual-only verification**; it is a throwaway dev aid, not committed test infrastructure, deleted once green.

### Readability Moves (Low Risk)
- Split `context.js` competitor helpers (`otherAgentDistTo`/`nearestAgentId`/…) and `moveTiming` into `beliefs/Competitors.js` / `beliefs/MoveTiming.js` (report §2.7) — pure relocation, re-exported from `context.js` to avoid touching every importer.
- Section `prompt.js` into named constants joined at the end (report §3.2) — verify by diffing the generated prompt string (must be byte-identical).
- Optionally decompose `handoff.js` `loop()` into its named phases (report §3.2) — moderate, behavior-preserving.

### Verify
Differential harness green, then the full scenario suite (A* underpins all movement), with extra attention to trap/handoff/gather geometry where path identity matters most.

---

## Behavior-Changing Items (Isolated, Opt-In — NOT Pure Refactors)

These appeared in the report's risk section; they change observable behavior, so they are flagged separately and kept conservative:

### `pickup_next_parcel` Unbounded Wait
(`commandTools.js:304`, report §4.1) — add a generous timeout that only fires in the pathological "never picks up" case and returns a `Failed:` observation. Normal operation unaffected. Do in its own small commit.

### `llmClient` Default Model
(`llmClient.js:13`, report §4.3) — make the unset-`LOCAL_MODEL` default `gpt-4o` (or throw) instead of a local llama. Only matters when `.env` omits the var (it currently always sets it), so effectively inert but fail-safe.

---

## Explicitly Out of Scope (Deferred — Behavior-Sensitive)

- **StrategyHurry dropping its Manhattan workaround after the A* heap** — this changes explore target selection; leave as-is. Revisit as separate tuning work.
- **liveMeet O(walkable×A) algorithmic optimization** (`handoff.js:217`, report §4.2) — changing the candidate scan could shift the chosen meet tile (behavior change). Phase 6's faster A* already reduces its constant cost; a true algorithmic rewrite is deferred.

---

## Rollback Strategy

Each phase is a standalone branch/PR merged only after its verification subset matches baseline. If a phase regresses, revert that branch — earlier phases are unaffected. The Phase-6 differential harness is the safety valve for the one change that manual observation alone can't fully validate.

---

## Critical Files

**Strategy layer:**
- `myAgent/strategies/Strategy.js`
- `StrategyGreedy.js`, `StrategyMemory.js`, `StrategyLookAhead.js`, `StrategyHighCapacity.js`, `StrategyLookAheadStochastic.js`, `StrategyBlind.js`, `StrategyHurry.js`
- `selectStrategy.js`

**New helpers:**
- `strategies/SpawnerGroupPatrol.js`
- `strategies/AntiLockExplorer.js`
- `llm/util.js`

**Navigation:**
- `myAgent/utils/astar.js`
- `utils/directions.js`
- `beliefs/SpawnerGroups.js`

**LLM/mission:**
- `myAgent/llm/commandTools.js`
- `missionState.js`, `handoff.js`, `worker_agent.js`, `prompt.js`, `commandLoop.js`, `llmClient.js`

**Shared state:**
- `myAgent/context.js` (+ new `beliefs/Competitors.js`, `beliefs/MoveTiming.js`)

**Verification:**
- `docs/Plan_LLM.md` (Phase 6 checklist)
- `lab/missionAgents/` (scenario maps + `start.js`)
