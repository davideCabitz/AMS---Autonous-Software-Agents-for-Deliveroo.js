# Parcel Scoring — "Is it worth picking up?" (Design)

Goal: **maximize total banked reward**. Replace the current split-brain scoring
(filter with one formula, rank with another) with a **single value** that decides
both *whether* a pickup is worth it and *which* parcel is best.

## 1. Why the current code is wrong

In [Strategy.js](../myAgent/strategies/Strategy.js) two different metrics are used:

- **Ranking** — `scoreOf(p) = reward / dist(me, p)`
  ([Strategy.js:38-40](../myAgent/strategies/Strategy.js#L38-L40)). Ignores decay
  and ignores the delivery leg entirely.
- **Threshold** — `estimatedRewardAtDelivery(p) = reward − ceil((toParcel + toDelivery)/DECAY_STEPS_PER_REWARD)`
  ([Strategy.js:43-48](../myAgent/strategies/Strategy.js#L43-L48)). Decay-aware,
  full round trip.

The strategies filter by the second, then **sort by the first**
([StrategyGreedy.js:38-45](../myAgent/strategies/StrategyGreedy.js#L38-L45),
[StrategyNotTooGreedy.js:65-72](../myAgent/strategies/StrategyNotTooGreedy.js#L65-L72)).
So the parcel ranked "best" is frequently not the one with the highest actual
payoff — the two metrics disagree. The fix is to rank and filter on the **same**
decay-aware net value.

## 2. Belief facts that constrain the math

- `parcel.reward` is the **last value the server sent**
  ([Parcels.js](../myAgent/beliefs/Parcels.js)); no local decay extrapolation.
  Treated as the best current estimate.
- `DECAY_STEPS_PER_REWARD = decayMs / MOVEMENT_DURATION`
  ([context.js:44-45](../myAgent/context.js#L44-L45)) = move-steps per 1 reward
  point lost. `decaying_event: 'infinite'` → `Infinity` → no decay.

## 3. Notation

| symbol | meaning |
|--------|---------|
| ρ | decay rate = `1 / DECAY_STEPS_PER_REWARD` — reward lost **per parcel, per step** (ρ = 0 if no decay) |
| `n` | number of parcels currently carried |
| `R` | sum of current rewards of carried parcels |
| `dist(a,b)` | travel cost in steps between a and b |
| `D_x` | nearest delivery tile to point `x` |
| `p` | a candidate free parcel, with `reward_p` |

## 4. The two values to compare (the benchmark)

**(A) Bank now** — keep the current load, go straight to delivery:
```
A = R − n · ρ · dist(me, D_me)
```
The `n · ρ · dist` term is the "loss = n·m": all `n` carried parcels decay over
the trip.

**(B) Detour to pick up `p`, then deliver everything:**
```
d1 = dist(me, p)        // leg 1: go to the parcel
d2 = dist(p, D_p)       // leg 2: parcel → its nearest delivery
B(p) = (R + reward_p) − (n+1) · ρ · (d1 + d2)
```

Expanding `(n+1)·ρ·(d1+d2)` accounts for every loss:
- `n·ρ·d1` — carried parcels decaying while fetching `p` (the `n·m` term)
- `ρ·d1` — `p` decaying on the ground before pickup
- `(n+1)·ρ·d2` — all `n+1` parcels decaying on the way to delivery

## 5. Decision rule

```
pick up p   ⇔   B(p) > A   AND   B(p) > 0
choose       argmax_p  B(p)
```

`A` is constant across candidate parcels, so `argmax B(p) = argmax (B(p) − A)`.
Marginal gain:
```
ΔB(p) = reward_p − (n+1)·ρ·(d1 + d2) + n·ρ·dist(me, D_me)
```

**One value (`B(p)`) drives both the worth-it test and the ranking**, so they can
never disagree — this is the core correction.

## 6. Generalization (sanity checks)

- **Empty-handed** (`n=0, R=0`): `A=0`, `B(p) = reward_p − ρ·(d1+d2)` — exactly
  today's `estimatedRewardAtDelivery`, now derived rather than ad-hoc.
- **Multi-pickup while carrying**: `ΔB(p) > 0` = "is the new reward worth the extra
  decay it inflicts on the whole load + itself." Larger `n` ⇒ harder to justify a
  detour. Desired behavior.
- **Deliver vs. detour**: handled directly by `B(p) > A`.

## 7. Optional clamping (more accurate)

A parcel's delivered reward can't go below 0. The exact forms:
```
A    = Σ_{i∈carried} max(0, reward_i − ρ·dist(me, D_me))
B(p) = Σ_{i∈carried} max(0, reward_i − ρ·(d1+d2)) + max(0, reward_p − ρ·(d1+d2))
```
Start with the linear (non-clamped) form for simplicity; add per-parcel clamping
if parcels are seen expiring mid-trip.

## 8. Open decisions

1. **Distance metric.** `dist()` is **Manhattan** today
   ([distance.js](../myAgent/utils/distance.js)) — ignores walls/crates/arrow
   tiles, so estimates are optimistic.
   - (a) Keep Manhattan — free, less accurate.
   - (b) Real A* path length (`findRoute().length`) — accurate, ~2 A* calls per
     candidate per tick.
   - (c) **Hybrid (recommended)** — Manhattan to shortlist top-K, A* only on those.
2. **Threshold.** Replace `MIN_DELIVERY_REWARD = 5` with `B(p) > 0` plus a small
   margin (e.g. `> 1`) to avoid dithering over near-zero gains. *(recommended)*
3. **Carry capacity.** Is there a max parcels-carried cap in config? If so, add a
   guard so a full agent never scores a pickup. *(needs confirmation)*
4. **Greedy vs. chained.** Keep **greedy** (re-decide each tick, one best parcel)
   to match current architecture; full multi-stop ordering is TSP-with-decay
   (NP-hard). *(recommended)*

## 9. Implementation sketch (after decisions)

- `Strategy.js`:
  - add `decayRate()` → `1 / DECAY_STEPS_PER_REWARD` (0 when `Infinity`).
  - add `bankNowValue()` → `A` from current carried load.
  - add `pickupValue(parcel)` → `B(p)`.
  - remove/repurpose `scoreOf`; fold `estimatedRewardAtDelivery` into the `n=0`
    case of `pickupValue`.
- `StrategyGreedy.js` / `StrategyNotTooGreedy.js`: filter by `B(p) > A && B(p) > margin`,
  sort by `B(p)`.
- Check `StrategyBlind.js` / `StrategySimple.js` for the old metrics and align.

## 10. Recommendations summary

1(c) hybrid distance · 2 margin `> 1` · 3 confirm capacity · 4 greedy.
