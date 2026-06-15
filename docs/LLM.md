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
3. **The LLM stays in the loop even for the time-critical signals.** The red/green-light shouts are interpreted by the model on *every* shout (via the message classifier), not by a hardcoded keyword reflex — at the cost of the model call sitting on the reaction path (see §5.2). Enforcement (no movement while red) is still instant once the flag is set; only the *decision* to set it is the LLM's.

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

`launch.js` sets `AGENT_ROLE` and `TOKEN` **before** importing `coordinator_agent.js` (the socket connects at module-load time in `context.js`, and `DjsConnect` reads `process.env.TOKEN` at call time). `coordinator_agent.js` is the single entry point for BOTH roles — it branches on `role`: the worker registers the order handler (`registerWorker` from `worker_agent.js`), otherwise (coordinator with `LITELLM_API_KEY` set) it registers the LLM layer (`registerLlm` from `llm/index.js`). A plain `npm start` runs `node myAgent/coordinator_agent.js` directly — a single coordinator-style agent (BDI-only if `LITELLM_API_KEY` is unset).

### 3.2 File layout

```
myAgent/llm/                            (coordinator only)
  index.js         Entry: wires chat channel + stdin to routing. Order of checks:
                   partner-protocol JSON → red/green-light fast-path → abort
                   keywords → /reset /memory → question/greeting fast-path →
                   classifier → ACTION lane (latest-wins) / CHAT lane.
  commandLoop.js   ReAct loops: runDirective (action lane, autonomy gate, 30 iter,
                   1-failure budget) and runConversation (read-only fast-lane).
                   classifyDirective (1 cheap call: STOP/GO live red-green-light
                   signals, else ACTION vs CHAT; mission offers/announcement →
                   ACTION). "End"-marker silent-ending contract.
  commandTools.js  Tool catalogue: reasoning/read/command/chat/partner/mission tools.
                   buildTools (full) / buildChatTools (read-only). safeSay (bounded
                   emitSay). The command() gateway sets the autonomy gate and refuses
                   to move during RED LIGHT. forbid_delivery + pickup_next_parcel live here.
  prompt.js        buildSystemPrompt (directive lane: live world state, partner
                   status, mission-evaluation rules, mission TAXONOMY-by-axis, action
                   playbook, strict ReAct/"End" output contract) and buildChatPrompt
                   (read-only fast-lane).
  llmClient.js     OpenAI-compatible wrapper (LiteLLM proxy). 90s request timeout,
                   retry + model fallback on Azure content-filter false positives.
  missionState.js  Shared mutation logic for persistent mission constraints —
                   used by BOTH the coordinator tools and the worker handler, so
                   the two agents can never drift on what a mission means.
  partner.js       Coordinator side of the partner link: handshake registry,
                   sendOrder (awaits the worker's result), sendHalt/sendResume,
                   sendConstraint (mirroring), requestStatus.
  handoff.js       Deterministic background loop for "one picks up, the other
                   delivers" missions — EMERGENT live rendezvous (no fixed meeting
                   tile). Started/stopped by LLM tools; the LLM does not babysit cycles.

myAgent/
  coordinator_agent.js  Single entry point for both roles: BDI loop
                        (optionsGeneration with the trafficLight/manualHold/directive
                        gates) + role branch (registerLlm vs registerWorker).
  launch.js             Role/token selector (see §3.1).
  worker_agent.js       Worker side of the partner link: registerWorker — JSON order
                        dispatch (order/putdown/halt/resume/constraint/status_req),
                        newest-order-wins supersession, hello keepalive, position
                        streaming while under order, red/green-light fast-path on raw shouts.

test/
  probe.js               Test driver: connects as a third client by name (no token) and
                         plays the mission agent's role minus rewards — shout mission
                         prompts, message an agent directly, print replies.
                         e.g.  node test/probe.js shout "Deliver exactly three packages
                               at a time. Bonus is 100pts."
  forbid_delivery.test.js  Unit test for the deterministic forbid_delivery resolver.
```

Additions to existing BDI files (nothing removed):

