# Plan — Mission handling: taxonomy prompt + deterministic resolver

> **Execution step 0:** save this file into the repo as `docs/MISSION_PROMPT_REFACTOR_PLAN.md`
> (plan mode only allows editing this plan file; copy it on approval).
>
> **Global rules:** `lab/` is course code — untouched. Storage/enforcement layer
> (`missionConstraints` + Strategy gates + `missionState`) is sound — keep it. All changes are
> in *my* code, default to no-ops, and are verified by `node --check` + offline logic tests
> (no live server).

## Context
Mission handling works at the storage/enforcement layer but is brittle at the **NL → constraint**
step. It is currently *one verbatim prompt pattern per mission phrasing*, which (a) proliferates,
and (b) **fails silently** on any phrasing not enumerated. Observed live: *"If you deliver in the
leftmost delivery tile you lose 50 points"* produced **no tool call at all** (empty log) — no
pattern matched, and the agent ended without acting. Also, the conversational lane can't report
*which* tiles are restricted because it only sees mission *description* text, not coordinates.

Reading all `lab/` scorers confirms the structure: every mission rewards on `onMove` / `onDelivery`
/ pickup-identity, i.e. Level-2 missions only ever touch ~4 behavioral axes — **where you deliver,
how many per delivery, how much value/cap, where you walk/explore**. That bounded taxonomy is the
key: the prompt should route by *meaning to an axis*, not by matching exact words. Goal: replace
enumerated patterns with a taxonomy + a no-silent-noop rule, and make tile-location resolution
deterministic (LLM arithmetic over reachable-filtered tile sets is unreliable).

## Changes

### 1. Prompt restructure — `myAgent/llm/prompt.js` (`buildSystemPrompt`)
Replace the enumerative **MISSION PATTERNS** block with:
- **MISSION TAXONOMY** — "Every persistent mission changes exactly one axis; map by *meaning* to
  the `apply_mission` field / tool, not by keywords":
  - **where you deliver** → `forbid_delivery(...)` (avoid a tile) or `allowedDeliveryTiles`
    (deliver only at...); a **penalty / "you lose N" / "0 pts" / "no reward" for delivering in a
    tile ⇒ AVOID it ⇒ `forbid_delivery`**.
  - **how many per delivery** → `requiredStackSize`.
  - **value / cap** → `maxBundleValue`, `maxParcelReward`; a positive per-tile bonus ("5× pts in
    (x,y)") → `deliveryMultipliers`.
  - **where you walk** → `avoidTiles`.  **where you explore** → `restrict_exploration` /
    `allowedSpawnerTiles`.
- Keep only **3–4 canonical examples**, not the full list.
- **NAMED EDGES** — state the convention once (`leftmost = least x, rightmost = greatest x,
  top = greatest y, bottom = least y`) and tell the model to pass the side keyword to the resolver
  rather than computing coordinates itself.
- **NO SILENT NO-OP** — for a mission/ACTION directive the model must end with either a tool
  Action or an explicit Final Answer (`Mission accepted.` / `Mission declined.` / a short "can't
  comply" statement). It must never end without acting.
- Keep the existing **MISSION EVALUATION** rules (incl. the negative/fractional decline rule).
- Add `forbid_delivery` to the tool list; reroute the `"0 pts delivering in (x,y)"` example from
  `deliveryMultipliers:0` to `forbid_delivery` (exclude is cleaner than "worth 0"); keep
  `deliveryMultipliers` for the **positive** (prefer/bonus tile) case.

### 2. New deterministic tool `forbid_delivery(spec)` — `myAgent/llm/commandTools.js`
Reliable executor for the whole "don't deliver here" family (penalty / 0-pts / never), modeled on
the existing `restrict_exploration` (resolve → `applyMissionConfig` → `sendConstraint` mirror):
- `spec` accepts explicit coords (`"x,y"`, or `;`-separated list) **or** a side keyword
  `leftmost|rightmost|top|bottom`.
- Resolve named edges over the **full** `deliveryTiles` from context (NOT `sense_delivery_tiles`,
  which is reachability-filtered) using the convention above; ties → all tiles at the extreme.
- Compute `newAllowed = (existing allowedDeliveryTiles ?? all deliveryTiles) − resolvedForbidden`
  so repeated calls **accumulate** restrictions instead of clobbering a prior one.
- Apply via `applyMissionConfig({ allowedDeliveryTiles: newAllowed, description })` and
  `sendConstraint('apply', {...})` to mirror to the worker.
- **Description carries the resolved coordinates** (e.g. `"never deliver in leftmost delivery tile
  (3,9) [allowedDeliveryTiles]"`) — this is what fixes conversational recall.
- **Guard:** if exclusion empties the allowed set, refuse and return an error string (don't strand
  the agent) so the model can report it.
- Returns an observation naming the resolved tile(s).

### 3. Conversational recall — `myAgent/llm/prompt.js` (`buildChatPrompt`)
The ACTIVE PERSISTENT MISSIONS block currently shows only `missionConstraints.descriptions`. Add
the actual resolved tiles when present (`allowedDeliveryTiles`, `avoidTiles`) so *"which tiles?"*
is answered from data, not paraphrase. Combined with #2's coordinate-bearing descriptions, recall
becomes accurate regardless of how the description was phrased.

### 4. Untouched
`missionState.js` field set, Strategy gates/scoring, and the `deliveryMultipliers` work from the
prior task all stay. No new constraint field is introduced — `forbid_delivery` reuses
`allowedDeliveryTiles`.

## Bug / smell review (do LAST)
- **Accumulation, not clobber:** confirm `forbid_delivery` intersects with any existing
  `allowedDeliveryTiles` (recompute from current allowed set, not always from all tiles).
- **Empty-set guard** prevents stranding; verify it triggers before applying.
- **Edge ties:** multiple tiles at the same extreme are all excluded.
- **Mirror parity:** the worker receives the same `allowedDeliveryTiles` via `sendConstraint`.
- **No-silent-noop wording** must not force a chatty reply on the *silent-by-design* action
  completions — it applies to "never end a mission directive *without acting*", not to suppressing
  the normal silent endings of executed actions.
- **Taxonomy doesn't regress accept/decline:** negative/fractional offers still DECLINE; penalty
  *avoidance* missions still ACCEPT.

## Verification (no live server)
- `node --check` on `prompt.js`, `commandTools.js`.
- **Offline logic test** (standalone Node, mirrors the resolver): assert
  `leftmost=min x / rightmost=max x / top=max y / bottom=min y`, tie handling (all extremes),
  `all − forbidden` inversion, accumulation across two calls, and the empty-set guard.
- **Dry-run table** → tool call for: "lose 50 in leftmost delivery tile", "0 pts in (3,3)",
  "never deliver in (x,y)", "5× pts in (x,y)", and an unseen phrasing ("deliveries at the top row
  are penalized") — each must resolve to a real tool, none silent.
- **Deferred (needs server + VPN):** `node test/probe.js shout "If you deliver in the leftmost
  delivery tile you lose 50 points."` → expect a `forbid_delivery(...)` toolLog + `Mission
  accepted.`; then chat "which tiles shouldn't you deliver to?" → names the resolved coords.

## Execution order
0. Save this as `docs/MISSION_PROMPT_REFACTOR_PLAN.md`.
1. `forbid_delivery` tool (#2) + offline resolver test.
2. Prompt taxonomy + no-silent-noop + tool-list/examples (#1).
3. Chat recall (#3).
4. Review checklist + `node --check` + dry-run table.
