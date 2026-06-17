# Agent Strategies

This document describes every strategy class used by the BDI agent, how each one decides what to do, and when it is selected. Strategies are pure deciders: `decide(currentIntent)` returns a predicate array to push (e.g. `['go_pick_up', x, y, id]`) or `null` to keep the current intention running. They never touch the intention queue directly.

---

## Table of Contents

1. [Strategy Selection](#1-strategy-selection)
2. [Base Class — Strategy](#2-base-class--strategy)
3. [StrategySimple](#3-strategysimple)
4. [StrategyGreedy](#4-strategygreedy)
5. [StrategyNotTooGreedy](#5-strategynottoogreedy)
6. [StrategyBlind](#6-strategyblind)
7. [StrategyHurry](#7-strategyhurry)
8. [StrategyMemory](#8-strategymemory)
9. [StrategyLookAhead](#9-strategylookahead)
10. [StrategyLookAheadStochastic](#10-strategylookaheadstochastic)
11. [StrategySingleParcel](#11-strategysingleparcel)
12. [StrategyHighCapacity](#12-strategyhighcapacity)
13. [StrategyHighCapacityRush](#13-strategyhighcapacityrush)

---

## 1. Strategy Selection

**File:** `myAgent/strategies/selectStrategy.js`

`selectStrategy()` is called once, after the server config (and therefore `OBSERVATION_DISTANCE`) has arrived. It inspects the map and returns the single strategy instance the agent will use for the whole game.

| Priority | Condition | Strategy chosen |
|---|---|---|
| 1 | `OBSERVATION_DISTANCE` ∈ `[-1, 1]` (agent senses only its own tile) | `StrategyBlind` |
| 2 | `spawnerTiles.length === 1` (single spawner) | `StrategySingleParcel` (also enables parcel memory) |
| 3 | Spawner tiles > 50 % of all walkable tiles | `StrategyHurry` |
| 4 | `CARRYING_CAPACITY > 5` **and** `PARCEL_GENERATION_MS ≤ 1000` **and** `PARCELS_MAX ≥ 15` **and** largest group ≥ 5 spawners | `StrategyHighCapacityRush` (also enables parcel memory) |
| 5 | `CARRYING_CAPACITY > 5` (finite) **and** largest group ≥ 3 spawners | `StrategyHighCapacity` (also enables parcel memory) |
| 6 | **Comb / hallway topology** detected (see below) | `StrategyLookAhead` (also enables parcel memory) |
| 7 | ≥ 3 path-based spatial groups | `StrategyLookAheadStochastic` (also enables parcel memory) |
| 8 | Otherwise (common case) | `StrategyLookAhead` (also enables parcel memory) |

`StrategySimple`, `StrategyGreedy`, `StrategyNotTooGreedy`, and `StrategyMemory` are available but not auto-selected — manual use or experiments only.

**Group density gates:** High-capacity strategies require the densest spawner cluster to meet a minimum size. If `maxGroupSize < 3` (all groups have 1–2 spawners) even a high-capacity agent falls through to stochastic/LookAhead, where probabilistic or deterministic exploration is more efficient than trying to farm a tiny cluster. The thresholds are `RUSH_MIN_GROUP_SIZE = 5` and `HC_MIN_GROUP_SIZE = 3`.

**Path-based grouping:** Spawner groups are computed with BFS on the walkable grid (max 2 steps). Two spawners separated only by a wall are **never** merged even if their Euclidean distance is ≤ 2.

### Comb / hallway topology override (priority 6)

**File:** `myAgent/beliefs/MapTopology.js` — `detectCombTopology(spawnerTiles, walkableTiles, groups)`.

On comb / hallway maps (parallel spawner "fingers" separated by walls and joined by a spine corridor — e.g. `long_hallways`, `hallways_interconnected`), every tooth is its own spawner group. That trips the `≥ 3 groups` rule (priority 7) and would select `StrategyLookAheadStochastic`, which samples groups **randomly**. On a linear layout that wastes movement: the teeth should be **swept sequentially**, which is exactly what `StrategyLookAhead`'s deterministic nearest-next exploration does. Priority 6 detects this case and diverts it to `StrategyLookAhead`.

The check sits **after** the Blind / single-spawner / Hurry / HighCapacity gates (those keep precedence — a high-capacity comb should still farm) and **immediately before** the stochastic gate, so it only ever converts a would-be-stochastic selection into LookAhead.

A layout is classified as a comb only when, on the horizontal **or** vertical axis (or both — a grid/cross map), **all** of the following hold. The detector keys on *periodic, wall-separated, solid corridors* rather than tracing corridors, which makes it immune to teeth shifted by ±1 on the cross axis:

| Criterion | Constant | Meaning |
|---|---|---|
| Enough teeth | `MIN_LINES = 4` | ≥ 4 distinct rows/columns contain a spawner. |
| Wide span | `MIN_SPAN = 6` | The teeth span ≥ 6 tiles along the tooth axis (not a tight cluster). |
| Regular spacing | `MAX_TOOTH_GAP = 3`, `REGULAR_FRAC = 0.7` | ≥ 70 % of consecutive-tooth gaps are ≤ 3 tiles. |
| Solid tooth corridors | `MIN_TOOTH_WALK = 0.85` | Average walkable fraction along the tooth-lines (across the cross-span) ≥ 85 %. **Key discriminator** — real comb teeth measure ≥ 97 %; maze/vortex "teeth" broken by walls measure ≤ 69 %. |
| Walled separators | `MIN_SEPARATORS = 4`, `MIN_WALL_FRAC = 0.6`, `SEP_WALL_FRAC = 0.7` | ≥ 4 separator bands between consecutive teeth, ≥ 70 % of which are ≥ 60 % wall. Confirms the teeth are genuinely isolated fingers. |

Validated against all 40 real SDK maps: exactly `long_hallways` and `hallways_interconnected` qualify; mazes, vortices, atom, crossroads, circuit, and open spawner fields are all rejected.

---

## 2. Base Class — Strategy

**File:** `myAgent/strategies/Strategy.js`

All strategies extend `Strategy`. It holds no game logic of its own (`decide()` returns `null`), but provides shared helpers and exploration state used by every subclass.

### 2.1 Shared Constants

| Constant | Value | Meaning |
|---|---|---|
| `MIN_DELIVERY_REWARD` | 5 | Minimum net gain required to bother picking up an empty-hand parcel. |
| `MULTI_PICKUP_MIN` | 0 | Minimum gain for a second pickup while already carrying (any positive gain counts). |
| `SWITCH_MARGIN` | 5 | A competing pickup must beat the current target by at least this much to justify abandoning the in-progress trip. Prevents per-tick flip-flopping. |
| `EXPLORE_NEARBY_MARGIN` | 4 tiles | Maximum extra distance tolerated when the ping-pong exclusion forces an alternative spawner. If every alternative is farther than `prevLen + 4`, the exclusion is skipped. |

### 2.2 Value Functions

The scoring model compares two alternatives at every decision point:

**Value A — bank now:**
```
A = R − n · ρ · d(me → D)
```
Reward banked by delivering the current load immediately. `R` = sum of carried rewards, `n` = number of parcels, `ρ` = decay rate (reward lost per tile per parcel), `D` = nearest delivery tile.

**Value B(p) — pick up then deliver:**
```
B(p) = (R + reward_p) − (n+1) · ρ · (d(me → p) + d(p → D'))
```
Reward banked if the agent detours to pick up parcel `p` and then delivers the whole load. The detour cost is paid by every already-carried parcel as well as the new one.

**Bank-first value:**
```
A_first(p) = (R − n·ρ·d0) + max(0, reward_p − ρ·(d0 + d3 + d4))
```
Alternative: deliver now, then come back for `p` as a solo trip. Multi-pickup is only justified when `B(p) > A_first(p)`.

### 2.3 Exploration — `exploreIfIdle`

Used by all sensing-based strategies when idle (nothing to pick up or deliver). Key behaviours:

- **Candidate filtering:** Only A\*-reachable tiles are considered. Prefers tiles in the *safe* region (from which a delivery is still reachable, avoiding one-way traps). Prefers tiles outside current sensing range (new ground).
- **Ping-pong prevention (sliding window):** Maintains two keys:
  - `_lastExploreKey` — the spawner currently committed to.
  - `_prevExploreKey` — the spawner committed to just before the current one.

  When selecting a new target, `_prevExploreKey` is **hard-excluded** from the candidate pool, forcing the agent toward a third option instead of bouncing A → B → A. The exclusion is skipped when every alternative would require travelling more than `EXPLORE_NEARBY_MARGIN` extra tiles (e.g. only one nearby spawner, or two nearby + two very far).

- **Reset on productive work:** Both keys are cleared when the agent transitions to `go_pick_up` or `go_deliver`, so the next exploration cycle starts with no stale exclusions.

### 2.4 Other Shared Helpers

| Helper | Purpose |
|---|---|
| `pathLen(from, to)` | A\* distance, crate-aware. Falls back to crate-ignoring path + 2 steps per crate when all crate-free routes are blocked. Returns `Infinity` when the target is entirely walled off. |
| `isReachable(to)` | `pathLen(me, to) < Infinity`. |
| `nearestDelivery(from)` | Nearest A\*-reachable delivery tile. |
| `nearestEscapableDelivery(from)` | Like `nearestDelivery` but prefers delivery tiles the agent can leave afterwards (not one-way traps). Falls back to any reachable delivery. |
| `inSafe(tile)` | True if the tile is in the pre-computed `safeTargetSet` (a delivery is reachable from it). Gates pickups and exploration on directional maps. |
| `shouldKeepCurrentPickup(intent, candidate)` | Hysteresis: keep the current `go_pick_up` unless the candidate beats it by `SWITCH_MARGIN`. |
| `decayRate()` | Reward lost per parcel per tile, derived from measured real move timing. |
| `atCapacity()` | True when carrying the server-imposed maximum number of parcels. |

---

## 3. StrategySimple

**File:** `myAgent/strategies/StrategySimple.js`  
**Extends:** `Strategy`

The most basic strategy. No decay math, no multi-pickup logic.

### Decision flow

```
carrying > 0  →  go_deliver to nearest delivery
else          →  pick best free parcel by reward / distance (scoreOf)
else          →  exploreIfIdle
```

**Scoring:** `score = reward / max(1, manhattan_distance)`. No A\* cost, no decay penalty.

**Use case:** Useful as a baseline or on trivial maps where decay is irrelevant and parcels are always nearby.

---

## 4. StrategyGreedy

**File:** `myAgent/strategies/StrategyGreedy.js`  
**Extends:** `Strategy`

Accumulates parcels within sensing range as long as adding another one beats delivering immediately, then delivers. Uses the full value model (decay, A\* distances).

### Decision flow

```
carrying > 0:
  │ not at capacity AND another worthwhile pickup nearby → go_pick_up (multi-pickup)
  │ else → go_deliver to nearest escapable delivery
  └ no delivery reachable → exploreIfIdle (reposition)

carrying == 0:
  │ best free parcel found (B − bankNow ≥ MIN_DELIVERY_REWARD) → go_pick_up
  └ else → exploreIfIdle
```

### Key mechanics

- **Worthwhile filter:** A parcel is worth picking up while carrying only when `B(p) − A_first(p) ≥ MULTI_PICKUP_MIN`. This compares the detour route against the bank-first alternative.
- **Hysteresis:** `shouldKeepCurrentPickup` prevents the agent from abandoning an in-progress pickup unless a competitor beats it by `SWITCH_MARGIN` (5 pts). Without this, decay fluctuations cause per-tick flip-flopping.
- **Sensing cap:** Only parcels within `OBSERVATION_DISTANCE` are considered (the agent cannot score what it cannot see).

---

## 5. StrategyNotTooGreedy

**File:** `myAgent/strategies/StrategyNotTooGreedy.js`  
**Extends:** `Strategy`

Identical to `StrategyGreedy` with one addition: before delivering, the agent makes a **one-time detour** to peek at the closest spawner tile just outside its sensing radius. This is useful on wide maps where a second spawner sits just beyond sensing range — the agent checks it for parcels before committing to the delivery trip.

### Extra mechanics

- **Detour condition:** A spawner tile at distance `(OBSERVATION_DISTANCE, OBSERVATION_DISTANCE + 5]` triggers a single `go_explore` to that tile before `go_deliver` is issued.
- **`#detourDone` flag:** Per-trip boolean (reset on each empty-hand state). Ensures the detour fires at most once per delivery cycle and does not loop.
- **Guard:** If the detour `go_explore` is already running, `decide()` returns `null` to let it finish before switching to `go_deliver`.

---

## 6. StrategyBlind

**File:** `myAgent/strategies/StrategyBlind.js`  
**Extends:** `Strategy`  
**Selected when:** `OBSERVATION_DISTANCE` ∈ `[-1, 1]`

Designed for maps where the agent senses only the parcel(s) on its own tile (e.g. the chaotic maze). The static map (tiles, spawners, delivery zones) is still fully known; only parcel and agent visibility is zero.

### Decision flow

```
parcel on current tile AND worth carrying → go_pick_up (opportunistic)
carrying > 0                              → go_deliver to nearest delivery
else                                      → wander between spawners (anti-lock exploration)
```

### Anti-lock exploration

The base `exploreIfIdle` is not used here. `StrategyBlind` manages its own exploration with a time-boxed, stall-detecting commitment loop and a TTL blacklist:

| Mechanism | Threshold | Behaviour |
|---|---|---|
| **Commit timeout** | `EXPLORE_COMMIT_MS` = 4 000 ms | Re-pick target periodically regardless of progress. |
| **Stall detector** | `EXPLORE_STALL_MS` = 1 500 ms | If the agent's tile has not changed for 1.5 s it is stuck; blacklist target and re-select. |
| **Arrival blacklist** | `EXPLORE_BLACKLIST_MS` = 5 000 ms | When the agent arrives at a target, blacklist it for 5 s so exploration fans out instead of ping-ponging between the two nearest spawners. |

Target selection uses **Manhattan distance** (not A\*) because on a maze the A\* cost does not correlate well with Manhattan progress and computing it for every spawner would be too expensive.

`tickIntervalMs = 100` forces re-deliberation on a timer, since a blind agent sitting still after a pickup receives no sensing events.

---

## 7. StrategyHurry

**File:** `myAgent/strategies/StrategyHurry.js`  
**Extends:** `StrategyGreedy`  
**Selected when:** spawner tiles > 50 % of all walkable tiles

On spawner-dense maps (most tiles are spawners) it is better to keep touring than to wait on any single spawner. `StrategyHurry` inherits the full pickup/deliver logic from `StrategyGreedy` and only replaces `exploreIfIdle` with a **persistent frontier sweep**.

### Frontier sweep

The agent maintains a `#visited` set of spawner keys observed this sweep. Every spawner within sensing range on each tick is marked visited. The next target is always the **nearest unvisited spawner** — the frontier advances toward unobserved ground (other rows, the far side of the map) instead of oscillating locally.

When all spawners have been visited, `#visited` is cleared and a new sweep begins.

### Stall / timeout handling

| Mechanism | Threshold | Behaviour |
|---|---|---|
| **Stall detector** | `EXPLORE_STALL_MS` = 1 500 ms | Agent tile unchanged → blacklist target for `EXPLORE_BLACKLIST_MS`. |
| **Commit timeout** | `EXPLORE_COMMIT_MS` = 4 000 ms | Give up target after 4 s regardless of stall. |
| **Blacklist TTL** | `EXPLORE_BLACKLIST_MS` = 5 000 ms | Unreachable/stuck targets are excluded for 5 s, then retried. |

Target selection uses **Manhattan distance** to avoid the O(n² · A\*) cost of computing real paths for hundreds of spawner tiles.

`tickIntervalMs = 100` ensures the stall detector fires even when the agent is blocked and no sensing events arrive.

---

## 8. StrategyMemory

**File:** `myAgent/strategies/StrategyMemory.js`  
**Extends:** `StrategyGreedy`  
**Selected when:** neither blind nor spawner-dense (the common case)

Extends `StrategyGreedy` with a **persistent parcel memory**: high-value parcels that leave the sensing zone are kept in belief memory and remain eligible targets until their decayed reward hits zero, another agent picks them up, or a clearly better candidate appears.

### Memory model

Memory is managed exclusively by the belief layer (`Parcels.sync` / `Parcels.remove`). The strategy only reads from it via `parcels.remembered()` and `parcels.getRemembered(id)` — beliefs are never written by the strategy (BDI separation preserved).

`parcels.enableMemory(DECAY_INTERVAL_MS)` must be called before this strategy runs; `selectStrategy` does this.

### Decision flow

```
carrying > 0:
  │ worthwhile multi-pickup from merged pool (live + remembered) → go_pick_up
  │ else → go_deliver to nearest escapable delivery
  └ no delivery reachable → exploreIfIdle

carrying == 0:
  │ best from merged pool (live + remembered, B − bankNow ≥ MIN_DELIVERY_REWARD) → go_pick_up
  └ else → exploreIfIdle
```

### Key differences from StrategyGreedy

- **Merged candidate pool:** Free live parcels are combined with remembered parcels (those that left sensing but have not decayed to zero). Live parcels take priority — a remembered parcel only enters the pool if there is no live entry with the same id.
- **No sensing-range cap:** The pool is not limited to `OBSERVATION_DISTANCE`. A remembered parcel at the far end of the map can still be targeted; `pickupValue` naturally penalises far targets through the decay term.
- **Capacity pre-filter:** When carrying capacity is finite, the pool is pre-screened to the top-`N` parcels by raw reward (where `N = CARRYING_CAPACITY`) before the expensive A\*-based scoring runs. This keeps the O(n · A\*) cost bounded.
- **Extended hysteresis — `#shouldKeepWithMemory`:** Overrides the base hysteresis to also check remembered parcels. The base `shouldKeepCurrentPickup` only checks the live map; a remembered target would be dropped, losing the `SWITCH_MARGIN` protection.

---

## 9. StrategyLookAhead

**File:** `myAgent/strategies/StrategyLookAhead.js`  
**Extends:** `StrategyMemory`  
**Selected when:** common case (default strategy), **or** when comb / hallway topology is detected (priority 6 — see [Strategy Selection](#1-strategy-selection))

Extends `StrategyMemory` with a **2-step look-ahead** on pickup selection. `StrategyMemory` scores each parcel in isolation — a high-reward distant parcel always wins even when a decent parcel sits almost on the route. `StrategyLookAhead` corrects this by considering pairs.

### Decision flow

```
carrying > 0:
  │ worthwhile multi-pickup (live + remembered pool) → #chooseTarget → go_pick_up
  │ else → go_deliver to nearest escapable delivery
  └ no delivery reachable → exploreIfIdle

carrying == 0:
  │ best from merged pool, scored then look-ahead promoted → go_pick_up
  └ else → exploreIfIdle
```

### Look-ahead mechanics

After picking the greedy winner **G** from the standard cost-function ranking, `#chooseTarget` finds the best complementary parcel **C** and scores both visit orders as complete tours:

```
me → C → G → delivery    value_CG = (R + r_C + r_G) − (n+2)·ρ·(d1+d2+d3)
me → G → C → delivery    value_GC = (R + r_C + r_G) − (n+2)·ρ·(d1'+d2'+d3')
```

The agent detours to **C first** (returning C instead of G) when:
1. The pair beats taking **G** solo by ≥ `LOOKAHEAD_MARGIN` (1 pt) — worthless second parcels are never chased.
2. The C-first order wins by value (≥ `LOOKAHEAD_MARGIN`), **or** both orders are within the margin and C-first has the shorter total tour.

There is no geometric "on the way" gate. Under decay the longer-travel order is already the lower-value one, so an opposite-direction parcel is grabbed first only when it genuinely shortens the trip.

### Hysteresis

`#shouldKeep` extends `StrategyMemory`'s hysteresis to handle remembered targets and one look-ahead edge case: when the chained plan's **second** stop is the current target, switching to the near parcel is a re-ordering of the same trip and is always allowed without the `SWITCH_MARGIN` cost.

---

## 10. StrategyLookAheadStochastic

**File:** `myAgent/strategies/StrategyLookAheadStochastic.js`  
**Extends:** `StrategyLookAhead`  
**Selected when:** ≥ 3 path-based spatial groups (and no high-capacity condition applies **and** the map is not comb / hallway topology — see priority 6 in [Strategy Selection](#1-strategy-selection))

Identical to `StrategyLookAhead` in all pickup, delivery, memory and look-ahead logic. Only `exploreIfIdle()` is overridden with **probabilistic group-based exploration** to break the deterministic ping-pong loop that forms on maps with many spatially separate spawner clusters.

### Group formation

Spawner tiles are clustered once (lazily on the first explore call) using **union-find** with walkable-path distance `D_CLUSTER = 2` steps. Two spawners reachable from each other in ≤ 2 walkable steps end up in the same group (transitively). Spawners separated only by a wall are never merged. Groups are static — computed once from the immutable `spawnerTiles` list.

### Probabilistic group selection

```
weight(G) = 1 / (1 + α·normDist(G) + β·recentCount(G))
P(G)      = weight(G) / Σ weight(all active groups)
```

| Parameter | Value | Effect |
|---|---|---|
| `α` | 1.5 | Distance penalty — farthest group gets ≈ 0.4× the weight of the nearest |
| `β` | 3.0 | Recency penalty — one recent choice roughly halves the weight |
| `WINDOW_SIZE` | 5 | Decisions remembered for recency; older choices have zero penalty |

`normDist` is the A\* distance to the nearest reachable spawner in the group, normalised to [0, 1] across all active groups. `recentCount` is how many of the last `WINDOW_SIZE` choices targeted that group.

**Properties:**
- No starvation — every group always has a positive weight.
- A group not chosen for ≥ 5 decisions has zero recency penalty and recovers to its natural distance-based weight.
- Normalised distance means the farthest group is penalised *relative to* the nearest, not zeroed out absolutely.

### Coverage-maximising target

Within the chosen group, the agent navigates to the tile that **covers the most group spawners** within `OBSERVATION_DISTANCE` (Euclidean), not simply the nearest spawner:

- **Fast path:** if the nearest eligible spawner already covers all group members, go there.
- **Slow path:** score every walkable tile in the group's bounding box expanded by `OBSERVATION_DISTANCE` by covered-spawner count, break ties by Euclidean distance to agent. Run A\* reachability only on the top-10 geometrically best candidates.

### Edge cases

| Situation | Behaviour |
|---|---|
| 0 or 1 group | Falls back to `super.exploreIfIdle()` (deterministic LookAhead logic) |
| All groups unreachable | Falls back to parent |
| Mission zone constraint (`allowedSpawnerTiles`) | Applied before group filtering |
| Stack-accumulation mission (`requiredStackSize`) | Current tile excluded from candidates |

### Auto-selection note

`selectStrategy` chooses this strategy automatically when ≥ 3 path-based groups are found, no high-capacity condition applies, and the map is not comb / hallway topology. On maps with fewer groups (stripe maps, single dense cluster), or on comb / hallway maps (where a sequential sweep beats random sampling — see priority 6), it falls back to `StrategyLookAhead` automatically.

---

## 11. StrategySingleParcel

**File:** `myAgent/strategies/StrategySingleParcel.js`  
**Extends:** `StrategyLookAhead`  
**Selected when:** `spawnerTiles.length === 1`

On maps with exactly one parcel spawner the only sensible idle behaviour is to **camp on that spawner** and react the instant a parcel appears. All pickup, delivery, memory and look-ahead logic is inherited from `StrategyLookAhead` unchanged — only `exploreIfIdle()` is overridden.

### Decision flow (exploreIfIdle only)

```
intent == go_pick_up | go_deliver  →  nothing to do (productive work in progress)
intent == go_explore               →  nothing to do (already en route to spawner)
already on spawnerTiles[0]         →  nothing to do (camp and wait)
spawner unreachable                →  null (give up)
else                               →  go_explore to spawnerTiles[0]
```

### Why no timer

No `tickIntervalMs` heartbeat is needed. The server fires `onSensing` the moment a parcel spawns on the agent's tile, which immediately triggers `optionsGeneration()` and the inherited `decide()` issues `go_pick_up`. The agent never misses a spawn event while camped.

---

## 12. StrategyHighCapacity

**File:** `myAgent/strategies/StrategyHighCapacity.js`  
**Extends:** `StrategyLookAhead`  
**Selected when:** `CARRYING_CAPACITY > 5` (finite) **and** largest spawner group ≥ 3 cells

Designed for maps where the agent can carry many parcels at once. Instead of delivering after every pickup, the agent farms a dense spawner cluster until its hold is full (or patience runs out), then banks everything in one trip. All pickup, delivery, memory and look-ahead logic is inherited from `StrategyLookAhead`; this strategy only overrides the top-level `decide()` and provides hook methods for the Rush subclass.

### Phases

The strategy cycles through three phases:

| Phase | Trigger | Behaviour |
|---|---|---|
| `FARM` | On start, after delivery, after hop | Patrol waypoints of the selected group, picking up every positive-value parcel. |
| `HOP` | `PATIENCE_MS` (3 s) with no eligible parcel sensed | Travel to the nearest reachable tile of the best neighbouring group, then return to FARM. |
| `DELIVER` | Hold full (`_deliveryCap`) **or** parcel TTL risk | Navigate to nearest delivery tile. En-route detours allowed (see below). |

### Group selection

Groups are built once from `spawnerTiles` using path-based union-find (`D_CLUSTER = 2` walkable steps). The initial farm group is picked by `#selectFarmGroup()`: the group with the most spawner cells, breaking ties by A\* distance to the agent.

### Patrol waypoints

Within the farm group, the agent does not camp on a single tile. `#buildPatrol(group)` generates a cyclic waypoint loop around the group centroid, sorting candidate tiles by angle so the agent sweeps the whole cluster systematically. This ensures every spawner in the group gets observed on each pass.

### Patience and hopping

If `PATIENCE_MS` (3 000 ms) elapses with no parcel spawning in the current group, `#bestNeighbourGroup()` finds the next group ordered by spawner count (most cells first), weighted by A\* distance. The agent hops there and resumes farming. This prevents the agent from idling indefinitely on a dry cluster.

### En-route detours during delivery

While navigating to a delivery tile, the agent checks for two kinds of worthwhile detours if it still has spare capacity:

1. **Parcel detour:** A live parcel within `DETOUR_MAX_TILES = 5` extra A\* steps and whose pickup gain exceeds the delivery opportunity cost.
2. **Speculative group visit:** An unvisited spawner group within `DETOUR_MAX_TILES` extra steps that likely has parcels (visited within `GROUP_VISIT_TTL_MS = 30 s`).

Detours are disabled when `_detoursEnabled = false` (overridden by Rush).

### Hook methods (overridable by subclasses)

| Hook | Default | Purpose |
|---|---|---|
| `_deliveryCap` | `CARRYING_CAPACITY` | Parcel count that triggers DELIVER phase. |
| `_detoursEnabled` | `true` | Whether en-route detours are allowed. |
| `_pickFarmTarget(groups)` | largest group by cell count | Choose the initial farm group. |
| `_countsForPatience(parcel)` | any positive-value parcel | Whether a sensed parcel resets the patience timer. |

`tickIntervalMs = 500` drives the patience timer between sensing events.

### Edge-case handling

| Situation | Behaviour |
|---|---|
| No reachable group | Falls back to `super.decide()` (LookAhead logic) |
| All parcels in group below value threshold | Patience timer fires, agent hops |
| Single group on map | No hopping; agent farms and delivers in place |
| Mission zone constraint | `allowedSpawnerTiles` applied when building pool before grouping |

---

## 13. StrategyHighCapacityRush

**File:** `myAgent/strategies/StrategyHighCapacityRush.js`  
**Extends:** `StrategyHighCapacity`  
**Selected when:** `CARRYING_CAPACITY > 5` **and** `PARCEL_GENERATION_MS ≤ 1000` **and** `PARCELS_MAX ≥ 15` **and** largest group ≥ 5 cells

Optimised for **abundance maps**: high spawn rate, high population cap, large hold. On such maps parcels respawn so fast that detour overhead and partial deliveries reduce total score. The strategy fills the hold completely, then banks in a straight line with no detours.

### Differences from StrategyHighCapacity

| Aspect | StrategyHighCapacity | StrategyHighCapacityRush |
|---|---|---|
| `_deliveryCap` | `CARRYING_CAPACITY` | `Infinity` (fill completely; infinite capacity caps at 10) |
| `_detoursEnabled` | `true` | `false` (no en-route detours, straight to delivery) |
| `_pickFarmTarget` | largest group | same, but also checks abundance-map heuristics |
| `_countsForPatience` | any positive parcel | only parcels meeting the quality bar (reward ≥ avg − margin) |

### Quality bar

On abundance maps parcels are plentiful, so the agent can afford to be selective. A parcel counts toward patience (keeping the agent on-farm) only when:

```
reward ≥ PARCEL_REWARD_AVG − RUSH_REWARD_MARGIN
```

If `PARCEL_REWARD_AVG > 30`, the minimum is raised to 20 regardless of the margin. This prevents low-value stragglers from delaying departure to a full-load bank run.

### When to prefer StrategyHighCapacity instead

`selectStrategy` prefers Rush only when the largest group has ≥ 5 spawner cells. On maps where all groups are small (2–4 cells), the hold can never be filled efficiently at one cluster, so the agent falls back to `StrategyHighCapacity` which uses patience-based delivery and inter-group hopping.

---

## 14. Composition helpers (CodeRefactor)

Two reusable helpers were extracted from strategy internals during the CodeRefactor phase. They are not strategies themselves — they are standalone modules composed into the strategies that need them.

### AntiLockExplorer

**File:** `myAgent/strategies/AntiLockExplorer.js`

Encapsulates the stall-detecting, blacklist-driven exploration loop previously inlined in `StrategyBlind` and `StrategyHurry`. Used by both strategies via composition rather than inheritance.

| Mechanism | Threshold | Behaviour |
|---|---|---|
| Commit timeout | `EXPLORE_COMMIT_MS` = 4 000 ms | Repicks target periodically regardless of progress |
| Stall detector | `EXPLORE_STALL_MS` = 1 500 ms | Tile unchanged → blacklists target |
| Arrival blacklist | `EXPLORE_BLACKLIST_MS` = 5 000 ms | Completed target excluded for 5 s to force fan-out |

Exposes `selectTarget(candidates)` and `tick(currentTile)`. The strategies call `tick()` on their `tickIntervalMs` heartbeat and `selectTarget()` when they need a new exploration goal.

### SpawnerGroupPatrol

**File:** `myAgent/strategies/SpawnerGroupPatrol.js`

Encapsulates the group-building, coverage-tile selection, and waypoint-patrol logic previously duplicated between `StrategyLookAheadStochastic` (probabilistic group selection) and `StrategyHighCapacity` (cyclic waypoint patrol). Both strategies construct a `SpawnerGroupPatrol` instance and delegate group/tile queries to it.

Key methods:
- `buildGroups(spawnerTiles)` — union-find clustering with `D_CLUSTER = 2` walkable steps.
- `coverageTile(group, agentPos)` — returns the walkable tile that covers the most group spawners within `OBSERVATION_DISTANCE`.
- `patrolWaypoints(group)` — returns a cyclic waypoint loop sorted by angle around the group centroid (used by `StrategyHighCapacity`).

Extracting this module removed ~120 lines of near-duplicate code and ensured both strategies apply identical group geometry logic.