| File | Addition | Purpose |
|---|---|---|
| `context.js` | `role` | 'coordinator' \| 'worker' (set by launch.js / defaults to coordinator) |
| `context.js` | `runtime = { strategy }` | Coordinator's chosen strategy instance, shared so the handoff routine drives B's acquisition with the SAME map-chosen strategy |
| `context.js` | `directive = { active, aborted }` | Autonomy gate: BDI stands down while the LLM drives; aborted flag for instant abort/preempt |
| `context.js` | `trafficLight = { red }` | Red-light enforcement flag, set by the LLM classifier's STOP/GO verdict; read instantly by `optionsGeneration`/`command()`/worker orders |
| `context.js` | `lightMission = { active }` | Whether a red-light-green-light mission has been STARTED; gates whether STOP/GO shouts take effect. Armed by `start_light_mission`, cleared by `stop_light_mission`/abort |
| `context.js` | `manualHold = { active }` | Indefinite hold (hold() tool) that survives directive end — "wait for each other" |
| `context.js` | `missionConstraints.maxBundleValue` | Level-2 field: total reward per delivery must be ≤ N |
| `context.js` | `missionConstraints.deliveryMultipliers` | Level-2 field: per-tile delivery reward multiplier (bonus tiles); null/empty = all tiles ×1 |
| `context.js` | `missionConstraints.requiredStackSize` / `maxStackSize` | Level-2 stacking as a FLOOR/CAP pair: `requiredStackSize` = deliver only once carrying ≥ N ("at least N"); `maxStackSize` = never carry more than N ("at most N"); both set = "exactly N" |
| `context.js` | `missionConstraints.oneShotBonus` | Level-2 field `{x,y,points,perAgent}`: a go-there reward the BDI pursues on its own when the points beat forgone parcel income (see `bonusGoalValue`) |
| `context.js` | `missionConstraints.penaltyTiles` | Level-2 field `Map<"x_y",points>`: a numbered location penalty; keys are also folded into `avoidTiles` (hard ban), the magnitude is kept for the worth-gate and recall |
| `context.js` | reconnect on `'io server disconnect'` | socket.io does not auto-reconnect after a server-initiated disconnect; observed live (server bounced the worker → zombie process) |
| `coordinator_agent.js` | role branch + `trafficLight`/`manualHold`/`directive` gates in `optionsGeneration` | BDI stops self-directing while the LLM/light/hold is in charge (still senses the world) |
| `IntentionDeliberation.js` | `completion` promise; relay first real plan failure; `cancel()` | `commandAndAwait` can await a goal; failures reach the LLM as actionable tags (`no path to`, not a generic `no plan for`); stale-dropped intentions settle their promise instead of hanging awaiters forever |
| `IntentionRevision.js` | `intention.cancel()` on stale drop | See above |
| `IntentionRevisionReplace.js` | `commandAndAwait(goal)`, `haltCurrent()` | Bridge: LLM pushes a goal and awaits it (bypassing autonomous-only guards, still respecting `pddl.busy`); abort/halt stops the agent in place |
| `Strategy.js` | mission gates: `missionPickupOk`, `stackReady`, `mustStack`, `stackFull`, `singleParcelBundles`; `deliveryMultipliers` valuation (`_bestDelivery`/`_pickDelivery`/`deliveryMultiplierAt`); point-magnitude coordination (`bonusGoalValue`/`bonusDiversion`) | One shared enforcement point for ALL Level-2 constraints in the strategy base, so every strategy honours stack/reward/bundle/bonus-tile missions identically. `stackFull` enforces the `maxStackSize` cap; `bonusGoalValue`/`bonusDiversion` let an `oneShotBonus` compete with parcel income inside the value functions |
| `coordinator_agent.js` | `bonusDiversion()` checked before `decide()` in `optionsGeneration` | Single hook makes every strategy (and the worker, which shares the loop) bonus-aware with no per-subclass edits |
| `astar.js` | non-finite start/goal guard in `findRoute` | A parcel/agent sighting whose coords never resolved made the A* heuristic NaN and crashed the open-set loop; now returns null (unreachable), the failure every caller already handles |
| every `Strategy*` subclass | inherits the base gates via `decide()` | All selectable strategies (Greedy/Memory/LookAhead/LookAheadStochastic/Blind/Hurry/SingleParcel/HighCapacity/HighCapacityRush) obey persistent missions |
| `astar.js` | `reachableFrom(me)`, `tilesThatReach`, `navigateTo` | Only offer tiles the agent can actually reach to the LLM; structure helpers for the handoff routine |

