# Mission System

Missions are natural-language offers sent by the challenge scorers via chat. The coordinator's LLM layer reads them, decides whether to accept, applies the resulting constraints to both agents, and the strategy layer enforces them on every `decide()` call.

---

## Mission catalogue (challenge-2)

Refer to [directives.md](directives.md) for a quick-reference table of all mission types and tool mappings.

### Level-2 — Persistent constraints

These missions modify `missionConstraints` and stay active until explicitly dropped.

| Mission type | Constraint applied | Strategy enforcement |
|---|---|---|
| Required stack size ("deliver at least N") | `requiredStackSize = N` | `mustStack` / `stackReady` gates in `decide()` |
| Max stack size / exactly N | `maxStackSize = N` (+ `requiredStackSize = N` for "exactly") | `stackFull` / `stackReady` |
| Forbidden stack size ("never deliver exactly N") | `forbiddenStackSizes.add(N)` | `stackForbidden` — forces agent to grab a (N+1)th parcel |
| Delivery zone restriction | `allowedDeliveryTiles = Set<"x_y">` | `_allowedDeliveryPool()` in all delivery targeting |
| Spawner zone restriction | `allowedSpawnerTiles = Set<"x_y">` | `_allowedSpawnerPool()` in exploration |
| Avoid tiles | `avoidTiles.add("x_y")` | Excluded from `findRoute` in `navigateTo`; excluded from `pathLen` |
| Max parcel reward ceiling | `maxParcelReward = N` | `missionPickupOk(p)` gates all strategy pickup decisions |
| Max bundle value | `maxBundleValue = N` | `missionPickupOk(p)`, `stackReady`, `singleParcelBundles` |
| Delivery multiplier ("5× pts at tile") | `deliveryMultipliers = Map<"x_y", mult>` | `deliveryScale` / `_pickDelivery` — routes deliveries to bonus tile |
| Penalty tile | `penaltyTiles.set("x_y", pts)` + `avoidTiles.add("x_y")` | Hard-banned via `avoidTiles`; magnitude in `penaltyTiles` for worth-gate |

### Level-3 — Multi-agent routines

These missions arm a background cooperative behaviour. Acceptance is gated by a net-points check (`armedByNet`): each same-type offer adds its signed value to a running total; the routine is active while the total ≥ 0 and declined/stopped when < 0.

| Mission type | Net field | What happens when armed |
|---|---|---|
| OnePickupAnotherDeliver ("one picks up, other delivers") | `handoffNet` | `start_handoff` starts the background handoff loop |
| GatherNear ("move both near (x,y) and wait") | `gatherNet` | `go_to` (self) + `order_partner_goto` + `halt_partner` + `hold` |
| Red/Green Light | `lightNet` | `start_light_mission` arms the mission; live STOP/GO signals then control both agents |

---

## Constraint lifecycle

### Applying — applyMissionConfig

**File:** [myAgent/llm/missionState.js](myAgent/llm/missionState.js)

Called by the `apply_mission` tool (and its convenience wrappers `forbid_delivery`, `restrict_exploration`). Reads a parsed JSON config object and applies each present field to `missionConstraints`. Fields:

- **Accumulative fields** — `avoidTiles`, `penaltyTiles`, `forbiddenStackSizes` use `add`/`set` (repeated missions stack).
- **Replacement fields** — `deliveryMultipliers`, `oneShotBonus`, `allowedDeliveryTiles`, `allowedSpawnerTiles` replace the prior value (re-issued mission supersedes the old one).
- **Net totals** — `handoffNet`, `gatherNet`, `lightNet` are added (+=) to the running sum.

Each applied config also pushes a tagged description string: `"text [fieldName1,fieldName2]"`. These descriptions appear in the LLM system prompt so the coordinator knows which missions are active.

### Mirroring to worker — applyAndMirror

