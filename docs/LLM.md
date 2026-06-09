# LLM Agent — Complete Context

*Autonomous Software Agents 2025–2026 | University of Trento*
*Single reference document: project context, challenge requirements, architecture, methodology, implementation, and constraints.*

---

## 1. Project Overview

The project runs on **Deliveroo.js** — a web-based parcel delivery game on an M×N grid. Players (agents) score by picking up parcels and delivering them to red delivery tiles before their countdown timers expire. The grid has four tile types: black (wall), green (spawn), red (delivery), white (walkable path). Agents operate under partial observability (sensing radius: Manhattan distance < 5).

**Two-agent system.** The second challenge requires **two cooperating agents** connected to the same game simultaneously:
- **BDI agent** (`myAgent/`) — already built. Handles all low-level execution: A* pathfinding, PDDL crate-pushing, belief revision, intention queuing. Strategies: greedy accumulation, blind exploration, etc.
- **LLM agent** — what this document describes. A command layer on top of the BDI agent that interprets natural-language special missions and drives the BDI agent to execute them.

**Core design principle:** the LLM decides **WHAT** to do; the BDI agent decides **HOW** to do it. The LLM never moves one tile at a time — it issues high-level commands (`go_to`, `go_pickup`, `deliver`) that the BDI plan library (A*) executes and returns from. This avoids the failure modes of a standalone LLM agent (wall collisions, one-model-call-per-tile slowness, no pathfinding).

---

## 2. Second Challenge — Special Missions

Both agents play simultaneously. Standard parcel collection runs autonomously via the BDI strategy. **Special missions** arrive as natural-language messages and must be: read by the LLM, interpreted, and executed by the system.

Special missions score significantly more than standard delivery but **may not always be worth completing** — the system must decide when to accept or ignore them.

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
- *If you deliver parcels with a score higher than 10, you get no reward*

### Level 3 — Multi-agent coordination
Require communication between the BDI agent and the LLM agent, or between an agent and the game chat.

Examples:
- *Move both agents to the neighborhood of (x,y) within distance 3, have them wait for each other — 500pts*
- *If a parcel is initially picked up by one agent and delivered by the other — 200pt bonus*
- *All agents must move to an odd-numbered row and wait for our message before moving again ("red light, green light") — 700pts*

---

## 3. LLM Agent Architecture

### 3.1 File layout

```
myAgent/llm/
  index.js        Entry: wires chat channel + stdin to the routing logic.
                  Routes each message: abort keywords → instant abort;
                  /reset /memory → handled inline; idle → action lane;
                  busy + ACTION → queued; busy + CHAT → fast-lane.
  commandLoop.js  ReAct loops: runDirective (action lane, uses autonomy gate)
                  and runConversation (read-only fast-lane). Also classifyDirective.
  commandTools.js Tool catalogue: read tools (no world effect) + command tools
                  (push BDI intention + await completion). buildTools / buildChatTools.
  prompt.js       System prompts: buildSystemPrompt (action lane) and buildChatPrompt
                  (conversational fast-lane). Both include a live world-state snapshot.

llmAgent/
  llmClient.js    OpenAI-compatible wrapper: callModel(), retry on content-filter errors.
```

Small additions to existing BDI files (nothing removed):

| File | Addition | Purpose |
|---|---|---|
| `context.js` | `directive = { active: false, aborted: false }` | Shared gate: BDI stands down while LLM has control; aborted flag for instant abort |
| `agent.js` | `if (directive.active) return;` in `optionsGeneration` | BDI stops self-directing while LLM is in charge (still senses the world) |
| `IntentionDeliberation.js` | `completion` promise | Lets `commandAndAwait` wait for a goal to finish |
| `IntentionRevisionReplace.js` | `commandAndAwait(goal)`, `haltCurrent()` | Bridge: LLM pushes a goal and waits; abort stops the agent in place |
| `astar.js` | `reachableFrom(me)` | Only offer tiles the agent can actually reach to the LLM |

### 3.2 Control flow

```
chat message / stdin
        │
        ▼
     route()
        │
        ├─ abort keyword? ──→ abortCurrent() [IMMEDIATE, no queue]
        ├─ /reset /memory  ──→ handled inline
        ├─ idle            ──→ enqueue → drain() → runDirective()
        └─ busy
              ├─ CHAT (classifier) ──→ runConversation() [concurrent, read-only]
              └─ ACTION            ──→ enqueue → drain() [waits its turn]
```

**Autonomy gate.** While the LLM is only *thinking* (model calls, read-only tools) the BDI agent keeps doing its own work. The **first command tool** (`go_to`, `go_pickup`, `deliver`, `wait`) sets `directive.active = true` and holds it through the entire directive. When the directive ends (or aborts), `directive.active = false` and the BDI strategy loop resumes.

