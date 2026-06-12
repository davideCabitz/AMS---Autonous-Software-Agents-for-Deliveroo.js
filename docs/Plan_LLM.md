# LLM Command Layer Upgrade — Challenge 2 (Two-Agent Coordinator/Worker)

Repo root: `c:\Users\Davide Cabitza\GitHub\AMS---Autonous-Software-Agents-for-Deliveroo.js`

## Context

The project is a Deliveroo.js BDI agent (`myAgent/`) plus an LLM command layer (`myAgent/llm/`, ~960 lines, working) that interprets natural-language directives via a flat ReAct loop and drives the BDI layer with coarse commands. The 2nd course challenge ("special missions", see `docs/LLM_context.md` and `lab/missionAgents/`) requires **two agents connected simultaneously** that read shouted natural-language missions, decide whether to accept them, and execute them — including persistent strategy-modifying missions and multi-agent coordination missions.

**Decisions made with the user (do not relitigate):**
1. **Topology: one LLM coordinator.** Agent A (coordinator) runs the LLM layer and commands both itself and Agent B (worker = plain BDI + lightweight JSON order handler over `emitSay`).
2. **Loop: keep flat ReAct** (lab 07C style). No planner/executor split. Rationale for the report: 08B's planner helps a weak LLM over static tools; here decomposition is already solved by gpt-4o + coarse BDI plans, while a pre-computed plan goes stale in a dynamic game and multiplies LLM latency on decaying parcels.
3. **Mission acceptance: LLM evaluates cost/benefit** (new `path_cost` tool + prompt guidance) and may decline.
4. **Scope: incremental upgrade** of `myAgent/llm/`, not a rewrite.

## Verified facts (read from code)

- `socket.emitShout` is rebroadcast server-side as a `msg` event (SDK `DjsServerSocket.js:213`), so the existing `socket.onMsg` handler in `myAgent/llm/index.js` already receives mission shouts; replies via `emitSay(sender, ...)` reach the mission agent (QuestionAnswer listens on `onMsg`).
- `myAgent/context.js:15` calls `DjsConnect()` with no args → uses `process.env.TOKEN`. `.env` has only `TOKEN_Alfiere` and `TOKEN_BDI` → launch infra needed (Phase 0).
- `myAgent/plans/GoDeliver.js` `execute(intent, x, y)` is **already parameterized** — only the LLM `deliver()` tool hardcodes the nearest tile.
- Constraint enforcement exists: `avoidTiles` in `myAgent/utils/astar.js` (~line 323), `allowedDeliveryTiles`/`requiredStackSize` in `myAgent/strategies/Strategy.js` (~lines 73, 103, 312). **Missing**: max-bundle-value constraint (scenario 26c2_7).
- No putdown primitive outside `GoDeliver` — needed for the handoff (26c2_8).
- `directive = { active, aborted }` in `myAgent/context.js` gates autonomy; `myAgent.commandAndAwait(predicate)` (`IntentionRevisionReplace.js`) pushes intentions and returns a completion promise; `myAgent.haltCurrent()` stops the running plan.
- LLM config: OpenAI SDK → `LITELLM_BASE_URL` (unitn proxy), `LOCAL_MODEL=gpt-4o`. Never use Ollama.

## Official mission catalogue (from `lab/missionAgents/start.js` + `challenge2/26c2_*.json`)

1. `26c2_1` GoTo +1000 una tantum: "Go to one of these coordinates ... (19,19), (20,19), (21,19)"
2. `26c2_2` DeliverAt +1000: "Deliver a package in 1,1 ..."
3. `26c2_3` QuestionAnswer +10000, answer "22": "Calculate (5*(5+3)/2)+2 ..."
4. `26c2_4` GoTo penalty −1000 persistent: "Do not go through tiles (13,15) (14,15) (15,15) (16,15) ..."
5. `26c2_5` deliverExactlyN +100/event: "Deliver exactly three packages at a time."
6. `26c2_6` DeliverAt penalty −500 persistent: "Do never deliver in (15,32) (16,32) (15,31) (16,31)."
7. `26c2_7` DeliverLessValueThan +1000/event, threshold 10: "Every time you deliver parcels for a total amount of reward lower or equal to 10 ..."
8. `26c2_8` OnePickupAnotherDeliver +500 each: "If you pick up a parcel and another agent delivers it, you both receive a bonus."
9. `26c2_9` RedLightGreenLight −10/move: shouts exactly `"RED LIGHT! Stop moving until the next green light!"` / `"GREEN LIGHT! You can move again!"` on a 20s cycle with a **5s grace period** after RED before penalties.
10. `26c2_10` (manual, +500): "Move both agents to the neighborhood of position (19,5) within a maximum distance of 3, and have them wait for each other."