`commandTools.js` wraps the pair `applyMissionConfig(cfg); sendConstraint('apply', cfg)` into `applyAndMirror(cfg)`. All four apply-tools call this wrapper. Forgetting the mirror silently desyncs the two agents (a live-tested bug: the worker ignored constraints that were applied only on the coordinator side).

### Dropping — dropMissionField / dropAllMissions

`dropMissionField(field)` looks up the field name in `FIELD_MAP` (fuzzy: case-insensitive, no spaces/underscores), calls its `clear()` closure, and removes matching description tags. Special case: dropping `penaltyTiles` also removes those keys from `avoidTiles`.

`dropAllMissions()` loops all `FIELD_MAP` entries and resets `descriptions` explicitly (it has no entry because it's reset per-field by tag in `dropMissionField`).

Both operations are mirrored to the worker via `sendConstraint('drop', field)` / `sendConstraint('dropAll')`.

---

## Strategy-layer enforcement gates

All gates are defined on the `Strategy` base class and apply to every strategy.

| Gate | Field read | Semantics |
|---|---|---|
| `missionPickupOk(p)` | `maxParcelReward`, `maxBundleValue` | False if this parcel would exceed the reward ceiling or bundle cap. Called before any pickup decision. |
| `stackForbidden(n)` | `forbiddenStackSizes` | True if delivering exactly `n` parcels is penalised. The strategy must grab another parcel to escape `n`. |
| `stackReady(carrying)` | `requiredStackSize`, `maxBundleValue`, `forbiddenStackSizes` | True when the stack is valid for delivery (floor met, forbidden count avoided). |
| `mustStack(carrying)` | `requiredStackSize`, `forbiddenStackSizes` | True when the agent must continue picking up before it may deliver. |
| `stackFull(carrying)` | `maxStackSize`, `forbiddenStackSizes` | True when the agent has reached the stack cap and must deliver now. |
| `singleParcelBundles()` | `maxBundleValue`, `maxStackSize` | True when only single-parcel deliveries are allowed. Disables multi-pickup logic. |

These gates were added to the `Strategy` base class to fix a live-testing gap: `requiredStackSize` and `maxParcelReward` were previously enforced only in `StrategyGreedy` and `StrategyBlind`; `StrategyMemory` and `StrategyLookAhead` silently ignored them.

---

## Control gates for special missions

### trafficLight

`trafficLight.red = true` blocks:
- `optionsGeneration` (no new autonomous intentions).
- All LLM command tools that would move the agent.
- All orders to the worker.

Set and cleared by the `route()` function in `llm/index.js` when a classified `STOP`/`GO` arrives, but only after `lightMission.active = true` (armed by `start_light_mission`). A stray "red light" in chat before the mission is started is silently ignored.

### manualHold

`manualHold.active = true` blocks `optionsGeneration`. Set by the `hold()` tool. Persists across directives until `release_hold()`. Also cleared by an abort and by a `GREEN LIGHT` signal (which ends the "wait for the light" halt).

### oneShotBonus — bonusDiversion

A one-shot bonus (`missionConstraints.oneShotBonus`) competes with the parcel loop via `bonusDiversion()`, called in `optionsGeneration` *before* `strategy.decide()`. If the bonus's net value (`bonusGoalValue()`) beats `bankNowValue() + SWITCH_MARGIN`, the agent diverts to the bonus tile. Once the agent arrives, `bonusDiversion()` returns `null` (already there), preventing a re-issuance loop. See [cost-function.md](cost-function.md) for the formula.

---

## Historical evolution

Challenge 1 had no missions. Challenge 2 added the full catalogue. Key fixes applied during live testing:

- **Mission gates on Memory/LookAhead** — previously only Greedy/Blind enforced constraints; the default strategies silently ignored them.
- **applyAndMirror wrapper** — four tools were applying constraints locally without mirroring to the worker. Added in CodeRefactor Phase 2f.
- **lightMission.active guard** — live STOP/GO signals were freezing the agent before the mission was started. Fixed by gating on `lightMission.active`.
