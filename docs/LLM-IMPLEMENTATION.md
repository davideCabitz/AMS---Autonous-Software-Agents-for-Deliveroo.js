# LLM Agent — Implementation Report

*Part 2 of the Autonomous Software Agents project. Written so a teammate who has **never worked with LLMs** can understand what was built, how it works, and the tests we ran to prove it.*

---

## 1. Summary (the one-paragraph version)

We added an **LLM** (a large language model, like the engine behind ChatGPT) to the project. It is **not** a second player. It is a layer that sits **on top of our existing BDI agent** (`myAgent/`). You can type or chat an instruction in plain English — *"go pick up the parcel at (13,0) and deliver it"* — and the LLM figures out the steps and **tells the BDI agent what to do**. The BDI agent still does the actual driving (pathfinding, picking up, delivering) exactly as before. When the instruction is done, the agent goes back to playing on its own.

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

Four design decisions make this work:

1. **Same program, same connection, shared knowledge.** The LLM layer imports the *same* `socket`, `me`, `parcels`, `deliveryTiles` the BDI agent already uses (`myAgent/context.js`). There is no second connection and no duplicate world-state.
2. **One ReAct loop** per instruction (simple and predictable).
3. **An "autonomy gate".** While the LLM is carrying out an instruction, the BDI agent's automatic decision-making is paused so the two don't fight over the player. It resumes the moment the instruction finishes.
4. **"Command-and-wait".** When the LLM issues `go_to(9,11)`, our code pushes that as a normal BDI goal and **waits** until the BDI agent (via A\*) actually arrives, then tells the LLM the result. This keeps the LLM in sync with reality.

---

## 4. What was built

### New files — `myAgent/llm/`

```
myAgent/llm/
  index.js        connects the chat channel to the loop; runs one instruction at a
                  time; sends the reply back; also reads the terminal for testing;
                  waits until the agent is connected before acting
  commandLoop.js  the ReAct loop for one instruction; turns the autonomy gate on/off
  commandTools.js the list of tools the LLM can use (see §5)
  prompt.js       the instructions we give the LLM (its rules + a live snapshot of
                  the game world + the strict reply format)
```

It reuses one file from the earlier prototype: `llmAgent/llmClient.js`, which is the small wrapper that actually sends the conversation to the model.

### Small additions to the existing BDI code (nothing old was removed)

| File | What we added | In plain words |
|---|---|---|
| `myAgent/context.js` | `directive = { active: false }` | a shared on/off switch: "is the LLM currently in charge?" |
| `myAgent/agent.js` | one line: `if (directive.active) return;` inside `optionsGeneration` | when the LLM is in charge, the BDI agent stops choosing its own goals (but still keeps sensing the world). Also: the LLM layer only turns on if an API key is configured — otherwise the BDI agent runs exactly as before. |
| `myAgent/intentions/IntentionDeliberation.js` | a `completion` promise | lets us *wait* for a goal to finish and find out if it succeeded |
| `myAgent/intentions/IntentionRevisionReplace.js` | `commandAndAwait(goal)` | the bridge the LLM tools use: "make this your next goal, and tell me when it's done" |

---

## 5. The tools the LLM can use

The LLM is deliberately given only **high-level** tools — it can never move one tile at a time.

| Kind | Tools | What it does |
|---|---|---|
| **Thinking** (no game effect) | `calculate(expression)`, `get_current_time(location)` | do maths; get the time in Rome |
| **Looking** | `get_my_position()`, `sense_parcels()`, `sense_delivery_tiles()` | read the current world state |
| **Doing** | `go_to(x,y)`, `go_pickup(x,y)`, `deliver()` | hand a goal to the BDI agent and wait for it to finish |
| **Talking** | `say(message)` | send a chat message back to whoever gave the instruction |

If a "doing" tool fails (target unreachable, blocked, times out after ~60 s), it returns a clear message like *"Failed: target (3,9) is unreachable"* so the LLM can try something else instead of crashing.

---

## 6. What happens, step by step, for one instruction

1. **An instruction arrives** — from in-game chat (`socket.onMsg`) or typed in the terminal. We wait until the agent is actually connected, and we handle one instruction at a time.
2. **Autonomy gate ON** — the BDI agent stops picking its own goals.
3. **The ReAct loop runs** — the LLM reads the instruction + a snapshot of the world, replies with one action, we run the matching tool, we feed back the result, and repeat — until the LLM says `Final Answer:` (max 12 steps as a safety limit).
4. **Reply** — the final answer is sent back in chat (or printed in the terminal).
5. **Autonomy gate OFF** — the BDI agent immediately goes back to playing on its own.

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

### What the tests also revealed (and we fixed)
The first live runs of the *old* standalone prototype (§10) exposed two real bugs, which we fixed in the command layer:
- The model sometimes writes `Action: go_to(5,3)` (function-call style). Our parser only accepted `go_to` + a separate input, so it failed with "unknown tool". **Fixed:** the parser now accepts both styles (visible in Test C — `calculate(13 + 2)` parsed fine).
- A single API error used to crash the whole agent. **Fixed:** model calls are wrapped so an error becomes a chat message instead of a crash.

---

## 9. Known limitations (be aware of these)

- **Model availability.** Only `gpt-4o` answers on the proxy right now; the assigned 70B model errors out. Smaller models also tend to drift from the strict reply format more than gpt-4o.
- **It finishes its current action before obeying.** When an instruction arrives, the agent stops choosing *new* goals, but it lets the goal it's *already doing* finish first. So for ~1–2 seconds (while the model is "thinking") you may see it complete its previous move before switching to your instruction. (This is intentional; it can be changed to "stop instantly" if we prefer.)
- **Vague instructions get interpreted.** "Go to the further left zone" made the LLM pick the leftmost *delivery tile* (9,11), not the far-left edge of the map. Precise instructions ("go to (0,10)") remove the guesswork.

---

## 10. Background: the earlier prototype (`llmAgent/`)

Before this, we built a **standalone** LLM agent (`llmAgent/`) that opened its *own* connection and tried to play the game by itself, moving one tile at a time. Live testing showed this was the wrong approach — it navigated blindly into walls, was slow (one model call per tile), and crashed on API errors. Those failures are exactly why we switched to the command-layer design: instead of having the LLM compete with the BDI agent, we made it *command* the BDI agent. The old code stays in the repo for reference (and we reuse its `llmClient.js`); it is no longer the way the project runs.

---

## 11. Next steps

1. Re-test on the assigned `llama-3.3-70b` model once the proxy is fixed; tune the prompt if it drifts from the format.
2. Optionally add "stop instantly on instruction" behaviour.
3. Optionally retire the old `llmAgent/` folder (keeping only `llmClient.js`).
4. Add more tools (e.g. weather, web search per the lab tutorial) and coordination between two players.