### 3.3 Control flow (coordinator)

```
chat message / stdin
        │
        ▼
     route()
        │
        ├─ partner JSON ({"type":...})  ──→ handlePartnerMessage()  [hello/result/status]
        ├─ abort keyword?               ──→ abortCurrent()  [IMMEDIATE: also stops handoff, releases hold]
        ├─ /reset /memory               ──→ enqueue (handled inline in drain)
        ├─ ends with "?" / greeting     ──→ runConversation()  [chat lane, NO classifier call]
        └─ classifyDirective (1 call)
              ├─ STOP    ──→ red light: if lightMission.active → trafficLight.red=true; haltCurrent(); sendHalt()   (else IGNORE)
              ├─ GO      ──→ green light: if lightMission.active → trafficLight.red=false; clear manualHold; resume both   (else IGNORE)
              ├─ CHAT    ──→ runConversation()  [concurrent, read-only tools]
              └─ ACTION  ──→ enqueue → drain() → runDirective()  [latest-wins; preempts running]
```

The live "RED LIGHT!/GREEN LIGHT!" signals are no longer caught by a regex reflex: they go through the same `classifyDirective` call as any other message, which returns `STOP`/`GO` (see §5.2). The classifier must distinguish the mission *announcement* (the rules/penalty message that *starts* the game → `ACTION`) from a live signal (`STOP`/`GO`). `STOP`/`GO` only take effect once the LLM has armed the mission (`start_light_mission`), so an unsolicited "red light" in chat is ignored. The worker no longer self-reacts to the shouts — it obeys the coordinator's relayed `halt`/`resume`.

**Question fast-path.** Anything ending in `?` (or a greeting like "hi"/"ciao") skips the classifier entirely and goes straight to the read-only chat lane, so the answer arrives in one model call even while a directive is running. Questions are NEVER actions ("can you go to 5,3?" gets a verbal answer, not movement).

**Autonomy gate.** While the LLM is only *thinking* (model calls, read-only tools) the BDI agent keeps doing its own work. The **first command tool** sets `directive.active = true` and the gate is held through the entire directive, so a multi-step directive doesn't drift between commands. When the directive ends (or aborts), the gate is released and the BDI strategy loop resumes — **unless** the handoff routine is running (it owns the gate until `stop_handoff`).

**ACTION lane — latest-wins preemption (NOT a FIFO queue).** There is at most ONE pending directive. A new ACTION directive arriving while one is running **preempts** it: `enqueue` sets `directive.aborted` and calls `haltCurrent()` (rejecting the in-flight `commandAndAwait`), then overwrites `pending`. The running ReAct loop sees `directive.aborted` at its next checkpoint, exits silently, and `drain()` starts the newest directive. So the latest order is the only one that counts — two directives never fight over the intention queue.

**Abort mechanism.** Keywords ("exit", "abort", "abort directive", "exit directive", "back to bdi", "go back to bdi") bypass the lane entirely and run `abortCurrent()` synchronously: sets `directive.aborted`, discards any pending directive, stops the handoff routine, releases any hold, calls `haltCurrent()` (rejects pending `commandAndAwait`), releases the gate, resumes autonomy. The ReAct loop and all tools check `directive.aborted` and return immediately.

### 3.4 The ReAct loop (`runDirective`)

```
for up to MAX_ITERATIONS (30):
    check directive.aborted → exit (silent) if true
    call LLM (callModel, 90s timeout)        ← log: "iter N: <output>"
    parse output:
        Action (+ optional "End") → run tool, observe result
            if "End"/Final present with the action → end SILENTLY the instant it completes
            failure budget: 1 failed command (MAX_TOOL_FAILURES) → give up, resume BDI
        bare "End" (no Action) → directive already complete → end silently
        Final Answer → return it (word-only directives & mission offers only)
finally:
    unless the handoff routine is running:
        directive.active = false; resumeAutonomy()
```

