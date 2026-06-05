# LLM Agent — Implementation Report

*Part 2 of the Autonomous Software Agents project. This documents what was built, how it works, how it was tested, and what is still missing or unverified.*

---

## 1. Summary

A standalone **LLM-driven agent** was added under `llmAgent/`, alongside the existing BDI agent in `myAgent/`. It takes a natural-language objective, plans it into steps, and executes each step through a **ReAct loop** (Reason → Act → Observe) whose actions are tool calls that drive the Deliveroo SDK.

It runs **instead of** the BDI agent (same token), not alongside it. The whole pipeline was tested end-to-end against the live local Deliveroo server using a mock LLM. **All deterministic code paths pass.** The only thing not exercised with a real model is the model itself — there were no LLM credentials / reachable model endpoint available at build time.

---

## 2. Design decision: why standalone

The first instinct was to import beliefs (`me`, `parcels`, `socket`) from `myAgent/context.js` so the two agents could share state. That does **not** work as-is:

- `myAgent/agent.js` registers `onYou` / `onSensing` handlers that call `optionsGeneration()`, which immediately pushes a BDI intention on every sensing event.
- If the LLM and BDI share one socket, the BDI loop overwrites whatever the LLM is doing on every server tick — they fight for control of the same player.

**Chosen fix (the simplest that works):** the LLM agent opens its **own socket** and keeps its **own minimal belief snapshot**. No import from `myAgent/`. You run one or the other. Multi-agent coordination (two real players talking to each other) is deferred — see §7.

This mirrors how the official `lab8-LLMs` reference (`9_07C_DeliverooAgent.mjs`) structures its DeliverooJS agent.

---

## 3. What was built

```
llmAgent/
  context.js     own socket + belief snapshot (me, parcels, deliveryTiles)
  llmClient.js   callModel() over the OpenAI-compatible endpoint
  tools.js       TOOLS dict wrapping the SDK; each returns a string observation
  memory.js      buildSystemPrompt() = objective + live beliefs + tool list + ReAct contract
  planner.js     createPlan() — objective -> ordered JSON steps (CoT)
  executor.js    runStep() ReAct loop + executeObjective() with Reflexion replanning
  llmAgent.js    entry point (CLI arg objective OR interactive prompt)
  test/smoke.mjs end-to-end test with a mock LLM
```

Supporting changes:
- `package.json`: added `"llm": "node llmAgent/llmAgent.js"` script and the `openai` dependency.
- `.env`: added `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LOCAL_MODEL` (key left blank — see §6).

### Mapping to the project brief (Context.md §4.3)

| Brief component | Implemented as |
|---|---|
| **LLM-Memory** | `memory.js` — the system prompt, rebuilt every call from the live belief snapshot |
| **LLM-Planner** (CoT) | `planner.js` — decomposes the objective into ordered JSON steps |
| **LLM-Replanner** (ReAct / Reflexion) | `executor.js` — ReAct loop per step; replans the remainder when a step is blocked repeatedly |
| **Tools catalog** | `tools.js` — `move`, `pick_up`, `put_down`, `get_my_position`, `sense_parcels`, `sense_delivery_tiles` |

---

## 4. How it works

1. **Connect** (`context.js`): `DjsConnect()` opens the socket using `HOST`/`TOKEN`/`NAME` from `.env`. Handlers keep `me` (rounded coords), `parcels` (a `Map`), and `deliveryTiles` (from the map) up to date.
2. **Plan** (`planner.js`): the objective goes to the model with a JSON-only planner prompt → `{ steps: [...] }`. Malformed output falls back to a single-step plan.
3. **Execute** (`executor.js`): for each step, a ReAct loop runs:
   - Model emits `Thought: … / Action: <tool> / Action Input: <arg>`.
   - The runtime executes `TOOLS[action](arg)` and appends `Observation: <result>`.
   - Repeats until the model emits `Final Answer:` or the iteration cap (12) is hit.
4. **Reflexion**: if a step's tool calls fail/block ≥ 3 times, the remaining plan is regenerated with the failure noted, then execution continues.
5. **Tools** (`tools.js`): every tool returns a **string**, including failures (`"Failed: move up blocked…"`), so the model can react instead of silently breaking.

