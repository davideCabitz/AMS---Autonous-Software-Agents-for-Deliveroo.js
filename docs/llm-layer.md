# LLM Layer

The LLM layer is coordinator-only. It is registered by `registerLlm` in [myAgent/llm/index.js](myAgent/llm/index.js) when `LITELLM_API_KEY` is set. It sits on top of the BDI engine: the LLM decides *what* to do; the BDI layer executes *how*.

---

## Message routing — registerLlm

**File:** [myAgent/llm/index.js](myAgent/llm/index.js)

All incoming messages arrive through `socket.onMsg`. The routing logic:

```
raw message arrives
  │
  ├─ starts with '{'  →  try JSON parse
  │       └─ has .type → partner protocol (consumed by handlePartnerMessage, not classified)
  │
  ├─ abort keyword ('exit', 'abort', ...) →  abortCurrent() immediately (bypasses queue)
  │
  ├─ ends with '?' or starts with greeting →  handleChat() (no classify call)
  │
  └─ classify(text) — one model call
        ├─ IGNORE → dropped silently (bare "red light"/"green light" with no imperative — no reply, no effect)
        ├─ STOP  →  trafficLight.red = true, halt both agents (if lightMission.active)
        ├─ GO    →  trafficLight.red = false, resume both agents (if lightMission.active)
        ├─ CHAT  →  handleChat() (concurrent read-only fast-lane)
        └─ ACTION → enqueue() (serialized action queue)
```

Messages are only accepted from `ADMIN_ID` (env var) or `WORKER_ID` (for JSON protocol). All others are silently ignored.

### Serialized ACTION queue

At most one ACTION directive runs at a time (`busy` flag). A new ACTION while `busy` is true aborts the current directive (`directive.aborted = true`, `myAgent.haltCurrent()`) and replaces it as the pending directive. `drain()` processes pending directives one by one.

### Concurrent CHAT fast-lane

`handleChat` calls `runConversation` concurrently — multiple CHAT messages can be answered in parallel. CHAT never moves the agent and never touches the intention queue.

### Per-sender history

`histories` map: sender id → `[{role,content}, ...]`. Capped at `MAX_HISTORY_TURNS = 5` turns (10 messages). Passed to both `runDirective` and `runConversation` as context. `/reset` clears a sender's history; `/memory` dumps it.

---

## classifyDirective

**File:** [myAgent/llm/commandLoop.js](myAgent/llm/commandLoop.js)

One model call with a tightly constrained prompt. Returns `'STOP'|'GO'|'ACTION'|'CHAT'|'IGNORE'`. Defaults to `'ACTION'` on any error or ambiguity.

Forced ACTION cases (model is instructed explicitly):
- Any mission offer, bonus/penalty mention, or "calculate for a reward" request.
- Red/green-light mission **announcement** (the setup text that starts the game) — this is a directive, not a live signal.
- Any instruction to do, move, apply, remove, abort a mission.

Forced CHAT cases: greetings, questions, status requests answerable with words.

STOP/GO: live "RED LIGHT! Stop moving" / "GREEN LIGHT! You can move again" commands (they carry a stop/resume imperative). These only take effect after `start_light_mission` arms the mission (`lightMission.active`).

IGNORE: a **bare** "red light" / "green light" on its own — just the colour words, no stop/resume imperative and not a game announcement. `route()` drops it before any handling, so it never arms, stops, or resumes the agents (and sends no reply). Only the full live shouts (STOP/GO) and the announcements (ACTION) affect the game.

---

## runDirective — the ReAct loop

**File:** [myAgent/llm/commandLoop.js](myAgent/llm/commandLoop.js)

```
runDirective(objective, myAgent, replySender, resumeAutonomy, history)
```

Limits: `MAX_ITERATIONS = 30`, `MAX_TOOL_FAILURES = 1`.