**Silent endings vs. spoken answers.** Action directives end silently — outcomes are observed in-game, not reported. The model marks its last step by appending the line **`End`** to the Action message (or outputs the bare line `End` if it realises after an Observation that the directive is already done); the directive then terminates the instant that action completes, with no confirmation round-trip. A `Final Answer` exists ONLY for (a) word-only directives (quiz/calculation/status) and (b) mission offers (where it must be exactly `Mission accepted.` or `Mission declined.`). Substantive Final Answers are sent back to the directive sender; `null` (aborted / silent `End`) and bare `Done.`/`Failure: …` replies are suppressed. Quiz missions (QuestionAnswer) are scored by literally matching the reply text, so for "Calculate <expr>" missions the prompt requires the Final Answer to be exactly the bare numeral, e.g. `22`.

### 3.5 Why flat ReAct and not a planner/executor split (lab 08B)

A deliberate decision, documented for the report:

- The 08B planner exists to help a *weak* LLM decompose long tasks over *static* tools. Here decomposition is already solved twice: gpt-4o reliably plans 3–6-step missions inside one ReAct trace, and the BDI layer's coarse tools (`deliver()` hides dozens of primitive steps) keep most missions to 1–4 iterations.
- A pre-computed plan goes stale in a dynamic game: by step 3 the parcel from step 1's plan may be gone. 08B has no replan machinery; flat ReAct re-reads fresh observations every iteration, so it adapts by construction.
- The split costs 2–4× the LLM calls/latency per mission, paid in parcel decay and proxy round-trips.

A planner module would duplicate the BDI layer's job — the architecture's whole thesis is *LLM decides WHAT, BDI decides HOW*.

---

## 4. The Partner Link (coordinator ⇄ worker)

All payloads are JSON strings over the normal chat channel (`emitSay`). The worker (`worker_agent.js`) ignores all chat that isn't protocol JSON — including the live light shouts, which the coordinator interprets and relays as `halt`/`resume`; the coordinator's `route()` intercepts protocol JSON before the classifier, so it never wastes an LLM call.

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
- `sendOrder()` returns a promise resolved by the matching `result` (orderId map, 45s timeout on the coordinator; the worker caps a single order at 40s internally). Failures are uniformly `Failed:`-prefixed so the handoff loop and the LLM detect them the same way as local tool failures.
- **Newest-order-wins on the worker.** Each incoming order bumps an `orderSeq`; a running order whose seq is no longer current was superseded (the coordinator re-steered the worker toward a moving rendezvous), so it stays silent — the newest order owns the reply. This lets the coordinator continuously re-target the worker without two plans racing.
- **Position streaming.** While executing a coordinator order (`directive.active`), the worker streams its position on every real move (throttled ~200ms, plus the resting tile on completion), so the coordinator can track it id-certainly at any distance — `otherAgents` is id-less and range-limited, but a handoff needs to know exactly where the worker is.
- A `go_pick_up` order without a parcel id is resolved on the **worker's own beliefs**; if it knows no parcel there, it walks to the tile and picks up whatever it finds (the next sensing event reconciles beliefs).
- Orders are refused on both sides while `trafficLight.red`.
- The hello keepalive re-registers the link automatically if either process restarts or the server bounces a socket.
- **Constraint mirroring:** every `apply_mission` / `restrict_exploration` / `forbid_delivery` / `dropMission(s)` on the coordinator is replayed to the worker through `missionState.js` (`sendConstraint`), so persistent missions bind both agents identically.

---

## 5. Level-3 Routines

### 5.1 Handoff ("one picks up, another delivers")

`start_handoff()` / `stop_handoff()` tools start/stop a **deterministic background loop** (`llm/handoff.js`) — the bonus repeats per delivery, so cycling is code, not model calls. Coordination is **emergent** (no fixed meeting tile): all geometry is recomputed live each pass, so it works on any map. Per cycle:

