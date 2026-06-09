# Agent Looping Behaviours

A complete reference for how every strategy and plan is chosen, what it does, and why alternatives are rejected at each step of the agent lifecycle.

---

## Table of Contents

1. [The BDI Loop — How Everything Connects](#1-the-bdi-loop--how-everything-connects)
2. [Strategy Selection at Startup](#2-strategy-selection-at-startup)
3. [The Plan Library — Resolution Order](#3-the-plan-library--resolution-order)
4. [Plans in Detail](#4-plans-in-detail)
   - [GoPickUp](#41-gopickup)
   - [GoDeliver](#42-godeliver)
   - [GoExplore](#43-goexplore)
   - [go\_to resolution — PddlMove vs AStarMove](#44-go_to-resolution--pddlmove-vs-astarmod)
5. [Strategies in Detail](#5-strategies-in-detail)
   - [StrategySimple](#51-strategysimple)
   - [StrategyGreedy](#52-strategygreedy)
   - [StrategyNotTooGreedy](#53-strategynottoogreedy)
   - [StrategyBlind](#54-strategyblind)
   - [StrategyHurry](#55-strategyhurry)
   - [StrategyMemory](#56-strategymemory)
6. [Full Lifecycle Walkthrough](#6-full-lifecycle-walkthrough)
   - [Exploration](#61-exploration)
   - [First Pickup](#62-first-pickup)
   - [Multi-Pickup Decision](#63-multi-pickup-decision)
   - [Delivery](#64-delivery)
   - [Blocked Delivery / Repositioning](#65-blocked-delivery--repositioning)
7. [Value Model Reference](#7-value-model-reference)
8. [Shared Guards and Helpers](#8-shared-guards-and-helpers)

---

## 1. The BDI Loop — How Everything Connects

```
 Server event (parcel sense / you / move-ack)
         │
         ▼
  decide(currentIntent)        ← called on every re-deliberation tick
         │
  ┌──────┴──────────────────────────────────┐
  │  Strategy.decide()                      │
  │   returns a predicate array             │
  │   e.g. ['go_pick_up', x, y, id]         │
  │   or null (keep current intention)      │
  └──────┬──────────────────────────────────┘
         │ non-null
         ▼
  IntentionRevisionReplace
    stops the running intention (if any)
    pushes new intention
         │
         ▼
  IntentionDeliberation.achieve()
    iterates planLibrary
    finds first plan where isApplicableTo() == true
         │
         ▼
  Plan.execute()               ← async, runs until completion or stop()
    may call subIntention(['go_to', x, y])
         │
         ▼
  go_to resolved by PddlMove or AStarMove
```

The strategy is a **pure decision function** — it reads beliefs and returns what to do next. It never executes actions directly. The plan layer owns all async execution (navigation, pickup, putdown).

`decide()` is called:
- On every server sensing event (parcel appears/disappears, agent moves)
- On every `tickIntervalMs` heartbeat (only for strategies that set it > 0)
- When the current intention completes or fails

When `decide()` returns `null` the current intention keeps running undisturbed.

---

## 2. Strategy Selection at Startup

**File:** `myAgent/strategies/selectStrategy.js`

Called once after the server config arrives (so `OBSERVATION_DISTANCE` is known). Checks conditions in priority order:

| Priority | Condition | Strategy chosen | Reason |
|---|---|---|---|
| 1 | `OBSERVATION_DISTANCE` ∈ [-1, 1] | `StrategyBlind` | Agent can only see its own tile — all sensing-based scoring is useless; exploration and pickup must work without parcel visibility |
| 2 | spawner tiles > 50 % of walkable tiles | `StrategyHurry` | On spawner-dense maps, waiting at one spawner is worse than constantly touring — the density means there's almost always something fresh to pick up somewhere else |
| 3 | otherwise | `StrategyMemory` | The general case: full sensing range, moderate spawner density. Memory extension keeps far high-value parcels reachable after they leave sensing |

`StrategySimple`, `StrategyGreedy`, and `StrategyNotTooGreedy` are available but not auto-selected. They serve as baselines or experimental alternatives.

`parcels.enableMemory(DECAY_INTERVAL_MS)` is also called before `StrategyMemory` starts, wiring up the belief layer's parcel memory.

---

## 3. The Plan Library — Resolution Order

**File:** `myAgent/plans/planLibrary.js`

```js
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
```

`IntentionDeliberation` walks this array in order and picks the **first** plan whose `isApplicableTo(intent, ...args)` returns true. Order matters:

| Position | Plan | Applicable to | Why this position |
|---|---|---|---|
| 1 | `GoPickUp` | `go_pick_up` | Unique intent name — no ambiguity, checked early |
| 2 | `GoDeliver` | `go_deliver` | Same — unique, cheap check |
| 3 | `GoExplore` | `go_explore` | Same |
| 4 | `PddlMove` | `go_to` **only when a crate blocks the crate-free A\* route** | Expensive (calls online PDDL solver); must be checked before AStarMove but only activates when actually needed |
| 5 | `AStarMove` | `go_to` (always) | Cheap default — only reached when PddlMove returned false |

`PddlMove.isApplicableTo` runs two A\* calls inline: one ignoring crates (to check if a free route exists) and one with crates (to confirm the target is reachable at all). If a crate-free route exists it returns `false` immediately and `AStarMove` handles the trip at zero network cost.

---

## 4. Plans in Detail

### 4.1 GoPickUp

**Intent:** `go_pick_up x y id`

**What it does:**
1. Guards `this.stopped` — if the intention was replaced mid-flight, abort immediately.
2. Issues `subIntention(['go_to', x, y])` → navigates to the parcel's tile.
3. Guards `this.stopped` again (a parcel could disappear while navigating).
4. Calls `socket.emitPickup()`.
5. Updates belief layer: if the server confirms the pickup, marks the parcel as carried by `me.id`; if it was already taken, removes it from beliefs entirely.

**Why not just navigate and trust sensing events to update beliefs?**
On blind or low-sensing maps, no sensing event fires when the agent picks up a stationary parcel (the agent doesn't move). Without the manual belief update, the agent would try to pick up the same parcel on the next tick forever.

---

### 4.2 GoDeliver

**Intent:** `go_deliver x y`

**What it does:**
1. Guards `this.stopped`.
2. Issues `subIntention(['go_to', x, y])` → navigates to the delivery tile.
3. Guards `this.stopped`.
4. Calls `socket.emitPutdown()`.
5. Removes all carried parcels from the belief layer immediately on confirmation.

**Why the immediate belief update?**
Same reason as GoPickUp: blind/low-sensing maps produce no sensing event after a putdown. Without manual removal the agent would believe it's still carrying and loop back to deliver again.

---

### 4.3 GoExplore

**Intent:** `go_explore x y`

**What it does:**
1. Guards `this.stopped`.
2. Issues `subIntention(['go_to', x, y])` → navigates to the target spawner tile.
3. Returns `true`.

**Why a separate plan instead of just reusing GoPickUp with a dummy target?**
`isApplicableTo` for `GoPickUp` checks for `go_pick_up` — a different intent string. Keeping intents separate lets the strategy (and intention validity checks) distinguish "I am navigating to a parcel I expect to still be there" from "I am exploring and there may be nothing here." The validity logic for `go_pick_up` checks that the parcel still exists; `go_explore` has no such validity gate.

**Stop behaviour:**
GoExplore is stopped (and the navigation abandoned) immediately when the strategy returns a new predicate. This is the normal path: the agent senses a parcel mid-exploration, `decide()` returns `go_pick_up`, and GoExplore is cancelled.

---

### 4.4 `go_to` Resolution — PddlMove vs AStarMove

Both plans handle `go_to x y`, issued as a sub-intention by GoPickUp, GoDeliver, and GoExplore.

#### AStarMove (default)

- Calls `navigateTo(x, y, stoppedFn)`.
- A\* over walkable tiles, crate-aware: tiles currently occupied by crates are treated as walls.
- Issues `socket.emitMove(dir)` one step at a time; waits for arrival confirmation before the next step.
- **Chosen when:** a crate-free A\* path exists (the overwhelming majority of moves).
- **Why not always use PDDL?** PDDL requires a round-trip to an online solver on every call — significant latency and network cost. AStarMove is pure local computation with no external dependency.

#### PddlMove (crate-blocking fallback)

- **Chosen when:** crates exist on the map AND every crate-free A\* path is blocked AND at least one path exists if crates are ignored (i.e. a push sequence could clear the way).
- Encodes the current world state as a PDDL problem (agent position, all crate positions, free tiles, pushable zones) and calls `onlineSolver(domain, problem)`.
- Executes the plan step by step. On a push step, the agent walks into the crate's tile, displacing it one tile forward.
- **Mid-plan replan:** if a new crate appears on the next planned tile during execution (entered sensing after the plan was built), it aborts the current plan and replans from the new state. Up to `MAX_REPLANS = 6` attempts before failing hard.
- **PDDL lock (`pddl.busy`):** while executing a PDDL plan, `pddl.busy = true`. The intention revision layer respects this flag and does not replace the intention mid-plan, preventing the agent from abandoning a half-executed push sequence (which would leave the map in an inconsistent state).
- **Opportunistic pickup:** if a free parcel is on any tile the agent steps onto during PDDL execution, it emits a pickup without detouring — zero extra movement cost.

---

## 5. Strategies in Detail

All strategies extend `Strategy` and call `exploreIfIdle(currentIntent)` from the base class when there is nothing productive to do.

---

### 5.1 StrategySimple

**Selected:** manually only (baseline).

**Decision cycle:**

```
carrying > 0  →  go_deliver  (nearest delivery, no decay math)
else          →  best free parcel by reward / manhattan_distance  →  go_pick_up
else          →  exploreIfIdle
```

**Key properties:**
- No A\* distance, no decay penalty, no multi-pickup. Score = `reward / max(1, manhattan)`.
- Delivers immediately after any pickup — never accumulates a second parcel.
- No hysteresis: switches targets every tick if a better parcel appears.

**When it is the right choice:** trivial maps where decay is zero or negligible, all parcels are nearby, and the map is simple enough that Manhattan approximates real distance.

**Why it is not auto-selected:** on any non-trivial map it wastes trips (delivers single parcels when accumulating two would cost almost nothing extra) and switches targets unnecessarily on every tick.

---

### 5.2 StrategyGreedy

**Selected:** manually only (general-case baseline with decay math).

**Decision cycle when carrying > 0:**

```
capacity remaining?
  ├─ shouldKeepCurrentPickup()?          → null (keep going)
  ├─ worthwhileInRange exists?           → go_pick_up  (multi-pickup)
  └─ no more worth picking up
       ├─ stackSize constraint met?
       │    └─ yes → go_deliver (nearestEscapableDelivery)
       │    └─ no  → exploreIfIdle (need more parcels first)
       └─ no reachable delivery         → exploreIfIdle (reposition)
```

**Decision cycle when carrying == 0:**

```
best parcel (A*-scored, pickupValue − bankNow ≥ MIN_DELIVERY_REWARD)?
  ├─ shouldKeepCurrentPickup()?          → null (keep heading there)
  └─ yes                                 → go_pick_up
else                                     → exploreIfIdle
```

**Key properties:**
- Uses full decay model for all scoring (A\* distances, `decayRate()`).
- Multi-pickup: a second parcel is only added if `B(p) − A_first(p) ≥ MULTI_PICKUP_MIN`. This compares the detour route against delivering now and then coming back — prevents adding a parcel that would cost more in decay than it's worth.
- Sensing cap: only considers parcels within `OBSERVATION_DISTANCE` for multi-pickup decisions.
- Hysteresis via `shouldKeepCurrentPickup`: a competing parcel must beat the current target by `SWITCH_MARGIN = 5` pts before the agent abandons an in-progress trip.
- `nearestEscapableDelivery` (not `nearestDelivery`) for the actual delivery target: picks a delivery tile the agent can leave afterwards, avoiding one-way traps on directional maps.

**Why multi-pickup beats simple:** combining two parcels into one delivery trip amortises the fixed cost of the delivery leg over more reward. On any map with decay, this is almost always better when a second parcel is close.

---

### 5.3 StrategyNotTooGreedy

**Selected:** manually only.

**Identical to StrategyGreedy** with one addition: before issuing `go_deliver`, a **one-time detour** checks the closest spawner just outside sensing range.

**Detour logic:**
- Looks for a spawner tile at distance `(OBSERVATION_DISTANCE, OBSERVATION_DISTANCE + 5]`.
- If found and `#detourDone == false`: sets `#detourDone = true`, returns `go_explore` to that tile.
- While the detour is running (`go_explore` is the current intent and `#detourDone` is true): returns `null` to let it complete.
- `#detourDone` resets when the agent is empty-handed (start of a new pickup cycle).

**Why this helps:** on wide maps with sparse spawners, the closest parcel cluster is often just beyond the sensing radius. Peeking before delivering adds one short detour that can find a high-value parcel without crossing the whole map.

**Why it is not auto-selected:** on maps where spawners are uniformly distributed, the detour rarely finds anything and wastes time on every delivery cycle. It is most useful in specific layouts that a human can identify.

---

### 5.4 StrategyBlind

**Selected when:** `OBSERVATION_DISTANCE` ∈ [-1, 1].

**Key constraint:** the agent cannot sense parcels or other agents beyond its own tile. The static map (walkability, spawners, delivery zones) is fully known. Navigation still works normally; only parcel/agent perception is zero.

**Decision cycle:**

```
free parcel on current tile AND pickupGain ≥ MIN_DELIVERY_REWARD?
  └─ go_pick_up  (opportunistic; resets explore commitment)

carrying > 0?
  └─ go_deliver to nearestDelivery  (resets explore commitment)

current intent == go_explore?
  ├─ arrived (distance == 0)       → blacklist tile for 5 s, reset commitment, re-select
  ├─ stalled (tile unchanged 1.5 s) → blacklist tile for 5 s, re-select
  ├─ timed out (4 s)               → blacklist tile for 5 s, re-select
  └─ otherwise                     → null (keep heading there)

re-select: nearest non-blacklisted non-current-tile spawner by Manhattan distance
  └─ go_explore
```

**Why Manhattan instead of A\*?** In a maze, Manhattan distance does not correlate well with real path length. The A\* cost for every spawner candidate would also be expensive. Manhattan is cheap and good enough to pick "roughly the closest" unvisited spawner.

**Why `tickIntervalMs = 100`?** After a pickup or putdown the agent is stationary. No sensing event fires (there is nothing to sense on a blind map). Without a heartbeat the agent would freeze after every action.

**Why a blacklist instead of the base `_prevExploreKey` sliding window?** The sliding window assumes the agent can detect arrival by sensing. A blind agent can only detect arrival by reaching `distance == 0`, but it also needs to handle stall (blocked by another agent or crate) and timeout. The blacklist TTL covers all three cases with a single mechanism.

---

### 5.5 StrategyHurry

**Selected when:** spawner tiles > 50 % of walkable tiles.

**Extends:** `StrategyGreedy` — all pickup/deliver decisions are inherited unchanged.

**Only `exploreIfIdle` is replaced** with a persistent frontier sweep.

**Frontier sweep logic:**

```
every tick: mark all spawners within sensing as #visited (persistent this sweep)

current intent == go_explore?
  ├─ target just entered sensing (#visited)  → drop commitment, re-select
  ├─ stalled (1.5 s)                         → blacklist 5 s, re-select
  ├─ timed out (4 s)                         → blacklist 5 s, re-select
  └─ otherwise                               → null (keep going)

re-select: nearest unvisited, non-blacklisted spawner by Manhattan distance
  └─ go_explore

all spawners visited → clear #visited, start fresh sweep
```

**Key distinction from base `exploreIfIdle`:** the visited set is **persistent across explore cycles**. The base `_prevExploreKey` only remembers one step back, so nearby spawners keep becoming eligible again and the agent oscillates locally. The persistent set makes the frontier advance continuously toward unobserved ground.

**Why arrival = "entered sensing" not "reached tile"?** On a spawner-dense map, the agent can sense 50+ spawners in every direction. The goal is not to stand on each one but to ensure every tile has been observed at least once. Entering sensing range is sufficient and much faster.

**Why Manhattan for target selection?** Computing A\* for hundreds of spawner candidates blocks the JavaScript event loop for ~15 seconds on large maps. Manhattan is O(1) per comparison; the stall detector handles the cases where the chosen tile is actually unreachable.

**Why `tickIntervalMs = 100`?** Same reason as StrategyBlind: the stall detector must fire even when the agent is blocked and no move events arrive.

---

### 5.6 StrategyMemory

**Selected when:** neither blind nor spawner-dense (the common case).

**Extends:** `StrategyGreedy` — same structure but operating on a **merged candidate pool** (live parcels + parcels still in belief memory from when they exited sensing).

**Memory model:** Managed entirely by the belief layer (`Parcels.sync` / `Parcels.remove`). The strategy only reads via `parcels.remembered()` and `parcels.getRemembered(id)` — BDI separation is preserved: beliefs are never written by decide().

**Decision cycle when carrying > 0:**

```
merged pool = live free parcels ∪ remembered parcels (not currently live)
  pre-filter top-N by raw reward when capacity is finite
  filter: A*-reachable AND inSafe
  score: pickupValue(p)
  filter: value − bankFirstValue(p) ≥ MULTI_PICKUP_MIN

#shouldKeepWithMemory()?     → null (hysteresis covering remembered targets too)
worthwhile from merged pool? → go_pick_up

go_deliver (nearestEscapableDelivery)
  or repositioning if no delivery reachable
```

**Decision cycle when carrying == 0:**

```
merged pool (same as above)
  filter: value − bankNow ≥ MIN_DELIVERY_REWARD

#shouldKeepWithMemory()?     → null
best from merged pool?       → go_pick_up

exploreIfIdle
```

**Key differences from StrategyGreedy:**

| Aspect | StrategyGreedy | StrategyMemory |
|---|---|---|
| Candidate pool | Live parcels within `OBSERVATION_DISTANCE` only | Live + remembered (no distance cap) |
| Parcel memory | None — parcel is forgotten the moment it exits sensing | Remembered parcels persist until decayed to zero or confirmed taken |
| Hysteresis | `shouldKeepCurrentPickup` (live map only) | `#shouldKeepWithMemory` (checks live map first, then memory) |
| Capacity pre-filter | No | Top-N by raw reward when capacity is finite, before the A\* scoring loop |

**Why the capacity pre-filter?** When carrying capacity is finite (e.g. max 5 parcels), the full O(n · A\*) scoring of every remembered parcel would be wasteful. Pre-filtering to the top-N by raw reward narrows the expensive scoring pass to only the candidates that could actually be carried.

**Why `#shouldKeepWithMemory` instead of the base method?** The base `shouldKeepCurrentPickup` calls `parcels.get(curId)` which returns `undefined` for a remembered parcel (it has left sensing). Without the override, a remembered target in progress would lose `SWITCH_MARGIN` protection and be immediately abandoned when a live parcel appears nearby, causing the agent to drop a valuable far target for a cheap nearby one.

---

## 6. Full Lifecycle Walkthrough

### 6.1 Exploration

**Entry condition:** `decide()` reaches `exploreIfIdle(currentIntent)` — no carrying, no worthwhile parcel visible.

**Base `exploreIfIdle` (used by StrategySimple, StrategyGreedy, StrategyNotTooGreedy, StrategyMemory):**

1. If currently pursuing `go_pick_up` or `go_deliver`: reset `_lastExploreKey` and `_prevExploreKey`, return `null`.
2. If currently pursuing `go_explore` and target is still `>= OBSERVATION_DISTANCE` away: return `null` (keep going, not arrived yet).
3. Build candidate pool: spawner tiles (or walkable if no spawners), filter to A\*-reachable, filter to `inSafe`.
4. Prefer tiles outside current sensing (`distance > OBSERVATION_DISTANCE`); fall back to all reachable if all are already in range.
5. Hard-exclude `_prevExploreKey` (the tile before the current one) to prevent A→B→A ping-pong. Skip this exclusion if every alternative is more than `EXPLORE_NEARBY_MARGIN = 4` tiles farther (avoids sending the agent across the map when only two nearby spawners exist).
6. Sort remaining candidates by A\* path length; pick the nearest.
7. Slide the window: `_prevExploreKey = _lastExploreKey`, `_lastExploreKey = new target key`.
8. Return `['go_explore', x, y]`.

**StrategyBlind / StrategyHurry** override `exploreIfIdle` entirely (see §5.4 and §5.5).

---

### 6.2 First Pickup

**Entry condition:** `decide()` finds a parcel whose `pickupValue(p) − bankNow ≥ MIN_DELIVERY_REWARD`.

1. `decide()` returns `['go_pick_up', p.x, p.y, p.id]`.
2. Intention revision replaces the running `go_explore` (stops it) with `go_pick_up`.
3. `GoPickUp.execute()` issues `subIntention(['go_to', p.x, p.y])`.
4. `go_to` resolves to `AStarMove` (crate-free path) or `PddlMove` (crates blocking).
5. Agent navigates step by step; each move fires a `you` event which triggers re-deliberation.
6. On re-deliberation during transit: `shouldKeepCurrentPickup` (or `#shouldKeepWithMemory`) checks whether the same parcel is still better than any newly visible alternative. If yes, `decide()` returns `null` → navigation continues undisturbed.
7. On arrival: `GoPickUp` calls `emitPickup()`, updates beliefs.
8. `GoPickUp` returns `true` → intention complete → `decide(null)` is called immediately for the next cycle.

**Why hysteresis matters here:** parcels decay every tick. A newly appearing parcel could momentarily score higher due to the agent's movement changing the distance estimate, only to be worse again one tick later. Without `SWITCH_MARGIN`, the agent would abort the current trip, take one step toward the new parcel, abort again, and loop indefinitely (the physical ping-pong visible in logs as alternating `go_pick_up` intentions).

---

### 6.3 Multi-Pickup Decision

**Entry condition:** agent is already carrying ≥ 1 parcel and is not at capacity, and `worthwhileInRange` / merged pool contains another candidate.

**The comparison being made:**

```
B(p)         = detour to p then deliver everything together
A_first(p)   = deliver now, then come back for p as a solo trip

Multi-pickup is chosen when: B(p) − A_first(p) ≥ MULTI_PICKUP_MIN
```

`B(p)` is cheaper than `A_first(p)` when the detour to `p` is short relative to the value `p` adds. On a map where parcels are dense, multi-pickup almost always wins. On a map where the next parcel is far away, the extra decay it inflicts on all carried parcels makes the solo trip better.

The same `shouldKeepCurrentPickup` / `#shouldKeepWithMemory` hysteresis applies: the agent won't abandon a multi-pickup trip mid-route unless the new candidate beats it by `SWITCH_MARGIN`.

**StrategyGreedy / StrategyNotTooGreedy:** candidates must be within `OBSERVATION_DISTANCE` (only what's currently visible).

**StrategyMemory:** candidates include remembered parcels with no distance cap. The decay term in `pickupValue` naturally makes far parcels less attractive — no artificial cap is needed.

---

### 6.4 Delivery

**Entry condition:** carrying > 0 AND no more worthwhile pickups AND stack-size constraint met.

1. `decide()` calls `nearestEscapableDelivery()`: finds the nearest A\*-reachable delivery tile that is in `usableDeliverySet` (one the agent can exit afterwards). Falls back to any reachable delivery if all are one-way.
2. Returns `['go_deliver', x, y]`.
3. `GoDeliver.execute()` navigates to the tile.
4. During navigation, re-deliberation checks for parcels worth picking up (multi-pickup path). If found, `go_deliver` is replaced by `go_pick_up`.
5. On arrival: `emitPutdown()`, belief layer cleared.
6. `GoDeliver` returns `true` → `decide(null)` fires → new cycle begins with `carrying == 0`.

**Why `nearestEscapableDelivery` over `nearestDelivery`?**
On maps with directional arrows (one-way tiles), some delivery tiles are reachable but the agent cannot leave them to pick up more parcels. Delivering to such a tile strands the agent. `usableDeliverySet` is pre-computed at map load; the O(1) lookup at decision time is free.

---

### 6.5 Blocked Delivery / Repositioning

**Entry condition:** `nearestEscapableDelivery()` returns `undefined` — every delivery route is currently blocked (e.g. other agents or crates wall off all paths).

Strategies fall through to `exploreIfIdle(currentIntent)` to reposition. This does not reset `_lastExploreKey` / `_prevExploreKey` — the agent will resume exploration from wherever it ends up. The repositioning move will likely unblock a delivery route within a tick or two (blocking by other agents is transient), at which point the carrying-branch check fires again and delivery resumes.

**StrategyBlind** uses `nearestDelivery` (not the escapable variant) because on a zero-sensing map the safe-region computation is not meaningful.

---

## 7. Value Model Reference

All value functions live in `Strategy.js`.

| Symbol | Formula | Meaning |
|---|---|---|
| `ρ` | `moveTiming.decayPerTile()` | Reward lost per parcel per tile; measured from real move timing, not the optimistic server config value |
| `R` | `Σ reward_i` for all carried parcels | Total reward currently held |
| `n` | `carrying.length` | Number of parcels currently carried |
| `d0` | `pathLen(me, nearestDelivery)` | A\* distance to the nearest delivery tile from current position |
| `d1` | `pathLen(me, p)` | A\* distance to parcel `p` |
| `d2` | `pathLen(p, nearestDelivery(p))` | A\* distance from `p` to the nearest delivery |
| `d3` | `pathLen(D, p)` | A\* distance from the delivery tile back to `p` (for bank-first) |
| `d4` | `pathLen(p, nearestDelivery(p))` | Same as `d2` (from `p` to next delivery after banking) |
| **A** | `R − n·ρ·d0` | Deliver now — value if agent goes straight to delivery |
| **B(p)** | `(R + reward_p) − (n+1)·ρ·(d1 + d2)` | Detour to `p` then deliver — value of the joint trip |
| **A_first(p)** | `(R − n·ρ·d0) + max(0, reward_p − ρ·(d0 + d3 + d4))` | Bank now, then solo-pickup `p` — value of the two-trip alternative |

The multi-pickup condition `B(p) > A_first(p)` is equivalent to: "the saved delivery leg from combining the trips outweighs the extra decay from detouring."

---

## 8. Shared Guards and Helpers

| Helper | Where used | Purpose |
|---|---|---|
| `inSafe(tile)` | All strategies | Filters out tiles from which no delivery is reachable; prevents the agent walking into one-way traps on directional maps |
| `isReachable(tile)` | All strategies | `pathLen(me, tile) < Infinity`; filters out walled-off parcels/spawners so they are never targeted |
| `atCapacity()` | StrategyGreedy, StrategyMemory | Suppresses multi-pickup check when carrying == server capacity; without this the agent tries to pick up a parcel it cannot hold |
| `shouldKeepCurrentPickup` | StrategyGreedy, StrategyNotTooGreedy | Hysteresis: keeps the current `go_pick_up` alive unless beaten by `SWITCH_MARGIN`. Prevents per-tick target switching caused by decay fluctuations |
| `#shouldKeepWithMemory` | StrategyMemory | Extended hysteresis: checks live map first, then memory; a remembered target in progress is protected |
| `pddl.busy` | PddlMove | Blocks intention replacement while executing a PDDL push sequence; ensures the agent completes a crate-push before re-deliberating |
| `_prevExploreKey` | Base `exploreIfIdle` | Sliding window: hard-excludes the spawner before the current one to prevent A→B→A exploration ping-pong |
| `_lastExploreKey` | Base `exploreIfIdle` | The currently committed spawner; used to maintain the sliding window and detect when a new selection is needed |
