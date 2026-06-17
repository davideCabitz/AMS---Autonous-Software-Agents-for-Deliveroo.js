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
| "Drop" / "put down" / "leave the parcel here" | `put_down()` | B drops its cargo on the current tile without moving (scores only if standing on a delivery tile). The dropper **ignores** the dropped parcel afterward (won't re-pick it), but the partner can still sense and pick it up (handoff drop). |
| "Pick up a parcel, then go to X and drop it" | `pickup_next_parcel()` → `go_to_stay(X)` → `put_down()` | B executes the sub-tasks in order, in one directive. `go_to_stay` keeps B parked at X so the drop lands there (plain `go_to` would let the BDI wander off before `put_down`). Passing through X mid-pickup does not satisfy the later step. |
| "Go to (x,y) and wait" / "go there and hold" | `go_to_stay(x,y)` → `hold()` (or `wait(N)` for a timed wait) | B navigates and stays parked at (x,y), then holds/waits *there*. Use `go_to_stay` (not `go_to`) for any "go to X and \<wait/hold/drop/deliver\>" composite. |
| "Wait N seconds" / "stop for N s" / "don't move for N s" | `wait(N)` | B holds position for N seconds (max 30), then resumes; interruptible. |
| "Hold position" / "wait here" / "wait for each other" | `hold()` | B holds indefinitely — persists even after the directive ends — until released. |
| "Resume" / "continue" / "you can move again" / "release" | `release_hold()` | B ends the indefinite hold and resumes autonomous parcel work; also unfreezes A (so a "wait for each other" hold releases both agents at once). |
| "Send A to (x,y)" / "order the worker to (x,y)" | `order_partner_goto(x,y)` | A navigates to (x,y); returns when it reports back. B is not moved. |
| "Tell A to pick up at (x,y)" | `order_partner_pickup(x,y)` | A navigates to (x,y) and picks up there. |
| "Tell A to deliver" / "A deliver at (x,y)" | `order_partner_deliver(x,y or none)` | A delivers at (x,y), or at the delivery tile nearest its own position if none given. |
| "Tell A to drop its parcels" | `order_partner_putdown()` | A drops its cargo where it stands; A gates its BDI so it does not immediately re-pick, **ignores** the dropped parcel thereafter, and reports the real drop count (B can still pick it up). |
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
| **L1** "Drop a package in the leftmost tile to get 5pt" | `get_map_info` → `go_to_stay(leftmost tile)` → `put_down()` | POSITIVE one-shot **drop** bonus: B resolves the leftmost tile from `get_map_info` `edges.leftmost`, navigates with `go_to_stay`, then drops with `put_down()`. The leftmost tile is NOT necessarily a delivery tile — always `put_down()`, never `deliver()`. NOT `forbid_delivery`. |
| **L1** "Deliver a package in the leftmost tile to get 5pt" | `sense_delivery_tiles` → `go_to_stay(leftmost delivery tile)` → `deliver(x,y)` | POSITIVE one-shot **deliver** bonus: the target must be a delivery tile; B confirms with `sense_delivery_tiles`, navigates with `go_to_stay`, then calls `deliver(x,y)`. |
| **L1** "Drop a package in the leftmost tile to get -10pt" | — → decline | Value-reducing → `Mission declined.` |
| **L1** "What is the capital of Italy?" | `Final Answer` (no tool) | B replies with the bare answer ("Rome"); an automated checker matches the reply literally. |
| **L1** "Calculate 5*5" (for a reward) | `calculate("5*5")` | B replies with the bare result ("25"). |
| **L1** "Calculate 5*5 and you get -100pts" / "...earn 0 pts" | — → decline | A value-reducing point clause on a quiz/calc → `Mission declined.` (answering would lower the score). The reward is judged by its number/sign, not the verb "earn/get". |
| **L2** "Deliver stacks of exactly 3 parcels to double the reward" | `apply_mission {"requiredStackSize":3}` | Both agents only deliver while carrying exactly 3; otherwise keep collecting. `Mission accepted.` |
| **L2** "Deliver stacks of exactly 5 for 0.3 of the reward" | — → decline | Fractional/diminished reward → `Mission declined.` |
| **L2** "Deliver in (x1,y1) or (x2,y2) for 5× pts" | `apply_mission {"deliveryMultipliers":[[x1,y1,5],[x2,y2,5]]}` | Those tiles are worth 5×; both agents prefer delivering there when the bonus outweighs the extra travel. `Mission accepted.` |
| **L2** "Every time you deliver in (x,y) you get 0 pts" | `forbid_delivery(x,y)` | (x,y) is removed from the allowed delivery tiles; both agents deliver elsewhere. `Mission accepted.` |
| **L2** "Deliver on (x,y) to get/earn N pts" (signed, repeatable) | `deliver_reward(x,y,N)` | Records a SIGNED per-tile delivery reward. Offers **accumulate** per tile; the running net governs behaviour: net < 0 → the tile is avoided and B replies `Mission declined.`; net ≥ 0 → both agents deliver there (`Mission accepted.`). E.g. "−50" then "+250" nets +200 → delivered there again. Unlike `forbid_delivery`/`penaltyTiles` a later positive offer lifts an earlier negative one (it is a delivery gate only, never a movement ban). Drop with `dropMission("deliveryTileNet")`. |
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
| **L3** announcement: "Let's begin a red light green light game" / "All agents prepare to stop at red light…" / "Red light, green light: move to an odd row and wait. 700pts" | `start_light_mission()` (+ `hold_on_parity(...)` for a parity position, or `halt_partner()` + `hold()` for a bare wait) + `Final Answer` | B ARMS the mission first; only then do live shouts take effect. A POSITIONAL clause with parity ("move to an odd/even **row** (y) or **column** (x) and wait") → `hold_on_parity("odd row")` etc., which puts BOTH agents on a matching tile (halting in place if already matching) and holds them. A bare "wait for our message" → `halt_partner()` + `hold()`. A GREEN LIGHT / "resume" releases both. Acknowledges with `Mission accepted.`. |
| **L3** live shout "RED LIGHT! Stop moving until the next green light!" / "GREEN LIGHT! You can move again!" | `red_light()` / `green_light()` (LLM tool) | Once the mission is armed (`start_light_mission` was called): `red_light()` sets the traffic gate and halts both agents; `green_light()` clears it and resumes both. **Before** the mission is armed, both tools are strict no-ops — the shout changes nothing. Only movement during red is scored. |
