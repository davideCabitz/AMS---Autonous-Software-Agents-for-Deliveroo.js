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

---

## 1. Strategy Selection

**File:** `myAgent/strategies/selectStrategy.js`

`selectStrategy()` is called once, after the server config (and therefore `OBSERVATION_DISTANCE`) has arrived. It inspects the map and returns the single strategy instance the agent will use for the whole game.

| Condition | Strategy chosen |
|---|---|
| `OBSERVATION_DISTANCE` in `[-1, 1]` (agent senses only its own tile) | `StrategyBlind` |
| Spawner tiles > 50 % of all walkable tiles | `StrategyHurry` |
| Otherwise | `StrategyMemory` (also enables parcel memory in the belief layer) |

`StrategySimple`, `StrategyGreedy`, and `StrategyNotTooGreedy` are available but are not auto-selected; they can be set manually or used in experiments.

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
| `IDLE_WAIT_MS` | 2000 ms | How long the agent waits on a spawner tile before giving up and moving on. |
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

- **Spawner wait:** When standing on a spawner, waits `IDLE_WAIT_MS` (2 s) for a parcel to appear before moving on.
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