1. **Freeze the worker** (it must not collect parcels itself — those deliveries would not qualify) and stand the coordinator's own autonomy down for the whole routine.
2. **Acquire.** The coordinator (B) gathers parcels using the **map's chosen strategy** — the same exploration, multi-pickup and value/decay decisions it makes autonomously — until the strategy decides to bank (a `go_deliver`), OR a proposed pickup would carry the load materially *past* the nearest drop (`HANDOFF_PASS_MARGIN`), at which point it hands off now instead of wandering toward distant spawners.
3. **Plan + pre-position.** B computes the cargo→delivery route to a delivery tile D and orders the worker (A) toward the live A↔B midpoint **immediately**, so A travels in parallel while B carries. While still gathering, B "drifts" A toward a tile beside itself every `DRIFT_MS` (≈500ms) so A trails close — suppressed while a previous cycle's pickup→deliver is still in flight (a drift order would supersede it).
4. **Converge & meet.** Every carry pass B recomputes the balanced rendezvous from both agents' live positions and re-steers A there; B homes onto A's live tile for the final step. The drop happens **only on adjacency** (a hand-to-hand exchange, never an unguarded dead-drop), detected from B's own sensing. If no meet happens within `MEET_TIMEOUT_MS` (25s), B freezes A and retries the cycle keeping the load — it never drops unguarded.
5. **Drop & vacate.** B drops on the spot — **never** on a delivery tile (that would score as B's own delivery and void the bonus; it backs off first if it's on one), then mandatorily steps aside (preferring the spawn side, `chooseAside`) so the worker can path onto the drop tile and single-lane corridors stay deadlock-free.
6. **Worker delivers (detached).** B orders A to pick up the drop and deliver at D → cross-agent bonus for both. This runs detached so B fetches the next parcel in parallel; the loop re-synchronizes on it before the next drop. A ends at D, which becomes its next anchor.

Any failed step skips to the next cycle with fresh state; no parcel in sight → idle. A frozen worker walling B off from a spawner is detected and parked on a delivery to open the corridor. Every own-navigation step is bounded by `STEP_TIMEOUT_MS` (60s); RED LIGHT pauses the loop. The routine outlives the directive that started it: `runDirective`'s `finally` skips releasing the autonomy gate while `handoffRunning()`; `stop_handoff` (or an abort keyword) tears it down and resumes both agents.

### 5.2 Red light / green light

LLM-driven, per shout — but only while the mission is **started**. Every incoming message already passes through one `classifyDirective` model call; that classifier recognises the LIVE signals, returning `STOP` (red) or `GO` (green), and also tags the mission *announcement* as `ACTION`. Crucially, `STOP`/`GO` are acted on **only when `lightMission.active` is set**: a stray "red light" typed in chat before any game has been announced is classified `STOP` but **ignored** (logged and dropped), so it can never freeze the agents. The mission is armed by the LLM — it reads the announcement (an `ACTION` directive) and calls `start_light_mission()`; `stop_light_mission()` or an abort disarms it.

Once armed: on `STOP` the coordinator sets `trafficLight.red`, halts its own plan, and relays `halt` to the worker; on `GO` it clears `trafficLight.red` **and** `manualHold`, then relays `resume`. `trafficLight.red` remains the instant *enforcement* flag (`optionsGeneration` returns early, the `command()` gateway and worker orders refuse to move while it is set) — only the *decision* to flip it is the LLM's.

**Both agents wait via the announcement, not just the live relay.** The official scorer (`lab/missionAgents/RedLightGreenLight.js`) penalises only *movement while the light is red* — positional flavour ("move to an odd row") is not checked. So on the announcement the coordinator's LLM puts BOTH agents into the wait directly — `halt_partner()` (freezes the worker) + `hold()` (sets `manualHold`, freezes itself) — and a `GREEN LIGHT` ends that wait (the `GO` handler clears `manualHold` and `resume`s the worker; this is why `GO` must clear `manualHold`, otherwise the coordinator stays frozen forever — the original bug). Thereafter each live `RED`/`GREEN` shout freezes/resumes both agents.

