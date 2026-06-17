# Two-Agent Coordination

The coordinator (B) and worker (A) communicate over the Deliveroo chat channel using JSON payloads. This document covers the partner registry protocol, the handoff routine, and the worker's order handler.

---

## Part A — Partner protocol

**Files:** [myAgent/llm/partner.js](myAgent/llm/partner.js) (coordinator side) · [myAgent/worker_agent.js](myAgent/worker_agent.js) (worker side)

### Handshake

The worker shouts a `hello` JSON every `HELLO_RETRY_MS = 5 s` until it receives a `hello_ack`. After the first ack it switches to a `HELLO_KEEPALIVE_MS = 30 s` interval so the coordinator re-registers the worker if it restarts.

```
worker  →  emitShout: {"type":"hello","role":"worker","name":"..."}
coordinator  →  emitSay(worker): {"type":"hello_ack"}
```

The coordinator stores `partner.id` and `partner.name`. The worker stores `coordinatorId`. Until the handshake completes, neither agent can send orders.

### Order protocol

```
coordinator  →  emitSay(worker): {"type":"order","orderId":"o1","predicate":["go_to",5,3]}
worker  →  emitSay(coordinator): {"type":"result","orderId":"o1","ok":true,"detail":"done: ..."}
```

`sendOrder(predicate)` returns a promise that resolves when the `result` arrives or after a 45 s timeout. Failure details have a uniform `'Failed:'` prefix so callers (LLM observation, handoff loop) can detect failures the same way.

**Newest-order-wins on the worker:** each incoming `order` bumps `orderSeq`. A plan running for an older order is `haltCurrent()`'d; only the current-seq order reports a result. This allows the coordinator to re-target the worker continuously (e.g., re-steering toward a moving rendezvous) without racing two results.

`go_pick_up` without an id: if the parcel id is unknown to the worker (the coordinator just dropped it), the worker walks to the tile and calls `emitPickup` directly.

### Halt / Resume

```
coordinator  →  emitSay(worker): {"type":"halt"}
coordinator  →  emitSay(worker): {"type":"resume"}
```

`halt()` sets `frozen = true` and `directive.active = true` on the worker (autonomous strategy stands down, current plan stopped). `resume()` clears both and calls `resumeAutonomy`.

### Constraint mirroring

```
coordinator  →  emitSay(worker): {"type":"constraint","op":"apply","config":{...}}
coordinator  →  emitSay(worker): {"type":"constraint","op":"drop","field":"..."}
coordinator  →  emitSay(worker): {"type":"constraint","op":"dropAll"}
```

Each apply-tool in `commandTools.js` calls `applyAndMirror(cfg)` which pairs `applyMissionConfig(cfg)` with `sendConstraint('apply', cfg)`. This ensures both agents enforce the same constraints. Forgetting the mirror silently desyncs them — a live-tested bug fixed by the `applyAndMirror` wrapper.

### Status request

```
coordinator  →  emitSay(worker): {"type":"status_req"}
worker  →  emitSay(coordinator): {"type":"status","x":...,"y":...,"score":...,"carrying":[...],"frozen":...}
```

The worker also streams its position to the coordinator on every `onYou` event while `directive.active` is true (i.e., while executing an order). Throttled to 200 ms minimum interval. This gives the coordinator precise id-certain position tracking at any range (`otherAgents` is id-less and range-limited).

---

## Part B — Handoff protocol

**File:** [myAgent/llm/handoff.js](myAgent/llm/handoff.js)

The handoff routine implements the `OnePickupAnotherDeliver` mission: coordinator (B) acquires parcels using its BDI strategy, meets the worker (A) in the middle of B's route to the delivery, and hands the whole load off to A to deliver.

### Overview of one cycle

```
1. Acquire  — B drives its strategy (decide → commandAndAwait) in a loop
               until it should bank (decide returns go_deliver or explore/null while loaded)
2. Plan     — planDelivery: pick delivery D + static-route midpoint
3. Parallel — order A → seed meet tile; B carries toward meetB
4. Converge — B re-steers A at the live geometric midpoint every pass (liveMeet)
5. Drop     — on adjacency only (partnerAdjacent); B vacates; B ignores the parcel
6. Worker   — A: go_pick_up(dropTile) + go_deliver(D) — detached, so B re-acquires immediately
```

### Acquire loop (step 1)

B calls `strat.decide(null)` in a tight loop, executing each `go_pick_up` or `go_explore` via `commandAndAwait`. The loop breaks when:
- `decision` is not `go_pick_up` while B is carrying (i.e., strategy wants to deliver).
- The next pickup's nearest-delivery distance is more than `HANDOFF_PASS_MARGIN = 3` tiles further than B's current nearest delivery (the pickup would carry the load past the drop — hand off now).