**Abort mechanism.** Keywords ("exit", "abort", "abort directive", "exit directive", "back to bdi", "go back to bdi") bypass the queue entirely, run `abortCurrent()` synchronously: sets `directive.aborted = true`, clears the queue, calls `haltCurrent()` (which rejects any pending `commandAndAwait`), releases the gate, resumes autonomy. The ReAct loop and all tools check `directive.aborted` and return immediately if set.

### 3.3 The ReAct loop (`runDirective`)

```
for up to MAX_ITERATIONS (20):
    check directive.aborted → exit if true
    call LLM (callModel)
    check directive.aborted → exit if true
    parse output:
        Action + Action Input → run tool, observe result
            check directive.aborted → exit if true
            failure budget: 3 failed commands → give up
        Final Answer → return (no reply sent to chat — silent by design)
finally:
    directive.active = false
    resumeAutonomy()
```

Only the abort reply is sent to chat. Normal directive completion is silent.

---

## 4. Core Methodologies

### ReAct (Reason + Act)
The backbone of the execution loop. At each iteration the model emits exactly one action; the runtime executes the corresponding tool, feeds back an `Observation`, and the model decides the next step. This continues until `Final Answer:` or the iteration cap.

```
Thought: <reasoning>
Action: <tool name>
Action Input: <argument>
--- runtime runs tool ---
Observation: <result>
Thought: ...
Final Answer: <summary>
```

### Chain-of-Thought (CoT)
The `Thought:` line before each action. Forces explicit reasoning before acting. Improves multi-step decisions at the cost of tokens. Required by the output format contract.

### Planner / Executor split (optional, for complex missions)
A planner prompt decomposes an objective into a JSON step list; a separate executor prompt runs each step with its own ReAct mini-loop. Separates "what to do" from "how to do it". Useful for Level 2/3 missions.

```javascript
const PLANNER_PROMPT = `Break the user's request into 1–10 concrete steps.
Return ONLY JSON: {"steps":["step 1","step 2"]}`;

async function createPlan(objective) {
    const raw = await callModel([
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user', content: objective }
    ]);
    try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return { steps: [objective] }; }   // graceful fallback
}
```

### Reflexion / Replanning
When an action fails, the failure observation is fed back into the conversation so the model revises its plan instead of repeating the mistake. Strengthen by tracking consecutive failures and re-invoking the planner with the failure log appended:

```javascript
if (consecutiveBlocked >= 2) {
    const note = `Previous attempt failed: ${lastObservation}. Replan around the obstacle.`;
    plan = await createPlan(`${objective}\n\nConstraint: ${note}`);
}
```

The BDI agent already handles this structurally (intention revision + replanning); the LLM side does it via prompt-level feedback.

### Tool registry
Maps tool names (strings the model produces) to JavaScript functions. Eliminates long `if/else` chains and makes adding tools trivial.

```javascript
const TOOLS = { calculate, get_current_time, go_to, go_pickup, deliver, wait, say };
// Execution: TOOLS[act.action](act.input)
```

---

## 5. Technical Stack & Configuration

**Endpoint:** University of Trento faculty LiteLLM proxy — OpenAI-compatible.

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
    baseURL: process.env.LITELLM_BASE_URL,   // https://llm.bears.disi.unitn.it/v1
    apiKey:  process.env.LITELLM_API_KEY,
});
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