Mission agents append `" Bonus is <N>pts."` to every prompt — usable for cost/benefit reasoning.

---

## Phase 0 — Two-agent launch infrastructure

**New `myAgent/launch.js`** (~25 lines): `import 'dotenv/config';` first, then set `process.env.AGENT_ROLE` and `process.env.TOKEN` (coordinator → `TOKEN_Alfiere`, worker → `TOKEN_BDI`) from `process.argv[2]` **before** `await import('./agent.js')` (context.js connects at module load).

**Modify `myAgent/context.js`**: `export const role = process.env.AGENT_ROLE ?? 'coordinator';`

**`package.json` scripts**: `"start:coordinator": "node myAgent/launch.js coordinator"`, `"start:worker": "node myAgent/launch.js worker"`.

**Modify `myAgent/agent.js`**: branch on role — coordinator keeps `registerLlm(...)` (when `LITELLM_API_KEY` set); worker skips it and calls `registerWorker(myAgent, { resumeAutonomy: optionsGeneration })` from new `myAgent/partnerWorker.js`.

## Phase 1 — Tool gaps on the coordinator (single-agent missions)

All in `myAgent/llm/commandTools.js` unless noted. Reuse existing helpers: `parseXY`, `resolveParcelId`, `nearestDelivery`, `onlyReachable`, `command()` wrapper.

1. **`deliver_at(x,y)`**: extend `deliver(input)` — optional coords via `parseXY`; if given, `command(['go_deliver', x, y], ...)`; else keep `nearestDelivery()`. Covers 26c2_2.
2. **`put_down()`**: `socket.emitPutdown()`, then remove carried parcels from beliefs (`parcels.carriedBy(me.id)` → `parcels.remove(id)`); return "Dropped N parcel(s) at (x,y)." Needed for 26c2_8 handoff.
3. **`path_cost(x,y)`**: use `findRoute(me, {x,y})` from `myAgent/utils/astar.js`; return JSON `{steps, estSeconds, decayLostPerParcel}` (use move timing/decay info from context if available), or "unreachable" on null. For the accept/decline decision.
4. **`apply_mission` extension**: new `maxBundleValue` field → `missionConstraints.maxBundleValue` (add field, default null, in `myAgent/context.js`); add to `dropMission` map and `dropMissions()`.
5. **Enforce `maxBundleValue` in `myAgent/strategies/Strategy.js`** (near the `requiredStackSize` logic ~line 312): when set, only pick parcels with `reward <= maxBundleValue` and deliver one cheap parcel at a time (effective stack size 1, bundle sum never exceeds threshold). Simple and safe — +1000/event dwarfs cargo optimization.
6. **Holding**: prefer adding `hold()` / `release_hold()` tools backed by the Phase 3 freeze flag (instead of raising the 30s `wait` cap) for 26c2_10 "wait for each other".

## Phase 2 — Partner link (coordinator ⇄ worker)

### Protocol (JSON strings over `emitSay`; non-JSON ignored by the worker except the red/green fast-path)

Coordinator → worker:
```json
{"type":"hello_ack"}
{"type":"order","orderId":"o1","predicate":["go_to",5,3]}   // also ["go_pick_up",x,y], ["go_deliver",x,y]
{"type":"putdown","orderId":"o2"}
{"type":"halt"}   {"type":"resume"}
{"type":"constraint","op":"apply","config":{...apply_mission shape...}}
{"type":"constraint","op":"drop","field":"avoidTiles"}
{"type":"constraint","op":"dropAll"}
{"type":"status_req"}
```
Worker → coordinator:
```json
{"type":"hello","role":"worker","name":"..."}   // emitShout every 5s until hello_ack
{"type":"result","orderId":"o1","ok":true,"detail":"arrived at (5,3)"}
{"type":"status","x":5,"y":3,"score":120,"carrying":[{"id":"p1","reward":7}],"frozen":false}
```