**Why `null` not the queue's current intent:** passing the queue's stale autonomous intention would make `decide()` return `null` ("keep current") and silently stall the routine.

**workerParkingSpot — deadlock break:** if the frozen worker is blocking the only corridor to a spawner/parcel (detectable because `staticRoute` succeeds but `findRoute` fails), B orders the worker to park on a delivery tile to clear the path.

**Pre-positioning drift:** while B gathers, it re-orders A toward a neighbour of B's current tile every `DRIFT_MS = 500 ms`, so A trails just behind B. Drift is suppressed while `deliveryInFlight` is true (a delivery is in progress) to prevent a drift order from superseding an active pickup→deliver pipeline.

### Meet-in-the-middle (steps 3–4)

`planDelivery` computes the static route from B's current tile to each delivery. For each route, `midpointTile` finds the interior tile that minimises `max(B's steps to that tile, A's BFS distance to that tile)` — the time when both arrive. `meetB` is the tile one step behind the midpoint on B's route (so B and A never target the same tile simultaneously — no "occupied goal" pathfinding failure).

Once B carries cargo, it:
- Orders A to the live geometric midpoint (`liveMeet` = walkable tile nearest the B+A centroid, A*-reachable by B) immediately, as a detached order.
- Navigates toward `meetB` using `navigateTo` with a `stoppedFn` that fires when `partnerAdjacent()` is true.
- Every loop iteration: recomputes `liveMeet(B's current pos, A's streamed pos)` and re-steers A if the target moved. The meet converges live instead of being pinned to a computed route tile.

**Adjacency detection:** `partnerAdjacent` checks `otherAgents` (id-less, real-time sensing) for a neighbour within Manhattan distance 1. It also sanity-checks against A's streamed position (≤ 3 tiles) to reject a third agent. This is critical: the streamed position alone lags by one tile because of the 200 ms throttle + the worker stopping the instant it arrives; trusting only the stream made B miss the meet in a prior bug.

**Meet timeout:** if no adjacency is detected within `MEET_TIMEOUT_MS = 25 s`, B freezes A (`sendHalt`), keeps the load, and restarts the cycle (re-acquire, recompute midpoint, re-invite A).

### Drop and handoff (steps 5–6)

Drop is always **hand-to-hand**: B drops only on adjacency. If B's current tile is a delivery tile (the server would score it as B's delivery), B first steps to a free neighbour.

After `emitPutdown`:
- B calls `parcels.ignore(id)` for every dropped parcel — permanently excluded from B's strategy so it never re-targets the parcel it just handed to A.
- B steps aside via `chooseAside` (prefers backing toward spawn so it doesn't block A's path to the drop tile).
- B issues `go_pick_up(dropTile)` + `go_deliver(D)` to A — **detached** (stored in `workerChain`). B immediately starts the next acquire cycle. `deliveryInFlight` gates drift off for the duration.
- `workerAnchor` is updated to `D` (A's predicted resting tile after delivery).

The cycle repeats. The previous `workerChain` is awaited before issuing a new order to A each cycle (a fresh order would supersede an in-flight delivery).

---

## Lifecycle — start / stop

`startHandoff(myAgent, resumeAutonomy)` starts the loop. Preconditions checked:
- Partner must be connected.
- `missionConstraints.handoffNet >= 0` (a net-penalty offer is refused with `'Mission declined.'`).

`stopHandoff()` sets `running = false`; the loop exits at the next iteration and calls `sendResume` + clears `directive.active`.

`handoffRunning()` is queried by `runDirective`'s `finally` block: while the handoff owns the gate, `runDirective` must not release `directive.active` on exit (the handoff outlives the directive that started it).

---

## Historical evolution

The handoff protocol was designed from scratch for challenge 2. Key changes after live testing:

- **Break condition** changed from "only on `go_deliver`" to "any non-pickup while carrying". The old condition looped forever when the worker blocked B's own delivery path (strategy returns `go_deliver` → unreachable → `go_explore` → never `go_deliver` again).
- **Adjacency detection** moved from streamed position to `otherAgents` live sensing. Trusting only the stream made B miss the meet by one tile and detour around A as an obstacle.
- **`parcels.ignore`** added after the coordinator's dropped parcel re-entered its own parcel pool and was re-targeted, causing B to "steal" the parcel it just handed to A.
- **`workerParkingSpot`** added after observing both agents stalling in 1-tile corridors when the frozen worker sat between B and the only spawner.
- **Hand-to-hand drop** (no fixed midpoint dead-drop) after observing a third agent picking up the dropped parcel before A arrived.
