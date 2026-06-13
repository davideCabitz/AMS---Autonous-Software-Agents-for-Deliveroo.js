# Plan 1 — Reward Accounting (per-tile multipliers + negative/fractional decline)

> **Global rule:** nothing already working may break. Every new behaviour is gated behind a
> mission being active; all defaults are exact no-ops. Verified by `node --check` + offline
> reasoning (no live server test).

## Context
The agent already accounts for **positive bonuses** (`path_cost` + LLM judgment) and **point
penalties** (`avoidTiles`, etc.). Two gaps remain, both about *rewards being taken into account*:

1. **No per-tile delivery reward multiplier.** Missions like *"every time you deliver in (x,y)
   you get 5× pts"* and *"deliver in (x,y) → 0 pts / no reward"* are not modelled — the strategy
   scoring treats every delivery tile as 1×.
2. **Negative / fractional-reward offers are declined only by fuzzy LLM judgment**, not a
   deterministic rule — e.g. *"move to X for −10pts"*, *"drop for −10pt"*, *"stacks of 5 for 0.3
   of the standard reward"*. These should be reliably declined (they lose/waste points).

Chosen approach: **value-aware scoring** — a real multiplier the strategy honours, not a
forced-tile hack. Defaults to 1× everywhere ⇒ existing behaviour unchanged. Key enabling fact:
the official challenge-2 maps are **capacity 1** (`26c2_*.json` → `player.capacity:1`), so the
active strategy is the `StrategyLookAhead` family and the **base `Strategy` scoring methods are
the single integration point**; `StrategyHighCapacity` inherits them and needs only one guard.

## Changes

### 1. New constraint field `deliveryMultipliers`
- **`myAgent/context.js`** — in `missionConstraints` add:
  `deliveryMultipliers: null,   // Map<"x_y", number> | null — null = every tile 1×`
- **`myAgent/llm/missionState.js`** — `applyMissionConfig(config)`: handle
  `config.deliveryMultipliers` as an array of `[x, y, mult]` triples → merge into a `Map` keyed
  `"x_y"` (additive: create the Map if null, then `set` each entry). Push `'deliveryMultipliers'`
  to `fieldsSet` so the description auto-tags `[deliveryMultipliers]`.
- **`missionState.js` `FIELD_MAP`** — add
  `deliverymultipliers: ['Delivery reward multiplier', 'deliveryMultipliers', () => { missionConstraints.deliveryMultipliers = null; }]`
- **`missionState.js` `dropAllMissions()`** — add `missionConstraints.deliveryMultipliers = null;`
- **`myAgent/llm/commandTools.js` — NO change.** `apply_mission` already JSON-parses the input,
  calls `applyMissionConfig(config)` and `sendConstraint('apply', config)`, so the new field flows
  to both agents automatically. Only the `[[x,y,m],…]` array crosses the wire (JSON-safe); the
  `Map` is rebuilt locally on each side — never serialise a `Map`.

### 2. Strategy scoring honours the multiplier — `myAgent/strategies/Strategy.js`
Single integration point; every strategy that uses these methods inherits it.
- **Add helper** `deliveryScale(tile)`:
  `return missionConstraints.deliveryMultipliers?.get(\`${Math.round(tile.x)}_${Math.round(tile.y)}\`) ?? 1;`
- **`nearestDelivery(from)`** and **`nearestEscapableDelivery(from)`** — change the candidate sort
  key from `a.len - b.len` to `(this.deliveryScale(b.d) - this.deliveryScale(a.d)) || (a.len - b.len)`
  (scale DESC, then distance ASC). **Safe-by-construction:** with no multiplier mission every scale
  is 1, the first term is 0, and it reduces to nearest-by-distance — identical to today. In
  `nearestEscapableDelivery` keep the existing `usable`/`reachable` trap filter; apply the new sort
  to `reachable` before the `usable` filter so a 0× tile is naturally chosen last.
- **`bankNowValue()`** — `R_eff = this.deliveryScale(del) * R` (`del = nearestDelivery(me)`), then
  `return R_eff - n * ρ * d0`.
- **`pickupValue(parcel)`** — scale `(R + parcel.reward)` by `this.deliveryScale(del)` where
  `del = nearestDelivery(parcel)`.
