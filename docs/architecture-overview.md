# Architecture Overview

## What this project is

A BDI (Belief-Desire-Intention) autonomous agent for the Deliveroo.js game, with a ReAct-style LLM command layer on top. Challenge 2 runs two cooperating agents simultaneously:

- **Coordinator** (`TOKEN_COORDINATOR`) — full BDI + LLM layer. Reads natural-language missions from chat, interprets them, and commands both itself and the worker.
- **Worker** (`TOKEN_BDI`) — plain BDI + a lightweight JSON order handler. No LLM: executes structured orders the coordinator sends over the chat channel.

A direct `node myAgent/coordinator_agent.js` invocation (no `launch.js`) runs the coordinator role only, falling back to BDI-only when `LITELLM_API_KEY` is absent.

---

## Directory map

```
myAgent/
  launch.js                  entry point (role injection)
  coordinator_agent.js       bootstrap: strategy, sensing loop, role split
  worker_agent.js            worker: order dispatch + position streaming

  beliefs/
    Me.js                    agent position + score
    Parcels.js               live + remembered parcel state
    SpawnerGroups.js         Union-Find spatial clustering for exploration
    MapTopology.js           comb-pattern map detection

  context.js                 shared singleton (socket, beliefs, constraints, gates)

  intentions/
    IntentionRevision.js     base queue drain loop
    IntentionRevisionReplace.js  active class: replace-on-better + LLM bridge
    IntentionDeliberation.js plan resolution for one intention

  plans/
    planLibrary.js           ordered plan registry
    GoPickUp.js              go_pick_up x y id
    GoDeliver.js             go_deliver x y
    GoExplore.js             go_explore x y
    AStarMove.js             go_to via A* (default)
    PddlMove.js              go_to via PDDL (crate-blocked fallback)

  strategies/
    selectStrategy.js        picks strategy from server config
    Strategy.js              base class: value functions, gates, explore
    StrategyGreedy.js        distance-capped, single-parcel
    StrategyMemory.js        adds remembered-parcel tracking
    StrategyLookAhead.js     two-parcel look-ahead (default)
    StrategyLookAheadStochastic.js  stochastic group exploration
    StrategySingleParcel.js  camps single spawner
    StrategyHurry.js         frontier sweep on dense spawner maps
    StrategyBlind.js         works without sensing (obs distance ≤ 1)
    StrategyHighCapacity.js  high-capacity delivery routing
    AntiLockExplorer.js      anti-lock helper (Blind + Hurry)
    SpawnerGroupPatrol.js    patrol primitive helper (LookAhead + HighCapacity)

  llm/
    index.js                 registerLlm: socket wiring, stdin, routing
    commandLoop.js           runDirective (ReAct), classifyDirective, runConversation
    commandTools.js          action + chat tool definitions
    prompt.js                buildSystemPrompt / buildChatPrompt
    llmClient.js             OpenAI-compatible LiteLLM client
    partner.js               coordinator ↔ worker JSON protocol
    handoff.js               meet-in-the-middle handoff loop
    missionState.js          applyMissionConfig / dropMissionField / dropAllMissions
    util.js                  shared withTimeout helper

  utils/
    astar.js                 A*, navigateTo, tilesThatReach, reachableFrom, pushAwareCost
    directions.js            STEP_DIRS, ARROW_VECTORS, canEnterDir
    distance.js              Manhattan distance
    logger.js                createLogger(ns) with LOG_NAMESPACES filter

domain-deliveroo.pddl        PDDL domain for crate-push planning
lab/missionAgents/           challenge-2 mission-agent test harness (course code)
```

---

## Module dependency graph

```
launch.js
  └─ coordinator_agent.js
       ├─ context.js  ←────────────────── (all modules import from here)
       │    ├─ beliefs/Me.js
       │    ├─ beliefs/Parcels.js
       │    └─ utils/astar.js (tilesThatReach for trap avoidance)
       ├─ intentions/IntentionRevisionReplace.js
       │    └─ intentions/IntentionDeliberation.js
       │         └─ plans/planLibrary.js → [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove]
       ├─ strategies/selectStrategy.js → Strategy subclass
       │    └─ Strategy.js → utils/astar.js, utils/distance.js
       ├─ llm/index.js (coordinator only)
       │    ├─ llm/commandLoop.js → llm/llmClient.js, llm/prompt.js, llm/commandTools.js
       │    ├─ llm/partner.js
       │    ├─ llm/handoff.js
       │    └─ llm/missionState.js
       └─ worker_agent.js (worker only)
            └─ llm/missionState.js
```

---

## A single tick: from event to socket command

1. **Socket event** — `socket.onYou` (position update) or `socket.onSensing` (parcels + agents)  fires in `coordinator_agent.js`.
2. **Beliefs update** — `me.update(data)`, `parcels.sync(sensing.parcels, me.id)`, `otherAgents` array replaced in `context.js:onSensing`.
3. **optionsGeneration** — checks control gates (`trafficLight.red`, `manualHold.active`, `directive.active`); if clear, asks `runtime.strategy.decide(currentIntent)` for the next predicate.
4. **push** — `IntentionRevisionReplace.push(predicate)` replaces the queued intention if different (respects `pddl.busy`).
5. **loop** — `IntentionRevision.loop()` drains the queue; validates `go_pick_up` staleness; calls `IntentionDeliberation.achieve()`.
6. **achieve** — iterates `planLibrary` in order `[GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove]`; first applicable plan runs.
7. **plan execute** — e.g. `AStarMove` calls `navigateTo(x, y, stoppedFn)` → `socket.emitMove(dir)` per step.
8. **Socket command** — `emitMove`, `emitPickup`, or `emitPutdown` sent to the Deliveroo server.

---

## Historical evolution

| Phase | What changed |
|---|---|
| Initial | Single agent, `node myAgent/agent.js`, one TOKEN. |
| Challenge 1 | BDI + A* + strategy hierarchy; PDDL crate-push added as fallback. |
| Challenge 2 | `launch.js` introduced; `agent.js` → `coordinator_agent.js`; worker role added; LLM layer wired per role; `context.js` grew mission constraints + control gates. |
| CodeRefactor | Composition helpers extracted (`AntiLockExplorer`, `SpawnerGroupPatrol`); A* open-set → binary heap; `astar.js` utilities deduplicated. |