### New `myAgent/llm/missionState.js` (shared refactor)
Extract constraint-mutation logic from `apply_mission`/`dropMission`/`dropMissions` in `commandTools.js` into `applyMissionConfig(config)`, `dropMissionField(field)`, `dropAllMissions()` — used by both coordinator tools and worker handler.

### New `myAgent/partnerWorker.js` (worker side, ~120 lines)
`registerWorker(myAgent, { resumeAutonomy })`:
- Hello loop: `emitShout({type:'hello',...})` every 5s until `hello_ack`; record `coordinatorId`.
- `socket.onMsg`: parse JSON, dispatch:
  - `order`: `directive.active = true; await myAgent.commandAndAwait(predicate)` → send `result` (ok/detail); `finally` release gate + `resumeAutonomy()` **unless frozen**. For `go_pick_up` with only x,y, resolve parcel id from own beliefs (like `resolveParcelId`).
  - `putdown`: emitPutdown + belief cleanup → `result`.
  - `halt`: `frozen = true; directive.active = true; myAgent.haltCurrent();`
  - `resume`: `frozen = false; directive.active = false; resumeAutonomy();`
  - `constraint`: via `missionState.js`.
  - `status_req`: reply `status` snapshot.
- Non-JSON messages: red/green keyword fast-path only (Phase 3).

### New `myAgent/llm/partner.js` (coordinator side, ~100 lines)
`export const partner = { id: null, lastStatus: null };`
`initPartnerLink(socket)` (hooked from `registerLlm`); `sendOrder(predicate, timeoutMs=45000)` → orderId promise map, returns `detail` string as tool observation; `sendHalt()`, `sendResume()`, `sendConstraint(op,payload)`, `requestStatus()`.

### Coordinator tools (add to `buildTools`)
`order_partner_goto`, `order_partner_pickup`, `order_partner_deliver` (coords optional), `order_partner_putdown`, `halt_partner`, `resume_partner`, `ask_partner_status`. All return `'No partner connected yet.'` when `partner.id == null`.

### Constraint mirroring
After local apply in `apply_mission`/`restrict_exploration`/`dropMission(s)`, fire-and-forget `sendConstraint(...)` to the worker — persistent missions (26c2_4/5/6/7) bind both agents.

### Routing change in `myAgent/llm/index.js`
At top of `route()`: `try { const j = JSON.parse(text); if (j?.type) return handlePartnerMessage(j, sender); } catch {}` — protocol JSON never hits `classifyDirective`.

## Phase 3 — Red light / green light fast-path (no LLM in the loop)

**`myAgent/context.js`**: `export const trafficLight = { red: false };`

**Coordinator `route()`** (before abort-keyword check):
```js
if (/\bred light\b/i.test(text))  { trafficLight.red = true;  myAgent.haltCurrent(); sendHalt();  return; }
if (/\bgreen light\b/i.test(text)) { trafficLight.red = false; resumeAutonomy?.();   sendResume(); return; }
```
**Worker**: identical keyword fast-path on raw messages (hears the shout directly; relayed halt/resume is redundancy).

**Gating while red** (penalty per movement):
- `agent.js` `optionsGeneration()`: `if (trafficLight.red) return;`
- `commandTools.js` `command()`: refuse with "RED LIGHT in force" observation.
- Worker `order` handler: same refusal.
- 5s grace covers any in-flight `emitMove`. On green, `resumeAutonomy()` both sides.

The mission announcement itself still reaches the LLM as a directive — prompt tells it to acknowledge (Final Answer); the runtime handles lights automatically.

## Phase 4 — Prompt upgrade (`myAgent/llm/prompt.js` `buildSystemPrompt`)

Add sections:
1. **PARTNER AGENT**: list partner tools; note constraints auto-mirror; include live `partner.lastStatus` line (or "not connected").
2. **MISSION EVALUATION**: shouted admin messages are mission offers ending "Bonus is N pts." Use `path_cost` before accepting; DECLINE (say() polite refusal + Final Answer, no behaviour change) if bonus doesn't outweigh lost delivery income; penalty/"do not" missions → almost always accept as constraints.
3. **MISSION PATTERNS** (one line each mapping catalogue → tools): go-to-bonus → path_cost+go_to; deliver-in-(x,y) → go_pickup+deliver_at; calculate-question → calculate then say() **exactly the numeric result**; do-not-cross-tiles → apply_mission avoidTiles; exactly-N → requiredStackSize; never-deliver-at → allowedDeliveryTiles = all delivery tiles EXCEPT forbidden (sense_delivery_tiles first); bundle-value≤T → maxBundleValue; one-picks-other-delivers → start_handoff(); red-light → acknowledge only (runtime handles); both-agents-near-(x,y)-within-D → two distinct walkable tiles, go_to + order_partner_goto, then hold both.
4. **Arithmetic note**: coordinates may be expressions ("x=4*2") — always resolve with `calculate` first.
5. Document new tools (deliver_at, put_down, path_cost, partner tools, start/stop_handoff, hold/release_hold, maxBundleValue).

