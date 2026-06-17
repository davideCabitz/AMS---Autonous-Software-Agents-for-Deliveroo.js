# Cost Function

All parcel-value decisions flow through a single family of functions defined in [myAgent/strategies/Strategy.js](myAgent/strategies/Strategy.js). Every strategy inherits them. The LLM uses a subset via the `path_cost` tool (see [llm-layer.md](llm-layer.md)).

---

## Decay rate

```js
decayRate()  →  moveTiming.decayPerTile()
             =  moveTiming.msPerTile / DECAY_INTERVAL_MS
```

`moveTiming.msPerTile` is an EMA-tracked real ms per tile (see [beliefs-and-context.md](beliefs-and-context.md)). `DECAY_INTERVAL_MS` is set from server config (how often the server drops 1 reward point). When `DECAY_INTERVAL_MS` is `Infinity` (no-decay maps), `decayPerTile()` returns 0, making all distance terms vanish.

Notation in the formulas below: **ρ** = `decayRate()`, **d** = tile distance (A* path length).

---

## Core metric — pickupValue

```
pickupValue(p)  =  scale · (R + p.reward) · contestFactor(p, d₁)
                   − (n + 1) · ρ · (d₁ + d₂)
```

where:
- **R** = total reward of parcels currently carried
- **n** = number of parcels currently carried
- **d₁** = `pathLen(me, p)` — tiles to the new parcel
- **d₂** = `pathLen(p, nearestDelivery(p))` — tiles from the parcel to the best delivery
- **scale** = `deliveryScale(nearestDelivery(p))` — multiplier from an active delivery-bonus mission (1 by default)
- **contestFactor** = win-probability discount against competing agents (see below)

**Interpretation:** the expected net banked reward of adding this parcel to the current load and delivering the whole bundle. Both the existing load *R* and the new parcel decay over the full round-trip *d₁ + d₂*, all *(n+1)* parcels together. This makes picking up a parcel with a short trip always better than one with a long trip, all else equal.

**Where used:**
- `StrategyGreedy.decide()` — ranks all free parcels, picks the best.
- `StrategyMemory.decide()` / `StrategyLookAhead.decide()` — primary ranking metric within `_eligiblePool()`.
- `shouldKeepCurrentPickup()` — compares candidate vs. current target to apply `SWITCH_MARGIN` hysteresis.
- `pickupDebug()` — debug string for logging.

---

## bankNowValue

```
bankNowValue()  =  scale · R − n · ρ · d₀
```

where **d₀** = `pathLen(me, nearestDelivery())`, **scale** = delivery tile's multiplier.

The value of delivering the current load immediately without picking up anything else. Returns 0 when not carrying.

**Where used:**
- `pickupGain(p)` = `pickupValue(p) − bankNowValue()` — whether adding a parcel beats banking now.
- `bonusDiversion()` — compares one-shot bonus value against `bankNowValue`.
- `StrategyGreedy.decide()` — gates multi-pickup: only add a second parcel when `pickupGain` exceeds `MULTI_PICKUP_MIN = 0`.

---

## bankFirstValue

```
bankFirstValue(p) =  (scale₀ · R − n · ρ · d₀)              ← bank current load first
                   + max(0, scale₂ · p.reward − ρ · (d₀ + d₃ + d₄))  ← then pick up p solo
```

where **d₀** = me → current delivery, **d₃** = that delivery → p, **d₄** = p → best delivery for p. Each leg uses its own tile's delivery multiplier.

The value of delivering first, then picking up parcel `p` solo from the delivery point.

**Where used:**
- `StrategyLookAhead.decide()` — two-parcel look-ahead: when the agent is already carrying, compare `pickupValue(p)` (add now) against `bankFirstValue(p)` (bank first, then pick up). The higher value wins. This is the "look-ahead" the strategy is named for.

---

## pickupGain

```
pickupGain(p) = pickupValue(p) − bankNowValue()
```

Net gain of picking up `p` vs. delivering the current load now. Positive means picking up is worth the detour.

**Where used:** `StrategyGreedy.decide()` (multi-pickup gate) and `StrategyMemory.decide()` (same gate, inherited).

