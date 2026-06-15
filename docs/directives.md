# Directives & Missions reference

How admin chat messages map to the LLM coordinator's tools and the resulting agent
behaviour. **B** = the LLM coordinator (talks to you, also called "agent B" / its
in-game name). **A** = the plain-BDI worker (also "agent A" / "the worker"). Mission
constraints are mirrored to BOTH agents automatically.

- **Directives** = imperative commands executed immediately (no accept/decline).
- **Missions** = point-bearing offers: B first evaluates worth, then replies
  `Mission accepted.` / `Mission declined.` (or executes the one-shot action).

## Directives

| Message | Tool | Behaviour |
|---|---|---|
| "Pick up a parcel" / "go pick up the next parcel" | `pickup_next_parcel()` | B releases the autonomy gate and lets its BDI strategy hunt; returns the instant a new parcel is in hand. No coordinates needed. |
| "Pick up the parcel at (x,y)" | `go_pickup(x,y)` | B navigates to (x,y) (A*) and picks up the parcel there; blind-tries a pickup if none is currently sensed. |
| "Go to (x,y)" / "move to (x,y)" | `go_to(x,y)` | B path-finds to the tile and stops there; returns on arrival or a failure reason. |
| "Move up/down/left/right by N" / "go to x+2, y-3" | `get_my_position` + `calculate` + `go_to` | B anchors on its current position, resolves the absolute target with math, then navigates. |
| "Deliver" / "deliver the parcels" | `deliver()` | B carries its load to the nearest delivery tile and drops it (scores). |
| "Deliver in (x,y)" / "deliver at tile (x,y)" | `deliver(x,y)` | B delivers at that specific delivery tile (errors if it is not a delivery tile). |
| "Drop" / "put down" / "leave the parcel here" | `put_down()` | B drops its cargo on the current tile without moving (scores only if standing on a delivery tile). |
| "Pick up a parcel, then go to X and drop it" | `pickup_next_parcel()` → `go_to(X)` → `put_down()` | B executes the sub-tasks in order, in one directive; passing through X mid-pickup does not satisfy the later step. |
| "Wait N seconds" / "stop for N s" / "don't move for N s" | `wait(N)` | B holds position for N seconds (max 30), then resumes; interruptible. |
| "Hold position" / "wait here" / "wait for each other" | `hold()` | B holds indefinitely — persists even after the directive ends — until released. |
| "Resume" / "continue" / "you can move again" / "release" | `release_hold()` | B ends the indefinite hold and resumes autonomous parcel work; also unfreezes A (so a "wait for each other" hold releases both agents at once). |
| "Send A to (x,y)" / "order the worker to (x,y)" | `order_partner_goto(x,y)` | A navigates to (x,y); returns when it reports back. B is not moved. |
| "Tell A to pick up at (x,y)" | `order_partner_pickup(x,y)` | A navigates to (x,y) and picks up there. |
| "Tell A to deliver" / "A deliver at (x,y)" | `order_partner_deliver(x,y or none)` | A delivers at (x,y), or at the delivery tile nearest its own position if none given. |
| "Tell A to drop its parcels" | `order_partner_putdown()` | A drops its cargo where it stands. |
| "Freeze A" / "stop the worker" / "park A at (x,y)" | `halt_partner()` (+ `order_partner_goto`) | A freezes and holds position; to park it somewhere, halt first then order it there so it stays put. |
| "Unfreeze A" / "resume the worker" | `resume_partner()` | A returns to autonomous work. |
| "Where is A?" / "what is A carrying?" / "is A frozen?" | `ask_partner_status()` | B asks A for a live snapshot (position, score, cargo, frozen state) and answers from it. |
| "Where are you?" / "what's your score?" | `get_my_position()` | B reports its own x, y and score. |
| "What parcels do you see?" | `sense_parcels()` | B lists the free parcels currently in view (id, position, reward). |
| "Where are the delivery tiles?" | `sense_delivery_tiles()` | B lists the reachable delivery (drop-off) tiles. |
| "Where are the spawn tiles?" | `sense_spawn_tiles()` | B lists the reachable spawner tiles (where parcels appear). |
| "How big is the map?" / "where is the leftmost/top tile?" | `get_map_info()` | B reports map bounds and the edge tiles (leftmost/rightmost/top/bottom). |
| "How far is (x,y)?" / "is (x,y) reachable?" | `path_cost(x,y)` | B returns the A* route cost (steps, est. seconds, decay lost), or "Unreachable". |
| "What time is it?" | `get_current_time()` | B returns the current local time (Rome). |
| "Calculate \<expr\>" / "what is the capital of Italy?" | `calculate(expr)` or direct `Final Answer` | B computes math with the tool (never in its head) or answers a knowledge question directly; reply is the bare result. |
| "Say X to ..." / any verbal reply | `say(message)` | B sends the text to the directive's sender over chat. |

## Missions