Also: raise `MAX_ITERATIONS` 20 → 30 in `commandLoop.js`; consider `COMMAND_TIMEOUT_MS` 30s → 60s in `commandTools.js` for long cross-map orders.

## Phase 5 — Handoff routine for 26c2_8 (`myAgent/llm/handoff.js`, new)

Deterministic background loop started/stopped by LLM tools `start_handoff()` / `stop_handoff()` (bonus repeats per delivery; the LLM should not babysit cycles):
1. `sendHalt()` — worker stops picking up its own parcels (would void the cross-agent bonus).
2. Coordinator picks best free parcel → `commandAndAwait(['go_pick_up',x,y,id])` (holds `directive.active`).
3. Meeting tile M = walkable tile adjacent to the delivery tile nearest the worker; coordinator `go_to(M)` + `emitPutdown()`.
4. Coordinator steps off M (agents can't share a tile).
5. `sendOrder(['go_pick_up', M.x, M.y])` then `sendOrder(['go_deliver'])` → +500 each.
6. Repeat; on stop: `sendResume()`, release gate. Failed step → retry next cycle with another parcel; no parcels → idle 2s.

**Gate interplay fix**: `runDirective`'s `finally` in `commandLoop.js` must skip resetting `directive.active` while `handoffRunning()` (getter exported from handoff.js); wire the abort path in `index.js` to also call `stopHandoff()`.

## Phase 6 — Verification

Setup (4 terminals): Deliveroo server at `HOST`; `.env` needs `ADMIN_TOKEN` added for mission agents (currently missing); `npm run start:coordinator` (expect "command layer ready"); `npm run start:worker` (expect hello → "partner connected"); edit `lab/missionAgents/start.js` to select a scenario and run `node lab/missionAgents/start.js` (server must have the matching `challenge2/26c2_N.json` map loaded).

Per scenario, observe:
- **1**: path_cost → go_to(19,19) → +1000. **2**: go_pickup → deliver_at(1,1) → +1000. **3**: calculate→22, say("22") to admin id → +10000.
- **4**: avoidTiles on BOTH agents; no −1000 over several minutes. **5**: requiredStackSize 3 mirrored; +100/delivery of exactly 3. **6**: never delivers at forbidden tiles. **7**: maxBundleValue 10; single low-value deliveries; +1000/event.
- **8**: handoff cycle repeats; +500 each per parcel. **9**: both stop within grace on RED, resume on GREEN, ≥3 cycles, zero penalties. **10**: both within distance 3 of (19,5), holding.
- **Regression**: stdin directives, abort keyword, chat lane, BDI-only mode (no LLM key), and solo mode (no worker → partner tools return "No partner connected yet.").

## Implementation order
Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 (3 and 4 parallelizable after 2; verify incrementally per phase).

## Critical files
- `myAgent/llm/commandTools.js` — deliver_at, put_down, path_cost, partner/handoff/hold tools, maxBundleValue
- `myAgent/llm/index.js` — JSON intercept, red/green fast-path, partner link init, abort→stopHandoff
- `myAgent/llm/prompt.js` — partner / evaluation / mission-pattern sections
- `myAgent/llm/commandLoop.js` — MAX_ITERATIONS, handoff gate fix
- `myAgent/partnerWorker.js` (new), `myAgent/llm/partner.js` (new), `myAgent/llm/handoff.js` (new), `myAgent/llm/missionState.js` (new refactor)
- `myAgent/context.js` — role, trafficLight, maxBundleValue; `myAgent/agent.js` — role branch, red-light gate; `myAgent/launch.js` (new); `package.json` scripts
- `myAgent/strategies/Strategy.js` — maxBundleValue enforcement
