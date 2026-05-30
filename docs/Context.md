# Project Documentation: Autonomous Software Agents (Deliveroo.js)

## 1. Project Context & Course Information
* **Course Title:** Autonomous Software Agents (Α.Α. 2025-2026)
* **Institution:** University of Trento, Italy – Department of Information and Communication Technology
* **Instructors:** Prof. Paolo Giorgini, Dr. Marco Robol, Dr. Marco Bombieri
* **Project Core Platform:** **Deliveroo.js**, a minimalistic, web-based parcel delivery game developed specifically for educational purposes within this course.

---

## 2. Problem Description & Game Environment

### 2.1 Core Objective
The main objective of the project is to develop an autonomous software agent that plays the game on behalf of the user. The agent must maximize its score by collecting as many parcels as possible and successfully transporting them to designated delivery zones. This must be accomplished using either a Belief-Desire-Intention (BDI) architecture or a Large Language Model (LLM) framework depending on the project phase.

### 2.2 The Environment (Grid System)
The game environment consists of an $M 	imes N$ grid layout consisting of distinct tile types, each serving a specific logical purpose:
* **Type '0' (Black/None):** Non-walkable tiles that act as obstacles.
* **Type '1' (Green):** Parcel-spawning tiles where new items appear during the game.
* **Type '2' (Red):** Delivery zones where parcels must be brought to earn points.
* **Type '3' (White):** Standard walkable paths.

### 2.3 Parcels and Scoring Mechanics
* **Spawning & Timers:** Parcels appear dynamically on the grid with an associated countdown timer. Multiple parcels can exist simultaneously.
* **Expiration:** A parcel disappears from the grid if its timer expires or if it is successfully delivered.
* **Carrying Capacity:** Players can pick up, put down, and carry multiple parcels at the same time. 
* **Scoring:** Points are awarded only when a parcel is dropped off inside a delivery zone (Red tile). The score gained from a successfully delivered parcel is equal to its remaining timer value at the exact moment of delivery.

---

## 3. Player Mechanics and Game Rules

### 3.1 Actions and Movement Mechanics
Agents interact with the environment using a predefined set of actions: `move_right`, `move_left`, `move_down`, `move_up`, `pick_up`, and `put_down`.

* **Movement Duration & Non-Instantaneous Physics:** Movement across tiles is not instantaneous and possesses a fixed duration. When an action starts, coordinates change by $0.6$ toward the target tile. Upon completion, the final $0.4$ distance is covered. This lets external observers infer an agent's current directional movement.
* **Tile Locking & Collisions:** During a move, both the starting tile and target tile are locked. No two players can occupy the same tile. If an agent tries to move into an occupied tile, the action fails, and the agent receives a penalty.
* **Pick Up and Put Down:** These actions are instantaneous. While a player can carry multiple parcels simultaneously, they can only pick up or put down a single parcel at a time. To pick up a parcel, the agent must share the exact same tile as the parcel. Agents can put down parcels anywhere, but score points only in delivery areas.

### 3.2 Sensing Capabilities and Constraints
Agents operate under partial observability:
* **Initial State:** Upon connecting, the client receives the structural map layout as a full list of tiles containing coordinates and types `{x, y, type}`.
* **Dynamic Sensing Range:** Dynamic updates are limited to a Manhattan distance formula: 
  $$\Delta x + \Delta y < 5$$
* **Sensed Data Objects:** Within this range, the client receives real-time sensing tables:
  * **Parcel Sensing:** `{id, x, y, carriedBy, reward}`
  * **Player/Agent Sensing:** `{id, name, x, y, score}`
  * **Self-Sensing (Me):** `{id, name, x, y, score, penalty}`
* **Blind Spots:** Everything outside the sensing radius is hidden. However, agents can track/guess the positions of previously seen players and decrement parcel reward timers locally.

### 3.3 Game Architecture & System Design
The platform uses a decoupled client-server architecture:
* **Backend Server:** Built on Node.js, Express JS, and Socket.IO. It evaluates and stores all authoritative game logic, state updates, and clock timers.
* **3D Visual Client:** Powered by Three.js, rendering a browser-based 3D environment. It contains no game logic and is purely utilized for testing and observation.
* **Communication Protocol:** Built entirely on WebSockets via Socket.IO.
* **Authentication:** Secured via unique passphrases/tokens generated via the 3D client. Tokens map to a specific player ID. If a token loses its active connection for more than 10 seconds, its character is temporarily removed from the board.

---

## 4. Project Requirements & Agent Architectures

The project is split into two foundational parts:

### 4.1 Part 1: BDI Architecture & Automated Planning
The first milestone focuses on implementing a classical rational agent workflow:
1. **Belief Management:** Parse incoming JSON sensing data streams to construct, update, and revise an internal world model (Belief Revision).
2. **Deliberation:** Activate goals and commit to specific desires, turning them into active Intentions.
3. **Plan Execution:** Use a predefined plan library or hardcoded strategies to execute actions.
4. **Automated Planning Extension:** Integrate an external symbolic planner component. Once an intention is triggered, the agent calls this automated planner to output an optimal action path, implementing replanning/redeliberating cycles if the environment shifts.

### 4.2 Part 2: LLM-Based Agent Integration
The second milestone introduces an advanced multi-agent cooperative environment by incorporating a Large Language Model (LLM) framework alongside the BDI system. High-level objectives are delivered to the system in natural language.

The LLM-based agent must execute an autonomous loop:
1. **Context & Memory Updates:** Read and interpret natural language objectives, fuse them with environmental observations, and consult an available tools catalog. This structural state forms the **LLM Memory**, which updates dynamically as objectives or grid states change.
2. **Plan Generation & Execution:** The LLM reasons over its memory state to construct an action plan consisting of a series of tool invocations to achieve the objective.
3. **Multi-Agent Coordination:** The BDI agent and LLM agent must talk to each other. They communicate by exchanging beliefs (e.g., sharing visibility over hidden map regions) and coordinating tasks (e.g., dynamically deciding that the closest agent handles a newly discovered parcel).

### 4.3 LLM Agent Key Components and Reasoning Techniques
Developers are free to design the LLM agent architecture, provided it contains these core elements:
* **LLM-Memory:** Houses the real-time context, containing active objectives and localized game configurations.
* **LLM-Planner:** Breaks down conversational objectives into actionable, structured tool execution plans. It must leverage prompt engineering methodologies like **Chain-of-Thought (CoT)** or **Reflexion** to bolster operational reasoning.
* **LLM-Replanner:** Utilizes iterative refinement techniques such as **ReAct**, **Reflexion**, or active feedback loops to rebuild or adjust execution plans when game clocks advance, obstacles arise, or objectives get overridden.
* **Infrastructure Additions:** LLMs and tools are hosted on an external server and exposed via API endpoints, authorized via custom access tokens.

---

## 5. Implemented Code-base Architecture

BDI agent in ES modules (Node.js, `"type": "module"`). A* for movement; PDDL (online solver) only for crate-pushing detours.

### 5.1 Directory layout

```
myAgent/
├── agent.js                 # Entry point: sensing hooks, option generation, strategies
├── context.js               # Shared state: socket, beliefs, map tiles, config, PDDL beliefset
├── beliefs/
│   ├── Me.js                # Agent self-state (id, name, x, y, score)
│   └── Parcels.js           # Parcel belief map (sync from sensing; free/carriedBy queries)
├── intentions/
│   ├── IntentionRevision.js         # Base: intention queue + loop, validity check
│   ├── IntentionRevisionReplace.js  # Active revision strategy (replace last intention)
│   ├── IntentionRevisionRevise.js   # Alternative revision strategy (defined, not selected)
│   └── IntentionDeliberation.js     # Selects + runs the first applicable plan for a predicate
├── plans/
│   ├── planLibrary.js       # Ordered list: [GoPickUp, GoDeliver, GoExplore, PddlMove, AStarMove]
│   ├── PlanBase.js          # Base plan: stop(), subIntention(), isApplicableTo()
│   ├── GoPickUp.js          # go_pick_up → go_to + emitPickup
│   ├── GoDeliver.js         # go_deliver → go_to + emitPutdown
│   ├── GoExplore.js         # go_explore → go_to
│   ├── AStarMove.js         # go_to via A* (default movement)
│   └── PddlMove.js          # go_to via online PDDL solver (only when a crate blocks the route)
└── utils/
    ├── astar.js             # A* pathfinder: findRoute() + navigateTo() with blocking/replan
    └── distance.js          # Manhattan distance

domain-deliveroo.pddl        # PDDL domain: directional moves + Sokoban-style crate pushing
problem-deliveroo.pddl       # PDDL problem template (placeholders filled at runtime)
multiple_run.js              # Spawns 5 agent processes for multi-agent runs
```

### 5.2 Control flow

1. `context.js` opens the socket (`DjsConnect`) and registers `onConfig` / `onMap` / `onSensing`.
   - `onConfig`: reads `OBSERVATION_DISTANCE`, `MOVEMENT_DURATION`; computes `DECAY_STEPS_PER_REWARD`.
   - `onMap`: classifies tiles into `deliveryTiles`, `spawnerTiles`, `crateSpawnerTiles`, `walkableTiles`; sets `mapHasCrates`; builds the PDDL `beliefset` (tile/delivery/right/left/up/down facts).
   - `onSensing`: refreshes `crateTiles` (only if `mapHasCrates`).
