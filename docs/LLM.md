# LLM Agent — Complete Context

*Autonomous Software Agents 2025–2026 | University of Trento*
*Single reference document: project context, challenge requirements, architecture, methodology, implementation, verification, and constraints.*

---

## 1. Project Overview

The project runs on **Deliveroo.js** — a web-based parcel delivery game on an M×N grid. Players (agents) score by picking up parcels and delivering them to red delivery tiles before their countdown timers expire. The grid has four tile types: black (wall), green (spawn), red (delivery), white (walkable path). Agents operate under partial observability (sensing radius: Manhattan distance < 5).

**Two-agent system.** The second challenge requires **two cooperating agents** connected to the same game simultaneously. This codebase implements them as two processes running the *same* agent code in different roles:

- **Coordinator** (token `TOKEN_COORDINATOR`) — full BDI agent **plus** the LLM command layer. It reads natural-language missions from the chat, interprets them, and commands both itself and the worker.
- **Worker** (token `TOKEN_WORKER`) — plain BDI agent **plus** a lightweight partner-order handler. No LLM: it executes structured JSON orders the coordinator sends over the chat channel.

Agent display names come from the JWT tokens, not from code — any names work (this repo's test tokens happen to be named `Alfiere` and `bdi_pawn`).

**Core design principles:**
1. The LLM decides **WHAT** to do; the BDI agent decides **HOW** to do it. The LLM never moves one tile at a time — it issues high-level commands (`go_to`, `go_pickup`, `deliver`) that the BDI plan library (A*/PDDL) executes and returns from. This avoids the failure modes of a standalone LLM agent (wall collisions, one-model-call-per-tile slowness, no pathfinding).
2. **One brain, two bodies.** Only the coordinator calls the model. The worker is commanded through a deterministic JSON protocol, so Level-3 coordination costs zero extra LLM calls and cannot suffer from two models disagreeing.
3. **Time-critical reflexes bypass the LLM.** Signals that must be obeyed within seconds (RED/GREEN light) are handled by keyword fast-paths in the runtime; the model is only consulted for interpretation, never for reaction time.

---

## 2. Second Challenge — Special Missions

Both agents play simultaneously. Standard parcel collection runs autonomously via the BDI strategy. **Special missions** arrive as natural-language messages (shouted by an admin "mission agent") and must be: read by the LLM, interpreted, and executed by the system.

Special missions score significantly more than standard delivery but **may not always be worth completing** — the system must decide when to accept or ignore them (see §7, mission evaluation).

### Level 1 — Atomic missions
Simple, one-shot actions resolvable with basic tools (move, calculate, pick-up, put-down).

Examples:
- *Move to coordinate (4,7) and you get +10pts*
- *Move to x=4×2, y=(1+3)×3 to get −10pts*
- *Drop a package in the leftmost tile to get 5pt*
- *What is the capital of Italy?*
- *Calculate 5×5 — send the answer to the agent who sent the prompt*

### Level 2 — Intermediate, persistent missions
Non-atomic missions that require the agent to **modify its standard pick-up/delivery strategy** for the entire match duration.

Examples:
- *Deliver stacks of exactly 3 parcels at a time to double the reward*
- *Every time you deliver in (x1,y1) or (x2,y2) you get 5× pts*
- *Do not go through tile (x,y) otherwise you lose 50pts*
- *Deliver parcels for a total reward ≤ 10 to get a bonus*

### Level 3 — Multi-agent coordination
Require communication between the two agents, or between an agent and the game chat.

Examples:
- *Move both agents to the neighborhood of (x,y) within distance 3, have them wait for each other — 500pts*
- *If a parcel is initially picked up by one agent and delivered by the other — bonus to both*
- *All agents must stop at "RED LIGHT!" and wait for "GREEN LIGHT!" before moving again ("red light, green light") — penalty per movement during red*

---

## 3. Architecture

### 3.1 Topology and launch

```
node myAgent/launch.js coordinator     (npm run start:coordinator)
node myAgent/launch.js worker          (npm run start:worker)
```

`launch.js` sets `AGENT_ROLE` and `TOKEN` **before** importing `agent.js` (the socket connects at module-load time in `context.js`). `agent.js` then branches: the coordinator registers the LLM layer (`registerLlm`), the worker registers the order handler (`registerWorker`). A plain `npm start` still runs a single coordinator-style agent (BDI-only if `LITELLM_API_KEY` is unset).

### 3.2 File layout

```
myAgent/llm/                            (coordinator only)
  index.js         Entry: wires chat channel + stdin to routing. Order of checks:
                   partner-protocol JSON → red/green-light fast-path → abort
                   keywords → /reset /memory → classifier → ACTION queue / CHAT lane.
  commandLoop.js   ReAct loops: runDirective (action lane, autonomy gate, 30 iter,
                   3-failure budget) and runConversation (read-only fast-lane).
                   classifyDirective (1 cheap call: ACTION vs CHAT; mission offers
                   forced to ACTION).
  commandTools.js  Tool catalogue: reasoning/read/command/chat/partner/mission tools.
                   buildTools (full) / buildChatTools (read-only). safeSay (bounded
                   emitSay). The command() gateway sets the autonomy gate and refuses
                   to move during RED LIGHT.
  prompt.js        buildSystemPrompt (directive lane: live world state, partner
                   status, mission-evaluation rules, mission→tool patterns, strict
                   ReAct contract) and buildChatPrompt (read-only fast-lane).
  llmClient.js     OpenAI-compatible wrapper (LiteLLM proxy). 90s request timeout,
                   retry + model fallback on Azure content-filter false positives.
  missionState.js  Shared mutation logic for persistent mission constraints —
                   used by BOTH the coordinator tools and the worker handler, so
                   the two agents can never drift on what a mission means.
  partner.js       Coordinator side of the partner link: handshake registry,
                   sendOrder (awaits the worker's result), sendHalt/sendResume,
                   sendConstraint (mirroring), requestStatus.
  handoff.js       Deterministic background loop for "one picks up, the other
                   delivers" missions. Started/stopped by LLM tools; the LLM does
                   not babysit individual cycles.

myAgent/
  launch.js        Role/token selector (see §3.1).
  partnerWorker.js Worker side of the partner link: JSON order dispatch
                   (order/putdown/halt/resume/constraint/status_req), hello
                   keepalive, red/green-light fast-path on raw shouts.

test/
  probe.js         Test driver: connects as a third client by name (no token) and
                   plays the mission agent's role minus rewards — shout mission
                   prompts, message an agent directly, print replies.
                   e.g.  node test/probe.js shout "Deliver exactly three packages
                         at a time. Bonus is 100pts."
```

Additions to existing BDI files (nothing removed):

| File | Addition | Purpose |
|---|---|---|
| `context.js` | `role` | 'coordinator' \| 'worker' (set by launch.js) |
| `context.js` | `directive = { active, aborted }` | Autonomy gate: BDI stands down while the LLM drives; aborted flag for instant abort |
| `context.js` | `trafficLight = { red }` | Red-light state, set by the keyword fast-path (never by the LLM) |
| `context.js` | `manualHold = { active }` | Indefinite hold (hold() tool) that survives directive end — "wait for each other" |
| `context.js` | `missionConstraints.maxBundleValue` | New Level-2 field: total reward per delivery must be ≤ N |
| `context.js` | reconnect on `'io server disconnect'` | socket.io does not auto-reconnect after a server-initiated disconnect; observed live (server bounced the worker → zombie process) |
| `agent.js` | role branch + `trafficLight`/`manualHold`/`directive` gates in `optionsGeneration` | BDI stops self-directing while the LLM/light/hold is in charge (still senses the world) |
| `IntentionDeliberation.js` | `completion` promise; relay first real plan failure; `cancel()` | `commandAndAwait` can await a goal; failures reach the LLM as actionable tags (`no path to`, not a generic `no plan for`); stale-dropped intentions settle their promise instead of hanging awaiters forever |
| `IntentionRevision.js` | `intention.cancel()` on stale drop | See above |
| `IntentionRevisionReplace.js` | `commandAndAwait(goal)`, `haltCurrent()` | Bridge: LLM pushes a goal and waits; abort stops the agent in place |
| `Strategy.js` | mission gates: `missionPickupOk`, `stackReady`, `mustStack`, `singleParcelBundles` | One shared enforcement point for Level-2 constraints. Previously only Greedy/Blind honoured them — the default LookAhead/Memory strategies silently ignored stack/reward missions |
| `StrategyGreedy/Memory/LookAhead/Blind.js` | call the gates in `decide()` | All selectable strategies (incl. Hurry/SingleParcel/Stochastic via inheritance) now obey persistent missions |
| `astar.js` | `reachableFrom(me)` | Only offer tiles the agent can actually reach to the LLM |

### 3.3 Control flow (coordinator)

```
chat message / stdin
        │
        ▼
     route()
        │
        ├─ partner JSON ({"type":...})  ──→ handlePartnerMessage()  [hello/result/status]
        ├─ ^RED LIGHT…  (anchored)      ──→ trafficLight.red=true; haltCurrent(); sendHalt()
        ├─ ^GREEN LIGHT… (anchored)     ──→ trafficLight.red=false; resume both agents
        ├─ abort keyword?               ──→ abortCurrent()  [IMMEDIATE: also stops handoff, releases hold]
        ├─ /reset /memory               ──→ handled inline
        └─ classifyDirective (1 call)
              ├─ CHAT    ──→ runConversation()  [concurrent, read-only tools]
              └─ ACTION  ──→ enqueue → drain() → runDirective()  [serialized, one at a time]
```

The light regexes are **anchored** (`/^\s*red light\b/i`) on purpose: the mission *announcement* contains "red light" mid-sentence and must still reach the LLM as a directive; only the actual shouts (`"RED LIGHT! Stop moving…"`) trigger the reflex. The worker runs the same fast-path on raw shouts itself — it does not depend on the coordinator relay (which is sent anyway as redundancy).

**Autonomy gate.** While the LLM is only *thinking* (model calls, read-only tools) the BDI agent keeps doing its own work. The **first command tool** sets `directive.active = true` and the gate is held through the entire directive, so a multi-step directive doesn't drift between commands. When the directive ends (or aborts), the gate is released and the BDI strategy loop resumes — **unless** the handoff routine is running (it owns the gate until `stop_handoff`).

**Abort mechanism.** Keywords ("exit", "abort", "abort directive", "exit directive", "back to bdi", "go back to bdi") bypass the queue entirely and run `abortCurrent()` synchronously: sets `directive.aborted`, clears the queue, stops the handoff routine, releases any hold, calls `haltCurrent()` (rejects pending `commandAndAwait`), releases the gate, resumes autonomy. The ReAct loop and all tools check `directive.aborted` and return immediately.

### 3.4 The ReAct loop (`runDirective`)

```
for up to MAX_ITERATIONS (30):
    check directive.aborted → exit if true
    call LLM (callModel, 90s timeout)        ← log: "iter N: <output>"
    parse output:
        Action + Action Input → run tool, observe result
            failure budget: 3 failed commands → give up, resume BDI
        Final Answer → return
finally:
    unless the handoff routine is running:
        directive.active = false; resumeAutonomy()
```

**The Final Answer is sent back to the directive sender.** (This was originally suppressed; quiz missions — QuestionAnswer — are scored by literally matching the reply text, so for "Calculate <expr>" missions the prompt requires the Final Answer to be exactly the bare numeral, e.g. `22`.)

### 3.5 Why flat ReAct and not a planner/executor split (lab 08B)

A deliberate decision, documented for the report:

- The 08B planner exists to help a *weak* LLM decompose long tasks over *static* tools. Here decomposition is already solved twice: gpt-4o reliably plans 3–6-step missions inside one ReAct trace, and the BDI layer's coarse tools (`deliver()` hides dozens of primitive steps) keep most missions to 1–4 iterations.
- A pre-computed plan goes stale in a dynamic game: by step 3 the parcel from step 1's plan may be gone. 08B has no replan machinery; flat ReAct re-reads fresh observations every iteration, so it adapts by construction.
- The split costs 2–4× the LLM calls/latency per mission, paid in parcel decay and proxy round-trips.

A planner module would duplicate the BDI layer's job — the architecture's whole thesis is *LLM decides WHAT, BDI decides HOW*.

---

## 4. The Partner Link (coordinator ⇄ worker)

All payloads are JSON strings over the normal chat channel (`emitSay`). The worker ignores chat that isn't protocol JSON (except the light fast-path); the coordinator's `route()` intercepts protocol JSON before the classifier, so it never wastes an LLM call.

Coordinator → worker:

```json
{"type":"hello_ack"}
{"type":"order","orderId":"o1","predicate":["go_to",5,3]}      // also ["go_pick_up",x,y], ["go_deliver",x,y]
{"type":"putdown","orderId":"o2"}
{"type":"halt"}            // freeze: stop current plan, gate autonomy (persists across orders)
{"type":"resume"}          // unfreeze, resume BDI
{"type":"constraint","op":"apply","config":{ ...apply_mission shape... }}
{"type":"constraint","op":"drop","field":"avoidTiles"}
{"type":"constraint","op":"dropAll"}
{"type":"status_req"}
```

Worker → coordinator:

```json
{"type":"hello","role":"worker","name":"bdi_pawn"}              // shouted every 5s until acked, then 30s keepalive
{"type":"result","orderId":"o1","ok":true,"detail":"done: go_to 5 3 — now at (5,3)"}
{"type":"result","orderId":"o1","ok":false,"detail":"target (5,3) is unreachable — …"}
{"type":"status","x":5,"y":3,"score":120,"carrying":[{"id":"p1","reward":7}],"frozen":false}
```

Implementation notes:
- `sendOrder()` returns a promise resolved by the matching `result` (orderId map, 45s timeout). Failures are uniformly `Failed:`-prefixed so the handoff loop and the LLM detect them the same way as local tool failures.
- A `go_pick_up` order without a parcel id is resolved on the **worker's own beliefs**; if it knows no parcel there, it walks to the tile and picks up whatever it finds (the next sensing event reconciles beliefs).
- Orders are refused on both sides while `trafficLight.red`.
- The hello keepalive re-registers the link automatically if either process restarts or the server bounces a socket.
- **Constraint mirroring:** every `apply_mission` / `restrict_exploration` / `dropMission(s)` on the coordinator is replayed to the worker through `missionState.js`, so persistent missions bind both agents identically.

---

## 5. Level-3 Routines

### 5.1 Handoff ("one picks up, another delivers")

`start_handoff()` / `stop_handoff()` tools start/stop a **deterministic background loop** (`llm/handoff.js`) — the bonus repeats per delivery, so cycling is code, not model calls:

1. Freeze the worker (it must not pick up parcels itself — those deliveries would not qualify).
2. Coordinator fetches the nearest reachable parcel (live sightings always outrank remembered ones — remembered parcels may be ghosts).
3. Meeting tile **M** = a free, **non-delivery** tile adjacent to the delivery tile nearest the worker, excluding the worker's own (frozen) position. Dropping on a delivery tile would count as the coordinator's *own* delivery and void the bonus.
4. Drop cargo at M, then **mandatorily** step aside (two agents can never share a tile) — neighbour first, nearest reachable walkable tile as fallback.
5. Order the worker: pick up at M, deliver at the adjacent delivery tile → bonus to both.
6. Repeat. No parcel in sight → tour the spawners. Any failed step → next cycle with fresh state. Every own-navigation step is bounded by a 60s timeout; RED LIGHT pauses the loop.

The routine outlives the directive that started it: `runDirective`'s `finally` skips releasing the autonomy gate while `handoffRunning()`; `stop_handoff` (or an abort keyword) tears it down and resumes both agents.

### 5.2 Red light / green light

Entirely reflex-based (see §3.3) — a 20s light cycle cannot afford LLM latency. While red: `optionsGeneration` returns early, the `command()` gateway and worker orders refuse to move, and `haltCurrent()` stops the plan in execution; the single in-flight move completes well within the mission's 5s grace period. The announcement itself still reaches the LLM, which just acknowledges (prompt pattern).

### 5.3 "Move both agents near (x,y) and wait"

Prompt pattern: pick two *different* walkable tiles within the radius, `go_to` one and `order_partner_goto` the other, then `halt_partner()` + `hold()`. `hold()` sets `manualHold` — unlike the gate, it persists after the directive ends, until `release_hold()` or an abort.

---

## 6. Tool Catalogue

The LLM has only **high-level** tools — never raw tile-by-tile movement.

| Kind | Tool | Behaviour |
|---|---|---|
| **Reasoning** | `calculate(expr)` | Evaluates math; comma-separated expressions for multi-coordinate output. Whitelisted chars only. |
| **Reasoning** | `get_current_time(location)` | Local time in Rome as JSON. |
| **Read** | `get_my_position()` | `{x, y, score}`. |
| **Read** | `sense_parcels()` | Free parcels currently in sensing range. |
| **Read** | `sense_delivery_tiles()` / `sense_spawn_tiles()` | Reachable tiles only (filtered via `reachableFrom`). |
| **Read** | `get_map_info()` | Map bounds + edge tiles (leftmost/rightmost/top/bottom reachable). |
| **Read** | `path_cost(x,y)` | A* route cost as `{steps, estSeconds, decayLostPerCarriedParcel}` or "Unreachable" — the mission-evaluation tool. |
| **Command** | `go_to(x,y)` | Pushes a `go_to` BDI intention, awaits arrival. |
| **Command** | `go_pickup(x,y)` | Navigates to (x,y) and picks up the highest-reward known parcel there. |
| **Command** | `deliver()` / `deliver(x,y)` | Nearest delivery tile, or a *specific* one ("deliver in 1,1" missions). |
| **Command** | `put_down()` | Drop cargo on the current tile without moving (handoffs; only scores on a delivery tile). |
| **Command** | `wait(seconds)` | Hold in place for N seconds (max 30), abort-aware. |
| **Command** | `hold()` / `release_hold()` | Indefinite hold that survives the directive ("wait for each other"). |
| **Chat** | `say(message)` | Chat reply to the directive sender (bounded, can't hang on a dead recipient). |
| **Partner** | `order_partner_goto/pickup/deliver/putdown(…)` | Run on the worker; return its result observation. |
| **Partner** | `halt_partner()` / `resume_partner()` | Freeze / unfreeze the worker. |
| **Partner** | `ask_partner_status()` | Worker position, score, cargo, frozen state. |
| **Partner** | `start_handoff()` / `stop_handoff()` | The §5.1 background routine. |
| **Mission** | `apply_mission(json)` | Persistent Level-2 constraints (see below). Auto-replies "Mission accepted", auto-mirrors to the worker. |
| **Mission** | `restrict_exploration(zone)` | left \| right \| top \| bottom half of the spawners; mirrored as a computed tile list. |
| **Mission** | `dropMission(field)` / `dropMissions()` | Remove one / all constraints (mirrored). |

`apply_mission` JSON fields (all optional, additive):

| Field | Effect (enforced by all strategies via the Strategy-base gates) |
|---|---|
| `requiredStackSize: N` | Deliver only when carrying exactly N parcels; value gates relax while filling a mandated stack |
| `allowedDeliveryTiles: [[x,y],…]` | Deliver only at these tiles ("never deliver in …" → all tiles EXCEPT the forbidden) |
| `allowedSpawnerTiles: [[x,y],…]` | Restrict exploration targets |
| `avoidTiles: [[x,y],…]` | Excluded from all pathfinding (A* `blockedKeys`) |
| `maxParcelReward: N` | Never pick parcels above N |
| `maxBundleValue: N` | Each delivery's total reward ≤ N → agents carry one cheap parcel at a time so every delivery qualifies |
| `description: "text"` | Label shown in future prompts, auto-tagged with field names for later `dropMission(field)` |

**Two toolsets.** `buildTools` (action lane — everything) and `buildChatTools` (fast-lane — read-only). The fast-lane physically cannot move the agent.

**Robustness features:**
- Command tools return descriptive failure strings (e.g. `"Failed: target (3,9) is unreachable — a wall, or a tile currently occupied/blocked by an agent."`). `IntentionDeliberation` relays the *first real* plan failure instead of masking it as `no plan for`, so the model can actually act on it.
- Every await in the loop is bounded: model calls 90s, own commands 30s, partner orders 45s, chat sends 5s, handoff steps 60s. A wedged anything cannot freeze the serialized directive lane.
- Stale intentions (`dropping stale intention`) settle their completion promise (`cancel()`) — awaiters never hang.
- After 3 failed commands the directive gives up and BDI resumes.

---

## 7. Prompts, Memory, Mission Evaluation

**System prompt** (`buildSystemPrompt`) is regenerated per directive and contains: the directive text, live world state (position, parcels, cargo, delivery tiles), **live partner status** (or "not connected: complete missions solo"), the tool catalogue with usage rules, coordinate conventions, game vocabulary, and the strict ReAct output contract. Three sections drive challenge-2 behaviour:

1. **MISSION EVALUATION** — shouted admin messages are *offers* ending with "Bonus is N pts.". Use `path_cost` first; if unreachable or the bonus doesn't beat the travel time + lost parcel income, **decline** (one polite `say()`, Final Answer, no behaviour change). Penalty missions ("do not… or you will be penalized") are almost always accepted as constraints.
2. **MISSION PATTERNS** — one line per catalogue entry mapping mission text → tools (go-to-bonus, deliver-at, calculate-quiz → bare-numeral Final Answer, avoidTiles, requiredStackSize, allowedDeliveryTiles-except, maxBundleValue, start_handoff, red-light acknowledge-only, both-agents-near-and-hold).
3. **PARTNER AGENT** — partner tools, automatic constraint mirroring, and the same-tile rule: *two agents can never stand on the same tile; move aside before sending the partner to your own tile*.

Arithmetic coordinates ("x=4×2") are always resolved with `calculate`, never in the model's head.

**Conversational fast-lane prompt** (`buildChatPrompt`) — read-only; explicitly told it cannot move. Quiz questions answered here must also be bare numerals (automated checkers match literally).

**Per-sender conversation memory.** Each chat sender gets a rolling history of the last 5 directive+answer pairs. `/reset` clears it; `/memory` prints it.

---

## 8. Technical Stack & Configuration

**Endpoint:** University of Trento faculty LiteLLM proxy — OpenAI-compatible. **VPN required.**

```javascript
const client = new OpenAI({
    baseURL: process.env.LITELLM_BASE_URL,    // https://llm.bears.disi.unitn.it/v1
    apiKey:  process.env.LITELLM_API_KEY,
    timeout: 90_000,                          // a stalled call must not wedge the directive lane
    maxRetries: 1,
});
```

The manual text protocol (regex-parsing `Action:` / `Action Input:` / `Final Answer:`) is used instead of OpenAI-native `tools`/`tool_calls`: model-agnostic, works with locally-hosted models.

**Required `.env` keys (repo root):**

| Key | Purpose |
|---|---|
| `HOST` | Deliveroo.js server URL |
| `TOKEN_COORDINATOR` | Coordinator token (role user) |
| `TOKEN_WORKER` | Worker token (role user) |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY` | Faculty proxy |
| `LOCAL_MODEL` | `gpt-4o` (primary) |
| `LOCAL_MODEL_FALLBACK` | `llama-3.3-70b` — used when Azure's content filter false-positives twice in a row |

**`lab/.env` (separate!):** the official mission agents in `lab/missionAgents/` load `../.env` *relative to their own folder* — i.e. `lab/.env`, **not** the repo root. It needs `HOST` and `ADMIN_TOKEN` (a role-admin JWT). They also need `argparse` (installed in the root `package.json`).

**Run:**

```
npm run start:coordinator        # BDI + LLM layer
npm run start:worker             # BDI + order handler
node lab/missionAgents/start.js  # official scorer (edit to pick the scenario), cwd lab/missionAgents
node test/probe.js shout "..."   # simulate a mission shout without admin rights
```

---

## 9. Verification (live, against the real server and official scorers)

Tested 2026-06-12 on a local Deliveroo.js server with both agents connected and the official `lab/missionAgents` scorers running under `ADMIN_TOKEN`:

| Scenario | Result |
|---|---|
| **QuestionAnswer** (*Calculate (5·(5+3)/2)+2*, +10000) | `Rewarded Alfiere with 10000pts because: answered correctly` — LLM calculated and replied exactly `22` |
| **OnePickupAnotherDeliver** (+500/delivery) | `Rewarded bdi_pawn with 500pts because: delivered a parcel initially picked up by another agent` — twice; handoff cycles repeat autonomously |
| **RedLightGreenLight** (−10/move during red) | 0 penalties for both agents over multiple 20s cycles (a foreign agent on the same server racked up 85 penalties as a control group) |
| GoTo with arithmetic coords (probe) | `calculate(4*2, (1+3)*3) → 8, 12` → `go_to(8,12)` arrived; partner also dispatched for the per-agent bonus |
| avoidTiles / requiredStackSize (probe) | Applied on the coordinator **and mirrored** to the worker (`constraint apply` in its log); coordinator visibly hoarded: "stack incomplete (2 carried) — hunting more parcels" |
| Chat lane | Concurrent position/map Q&A while autonomous play continued |
| Abort / stop_handoff / drop missions | All restore autonomous BDI on both agents |

Remaining: GoTo/DeliverAt/deliverExactlyN/DeliverLessValueThan official scorers use hardcoded coordinates from the `challenge2/26c2_N.json` maps — run them with those maps loaded on the server (mechanics already probe-verified).

---

## 10. Constraints & Known Limitations

- **VPN required.** The LiteLLM proxy is only reachable on the university network. Connection errors are not retried (keeps a missing VPN obvious).
- **Model availability.** `gpt-4o` is the reliable primary on the proxy; the Azure content filter intermittently 400s harmless prompts — retried once, then `LOCAL_MODEL_FALLBACK` takes over.
- **BDI runs during LLM thinking, not during commands.** Autonomous work continues while the model reasons; the first command takes control and holds it. A "freeze" freezes where the agent was *when the command fired*.
- **Shared-game reachability is dynamic.** `reachableFrom`/`path_cost` are snapshots; another player (or the partner — same-tile rule) can block a chosen tile. Failures come back as accurate observations and the LLM may try one alternative before reporting failure.
- **Server may bounce sockets.** Observed live (`io server disconnect`); both agents reconnect automatically and the worker's keepalive re-registers the partner link. The keepalive hello is visible in the game chat every 30s (cosmetic).
- **ACTION-vs-CHAT classifier costs one model call** per incoming message; defaults to ACTION on uncertainty (safe: serialized queue). Mission offers (bonus/penalty/quiz wording) are always ACTION.
- **ReAct loop cap: 30 iterations; failure budget: 3 failed commands; every await bounded.** A confused, impossible, or wedged directive cannot run — or hang — indefinitely.
- **One serialized action lane.** Directives execute one at a time; chat questions answer concurrently. A long mission delays queued directives (by design — two directives must not fight over the intention queue).