| Message | Tool | Behaviour |
|---|---|---|
| **L1** "Move to (4,7) and you get +10pts" | `path_cost(4,7)` → `go_to(4,7)` | B checks the trip is worth the bonus vs. lost parcel income, then navigates and accepts; declines if unreachable or not worth it. |
| **L1** "Move to x=4*2 y=(1+3)*3 to get -10pts" | `calculate` → decline | Negative reward → B does not move; `Mission declined.` |
| **L1** "Drop a package in the leftmost tile to get 5pt" | `get_map_info`/`sense_delivery_tiles` → `go_to` → `deliver`/`put_down` | B resolves the leftmost tile, goes there and drops/delivers the parcel to claim the points. |
| **L1** "Drop a package in the leftmost tile to get -10pt" | — → decline | Value-reducing → `Mission declined.` |
| **L1** "What is the capital of Italy?" | `Final Answer` (no tool) | B replies with the bare answer ("Rome"); an automated checker matches the reply literally. |
| **L1** "Calculate 5*5" (for a reward) | `calculate("5*5")` | B replies with the bare result ("25"). |
| **L2** "Deliver stacks of exactly 3 parcels to double the reward" | `apply_mission {"requiredStackSize":3}` | Both agents only deliver while carrying exactly 3; otherwise keep collecting. `Mission accepted.` |
| **L2** "Deliver stacks of exactly 5 for 0.3 of the reward" | — → decline | Fractional/diminished reward → `Mission declined.` |
| **L2** "Deliver in (x1,y1) or (x2,y2) for 5× pts" | `apply_mission {"deliveryMultipliers":[[x1,y1,5],[x2,y2,5]]}` | Those tiles are worth 5×; both agents prefer delivering there when the bonus outweighs the extra travel. `Mission accepted.` |
| **L2** "Every time you deliver in (x,y) you get 0 pts" | `forbid_delivery(x,y)` | (x,y) is removed from the allowed delivery tiles; both agents deliver elsewhere. `Mission accepted.` |
| **L2** "If you deliver in the leftmost delivery tile you lose 50 points" | `forbid_delivery(leftmost)` | The resolver excludes the real leftmost delivery tile(s) (ties included); both agents avoid them. `Mission accepted.` |
| **L2** "Deliver only at (x,y)" | `apply_mission {"allowedDeliveryTiles":[[x,y]]}` | Both agents restrict deliveries to the listed tiles only. `Mission accepted.` |
| **L2** "If you deliver parcels worth more than 10, you get no reward" | `apply_mission {"maxParcelReward":10}` | Both agents never pick up a parcel with reward > 10. `Mission accepted.` |
| **L2** "Each delivery's total reward must be ≤ T" | `apply_mission {"maxBundleValue":T}` | Both agents carry one cheap parcel at a time so every delivery stays under T. `Mission accepted.` |
| **L2** "Do not go through tile (x,y) or you lose 50pts" | `apply_mission {"avoidTiles":[[x,y]]}` | (x,y) is excluded from all pathfinding for both agents. `Mission accepted.` |
| **L2** "Explore only the left/right/top/bottom half" | `restrict_exploration(zone)` | Both agents restrict exploration to the named map half. `Mission accepted.` |
| **L2** "Explore only these spawners [list]" | `apply_mission {"allowedSpawnerTiles":[[x,y],…]}` | Both agents only target the listed spawner tiles when exploring. `Mission accepted.` |
| **L2** "Drop / cancel / abort the latest mission" | `dropMission(field)` | Clears one constraint (identified by its `[field]` tag); the rest stay in force. |
| **L2** "Abort all missions" / "clear all" | `dropMissions()` | Clears every constraint; both agents return to default behaviour. |
| **L3** "Move both agents near (x,y) within distance 3 and wait. 500pts" | `gather_near(x,y,3)` | One deterministic call: enumerates the walkable tiles within distance 3 of (x,y), picks two different reachable ones (one per agent, never each other's tile), parks A on one and sends B to the other, then holds both. `Mission accepted.`. "resume" releases both. |
| **L3** "If one agent picks up a parcel and the other delivers it, 200pts bonus" | `start_handoff()` | The cross-agent routine runs by itself (one fetches, the other delivers) and repeats per delivery; `stop_handoff()` ends it. |
| **L3** announcement: "Let's begin a red light green light game" / "All agents prepare to stop at red light…" / "Red light, green light: move to an odd row and wait. 700pts" | `start_light_mission()` (+ `halt_partner()` + `hold()` if it says to wait) + `Final Answer` | B ARMS the mission first; only then do live shouts take effect. If told to wait, it freezes both agents (worker + itself). Acknowledges with `Mission accepted.`. |
| **L3** live shout "RED LIGHT! Stop moving until the next green light!" / "GREEN LIGHT! You can move again!" | (classifier → STOP / GO) | Once the mission is armed: STOP freezes both agents, GO clears the hold and resumes both. **Before** the mission is armed, a bare "red light"/"green light" is ignored — it does not change behaviour. Only movement during red is scored. |
