# BDI Core

The intention-revision engine is the heart of the agent. It runs a continuous loop that drains an intention queue, validates intentions, and executes them via the plan library.

---

## Class hierarchy

```
IntentionRevision          base queue drain loop
  └─ IntentionRevisionReplace   active class — replace-on-better + LLM bridge
       uses → IntentionDeliberation   per-intention plan resolution
                uses → planLibrary    ordered plan registry
```

`IntentionRevisionRevise` exists on disk as a historical dead-end and is never instantiated.

---

## IntentionRevision — base loop

**File:** [myAgent/intentions/IntentionRevision.js](myAgent/intentions/IntentionRevision.js)

`loop()` runs forever:

1. Yields via `setImmediate` so async socket callbacks can fire between ticks.
2. Shifts and discards any stopped intentions from the front of the queue.
3. Validates the head intention with `#isValid()` — currently only `go_pick_up` is checked: the parcel must still exist and be unclaimed (falls back to `parcels.getRemembered(id)` when memory is enabled). A stale intention is cancelled (its `completion` promise is rejected) so `commandAndAwait` awaiters don't hang.
4. Calls `intention.achieve()` and awaits it. Failures with tag `stopped` are silenced; all other failures are logged.
5. Shifts the completed intention and repeats.

---

## IntentionRevisionReplace — replace-on-better

**File:** [myAgent/intentions/IntentionRevisionReplace.js](myAgent/intentions/IntentionRevisionReplace.js)

Extends the base loop with three additional capabilities.

### push(predicate)

Called by `optionsGeneration` (the strategy tick) on every sensing event.

- No-ops if the new predicate is identical to the current tail intention.
- No-ops if `pddl.busy` — a PDDL macro-plan is executing and cannot be interrupted mid-step.
- Otherwise creates a new `IntentionDeliberation`, appends it to the queue, and calls `last.stop()` to cancel the currently running intention.

### commandAndAwait(predicate)

The LLM command bridge. Called by every action tool in `commandTools.js` (e.g. `go_to`, `go_pickup`, `deliver`).

- Rejects immediately if `pddl.busy`.
- Otherwise pushes the predicate, stops the current intention, and returns `intention.completion` — a promise that resolves when the plan finishes or rejects with `['stopped', ...]`, `['no path to', ...]`, etc.
- The ReAct loop uses the resolved/rejected value as the observation text fed back to the model.

### haltCurrent()

Stops the current intention without pushing a replacement. Returns `false` (and does nothing) if `pddl.busy`. Called by `abortCurrent()` in `llm/index.js` and by the `STOP` (red-light) handler.

---

## IntentionDeliberation — plan resolution

**File:** [myAgent/intentions/IntentionDeliberation.js](myAgent/intentions/IntentionDeliberation.js)

Wraps a single predicate and a `completion` promise (resolve/reject exposed internally).

### achieve()

Iterates `planLibrary` in order. For each plan class:
- If `this.stopped`, rejects with `['stopped', ...predicate]`.
- Calls `PlanClass.isApplicableTo(...predicate)`.
- If applicable, instantiates the plan and calls `execute(...predicate)`.
- On success: resolves `completion` and returns the result.
- On failure: records the error. A `stopped` tag sets `wasStopped = true`; any other error is stored as `firstError`.

If no plan succeeds, rejects with:
- `['stopped', ...predicate]` if any plan was stopped.
- `firstError` if a real plan failure was recorded (e.g. `['no path to', x, y]`).
- `['no plan for', ...predicate]` as last resort.

Relaying the first real error (not masking as `'no plan for'`) is load-bearing: the LLM command path turns these tags into observations the model can actually act on.

### stop() / cancel()

`stop()` sets the stopped flag and propagates to the currently running plan instance. `cancel()` additionally rejects `completion` — used when the base loop drops a stale intention before `achieve()` has been called, so `commandAndAwait` awaiters don't block forever.

---

## Plan library

**File:** [myAgent/plans/planLibrary.js](myAgent/plans/planLibrary.js)

```js
export const planLibrary = [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove];
```

Resolution order is significant: `PddlMove` is checked before `AStarMove` for `go_to` predicates. `PddlMove.isApplicableTo` only fires when the map has crates AND no crate-free A* route exists to the target — so the PDDL solver is never invoked on a normal map.

| Plan | Predicate | What it does |
|---|---|---|
| `GoPickUp` | `go_pick_up x y id` | `navigateTo(x,y)` then `emitPickup`; updates parcel beliefs |
| `GoDeliver` | `go_deliver x y` | `navigateTo(x,y)` then `emitPutdown`; clears carried beliefs |
| `GoExplore` | `go_explore x y` | `navigateTo(x,y)` only (no pickup/putdown) |
| `PddlMove` | `go_to x y` | PDDL online solver for crate-blocked paths (see [PDDL.md](PDDL.md)) |
| `AStarMove` | `go_to x y` | `navigateTo(x,y)` — the default for all non-crate-blocked navigation |

---

## Control gates

Two singleton flags in `context.js` guard intention replacement:

- **`pddl.busy`** — set by `PddlMove` once a plan is found and executing. Blocks `push` and `commandAndAwait` until the macro-plan completes, ensuring the full crate-push sequence runs atomically.
- **`directive.active`** — set by the first command tool in a ReAct loop iteration. Blocks `optionsGeneration` (the autonomous strategy tick) so the LLM's pushed intentions are not clobbered by the strategy's own decisions. Released in `runDirective`'s `finally` block.

These two flags are independent: `pddl.busy` blocks the BDI replacement path; `directive.active` blocks the autonomous generation path. Both can be true simultaneously (LLM issued a `go_to` that requires PDDL).