Each iteration:
1. Calls `callModel(messages, {temperature: 0})`.
2. Parses `Action:` / `Action Input:` or `Final Answer:` or bare `End` from the response.
3. On `Action`: looks up the tool in `tools`, calls it, appends `Observation:` with live state (`at (x,y), carrying N`), continues.
4. On tool failure (`/^Failed/` prefix): increments `failures`; aborts after `MAX_TOOL_FAILURES`.
5. On `End` marker (with or without Action): returns `'Mission accepted.'` if a mission tool succeeded, `'Mission declined.'` if a net-penalty Level-3 routine was refused, `null` otherwise.
6. On `Final Answer:`: returns the answer string (sent to chat for quiz/calculation responses).

The `directive.active` gate is NOT set at the start — the BDI agent keeps running while the LLM thinks between commands. Each command tool sets it on entry and clears it on completion. The `finally` block ensures the gate is cleared and `resumeAutonomy` is called when the directive ends, except when the handoff loop is running (it owns the gate beyond directive lifetime).

Replies:
- `null` and silent-outcome patterns (`Done.`, `Failure:...`, `Mission declined.`, `Could not complete…`, iteration-limit messages) are **not sent to chat**.
- `'Mission accepted.'` and substantive answers (quiz/calculation results) **are sent**.

---

## runConversation — read-only fast-lane

```
runConversation(message, history)
```

Same ReAct structure but uses `buildChatTools()` (read-only subset). Action tools are not available; attempting to call one returns an error observation. Exits on `Final Answer:`. The answer is always sent back to the sender (no silent filter).

Quiz answers (`QuestionAnswer` mission type): must be bare numerals. The mission scorer listens for the raw text of the reply, so the final answer must not include explanation text.

---

## Tools — action vs. chat subsets

**File:** [myAgent/llm/commandTools.js](myAgent/llm/commandTools.js)

### Action tools (full set)

| Tool | What it does |
|---|---|
| `calculate` | Evaluates a JS expression (e.g. `"3 + sqrt(4)"`) |
| `get_current_time` | Returns wall-clock time |
| `get_my_position` | Returns `(x, y)` |
| `sense_parcels` | Returns free parcels in range with reward and position |
| `sense_delivery_tiles` | Returns reachable delivery tiles |
| `sense_spawn_tiles` | Returns reachable spawner tiles |
| `get_map_info` | Returns map dimensions, tile counts, reachable tile sets |
| `path_cost` | `pathLen(me, {x,y})` via `Strategy.pathLen` — used by the LLM to evaluate mission accept/decline (see below) |
| `go_to` | `commandAndAwait(['go_to', x, y])`; then BDI resumes. Accepts a side keyword (`leftmost`/`rightmost`/`top`/`bottom`) as well as `x,y` |
| `go_to_stay` | Like `go_to` but stays parked at the destination (gate held) for a trailing `wait`/`hold`/`deliver`. Also accepts a side keyword |
| `go_pickup` | `commandAndAwait(['go_pick_up', x, y, id])` |
| `deliver` | `commandAndAwait(['go_deliver', x?, y?])` — uses nearest delivery if no coords given |
| `put_down` | `emitPutdown` immediately at current position (via shared `dropHere()`) |
| `go_put_down` | Navigate to the destination **and** drop there in one call — the go+drop sibling of `go_pickup`/`deliver`. Accepts `x,y` or a side keyword; reuses `dropHere()`. Use for "drop a parcel in the &lt;edge&gt; tile" (no `get_map_info` + `go_to_stay` + `put_down` round-trips) |
| `wait` | Sleeps for N seconds |
| `hold` | Sets `manualHold.active = true` — indefinite position hold |
| `release_hold` | Clears `manualHold.active` |
| `say` | `emitSay(target, text)` — bounded to 5 s |
| `order_partner_goto/pickup/deliver/putdown` | Sends a BDI predicate order to the worker and awaits result |
| `halt_partner` | `sendHalt()` — freezes the worker |
| `resume_partner` | `sendResume()` — unfreezes the worker |
| `ask_partner_status` | `requestStatus()` — returns worker position/carrying/frozen |
| `apply_mission` | `applyMissionConfig(cfg)` + `sendConstraint('apply', cfg)`. Key fields: `requiredStackSize`, `maxStackSize`, `forbiddenStackSizes`, `allowedDeliveryTiles`, `allowedSpawnerTiles`, `avoidTiles`, `maxParcelReward`, `maxBundleValue` (≤), `minBundleValue` (≥), `exactBundleValue` (=), `deliveryMultipliers`, `penaltyTiles`, `oneShotBonus`. ASCII comparison operators in mission text (`>=`→≥, `<=`→≤, `>`→floor+1, `<`→ceiling−1, `=`→exact) are mapped to these fields by the LLM before calling. |
| `forbid_delivery` | Convenience: applies `allowedDeliveryTiles` constraint |
| `restrict_exploration` | Convenience: applies `allowedSpawnerTiles` constraint |
| `dropMission` | `dropMissionField(field)` + mirror to worker. Accepted fields: `requiredStackSize`, `maxStackSize`, `forbiddenStackSizes`, `allowedDeliveryTiles`, `allowedSpawnerTiles`, `avoidTiles`, `maxParcelReward`, `maxBundleValue`, `minBundleValue`, `exactBundleValue`, `deliveryMultipliers`, `oneShotBonus`, `penaltyTiles`, `handoffNet`, `gatherNet`, `lightNet`, `multiplierNet`. |
| `dropMissions` | `dropAllMissions()` + mirror to worker |
| `start_handoff` / `stop_handoff` | Start/stop the background handoff loop |
| `start_light_mission` / `stop_light_mission` | Arm/disarm the red-light-green-light mission |

