# Directional Tiles — Implementation Plan

Add support for one-way **arrow tiles** (`↑ → ↓ ←`) to the agent so that
pathfinding (A*) and PDDL planning never attempt an illegal entry, which the
backend punishes with a wasted tick + `-PENALTY` and a `move() → false`.

## 1. The rule (recap)

Arrow tiles are encoded as the literal arrow characters in `tile.type`. The grid
is **y-up** (north = `+y`), which already matches this project's A* `DIRS`
([astar.js:3-8](../myAgent/utils/astar.js#L3-L8) — `up` is `dy:+1`, `down` is `dy:-1`),
so **no sign-flipping is needed**.

| `type` | arrow vector `{dx,dy}` | blocks entry from |
|--------|------------------------|-------------------|
| `'↑'`  | `{0, +1}`              | moving down (`−y`) into it |
| `'→'`  | `{+1, 0}`             | moving left (`−x`) into it |
| `'↓'`  | `{0, −1}`             | moving up (`+y`) into it |
| `'←'`  | `{-1, 0}`            | moving right (`+x`) into it |

Entry is blocked **iff** the movement vector equals the *negated* arrow vector.
Entering along the arrow or perpendicular to it is allowed. **Exit is never
restricted** — only model the entry check. Do **not** treat arrows as strict
single-lane corridors (that discards valid paths).

## 2. Current state — what ignores direction today

- `walkableTiles` holds full tile objects incl. `x, y, type`
  ([context.js:72-77](../myAgent/context.js#L72-L77)). Arrow tiles already pass
  the `walkable !== false` filter, so they *are* in the set — but with no
  direction info attached anywhere downstream.
- **A*** ([astar.js](../myAgent/utils/astar.js)) collapses the map into a
  `Set<"x_y">` of walkable keys (`getWalkable()`), discarding `type`. Neighbour
  expansion in `astar()` (line 58-71) and `navigateTo()` (line 110-127) only
  checks set membership → it will happily route the agent into an arrow tile from
  the forbidden side.
- **PDDL beliefset** ([context.js:88-96](../myAgent/context.js#L88-L96)) declares
  `right/left/up/down` adjacency edges purely from walkability, symmetrically.
  The solver can therefore plan an illegal step.
- **PDDL domain** ([domain-deliveroo.pddl](../domain-deliveroo.pddl)) gates moves
  on those edge predicates — so if we simply *omit* the illegal edges at
  generation time, the domain needs **no change** for plain moves.

## 3. Design — single source of truth: `canEnter`

Add one shared helper module so A*, the PDDL edge generator, and any defensive
runtime check all use identical logic. Put it in
[myAgent/utils/directions.js](../myAgent/utils/directions.js) (new file):

```js
// y is UP (north = +y), matching the server and this project's astar DIRS.
export const ARROW_VECTORS = {
    '↑': { dx: 0,  dy: 1 },
    '→': { dx: 1,  dy: 0 },
    '↓': { dx: 0,  dy: -1 },
    '←': { dx: -1, dy: 0 },
};

export const isDirectional = (type) =>
    Object.prototype.hasOwnProperty.call(ARROW_VECTORS, type);

/**
 * Can an agent stepping from (fromX,fromY) enter a directional tile of `type`
 * at (toX,toY)? Blocked iff moving exactly opposite the arrow. Non-directional
 * (or undefined) types are unrestricted here — walkability is checked elsewhere.
 */
export function canEnterDir(type, fromX, fromY, toX, toY) {
    if (!isDirectional(type)) return true;
    const a = ARROW_VECTORS[type];
    return !((toX - fromX) === -a.dx && (toY - fromY) === -a.dy);
}
```

## 4. File-by-file changes

> **Scope decision:** directional handling lives in the **A* / BDI loop only**.
> The PDDL beliefset and domain are left untouched (see §4.4). `directionalTiles`
> is exposed purely so A* can consult it.

### 4.1 `myAgent/context.js`
1. Detect arrow tiles in `onMap` and expose a lookup keyed `"x_y" → type`:
   ```js
   export const directionalTiles = new Map(); // "x_y" -> '↑'|'→'|'↓'|'←'
   ```
   Populate it inside `onMap` (after `walkableTiles` is built), recognising the
   four arrow chars via `isDirectional`. Clear it (`.clear()`) on every map event
   like the other collections.
2. Keep arrow tiles in `walkableTiles` (already the case) — they are normal
   floor for *exit* and for entry from legal sides.

### 4.2 `myAgent/utils/astar.js`
The core change: A* must know tile `type`, not just a membership Set.
1. Build a `"x_y" → type` map alongside `getWalkable()` (cache & invalidate the
   same way, on `walkableTiles.length` change). Reuse `directionalTiles` from
   context for O(1) lookup instead of re-deriving.
2. In `astar()` neighbour loop (line 58-71) and the inline expansion used by
   `navigateTo`, add after the `walkable.has(nk)` check:
   ```js
   if (!canEnterDir(typeAt(nx, ny), cur.x, cur.y, nx, ny)) continue;
   ```
3. `findRoute()` and `navigateTo()` need no signature change — they call the same
   `astar()`. Verify the crate-exclusion Set filtering still composes (it filters
   keys out of `walkable`; direction check is independent and additive).

### 4.3 `myAgent/plans/PddlMove.js`
- `isApplicableTo` calls `findRoute` — now direction-aware automatically, so the
  "crate-free path exists?" decision correctly accounts for arrows. No change.
- `#runPlan` executes solver steps as moves. Because illegal edges are no longer
  emitted, plans are legal by construction. **Add a defensive guard**: if
  `emitMove` returns `false` on a step we believed legal, treat as blocked /
  replan (existing `if (!r) return true` already does this — good).
- Crate pushing vs. arrows: the shared edge predicates also gate `pushX` actions.
  Pushing a **crate** into an arrow tile is a separate physics question from the
  *agent's* entry restriction. **Decision needed** (see Open Questions). Safest
  default for now: arrow tiles and crate-zone tiles (`5`/`5!`) rarely overlap, so
  omitting agent-illegal edges is acceptable; document the assumption.

### 4.4 PDDL (`context.js` beliefset + `domain-deliveroo.pddl`)
**Left untouched by design.** Directional restriction is enforced only in A* /
the BDI loop. PddlMove is engaged solely when a *crate* blocks the route; in that
case the agent reaches the crate and pushes it, and the surrounding navigation
(via `findRoute`/`navigateTo`) already respects arrows. Re-evaluate only if a map
is found where an arrow lies on a forced crate-push corridor.

## 5. Order of work
1. Add `myAgent/utils/directions.js` (`ARROW_VECTORS`, `isDirectional`, `canEnterDir`).
2. `context.js`: populate `directionalTiles`; filter PDDL edges.
3. `astar.js`: thread `type` into neighbour expansion; apply `canEnterDir`.
4. Manual/unit checks (section 6).
5. Update `docs/` (CRATE_SYSTEM / Context) if the new export is referenced there.

## 6. Testing & verification
- **Unit (pure):** table-test `canEnterDir` for all 4 arrows × 4 approach dirs
  (1 blocked, 3 allowed each) + non-directional passthrough.
- **A* path legality:** build a tiny synthetic map with a `←` tile and assert the
  returned path never enters it from the right; assert a legal detour is found
  rather than `null` (guards against over-constraining).
- **Live run:** start the SDK server on a map containing arrows
  (`npm start` / per project run skill), watch logs — agent should never log a
  `move → false` against an arrow tile, and `[nav] blocked` loops shouldn't form
  around arrows. Confirm penalty isn't accruing.
- **PDDL:** on a crate map with an arrow on-route, confirm the emitted problem
  lacks the illegal edge and the solver still returns a valid plan.

## 7. Open questions / decisions
- **Crate push through arrows:** does the backend apply the entry restriction to
  *pushed crates*, or only to agent self-moves? The analysis only covers agent
  moves. If crates are also restricted, the `pushX` edges need the same filter as
  walk edges (they already share the predicate, so filtering covers both — which
  is conservative/safe). Decide whether that over-restricts legal crate pushes.
- **Map storage sign:** confirmed not an issue here (coordinate-keyed, y-up).
  Re-verify if tile ingestion ever changes to row-indexed.
- **Performance:** `typeAt` should be O(1) (Map). Avoid rebuilding per A* node.
