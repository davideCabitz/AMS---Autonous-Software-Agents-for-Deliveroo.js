# Directional-tile trap avoidance

## Problem

On maps where arrow / directional tiles (`↑ → ↓ ←`) form a one-way maze, some
zones are **traps**: A\* can route the agent *into* them, but once inside the agent
can never leave. The agent would pick up a parcel, head to the **nearest** delivery,
deliver into a one-way pocket, and then freeze forever — it could no longer reach a
spawner to keep working.

Root cause: directional tiles make the map a **directed graph**, but every decision
only checked reachability `me → target`. `isReachable(to)` and `nearestDelivery()`
confirm you can *get to* a tile — never that you can *get back out*. A\* already
honours arrow constraints (`canEnterDir` in
[utils/astar.js](../myAgent/utils/astar.js)), so entering a pocket is "reachable"
even when leaving is impossible.

## Key idea: sustainability, not returnability

"Avoid zones you can't go back from" is the wrong rule — a one-way loop that passes
both spawners *and* deliveries is perfectly fine even though you never return the way
you came. The correct rule is:

> Only commit to a zone from which the agent can keep running the
> **pick-up → deliver → pick-up** loop.

We compute the maximal region that sustains this loop as a **greatest fixpoint**:

- `usableSpawn` = spawners that can still reach a `usableDeliv`
- `usableDeliv` = deliveries that can still reach a `usableSpawn`

Start with all spawners/deliveries and iterate (each pass only shrinks the sets)
until stable. Then:

- a delivery is a valid **deliver target** iff it is a `usableDeliv`;
- a tile is **safe** for **pickup / exploration** iff it can reach a `usableDeliv`.

If the fixpoint empties (the whole map is a trap, or there are no spawners), we fall
back to "any reachable delivery" so the agent still works instead of freezing —
i.e. it enters a trap **only** when every alternative is also a trap.

## Why it's cheap

The analysis depends **only on the static map** (walls + arrow tiles). Other agents
and crates are deliberately **excluded** so the verdict reflects fixed geometry and
can't flicker as agents move. Therefore the whole thing is computed **once per map**
(in `onMap`) and cached; per-tick the strategies only do O(1) `Set.has(...)` lookups.
Convergence takes 1–3 iterations (a handful of floods, milliseconds, one time).

## Implementation

### 1. `tilesThatReach(goals)` — [myAgent/utils/astar.js](../myAgent/utils/astar.js)
A multi-source **reverse** BFS returning the set of `"x_y"` tiles from which at
least one goal is reachable, honouring arrow constraints on the reversed edges
(structure-only — does not consider agents/crates). For a known-good tile `v`, a
predecessor `u = v − Δ` is added iff `u` is walkable and the *forward* edge `u → v`
is legal (`canEnterDir` on `v`'s arrow). Uses an index-based queue to avoid
`Array.shift` cost.

### 2. Fixpoint at map load — [myAgent/context.js](../myAgent/context.js)
At the end of `onMap`, the greatest fixpoint above is run and its result cached in
two exported sets:

- `usableDeliverySet` — `"x_y"` of deliveries in the sustainable loop.
- `safeTargetSet` — tiles from which a usable delivery is reachable.

Logged as `[map] usable deliveries: X/Y | safe tiles: Z/W`.

### 3. Strategy hooks — [myAgent/strategies/Strategy.js](../myAgent/strategies/Strategy.js)
- `inSafe(tile)` → membership test against `safeTargetSet`.
- `nearestEscapableDelivery(from)` → nearest A\*-reachable delivery preferring those
  in `usableDeliverySet`; falls back to nearest reachable when none is usable.
- `exploreIfIdle` prefers `inSafe` spawners, falling back to all reachable.
- `nearestDelivery` is left unchanged — it stays the nearest-reachable estimate used
  by the scoring (`bankNowValue` / `pickupValue`).

### 4. Decision filters
- [StrategyGreedy.js](../myAgent/strategies/StrategyGreedy.js) and
  [StrategyNotTooGreedy.js](../myAgent/strategies/StrategyNotTooGreedy.js): the
  `worthwhileInRange` (multi-pickup) and empty-handed `best` filters add
  `&& this.inSafe(p)`, so the agent never picks a parcel whose region can't sustain
  the loop; the `go_deliver` target uses `nearestEscapableDelivery()`.
- [StrategyHurry.js](../myAgent/strategies/StrategyHurry.js): the frontier sweep
  prefers `inSafe` candidates before picking the nearest (inherits the pickup/deliver
  changes from `StrategyGreedy`).

## Behaviour summary

| Situation | Before | After |
|-----------|--------|-------|
| Carrying, nearest delivery is a one-way dead-end | delivers in, freezes | routes to nearest **usable** delivery; keeps working |
| A worthwhile parcel sits in a trap pocket | picks it, gets stuck | parcel filtered out (`inSafe`) |
| Empty, exploring | nearest reachable spawner | nearest **safe** spawner |
| Entire map is a trap | n/a | all-traps fallback: behaves as nearest-reachable |
| Normal map (no arrows) | unchanged | unchanged (all tiles usable/safe) |

## Scope / non-goals

- Cost math (`pickupValue` / `bankNowValue` / `decayRate`), capacity cap, hysteresis,
  and the movement pacing fix are untouched.
- `findRoute` / `navigateTo` agent-as-obstacle behaviour is untouched; the loop
  analysis is a separate, structure-only, load-time computation.