### Symbolic destinations — resolveDestination

`go_to`, `go_to_stay`, and `go_put_down` resolve their argument through `resolveDestination(input)`: an explicit `"x,y"` passes through, while a side keyword (`leftmost`/`rightmost`/`top`/`bottom`) is resolved over the reachable walkable tiles with the same min/max logic as `get_map_info`, then tie-broken to the tile **nearest** the agent by `findRoute` (least travel ⇒ least decay). This lets the LLM nav-and-drop at an edge tile without a separate `get_map_info` round-trip.

### Chat tools (read-only subset)

`calculate`, `get_current_time`, `get_my_position`, `sense_parcels`, `sense_delivery_tiles`, `sense_spawn_tiles`, `get_map_info`.

### path_cost and mission evaluation

The `path_cost` tool exposes `pathLen(me, {x,y})` to the LLM. When a mission offer specifies coordinates (e.g. "deliver at tile (5,3) to get +500pts"), the LLM calls `path_cost` to estimate the travel cost, then weighs it against the offered bonus — the same `B(p)` intuition applied to mission accept/decline. See [cost-function.md](cost-function.md) for the full formula and [mission-system.md](mission-system.md) for mission acceptance logic.

---

## Prompt structure

**File:** [myAgent/llm/prompt.js](myAgent/llm/prompt.js)

`buildSystemPrompt(objective)` constructs the action-directive system prompt:

1. **Preamble + live world state** — interpolated: agent name, position, carrying, current mission constraints, active mission descriptions.
2. **ACTION_REFERENCE** — static module-level constant (no interpolation): coordinate/vocabulary conventions, full tool catalogue with signatures, operating notes, ReAct output format rules. Hoisted to avoid re-constructing it every call (148 lines, zero interpolation).

`buildChatPrompt(message)` is a shorter read-only context prompt for the CHAT fast-lane.

---

## llmClient

**File:** [myAgent/llm/llmClient.js](myAgent/llm/llmClient.js)

OpenAI-compatible client pointing to the LiteLLM proxy. Configuration via env vars:

| Var | Default | Description |
|---|---|---|
| `LITELLM_API_KEY` | — | Required; enables the LLM layer |
| `LOCAL_MODEL` | `'gpt-4o'` | Primary model |
| `LOCAL_MODEL_FALLBACK` | `'llama-3.3-70b'` | Fallback after Azure content-policy 400 |
| `LITELLM_BASE_URL` | — | Proxy base URL |

Request timeout: 90 s. On a content-policy `400` error, retries once with `LOCAL_MODEL_FALLBACK` before propagating the failure.

Every call logs its wall-clock latency and token usage — `[llm] call <ms> prompt=<n> completion=<n> tok` — so per-call proxy/model latency is visible separately from the number of ReAct round-trips a directive makes.
