# LLM Agent — Implementation Report

*Dear AL, since u've **never worked with LLMs**, I've written this doc so u can understand what was built, how it works, and the tests we ran to prove it.*

---

## 1. Summary 

We added an **LLM** to the project as a layer that sits **on top of our existing BDI agent** (`myAgent/`). You can type or chat an instruction in plain English — *"go pick up the parcel at (13,0) and deliver it"* — and the LLM figures out the steps and **tells the BDI agent what to do**. The BDI agent still does the actual driving (pathfinding, picking up, delivering) exactly as before. When the instruction is done, the agent goes back to playing on its own.

**Key idea:** the LLM decides **WHAT** to do; the BDI agent decides **HOW** to do it.

---

## 2. Background — for someone new to LLM agents

If you've never built with an LLM, read this section first. Three concepts are enough.

**(a) An LLM only produces text.** You send it a conversation (some "system" instructions + the user's message) and it replies with text. By itself it cannot move anything in the game — it can only *write words*.

**(b) "Tools" turn its words into actions.** We tell the LLM, in its instructions: *"If you want to act, reply in this exact format — `Action: go_to` / `Action Input: 5,3`."* Our program reads that text, recognises `go_to`, and actually runs the corresponding JavaScript function. The function does something real (commands the BDI agent to walk to 5,3) and returns a short result string ("Arrived at (5,3)"). We paste that result back into the conversation as an **Observation**. Now the LLM can read what happened and decide its next step.

**(c) The ReAct loop.** Repeating (b) in a loop is the whole engine:

```
   Reason  → the model thinks and picks ONE action
   Act     → our code runs the matching tool
   Observe → we feed the tool's result back to the model
   …repeat until the model says "Final Answer: <done>"
```

That loop — **Rea**son + **Act** — is called *ReAct*. It's how the LLM strings several steps together to satisfy an instruction.

**Why we put the LLM "on top of" the BDI agent instead of letting it play directly.**
An LLM is bad at low-level game control. If you ask it to walk somewhere, it tries one tile at a time, bumps into walls, and wastes time (we tried this first — see §10). But our BDI agent is *excellent* at that: it has A\* pathfinding, strategies, scoring. So we don't let the LLM move tile-by-tile. Instead the LLM's "tools" are **high-level commands** — `go_to`, `go_pickup`, `deliver` — that hand the job to the BDI agent. Think of the LLM as a **manager who reads English and gives orders**, and the BDI agent as the **expert worker** who already knows how to walk the map.

---

## 3. Architecture

```
            chat / typed instruction  (socket.onMsg, or terminal)
                      │
                      ▼
         ┌──────────────────────────┐
         │   LLM command layer        │   myAgent/llm/
         │   (the ReAct loop)         │
         │  Reason → Act → Observe    │
         └──────────────────────────┘
            │ "thinking" tools │ "doing" commands
            │ (no game effect) │ (go_to / go_pickup / deliver)
            ▼                   ▼
   calculate, get_time,   myAgent.commandAndAwait(intention)
   sense_*, position             │  push a BDI intention, wait for it to finish
                                 ▼
         ┌──────────────────────────┐
         │  BDI agent (myAgent/)      │   ONE socket, ONE belief base
         │  A* / PDDL / strategies    │   does the real driving
         └──────────────────────────┘
              │ reply in chat (emitSay)   ▲ when the instruction is done,
              ▼                           │ autonomous play resumes
          the person who asked
```

Five design decisions make this work:

1. **Same program, same connection, shared knowledge.** The LLM layer imports the *same* `socket`, `me`, `parcels`, `deliveryTiles` the BDI agent already uses (`myAgent/context.js`). There is no second connection and no duplicate world-state.
2. **One ReAct loop** per instruction (simple and predictable).
3. **An "autonomy gate".** While the LLM is carrying out an instruction, the BDI agent's automatic decision-making is paused so the two don't fight over the player. It resumes the moment the instruction finishes.
4. **"Command-and-wait".** When the LLM issues `go_to(9,11)`, our code pushes that as a normal BDI goal and **waits** until the BDI agent (via A\*) actually arrives, then tells the LLM the result. This keeps the LLM in sync with reality.
5. **A conversational fast-lane.** A message that is just a *question* ("can you hear me?", "where are you?") is answered **immediately and concurrently** with read-only tools — it never waits behind a long action like a 25-second wait (see §6).

---

## 4. What was built

### New files — `myAgent/llm/`

```
myAgent/llm/
  index.js        connects the chat channel; ROUTES each message to the ACTION lane
                  (one instruction at a time) or the conversational fast-lane
                  (answered concurrently); keeps a short memory per sender (so "do
                  the same" works); supports /reset and /memory; replies via chat;
                  also reads the terminal for testing; waits until connected first
  commandLoop.js  the ReAct loops: runDirective (actions, uses the autonomy gate) and
                  runConversation (read-only chat); plus classifyDirective (ACTION vs CHAT)
  commandTools.js the tools the LLM can use (see §5): the full set for actions, and a
                  read-only subset (buildChatTools) for the conversational lane
  prompt.js       the instructions we give the LLM (its rules + a glossary of game
                  terms + a live snapshot of the world + the strict reply format)
```

It reuses one file from the earlier prototype: `llmAgent/llmClient.js`, which is the small wrapper that actually sends the conversation to the model.

### Small additions to the existing BDI code (nothing old was removed)

| File | What we added | In plain words |
|---|---|---|
| `myAgent/context.js` | `directive = { active: false }` | a shared on/off switch: "is the LLM currently in charge?" |
| `myAgent/agent.js` | one line: `if (directive.active) return;` inside `optionsGeneration` | when the LLM is in charge, the BDI agent stops choosing its own goals (but still keeps sensing the world). Also: the LLM layer only turns on if an API key is configured — otherwise the BDI agent runs exactly as before. |
| `myAgent/intentions/IntentionDeliberation.js` | a `completion` promise | lets us *wait* for a goal to finish and find out if it succeeded |
| `myAgent/intentions/IntentionRevisionReplace.js` | `commandAndAwait(goal)` and `haltCurrent()` | the bridge the LLM tools use ("make this your next goal, tell me when done"), and a way to stop the agent in place (used by the `wait` tool) |
| `myAgent/utils/astar.js` | `reachableFrom(me)` | computes which tiles the agent can actually reach, so the LLM is only offered reachable tiles (see §5) |

---

## 5. The tools the LLM can use

The LLM is deliberately given only **high-level** tools — it can never move one tile at a time.

| Kind | Tools | What it does |
|---|---|---|
| **Thinking** (no game effect) | `calculate(expression)`, `get_current_time(location)` | do maths; get the time in Rome |
| **Looking** | `get_my_position()`, `sense_parcels()`, `sense_delivery_tiles()`, `sense_spawn_tiles()`, `get_map_info()` | read the current world state: where parcels are, where the drop-off (delivery) tiles are, where the green spawn tiles are, and the map's reachable bounds/edges |
| **Doing** | `go_to(x,y)`, `go_pickup(x,y)`, `deliver()` | hand a goal to the BDI agent and wait for it to finish |
| **Waiting** | `wait(seconds)` | hold position without moving for N seconds (max 30) — for "stop/wait/don't move for N s". It really stops the agent (it doesn't just claim to). |
| **Talking** | `say(message)` | send a chat message back to whoever gave the instruction |

**Two things make these robust:**

- **Reachable-only tiles.** `sense_spawn_tiles`, `sense_delivery_tiles` and `get_map_info` only report tiles the agent can actually get to (computed with `reachableFrom`). So when an admin says *"go to the leftmost tile"* it correctly means the leftmost **reachable** one — the admin never has to spell that out.
- **Graceful failure + fallback.** If a "doing" tool fails (blocked, times out after ~60 s), it returns a clear message like *"Failed: target (3,9) is unreachable"*. Because this is a **shared** game (other players can block a path at any moment), the LLM is told to then try the next-best candidate from its list (e.g. the next-rightmost tile) instead of giving up.

---

## 6. What happens, step by step, for one instruction

1. **An instruction arrives** — from in-game chat (`socket.onMsg`) or typed in the terminal. We wait until the agent is actually connected, and we handle one instruction at a time.
2. **Autonomy gate ON** — the BDI agent stops picking its own goals.
3. **The ReAct loop runs** — the LLM reads the instruction + a short memory of the last few instructions + a snapshot of the world, replies with one action, we run the matching tool, we feed back the result, and repeat — until the LLM says `Final Answer:` (max 12 steps as a safety limit).
4. **Reply** — the final answer is sent back in chat (or printed in the terminal), and the instruction + answer are saved to memory.
5. **Autonomy gate OFF** — the BDI agent immediately goes back to playing on its own.

**Conversation memory.** Each chat sender gets a short rolling memory (the last ~5 instructions + answers), so follow-ups like *"do the same but on a delivery tile"* or *"I said spawn, not delivery"* have context. Two special messages: **`/reset`** clears the memory, **`/memory`** prints it.

### Two lanes: doing vs talking

The agent can be **doing** something (e.g. a 25-second `wait`) when a new message arrives. We don't want a quick question to be stuck behind that. So every incoming message is routed:

- If the agent is **idle**, the message just runs (steps 1–5 above).
- If the agent is **busy** with an action, we ask the model one cheap question: *is this new message an ACTION (move/pick up/wait/…) or just CHAT (a question/greeting)?*
  - **ACTION** → it **queues** behind the running instruction (we never run two movements at once — that's what the autonomy gate protects).
  - **CHAT** → it runs on the **fast-lane**: a separate read-only loop that can look at the world and reply, but **cannot move the agent and never touches the autonomy gate**. It answers *while* the action keeps running.

That read-only restriction is the whole safety story: the fast-lane physically can't move the player, so the two lanes can never fight. The only things that happen concurrently are *reading state* and *talking* — both harmless.

---

## 7. How to run it

```bash
npm start            # starts the BDI agent + the LLM layer (if a key is set)
```

At startup you should see:
```
[llm] command layer ready — type a directive and press enter (or message the agent in chat).
```
(If instead you see `[llm] LITELLM_API_KEY not set — running BDI only`, the LLM is off and only the BDI agent runs — useful to know it never breaks the base agent.)

Then give it an instruction either by **typing in the terminal** or **chatting to the agent in-game**. Required `.env` keys: `HOST`, `TOKEN`, `NAME` (BDI) and `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LOCAL_MODEL` (LLM).

---

## 8. Tests we ran (with real output)

We tested in two stages: a deterministic plumbing test (no real model needed), then live runs against the real game with a real model.

> **Model note:** the model assigned to us (`llama-3.3-70b-lmstudio`) and the other local models currently return an error (HTTP 500) from the faculty proxy — only `gpt-4o` answered. So the live tests below used `LOCAL_MODEL=gpt-4o`. The code uses whatever `LOCAL_MODEL` in `.env` names, so switch back to the assigned model once the proxy is healthy.

### Test A — plumbing test (no real LLM)
`node llmAgent/test/smoke.mjs` stands up a *fake* model that returns scripted replies, and runs the real tool code against the live local server. **Result: ALL CHECKS PASSED** — connection, reading tools, the maths tool (`calculate("11 + 2") = 13`), the safety check (it refused `calculate("process.exit(1)")`), and the time tool all behaved. This proves the wiring works without spending any real model calls.

### Test B — full pick-up → deliver (real model, live game)
Instruction: *"sense the parcels in view, go pick up the highest-reward one, then deliver it and tell me the result."*

```
[llm] directive from console: sense the parcels ... pick up the highest-reward one ... deliver it
[llm tool] sense_parcels(none) -> [{"id":"p800","x":16,"y":0,"reward":21},
                                   {"id":"p798","x":14,"y":0,"reward":53},
                                   {"id":"p801","x":13,"y":0,"reward":56}]
[agent] pursuing: go_pick_up 13 0 p801                ← BDI agent now driving (A*)
[llm tool] go_pickup(13,0) -> Picked up parcel p801 at (13,0); now carrying 1.
[agent] pursuing: go_deliver 12 8
[llm tool] deliver(none) -> Delivered at (12,8); score now 2137.
[llm] reply -> console: Picked up parcel p801 with reward 56 and delivered it at (12,8),
                        increasing the score to 2137.
```
**What this proves:** the LLM correctly read the three parcels, chose the highest reward (56), and the BDI agent actually walked there, picked up, and delivered — the complete cycle, end to end.

### Test C — instruction needing maths + movement
Instruction: *"what is your current position? then move 2 tiles to the right and report your final position."*

```
[llm tool] get_my_position(none) -> {"x":13,"y":0,"score":4966}
[llm tool] calculate("13 + 2") -> Error: invalid expression ...   ← model used quotes
[llm tool] calculate(13 + 2)   -> 15                              ← model self-corrected
[agent] pursuing: go_to 15 0
[llm tool] go_to(15,0) -> Arrived at (15, 0).
[llm] reply -> console: I started at (13, 0) and moved 2 tiles to the right to reach (15, 0).
```
**What this proves:** the LLM chains tools together (look → calculate → move) and **recovers from its own mistake** (the first `calculate` was rejected, so it retried correctly) without crashing.

### Test D — instruction sent over **in-game chat** by another agent
This is the real use-case: another player/admin messages our agent.

```
[llm] directive from 93d938: go to the further left zone
[llm tool] sense_delivery_tiles(none) -> [{"x":9,"y":11}, ... ]
[agent] pursuing: go_to 9 11                          ← BDI agent drives there
[llm tool] go_to(9,11) -> Arrived at (9, 11).
[llm] reply -> 93d938: I navigated to the further left zone at coordinates (9, 11).
[agent] pursuing: go_explore 0 10                     ← autonomy resumed automatically
```
**What this proves:** the whole loop works over chat — instruction in → LLM reasons → BDI agent drives → reply sent back to the sender → the agent goes back to playing on its own.

### Test E — waiting, spawn tiles, memory, and reachable fallback (real model)
A later round of testing added the `wait` tool, the spawn-tile / map tools, conversation memory, and reachable-only tile filtering. Two instructions in a row:

Instruction 1: *"go to the rightmost spawn tile and wait there 2 seconds."*
```
[llm tool] sense_spawn_tiles(none) -> [ ... ,{"x":22,"y":19},{"x":23,"y":4}]
[llm tool] go_to(23,4)  -> Failed: no plan applies to go_to 23 4.   ← blocked right now
[llm tool] go_to(22,4)  -> Failed: no plan applies to go_to 22 4.   ← tries next candidate
[llm tool] go_to(22,19) -> Arrived at (22, 19).                     ← reachable one
[llm tool] wait(2)      -> Waited 2 second(s) holding position at (22, 19).
[llm] reply -> I navigated to the rightmost spawn tile at (22, 19) and waited there for 2 seconds.
```
Instruction 2: *"do the same but on a delivery tile."*
```
[llm tool] sense_delivery_tiles(none) -> [ ... {"x":15,"y":11}]
[llm tool] go_to(15,11) -> Arrived at (15, 11).
[llm tool] wait(2)      -> Waited 2 second(s) holding position at (15, 11).
[llm] reply -> Reached the rightmost delivery tile at (15, 11) and waited for 2 seconds.
```
**What this proves:** (a) `wait` actually holds the agent still instead of pretending; (b) the agent knows what a *spawn tile* is and can locate it; (c) when the literal rightmost tile is momentarily blocked by another player it **falls back** to the next reachable one instead of giving up; (d) **memory** works — "do the same" correctly repeated the go-to-and-wait pattern, and even carried over "rightmost".

### Test F — answering a question *while busy* (the conversational fast-lane)
We sent an action and then, immediately, a question — the question was answered **during** the action, not after it.

Instruction 1: *"wait where you are for 25 seconds."*  Instruction 2 (sent right after): *"can you hear me?"*
```
[llm] directive from console: wait where you are for 25 seconds
[llm:chat] message from console: can you hear me?                ← classified CHAT → fast-lane
[llm] reply -> console: Yes, I can hear you. How can I assist you today?   ← answered DURING the wait
[llm tool] wait(25) -> Waited 25 second(s) holding position at (11, 4).    ← 25s later
[llm] reply -> console: Waited for 25 seconds at my current position as instructed.
```
**What this proves:** the question reply appears **before** the wait finishes — the agent answered concurrently instead of making the admin wait 25 seconds. Movement stays serialized; only the verbal reply runs in parallel.

### What the tests also revealed (and we fixed)
The first live runs of the *old* standalone prototype (§10) exposed two real bugs, which we fixed in the command layer:
- The model sometimes writes `Action: go_to(5,3)` (function-call style). Our parser only accepted `go_to` + a separate input, so it failed with "unknown tool". **Fixed:** the parser now accepts both styles (visible in Test C — `calculate(13 + 2)` parsed fine).
- A single API error used to crash the whole agent. **Fixed:** model calls are wrapped so an error becomes a chat message instead of a crash.

---

## 9. Known limitations (be aware of these)

- **Needs the VPN / a reachable model.** The model lives behind the faculty proxy; without the university VPN the call fails with "Connection error". We deliberately do **not** auto-retry on this (it's an environment issue, not a bug) — connect the VPN and re-send.
- **Model availability.** Only `gpt-4o` answers on the proxy right now; the assigned 70B model errors out. Smaller models also tend to drift from the strict reply format more than gpt-4o.
- **It finishes its current action before obeying.** When an instruction arrives, the agent stops choosing *new* goals, but it lets the goal it's *already doing* finish first. So for ~1–2 seconds (while the model is "thinking") you may see it complete its previous move before switching to your instruction. (This is intentional; it can be changed to "stop instantly" if we prefer.)
- **Shared-game reachability is dynamic.** We only offer the LLM tiles it can reach, but other players can block a path *after* a tile was chosen. That's why a `go_to` can still fail mid-way; the LLM then falls back to the next candidate. A static check can't fully predict a moving opponent.
- **Vague wording is still interpreted.** With the glossary the agent now understands "spawn tile", "delivery tile", "leftmost/rightmost", etc. But genuinely ambiguous wording is still resolved by the model's judgement; precise instructions remove any guesswork.
- **The ACTION-vs-CHAT split is a model call.** When a message arrives *while the agent is busy*, we spend one extra (cheap) model call to classify it. If it's unsure it defaults to ACTION (the safe side — it queues rather than risking a concurrent move). A genuinely mis-classified action would just be handled verbally ("I'll do that next") instead of moving — never a wrong move.

---

## 10. Background: the earlier prototype (`llmAgent/`)

Before this, we built a **standalone** LLM agent (`llmAgent/`) that opened its *own* connection and tried to play the game by itself, moving one tile at a time. Live testing showed this was the wrong approach — it navigated blindly into walls, was slow (one model call per tile), and crashed on API errors. Those failures are exactly why we switched to the command-layer design: instead of having the LLM compete with the BDI agent, we made it *command* the BDI agent. The old code stays in the repo for reference (and we reuse its `llmClient.js`); it is no longer the way the project runs.

---

## 11. Next steps

1. Re-test on the assigned `llama-3.3-70b` model once the proxy is fixed; tune the prompt if it drifts from the format.
2. Optionally add "stop instantly on instruction" behaviour.
3. Optionally retire the old `llmAgent/` folder (keeping only `llmClient.js`).
4. Add more tools (e.g. weather, web search per the lab tutorial) and coordination between two players.