async function callModel(messages, { temperature = 0 } = {}) {
    const r = await client.chat.completions.create({ model: MODEL, messages, temperature });
    return r.choices?.[0]?.message?.content ?? '';
}
```

**Note:** the manual text protocol (parsing `Action:` / `Action Input:` / `Final Answer:` with regexes) is used instead of OpenAI native `tools`/`tool_calls`. This is model-agnostic and works with locally-hosted Llama models.

**Required `.env` keys:**

| Key | Purpose |
|---|---|
| `HOST` | Deliveroo.js server URL |
| `TOKEN` | Agent authentication token |
| `NAME` | Agent display name |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL |
| `LITELLM_API_KEY` | Faculty API key |
| `LOCAL_MODEL` | Model name (e.g. `gpt-4o`, `llama-3.3-70b-lmstudio`) |
| `LOCAL_MODEL_FALLBACK` | Optional second model for content-filter fallback |

**Run:** `npm start` — starts BDI agent + LLM layer (LLM only activates if `LITELLM_API_KEY` is set; otherwise pure BDI runs unchanged).

---

## 6. Tool Catalogue

The LLM has only **high-level** tools — never raw tile-by-tile movement.

| Kind | Tool | Behaviour |
|---|---|---|
| **Reasoning** | `calculate(expr)` | Evaluates math. Accepts comma-separated expressions for multi-coordinate output. Whitelisted chars only (no `eval` on arbitrary code). |
| **Reasoning** | `get_current_time(location)` | Returns local time in Rome as JSON. |
| **Read** | `get_my_position()` | Returns `{x, y, score}`. |
| **Read** | `sense_parcels()` | Free parcels currently in sensing range. |
| **Read** | `sense_delivery_tiles()` | Reachable delivery tiles only (filtered via `reachableFrom`). |
| **Read** | `sense_spawn_tiles()` | Reachable spawn tiles only. |
| **Read** | `get_map_info()` | Map bounds + edge tiles (leftmost/rightmost/top/bottom reachable tiles). |
| **Command** | `go_to(x,y)` | Pushes `go_to` BDI intention, awaits arrival. Returns on success or failure. |
| **Command** | `go_pickup(x,y)` | Navigates to (x,y) and picks up the highest-reward known parcel there. |
| **Command** | `deliver()` | Navigates to the nearest delivery tile and drops all carried parcels. |
| **Command** | `wait(seconds)` | Halts the agent in place for N seconds (max 30). Abort-aware: resolves early if `directive.aborted`. |
| **Chat** | `say(message)` | Sends a chat reply to the directive sender. |

**Two toolsets.** `buildTools` (action lane, has all tools including commands) and `buildChatTools` (fast-lane, read-only subset — calculate, times, sensing). The fast-lane physically cannot move the agent.

**Robustness features:**
- `sense_*` and `get_map_info` return only tiles reachable from the current position (`reachableFrom(me)`), so "leftmost tile" always resolves to a real reachable tile.
- Command tools return a descriptive failure string on rejection (e.g. `"Failed: target (3,9) is unreachable"`). The LLM may try one alternative. After 3 failed commands the directive is auto-aborted.
- `wait` and any inter-tile delay use `abortableDelay` (100ms polling) so the abort keyword interrupts them instantly.
- `llmClient.js` retries once on Azure content-filter false-positives; does not retry on connection/VPN errors (keeps those obvious).

---

## 7. Prompts & Memory

**System prompt** (`buildSystemPrompt`) is regenerated per directive and contains: the directive text, live world state (position, parcels in view, carried parcels, delivery tiles), the tool catalogue with usage rules, coordinate conventions, game vocabulary (spawn tile, delivery tile, leftmost, etc.), and the strict output format contract.

**Conversational fast-lane prompt** (`buildChatPrompt`) — lighter version for read-only questions. Explicitly tells the model it cannot move, can only observe and answer.

**Per-sender conversation memory.** Each chat sender gets a rolling history of the last 5 directive+answer pairs. Follow-ups like "do the same but on a delivery tile" or "I said spawn, not delivery" have context. `/reset` clears it; `/memory` prints it.

---

## 8. Multi-Agent Coordination (BDI ↔ LLM)

Both agents share the same program process and the same belief state (`me`, `parcels`, `deliveryTiles`, etc. from `context.js`). No second socket connection.

**Two coordination channels:**

1. **Shared beliefs (already implemented).** The LLM's sensing tools read the same `parcels` map and `deliveryTiles` list the BDI agent maintains. Both agents' observations merge into one belief base.

2. **SDK messaging (`say`/`shout`).** The Deliveroo.js SDK provides `socket.emitSay(recipientId, text)` and `socket.onMsg(handler)`. This is the channel through which:
   - Special missions arrive (the game server or another player messages our agent).
   - The LLM agent can reply, confirm, or send answers to Level 1 questions.
   - Level 3 coordination happens: agents negotiate who takes which parcel, synchronize position, etc.

**Rule of thumb:** BDI for fast, deterministic execution; LLM for high-level objective interpretation and multi-agent negotiation.

---

## 9. Constraints & Known Limitations

- **VPN required.** The LiteLLM proxy is only reachable on the university network. Connection errors are not retried.
- **Model availability.** Only `gpt-4o` reliably answers on the proxy at time of writing; `llama-3.3-70b-lmstudio` returns HTTP 500. Smaller models drift from the strict output format more often.
- **BDI runs during LLM thinking, not during commands.** The agent keeps doing autonomous BDI work while the LLM is reasoning (before the first command fires). Once the first command runs, the gate is held — so a "freeze" will freeze wherever the agent was *when the command fired*, not where it was when the directive was typed.
- **Shared-game reachability is dynamic.** `reachableFrom` is a static snapshot; another player may block a path after a tile is chosen. `go_to` can still fail mid-way; the LLM may try one alternative, then the directive is abandoned.
- **Directive replies are silent.** By design, the agent sends no confirmation when a directive completes — only the abort reply ("Aborted.") and `/reset`/`/memory` responses are echoed to chat.
- **ACTION-vs-CHAT classifier costs one model call.** Only when the agent is already busy and a new message arrives. Defaults to ACTION on uncertainty (safe: queues rather than risking a concurrent move).
- **ReAct loop cap: 20 iterations; failure budget: 3 failed commands.** A confused or impossible directive cannot run indefinitely.
