# Intentions Folder — Complete Explanation

## Architecture Overview

The intentions folder implements the **Intention** layer of a BDI (Belief-Desire-Intention) agent. In BDI:

- **Beliefs** = what the agent knows about the world (`context.js`, beliefs folder)
- **Desires** = goals the agent _wants_ to achieve (e.g. "pick up parcel X")
- **Intentions** = goals the agent is _currently committed to_, with a concrete plan attached

A **predicate** is the representation of a desire/intention as an array of strings, e.g. `['go_pick_up', x, y, parcelId]`. It is both the goal name and its arguments bundled together.

---

## IntentionDeliberation.js

This is the **execution engine for a single intention**. It takes a predicate, finds a matching plan from the library, and runs it.

### Private Fields

| Field | Type | Meaning |
|---|---|---|
| `#stopped` | `boolean` | Set to `true` when someone calls `stop()` from outside. Acts as a cancellation flag. |
| `#started` | `boolean` | Set to `true` on first `achieve()` call. Guards against double-execution. |
| `#current_plan` | `Plan instance \| null` | Reference to the plan currently being executed. Kept so it can be stopped mid-execution. |
| `#predicate` | `Array<string>` | The goal this intention is trying to achieve, e.g. `['go_pick_up', 3, 5, 'abc123']`. |
| `#parent` | `IntentionRevision` | The agent/revision object that owns this intention. Used for delegation of logging. |

### Constructor

```js
constructor(parent, predicate)
```

- `parent`: the owning `IntentionRevision` instance (provides context like logging)
- `predicate`: the goal array this intention should pursue

### Getters

- `predicate` — exposes `#predicate` (read-only). Used externally for deduplication and validity checks.
- `stopped` — exposes `#stopped` (read-only). The revision loop polls this to skip dead intentions.

### `stop()`

Sets `#stopped = true` and immediately propagates the stop to `#current_plan` (using optional chaining `?.`, so safe if no plan is running yet). This is the cancellation mechanism: when the revision policy decides this intention is no longer relevant, it calls `stop()`, which bubbles down into whatever plan step is executing.

### `log(...args)`

Delegates to `#parent.log()` with a tab indent. The `?.` chains protect against `parent` being null. This means all log output from a plan execution is indented under the parent agent's log lines.

### `achieve()` — The Core Method

```js
async achieve()
```

1. **Guards double-start**: if `#started` is already `true`, returns `false` immediately. An intention can only be executed once.
2. Sets `#started = true`.
3. **Iterates `planLibrary`** (imported from `plans/planLibrary.js`) — an ordered array of plan classes: `[GoPickUp, GoDeliver, GoExplore, AStarMove]`.
4. For each `PlanClass`:
   - Checks `#stopped` first — if stopped, throws `['stopped', ...predicate]` to propagate cancellation.
   - Calls `PlanClass.isApplicableTo(...this.#predicate)` — a static method on every plan class that returns `true` if that plan can handle this predicate type.
   - If applicable, instantiates the plan: `new PlanClass(this.#parent)` and saves it in `#current_plan`.
   - Calls `await this.#current_plan.execute(...this.#predicate)` and returns the result if it succeeds.
   - If `execute()` throws, logs the failure and **continues to the next plan in the library** (plan fallback).
5. If no plan succeeded, throws `['no plan for', ...predicate]`.

This is a **plan selection with fallback**: plans are tried in priority order; the first one that doesn't throw wins.

---

## IntentionRevision.js

This is the **abstract base class** for the agent's intention management loop. It maintains a queue and runs intentions one at a time.

### Private Field

| Field | Type | Meaning |
|---|---|---|
| `#queue` | `IntentionDeliberation[]` | The ordered list of pending intentions the agent will pursue. |

### Getter

- `intention_queue` — exposes `#queue` to subclasses (the private field itself is inaccessible to them).

### `log(...args)`

Prints to console with prefix `[agent]`. This is overridden indirectly by `IntentionDeliberation` which calls `parent.log()`.

### `loop()` — The Agent's Main Execution Loop

```js
async loop()
```

Runs forever (`while (true)`). Each iteration:

1. **`await new Promise(res => setImmediate(res))`** — yields control to the Node.js event loop before doing anything. This is critical: it allows incoming socket events (parcel appearances, position updates) to be processed between intention executions. Without this, the agent would block the event loop.

2. **Prune stopped intentions**: advances past any intentions at the front of the queue that have been stopped (`queue[0].stopped === true`), removing them with `shift()`.

3. **Empty queue**: if nothing is left, `continue` (loops back and yields again).

4. **Validity check** (`#isValid`): if the top intention is stale (e.g. the parcel it was going to pick up was already taken), it is dropped and the loop continues.

5. **Logs and executes** the top intention via `intention.achieve()`. Errors are caught:
   - If the error tag is `'stopped'`, it is silently swallowed (normal cancellation).
   - Any other error is logged.

6. **`shift()`** removes the completed intention from the queue.

### `push(_predicate)` — Abstract Method

```js
async push(_predicate) {}
```

Empty implementation. Each subclass overrides this with its own policy for adding new intentions to the queue. The `_predicate` prefix convention signals it is intentionally unused here.