### Key facts verified in the SDK before coding
- `emitMove(dir)` → `{x,y}` on success, `false` when blocked.
- `emitPickup()` / `emitPutdown([])` → array of `{id}`.
- Sensing payload: `{ positions, agents, parcels, crates }`; parcel = `{id,x,y,carriedBy,reward}`.
- Delivery tiles come from `onMap` (static), **not** from sensing.
- Server reports fractional coords mid-move → snapshot rounds them (matches the BDI agent).

---

## 5. Testing — what was done

`llmAgent/test/smoke.mjs` stands up a tiny **OpenAI-compatible mock server** that returns scripted ReAct responses, points the client at it, and runs the **real** agent code against the **live local Deliveroo server**. This covers every path except the model's own reasoning.

Run: `node llmAgent/test/smoke.mjs`

### Result: ALL CHECKS PASSED

| Check | Outcome |
|---|---|
| Connect + authenticate | PASS — connected as *Alfiere* (id 4d07e8) at (11,6) |
| Delivery tiles from map | PASS — 12 tiles loaded |
| Planner JSON parsing | PASS |
| `get_my_position` | PASS — `{"x":11,"y":6,"score":0}` |
| `sense_parcels` / `sense_delivery_tiles` | PASS — well-formed strings |
| Invalid direction rejected | PASS |
| **All 4 `move` directions on the real server** | PASS — agent physically moved up→down→left→right |
| `pick_up` on empty tile | PASS — `"Nothing to pick up on this tile."` |
| Full plan → ReAct → Final Answer | PASS |
| Mock invoked (planner + executor calls) | PASS |

The agent genuinely moved on the board (11,6) → … → (11,7), proving the SDK round-trips work, not just the parsing.

---

## 6. What is missing / unverified

### Missing: a real LLM endpoint
- `LITELLM_API_KEY` in `.env` is **blank**, and no local model server (LM Studio :1234, Ollama :11434, LiteLLM :4000/:8000) was reachable during the build.
- Everything **except** the actual `callModel` HTTP request is tested. To run for real you need either the faculty proxy token or a local OpenAI-compatible server, then fill in `LITELLM_API_KEY` (and `LITELLM_BASE_URL` / `LOCAL_MODEL` if different).

### Unverified: full pickup → deliver → score cycle
- No parcel was in view during the test, so `put_down` and an actual scoring delivery were **not** exercised end-to-end.
- The `put_down` code path mirrors the verified `pick_up` one, but a real pickup-and-deliver run should be confirmed once a parcel spawns near the agent.

### Known limitation: model format adherence
- The ReAct protocol relies on the model emitting the strict `Thought / Action / Action Input` (or `Final Answer`) format. Smaller/local models drift from this.
- There **is** a recovery path (a malformed message triggers a re-prompt nudging the model back into format), but it was only tested with the well-behaved mock. Real models may need prompt tuning or more iterations.

### Deferred by request: multi-agent coordination
- The brief (§4.2) asks for BDI ↔ LLM communication (shared beliefs, task division). This was explicitly postponed. The current agent is single-player.
- When tackled: keep the standalone split and coordinate over the SDK message channel (`emitSay` / `emitShout` / `onMsg`, which exist in the SDK), or run both as separate processes with a shared belief exchange.

---

## 7. How to run

```bash
# BDI agent (unchanged)
npm start

# LLM agent — INSTEAD of the BDI agent, same token
npm run llm                                   # interactive prompt
npm run llm -- "pick up the nearest parcel and deliver it"   # one-shot

# End-to-end smoke test (mock LLM + live server)
node llmAgent/test/smoke.mjs
```

Required `.env` keys: `HOST`, `TOKEN` (already present) plus `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LOCAL_MODEL` for the model.

---

## 8. Next steps

1. Provide LLM credentials / a local model and run `npm run llm` for a real objective.
2. Confirm a full pickup → deliver → score cycle with a parcel present.
3. Tune the system prompt if the chosen model drifts from the ReAct format.
4. (Later) Implement BDI ↔ LLM coordination per brief §4.2.