- **`bankFirstValue(parcel)`** — scale the `bankNow` term by `scale(del)` and the `valueAfter`
  term's `parcel.reward` by `scale(del2)`.
- All four default to scale 1 ⇒ identical output when no multiplier mission is active.

### 3. `StrategyHighCapacity` guard — `myAgent/strategies/StrategyHighCapacity.js`
- `#enRouteDelivery(farmTarget)` selects a delivery by nearest distance and would bypass the
  multiplier. Add at the top: `if (missionConstraints.deliveryMultipliers) return null;` — active
  only when a multiplier mission exists, so the multiplier-aware `nearestEscapableDelivery` (main
  DELIVER path) picks the bonus tile. Inactive ⇒ unchanged.

### 4. Prompt — `myAgent/llm/prompt.js`
- **`apply_mission` field doc** (JSON-fields block): add
  `"deliveryMultipliers": [[x,y,mult],…] — per-tile delivery reward multiplier (5 for "5× pts in (x,y)", 0 for "0 pts / no reward in (x,y)")`.
- **MISSION PATTERNS** — add:
  - `"Every time you deliver in (x,y) you get N× pts" -> apply_mission {"deliveryMultipliers":[[x,y,N],…]}.`
  - `"You get 0 pts / no reward delivering in (x,y)" -> apply_mission {"deliveryMultipliers":[[x,y,0]]}.`
  - Keep existing `"Do never deliver in …" -> allowedDeliveryTiles-except` (a hard ban, distinct from a 0× soft-avoid).
- **MISSION EVALUATION** — add a deterministic decline rule (worded to NOT touch legitimate
  positive missions like "total reward ≤ 10 for a bonus"):
  > A payoff that is **negative** ("for −10 pts", "you lose") or an explicit **reduced fraction of
  > the normal reward** ("0.3 of the standard reward", "X% of", "less reward than normal") for
  > *performing the requested action* loses/wastes points → **DECLINE**: Final Answer EXACTLY
  > `Mission declined.`, change nothing. Distinct from a **penalty** mission ("do not … or you
  > lose N") which you ACCEPT as a constraint, and from a positive bonus with a threshold which
  > you ACCEPT.
  - Keep "double the reward" → accept (positive).

## Bug / smell / incoherence review (do LAST)
- **`requiredStackSize` vs capacity**: `N > CARRYING_CAPACITY` ⇒ `stackReady` never true ⇒ agent
  never delivers (starvation). Pre-existing but surfaced by these missions. Decide: cap `N` at
  capacity in `applyMissionConfig`, or add a prompt rule to decline impossible stacks.
- **`missionPickupOk` uses `>`** for `maxBundleValue` (parcel == threshold allowed) — correct;
  confirm, don't "fix".
- **0× tile must not strand**: confirm value-aware sort puts it last yet the agent still delivers
  there if it is the ONLY reachable tile (`usable[0] ?? reachable[0]` fallback intact).
- **Key rounding**: `deliveryScale` rounds coords to match the integer `"x_y"` keys built in
  `applyMissionConfig`.
- **No double counting**: scoring `R` scale and selection scale reference the same chosen tile.
- **Field-name consistency**: `deliveryMultipliers` spelled identically in context.js, missionState
  (apply + FIELD_MAP + dropAll), prompt.js.
- **Drop paths**: `dropMission("deliveryMultipliers")` and `dropMissions()` both reset it.

## Verification (no live server)
- `node --check` on context.js, missionState.js, Strategy.js, StrategyHighCapacity.js, prompt.js.
- Grep `deliveryMultipliers` across edited files — confirm identical spelling.
- **Offline scoring harness** (throwaway Node script, no socket): stub `me`, `parcels.carriedBy`,
  `deliveryTiles`, set `missionConstraints.deliveryMultipliers`, assert: (a) no multiplier ⇒
  `nearestDelivery` returns nearest (unchanged); (b) far 5× vs near 1× ⇒ selection prefers 5× and
  `bankNowValue` ≈ 5·R − decay; (c) a 0× tile is selected last.
- Dry-run table mapping every slide example → resulting tool call (accept/decline/which field).
- **Deferred (needs a server)**: `node test/probe.js shout "Every time you deliver in (3,3) you
  get 5x pts. Bonus is per delivery."` → deliveries route to (3,3); a `… −10pts` shout → expect
  `Mission declined.`