### `#isValid(intention)` — Validity / Staleness Check

```js
#isValid(intention)
```

Uses destructuring on the predicate array:

```js
const [intent, , , id] = intention.predicate;
//      [0]   [1][2] [3]
```

- Position `[0]` = intent name (e.g. `'go_pick_up'`)
- Positions `[1]`, `[2]` = x, y coordinates (skipped)
- Position `[3]` = parcel ID

If the intent is `'go_pick_up'`:
- Looks up the parcel in the global `parcels` map (imported from `context.js`).
- Returns `true` only if the parcel exists **and** is not currently `carriedBy` anyone.
- If the parcel disappeared or was picked up by another agent, returns `false` → intention is dropped.

For all other intents (e.g. `go_deliver`, `go_explore`), always returns `true` — no staleness check needed.

---

## IntentionRevisionQueue.js

**Policy: FIFO queue with deduplication.**

Extends `IntentionRevision`. Overrides `push()`:

```js
async push(predicate) {
    const key = predicate.join(' ');
    if (this.intention_queue.find(i => i.predicate.join(' ') === key)) return;
    this.intention_queue.push(new IntentionDeliberation(this, predicate));
}
```

- Converts the predicate array to a string key (e.g. `"go_pick_up 3 5 abc123"`).
- **Deduplication**: if an intention with the same key already exists anywhere in the queue, the new one is silently dropped.
- Otherwise, appends a new `IntentionDeliberation` to the **end** of the queue.

**Behavior**: the agent finishes each intention to completion before starting the next. New events accumulate. The currently-executing intention is **never stopped**. Best for stable, low-churn environments.

---

## IntentionRevisionReplace.js

**Policy: Replace — always pursue the most recent intention, stop the old one.**

Extends `IntentionRevision`. Overrides `push()`:

```js
async push(predicate) {
    const last = this.intention_queue.at(-1);
    if (last && last.predicate.join(' ') === predicate.join(' ')) return;

    const intention = new IntentionDeliberation(this, predicate);
    this.intention_queue.push(intention);

    if (last) last.stop();
}
```

- `at(-1)` gets the **last** item in the queue (most recently added, i.e. the one currently executing or queued next).
- **Deduplication**: if the new predicate equals the last one, do nothing.
- Otherwise: push the new intention, then call `last.stop()` on the previous one.

**Behavior**: the agent is always chasing the most recently signalled goal. Whenever a better opportunity appears (a closer parcel, higher reward), the current plan is interrupted and replaced. Most reactive policy — but can thrash if new signals come too frequently.

---

## IntentionRevisionRevise.js

**Policy: Revise — similar to Replace, with a threshold hook.**

Extends `IntentionRevision`. Overrides `push()`:

```js
async push(predicate) {
    const last = this.intention_queue.at(-1);
    if (!last) {
        this.intention_queue.push(new IntentionDeliberation(this, predicate));
        return;
    }
    if (last.predicate.join(' ') !== predicate.join(' ')) {
        this.intention_queue.push(new IntentionDeliberation(this, predicate));
        last.stop();
    }
}
```

### `#SWITCH_THRESHOLD = 0.5`

A private constant currently declared but **not yet used** in `push()`. It is a placeholder for a future utility threshold — the idea would be: only switch intentions if the new goal is significantly better than the current one (e.g. by at least 50% more reward). As-is, the logic is functionally identical to `IntentionRevisionReplace`.

### Logic

- If queue is empty → push the new intention, done.
- If the last predicate **differs** from the new one → push new, stop the old one.
- If the last predicate is **the same** → do nothing (implicit deduplication by doing nothing in the else-case).

The difference from `Replace` is subtle: `Replace` has an explicit early-return for the matching case, while `Revise` simply does nothing if the condition in the `if` is false. The `#SWITCH_THRESHOLD` is where the two policies would eventually diverge — `Revise` would only replace if the new intention is meaningfully better.

---

## How They All Connect

```
IntentionRevision (base)
│  #queue: IntentionDeliberation[]
│  loop()        ← runs forever, pops & executes queue[0]
│  push()        ← empty, overridden by subclasses
│  #isValid()    ← checks parcel still pickable
│
├── IntentionRevisionQueue   → push appends, no interruption
├── IntentionRevisionReplace → push replaces last, stops old
└── IntentionRevisionRevise  → push replaces if different (threshold unused)

IntentionDeliberation (one per intention)
│  predicate     ← the goal: ['go_pick_up', x, y, id]
│  achieve()     ← iterates planLibrary, runs first matching plan
│  stop()        ← cancels execution mid-plan
```

The agent picks **one** of the three revision strategies at startup, then calls `loop()` in the background. As events come in (parcels appear, positions change), the deliberation module calls `push(predicate)` on the chosen strategy, and the loop continuously drains and executes whatever is in the queue.

---

## Policy Comparison Table

| Strategy | Interrupts current? | Deduplication scope | Best for |
|---|---|---|---|
| `IntentionRevisionQueue` | Never | Entire queue | Stable, ordered tasks |
| `IntentionRevisionReplace` | Always | Last item only | Highly reactive, greedy |
| `IntentionRevisionRevise` | If different | Last item only | Reactive with future threshold |