**Trade-off (deliberate).** The classify call sits on the critical path, so a slow proxy/VPN can let one move slip through during red (a penalty) before `STOP` lands; and the worker — having no model — now waits out the coordinator's call + the relay hop before freezing (its own keyword reflex was removed for one-brain consistency). The earlier design halted instantly on an anchored regex; this one trades that guarantee for a fully LLM-driven mission, as required by the project's "LLM decides WHAT" thesis. The mission's ~5s grace period absorbs a fast call; it does not absorb a stalled one.

### 5.3 "Move both agents near (x,y) and wait"

A single deterministic tool, `gather_near(x,y,D)` — the LLM only supplies the coordinate and distance. The prompt-only version (have the model pick the two tiles itself) failed because the LLM has no tool to enumerate the walkable tiles around an arbitrary coordinate (`get_map_info` gives only bounds/edges), so it guessed walls, unreachable tiles, or the same tile twice. `gather_near`:

1. Enumerates the walkable tiles within Manhattan distance D of (x,y) (the centre itself may be a wall or a forbidden tile — only the surrounding tiles matter).
2. Keeps the tiles each agent can actually reach (`reachableFrom(me)` for B, `reachableFrom(workerPos)` for A — the worker's live position comes from its streamed status / a `status_req`).
3. Picks two **different** tiles, neither being the other agent's current tile (two agents can never share a tile): the nearest reachable one to each.
4. Parks the worker first via `halt_partner()` + `order_partner_goto` (so it has vacated before B moves and stays put afterwards), sends B to its tile, then sets `manualHold` so **both** hold. `manualHold` persists after the directive ends, until `release_hold()` (now also resumes the partner) or an abort.

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
| **Command** | `go_pickup(x,y)` | Navigates to (x,y) and picks up the highest-reward known parcel there (explicit coordinates only). |
| **Command** | `pickup_next_parcel()` | "Pick up the next parcel" (no coordinates): releases the gate, lets the SELECTED BDI STRATEGY hunt autonomously, and takes control back the instant a NEW carried parcel id appears. One call — no wait/sense polling loop. |
| **Command** | `deliver()` / `deliver(x,y)` | Nearest delivery tile, or a *specific* one ("deliver in 1,1" missions). |
| **Command** | `put_down()` | Drop cargo on the current tile without moving (handoffs; only scores on a delivery tile). |
| **Command** | `wait(seconds)` | Hold in place for N seconds (max 30), abort-aware. |
| **Command** | `hold()` / `release_hold()` | Indefinite hold that survives the directive ("wait for each other"). |
| **Chat** | `say(message)` | Chat reply to the directive sender (bounded, can't hang on a dead recipient). |
| **Partner** | `order_partner_goto/pickup/deliver/putdown(…)` | Run on the worker; return its result observation. |
| **Partner** | `halt_partner()` / `resume_partner()` | Freeze / unfreeze the worker. |
| **Partner** | `ask_partner_status()` | Worker position, score, cargo, frozen state. |
| **Partner** | `start_handoff()` / `stop_handoff()` | The §5.1 background routine. |
| **Partner** | `gather_near(x,y,D)` | The §5.3 routine: deterministically place both agents on two different reachable tiles within distance D of (x,y) and hold both. |
| **Mission** | `start_light_mission()` / `stop_light_mission()` | Arm / disarm a red-light-green-light mission (§5.2). Live STOP/GO shouts only act while armed. |
| **Mission** | `apply_mission(json)` | Persistent Level-2 constraints (see below). Auto-mirrors to the worker. |
| **Mission** | `restrict_exploration(zone)` | left \| right \| top \| bottom half of the spawners; mirrored as a computed tile list. |
| **Mission** | `forbid_delivery(spec)` | Deterministic "don't deliver here" executor: a side keyword (leftmost/rightmost/top/bottom, resolved over real delivery tiles) OR coordinates ("x,y" or a ";"-list). Narrows `allowedDeliveryTiles`, accumulates across calls, refuses if it would strand the agent. |
| **Mission** | `dropMission(field)` / `dropMissions()` | Remove one / all constraints (mirrored). |

`apply_mission` JSON fields (all optional, additive):

| Field | Effect (enforced by all strategies via the Strategy-base gates) |
|---|---|
| `requiredStackSize: N` | FLOOR — deliver only once carrying ≥ N ("at least N"); value gates relax while filling a mandated stack |
| `maxStackSize: N` | CAP — never carry more than N ("at most N"); `stackFull` stops pickups at the cap. "Exactly N" = set BOTH `requiredStackSize` and `maxStackSize` to N |
| `allowedDeliveryTiles: [[x,y],…]` | Deliver only at these tiles (use `forbid_delivery` for the "never deliver in …" complement) |
| `allowedSpawnerTiles: [[x,y],…]` | Restrict exploration targets |
| `avoidTiles: [[x,y],…]` | Excluded from all pathfinding (A* `blockedKeys`) |
| `maxParcelReward: N` | Never pick parcels above N |
| `maxBundleValue: N` | Each delivery's total reward ≤ N → agents carry one cheap parcel at a time so every delivery qualifies |
| `deliveryMultipliers: [[x,y,m],…]` | Tile (x,y) is worth m× a normal delivery (positive "5×/double pts in (x,y)" bonus tiles); the strategy both routes deliveries to and values the load higher near the bonus tile. Replaces any prior map. |
| `oneShotBonus: {x,y,points,perAgent?}` | A go-there reward (e.g. "+700 at (8,3)"). The BDI diverts to it only when its net value (`points − n·ρ·dist`, via `bonusGoalValue`) beats banking the current load — so the literal point figure competes inside the cost function, not by LLM guess. For a "go there NOW" one-off, use `path_cost`+`go_to` instead. |
| `penaltyTiles: [[x,y,points],…]` | A numbered location penalty ("going to (x,y) costs 1000 pts"): the tile is hard-banned from all pathfinding (folded into `avoidTiles`) AND the magnitude is recorded for the worth-gate / recall. Accumulates; dropping it lifts only its own bans. Use `forbid_delivery` for penalties tied to *delivering*. |
| `description: "text"` | Label shown in future prompts, auto-tagged with field names for later `dropMission(field)` |

**Two toolsets.** `buildTools` (action lane — everything) and `buildChatTools` (fast-lane — read-only: the read/reasoning tools plus `ask_partner_status`). The fast-lane physically cannot move the agent.

**Robustness features:**
- Command tools return descriptive failure strings (e.g. `"Failed: target (3,9) is unreachable — a wall, or a tile currently occupied/blocked by an agent."`). `IntentionDeliberation` relays the *first real* plan failure instead of masking it as `no plan for`, so the model can actually act on it.
- Every await in the loop is bounded: model calls 90s, own commands 30s, partner orders 45s, chat sends 5s, handoff steps 60s. A wedged anything cannot freeze the serialized directive lane.
- Stale intentions (`dropping stale intention`) settle their completion promise (`cancel()`) — awaiters never hang.
- After **1** failed command (`MAX_TOOL_FAILURES`) the directive gives up and BDI resumes — the LLM can't keep the agent occupied retrying a stuck command.

---

## 7. Prompts, Memory, Mission Evaluation

**System prompt** (`buildSystemPrompt`) is regenerated per directive and contains: the directive text, live world state (position, parcels, cargo, delivery tiles), **live partner status** (or "not connected: complete missions solo"), the tool catalogue with usage rules, coordinate conventions, game vocabulary, and the strict ReAct/"End" output contract. The sections driving challenge-2 behaviour:

1. **MISSION EVALUATION** — shouted admin messages are *offers* ending with "Bonus is N pts.". Use `path_cost` first and judge NUMERICALLY: a parcel is worth ~tens of points, so each detour step costs roughly that much in forgone income — accept a go-there bonus only when `bonus_points` clearly exceeds `path_cost.steps × ~10` (there and back). Decline (Final Answer exactly `Mission declined.`, no behaviour change) when unreachable, when the bonus loses that comparison, or when accepting would *lower* the score (a negative bonus, or a fractional/diminished delivery reward). Penalty missions you can avoid with a constraint ("lose 50 if you deliver in tile X") and big one-shot bonuses are almost always accepted; an accepted constraint mission ends with the Final Answer exactly `Mission accepted.`. When a go-there bonus is worth it but you should keep working too, prefer `apply_mission {"oneShotBonus":…}` so the BDI picks the moment to divert (it re-checks the same `points − n·ρ·dist` math live).
2. **MISSION TAXONOMY (by axis, not by wording)** — every persistent mission changes exactly ONE behavioural axis; route it to the tool/field for that axis even when the phrasing is novel: WHERE YOU DELIVER (`forbid_delivery` for delivery penalties/0-pts; `allowedDeliveryTiles` for "deliver only at"; `deliveryMultipliers` for positive per-tile bonuses), HOW MANY PER DELIVERY (the FLOOR/CAP pair — `requiredStackSize` for "at least N", `maxStackSize` for "at most N", BOTH for "exactly N"), VALUE/CAP (`maxBundleValue`, `maxParcelReward`), WHERE YOU WALK (`avoidTiles` for a plain "don't go through (x,y)"; `penaltyTiles` for a numbered "going to (x,y) costs N"), GO-THERE BONUS (`oneShotBonus` for "there is a +N reward at (x,y)" the agent should pursue opportunistically), WHERE YOU EXPLORE (`restrict_exploration` / `allowedSpawnerTiles`). NAMED EDGES are fixed: leftmost = least x, rightmost = greatest x, top = greatest y, bottom = least y — pass the side keyword to `forbid_delivery` rather than computing coordinates.
3. **ACTION PLAYBOOK** — one-shot/atomic & Level-3 patterns: "pick up" without coordinates → `pickup_next_parcel()` (trust the "now carrying N" result, don't re-sense); go-to-bonus → `path_cost` then `go_to`; "deliver in (x,y)" → pickup first if empty, then `deliver(x,y)`; calculate/quiz → `calculate` then a bare-numeral Final Answer; "one picks up, other delivers" → `start_handoff()`; "red light green light" *announcement* → do any setup then acknowledge (the live shouts are then interpreted per-shout by the classifier as STOP/GO, §5.2); "both agents near (x,y) and wait" → `gather_near(x,y,D)` (one call positions and holds both).
4. **PARTNER AGENT** — partner tools, automatic constraint mirroring, and the same-tile rule: *two agents can never stand on the same tile; move aside before sending the partner to your own tile*. "A"/"the worker" = the partner; "B"/your own name = you.

**NO SILENT NO-OP.** A mission/ACTION directive must always end with EITHER a tool Action OR an explicit Final Answer — the model is forbidden from going silent on a directive it took no action on. (This is distinct from executed actions, which still end silently per the `End` contract.) Arithmetic coordinates ("x=4×2") are always resolved with `calculate`, never in the model's head.

**Conversational fast-lane prompt** (`buildChatPrompt`) — read-only; explicitly told it cannot move, and surfaces live partner status + active missions so state questions are answered from data. Quiz questions answered here must also be bare numerals (automated checkers match literally).

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

The manual text protocol (regex-parsing `Action:` / `Action Input:` / `End` / `Final Answer:`) is used instead of OpenAI-native `tools`/`tool_calls`: model-agnostic, works with locally-hosted models.

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
npm start                        # single coordinator (node myAgent/coordinator_agent.js)
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
- **The classifier costs one model call** per *non-question* message; questions (ending in `?`) and greetings skip it via the fast-path. It returns STOP/GO (the live red/green-light signals), CHAT, or ACTION, defaulting to ACTION on uncertainty (safe: serialized lane). Mission offers and the red-light-green-light *announcement* are ACTION; only the live shouts are STOP/GO — so a misclassified or slow shout can cost a movement penalty (the price of making the mission LLM-driven; see §5.2).
- **ReAct loop cap: 30 iterations; failure budget: 1 failed command; every await bounded.** A confused, impossible, or wedged directive cannot run — or hang — indefinitely.
- **Latest-wins ACTION lane.** Directives execute one at a time, but a new directive PREEMPTS the running one (it aborts at the next checkpoint) rather than queueing behind it — the most recent order is the only one that counts. Chat questions answer concurrently and never touch the gate.