2. `agent.js` registers `onYou` (updates `me`) and `onSensing` (updates `parcels`); both call `optionsGeneration()`.
3. `optionsGeneration()` runs the active strategy, which pushes a predicate via `myAgent.push([...])`.
4. `IntentionRevisionReplace` queues an `IntentionDeliberation` and stops the previous intention.
5. `IntentionRevision.loop()` continuously pursues the front intention, dropping stale ones (`#isValid`: a `go_pick_up` is invalid once its parcel is gone or carried).
6. `IntentionDeliberation.achieve()` walks `planLibrary` and runs the first plan whose `isApplicableTo()` matches the predicate.

### 5.3 Beliefs

- `me` (`Me`): id, name, x, y, score; `isReady` once id is set.
- `parcels` (`Parcels`): `Map<id, parcel>` synced from sensing; `free()`, `carriedBy(id)`, `all()`.
- Map tiles + config + PDDL `beliefset`: module-level exports in `context.js`.

### 5.4 Intentions

- Predicates: `['go_pick_up', x, y, id]`, `['go_deliver', x, y]`, `['go_explore', x, y]`, `['go_to', x, y]`.
- `IntentionRevisionReplace` (active): replaces the running intention on a new push, except it never re-pushes an identical predicate and never replaces a `go_deliver` with another `go_deliver` (avoids stop/restart loops when the PDDL planner routes to a different delivery tile).
- `IntentionRevisionRevise` (defined, not selected): appends instead of replacing.

### 5.5 Plans

- Plan library is order-sensitive; `IntentionDeliberation` picks the first applicable plan.
- `GoPickUp` / `GoDeliver` / `GoExplore` decompose into a `go_to` sub-intention then emit a pickup/putdown.
- `go_to` resolution: `PddlMove` is tried before `AStarMove`. `PddlMove.isApplicableTo` returns true only when crates are present AND no crate-free route exists but a route exists if crates can be pushed; otherwise plain A* (`AStarMove`) runs. `AStarMove` is also the fallback if the solver fails.

### 5.6 Movement / pathfinding (`utils/astar.js`)

- A* over `walkableTiles` with Manhattan heuristic and a backtrack penalty.
- `navigateTo()`: step-by-step execution with dynamic replanning — blocked intermediate tiles are excluded and re-routed; a blocked goal tile is waited on (up to 6 × 500 ms) in case another agent moves.
- `findRoute()`: route-existence check (optionally treating a set of tiles as blocked), used by `PddlMove` to decide whether the solver is needed.

### 5.7 PDDL crate pushing (`PddlMove.js` + `domain-deliveroo.pddl`)

- STRIPS domain: 4 directional moves + 4 Sokoban-style push actions; a crate can be pushed onto a `pushable` (crate-zone) tile that is `free`.
- `#buildProblem()` substitutes runtime facts into `problem-deliveroo.pddl` (objects, agent tile, crate facts, beliefset topology, free/pushable facts, goal tile). Tile/crate object names are letter-prefixed (`t<x>_<y>`, `c<x>_<y>`) for the solver.
- Calls `onlineSolver(domain, problem)`, executes the macro-plan step by step, and replans (up to `MAX_REPLANS = 6`) if a move is blocked mid-plan by a newly sensed crate.

### 5.8 Strategies (`agent.js`)

Selected in `optionsGeneration()` (currently `strategyGreedy`):

- `strategySimple` — deliver immediately whenever carrying; otherwise pick the best free parcel by `reward / distance`.
- `strategyGreedy` (active) — accumulate parcels still worth picking up within sensing range (`estimatedRewardAtDelivery ≥ MIN_DELIVERY_REWARD`), then deliver when nothing nearby is worthwhile.
- `strategyNotTooGreedy` — like greedy, but does a one-time detour to a nearby unseen spawner (just outside sensing range) before delivering.
- `exploreIfIdle()` — when no parcel/delivery is pending: wait briefly on a spawner tile for a spawn, else `go_explore` toward the nearest out-of-sensing-range spawner (or walkable tile).

### 5.9 Configuration / external

- Connection via env vars `HOST`, `TOKEN`, `NAME` (loaded with `dotenv`).
- Dependencies: `@unitn-asa/deliveroo-js-sdk` (game client), `@unitn-asa/pddl-client` (`Beliefset`, `onlineSolver`), `dotenv`.
- Run: `npm start` (single agent) or `node multiple_run.js` (5 agents).