---

## shouldKeepCurrentPickup and SWITCH_MARGIN

When the strategy already has an active `go_pick_up` intention, it checks whether to switch to a better target. Switching has a hysteresis margin of `SWITCH_MARGIN = 5` reward points to prevent the agent from flipping between two near-equal parcels on consecutive ticks (decay/distance shifts move them in and out of the worthwhile set each tick).

```js
keep current  ←  candidate.value − pickupValue(currentTarget) < SWITCH_MARGIN
```

`StrategyLookAhead` overrides `_allowSwitchWithoutMargin(curId, candidate)` to waive the margin when re-ordering the two stops of a single chained trip — in that case the switch does not change the total trip cost.

---

## contestFactor

```
delta = otherAgentDistTo(p) − pathLen(me, p)    // > 0 means we're closer

if delta ≥ 0  →  factor = 1            (we're winning or tied → no discount)
if delta < 0  →  factor = CONTEST_FLOOR + (1 − CONTEST_FLOOR) · max(0, 1 + delta/CONTEST_K)
```

Constants: `CONTEST_K = 3` (tiles of lead for 100% win), `CONTEST_FLOOR = 0.15` (minimum multiplier — a heavily contested parcel is deprioritised, never inverted), `CONTEST_DEADBAND = 1` (ties within 1 tile count as ties, preventing 1-tile jitter from moving the score).

A competitor not moving toward the parcel (`isAgentMovingToward` returns false) gets a `+CONTEST_K/2` delta bonus — softening the penalty for a non-racing agent.

**Where used:** inside `pickupValue`. Consumed transitively by every strategy that calls `pickupValue`.

---

## bonusGoalValue

```
bonusGoalValue()  =  oneShotBonus.points  −  n · ρ · pathLen(me, bonus)
```

Net value of travelling to a one-shot bonus tile (a `GoTo` mission with a point reward). Competing against `bankNowValue()` in `bonusDiversion()`.

**Where used:** `bonusDiversion()` in `Strategy`, called from `optionsGeneration` in `coordinator_agent.js` before every `strategy.decide()`. If the bonus beats `bankNowValue + SWITCH_MARGIN`, the agent diverts to it.

---

## deliveryScale / deliveryMultiplierAt

```
deliveryScale(tile) = missionConstraints.deliveryMultipliers?.get("x_y") ?? 1
```

Multiplier from a delivery-bonus mission (e.g. "deliver in (x,y) for 5× pts"). With no mission active, every tile is 1× and all formulas collapse to historical behaviour. Applied to the banked reward in `pickupValue`, `bankNowValue`, `bankFirstValue`, and `_pickDelivery` (routing deliveries to the bonus tile).

---

## pathLen — the cost of a route

```js
pathLen(from, to)
```

Returns A* path length in tiles (Infinity if unreachable). When crates are present it tries a crate-free path first; if none exists it falls back to `pushAwareCost` as a cost estimate (see [PDDL.md](PDDL.md)). Mission `avoidTiles` are always excluded from the walkable set. All value functions above call `pathLen` to compute their distance terms.

---

## Summary — who calls what

| Function | Called by |
|---|---|
| `pickupValue` | All strategy `decide()` methods, `shouldKeepCurrentPickup` |
| `bankNowValue` | `pickupGain`, `bonusDiversion`, `StrategyGreedy.decide` |
| `bankFirstValue` | `StrategyLookAhead.decide` |
| `pickupGain` | `StrategyGreedy.decide`, `StrategyMemory.decide` |
| `contestFactor` | `pickupValue` (transitively, all strategies) |
| `bonusGoalValue` | `bonusDiversion` → `optionsGeneration` (every tick, before `decide`) |
| `deliveryScale` | `pickupValue`, `bankNowValue`, `bankFirstValue`, `_pickDelivery` |
| `pathLen` | All of the above, `Strategy.exploreIfIdle`, `isReachable` |
| `path_cost` tool (LLM) | `commandTools.js` wraps `pathLen` for the LLM — see [llm-layer.md](llm-layer.md) |
