# Parcel Scoring — "Is it worth picking up?" (Design + Implementation Status)

Goal: **maximize total banked reward**. Replace the original split-brain scoring
(filter with one formula, rank with another) with a **single value** that decides
both *whether* a pickup is worth it and *which* parcel is best.

---

## 1. Original problem (resolved)

The old code in `Strategy.js` used two incompatible metrics:

- **Ranking** — `scoreOf(p) = reward / dist(me, p)` — ignores decay and the delivery leg.
- **Threshold** — `estimatedRewardAtDelivery(p)` — decay-aware, full round trip.

Strategies filtered by the second, then **sorted by the first**, so the parcel
ranked "best" was frequently not the one with the highest payoff.

**✅ Fixed**: both filtering and ranking now use the same `pickupValue(p) = B(p)`.

---

## 2. Notation

| symbol | meaning |
|--------|---------|
| ρ | `decayRate()` — reward lost **per parcel, per step** (0 if no decay) |
| `n` | parcels currently carried |
| `R` | sum of current rewards of carried parcels |
| `dist(a,b)` | **A\* path length** between a and b (`pathLen` via `findRoute`) |
| `D_x` | nearest delivery tile to point `x` |
| `p` | a candidate free parcel, reward `reward_p` |

---

## 3. Core value functions (all implemented in `Strategy.js`)

### A — Bank now
Deliver the current load immediately:
```
A = R − n · ρ · dist(me, D_me)
```
Implemented as `bankNowValue()`.

### B(p) — Multi-pickup
Detour to pick up `p`, then deliver everything together:
```
d1 = dist(me, p)
d2 = dist(p, D_p)
B(p) = (R + reward_p) − (n+1) · ρ · (d1 + d2)
```
Implemented as `pickupValue(parcel)`.

Both use **real A\* path lengths** (open decision 1(b) chosen — accurate over the
Manhattan/hybrid alternatives). `decayRate()` returns the measured wall-clock decay
per tile from `moveTiming`.

### A_first(p) — Bank-first *(added 2026-06-08)*
The correct multi-pickup baseline is not just A but the full alternative trip:
deliver now → travel from delivery D to p → deliver p alone.

```
d0 = dist(me, D_me)
d3 = dist(D_me, p)        // cost of reaching p *after* banking
d4 = dist(p, D_p)         // solo delivery of p
A_first(p) = (R − n·ρ·d0) + max(0, reward_p − ρ·(d0 + d3 + d4))
```
Implemented as `bankFirstValue(parcel)` in `Strategy.js`.

**Why this matters**: the old comparison `B(p) > A` asked "is multi-pickup better
than delivering and *not* picking up p at all?" — which unfairly penalised banking.
`B(p) > A_first(p)` asks the correct question: "is the combined detour trip better
than banking now and picking up p cleanly afterwards?"

Example (d0=2, d1=24, d2=25, reward_p=35, n=1, R=10, ρ=0.118):
- B(p) = 33.4 — multi-pickup score
- A_first(p) ≈ 40.4 — bank-first score
- `B − A_first` = −7.0 → **bank first** (old code incorrectly triggered multi-pickup)

Example (d0=20, d1=3, d2=18, reward_p=35, n=1, R=10, ρ=0.118):
- B(p) = 40.0
- A_first(p) ≈ 35.4
- `B − A_first` = +4.6 → **multi-pickup** (close parcel genuinely worth the detour)

---

## 4. Decision rule

```
pick up p    ⇔   B(p) − A_first(p) ≥ MIN_DELIVERY_REWARD   AND   B(p) > 0
choose            argmax_p  B(p)
```

`A_first` is the filter gate; `B(p)` is the ranking key. Both use the same A\*
distances so they can never disagree.

`MIN_DELIVERY_REWARD = 5` is kept as hysteresis (open decision 2) to suppress
dithering over near-zero gains. An additional `SWITCH_MARGIN = 5` is used in
`shouldKeepCurrentPickup` to prevent flip-flopping between two pickup targets
mid-trip.

---

## 5. Sanity checks

- **Empty-handed** (`n=0, R=0`): `bankFirstValue` returns `−∞` (guard clause), so
  the filter reverts to `B(p) ≥ MIN_DELIVERY_REWARD` — the correct empty-hand
  threshold. `A_first` is undefined when not carrying.
- **Multi-pickup while carrying**: larger `n` → larger `(n+1)·ρ·(d1+d2)` in B(p)
  → harder to justify a detour. Desired behaviour.
- **Parcel far, delivery close**: d1 large → B(p) small, A_first large →
  `B − A_first` negative → bank first. ✓
- **Parcel close, delivery far**: d1 small → B(p) ≈ A_first or B > A_first →
  multi-pickup when genuinely better. ✓

---

## 6. Where the filter is applied

| Location | Filter used |
|----------|-------------|
| `StrategyGreedy.decide()` — `worthwhileInRange` | `B(p) − A_first(p) ≥ MIN_DELIVERY_REWARD` |
| `StrategyNotTooGreedy.decide()` — `worthwhileInRange` | same |
| `StrategyGreedy.decide()` — global `best` (empty-hand) | `B(p) − 0 ≥ MIN_DELIVERY_REWARD` (A_first returns −∞, guard kicks in) |
| `StrategyBlind.decide()` | uses `pickupGain()` (unchanged — blind strategy has no delivery-zone concept) |

`StrategyHurry` inherits `StrategyGreedy.decide()` and receives the fix automatically.

---

## 7. Open decisions — resolved

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Distance metric | **Full A\* path length** (`findRoute().length`) for all scoring |
| 2 | Threshold | **`MIN_DELIVERY_REWARD = 5`** kept as hysteresis margin |
| 3 | Carry capacity | **`atCapacity()` guard** — no pickup scored if already at server capacity |
| 4 | Greedy vs. chained | **Greedy** — re-decide each tick, pick best single parcel |

---

## 8. Performance note

`bankFirstValue(parcel)` adds one extra `findRoute` call per in-range parcel candidate
(`dist(D_me, p)`). This runs only when `carrying.length > 0` and the parcel has
already passed the `isReachable` filter. Typical count ≤ 3 parcels in sensing range.
