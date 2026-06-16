# Plan: New PDDL-Based Planning Capabilities for the Deliveroo.js BDI Agent

## Context

This is for a university exam. The agent currently uses PDDL for exactly ONE thing:
crate-pushing navigation (`domain-deliveroo.pddl` + `PddlMove.js`). The goal is to
demonstrate PDDL planning in MORE situations, and — more ambitiously — to show that
mission *constraints* (forbidden / required / max stack sizes) can be encoded as PDDL
*preconditions* the solver discharges during planning, instead of being filtered after
the fact by the strategy layer.

### Confirmed decisions (from the user)
- **Part A (distance mission) is always implemented.** It is the primary deliverable.
- **Part B (stack-constraints-as-preconditions demo) is gated behind an env flag**
  (e.g. `PDDL_TASK_DEMO=1`): the `run_stack_plan` tool is only registered/exposed when the
  flag is set, so Part B can be enabled or disabled without touching Part A.
- **Part B stays ABSTRACT**: the PDDL domain models only pickup / deliver / count logic;
  the executor reuses the existing `go_pick_up` / `go_deliver` sub-intentions for movement.
- **The distance mission is ONE-SHOT**: `go_near` runs when the LLM calls it; no persistent
  `maintainDistance` constraint. (Persistent variant noted as a deferred stretch goal only.)
- **Red/green light is deliberately NOT done as PDDL** (justified exclusion — see Part C).

---

## 0. Verified facts that constrain the design

- Solver backend is `dual-bfws-ffparser` (see node_modules/@unitn-asa/pddl-client/src/PddlOnlineSolver.js:4 `PATH=/package/dual-bfws-ffparser/solve`). This is the FF parser. The existing domain declares only `(:requirements :strips)`. The FF family is conservative: quantified goals (`exists`/`forall`) and `:disjunctive-preconditions` are unreliable here. CONCLUSION: keep goals as plain conjunctions of ground atoms; do the set-reasoning in JS. Avoid `:typing`, `:disjunctive-preconditions`, quantified goals.
- `onlineSolver(domain, problem)` takes two STRINGS and returns `[{action, args, parallel}]`. The current domain is loaded once via `readFileSync` in PddlMove.js:18. A new domain file is read the same way.
- Plan selection: IntentionDeliberation.achieve() (intentions/IntentionDeliberation.js:88) iterates `planLibrary` and runs the FIRST plan whose `static isApplicableTo(...predicate)` returns true. Order matters; PddlMove sits before AStarMove (plans/planLibrary.js:12).
- The PDDL lock: PddlMove sets `pddl.busy=true` while executing; IntentionRevisionReplace.push/commandAndAwait/haltCurrent all refuse to interrupt while busy (intentions/IntentionRevisionReplace.js:27,44,59). Any new long PDDL plan MUST take this lock too, or it will be interrupted mid-plan.
- LLM -> BDI routing: commandTools.js `command(predicate, ok)` (line 281) takes the autonomy gate (`directive.active=true`), halts current BDI, then `myAgent.commandAndAwait(predicate)` pushes an IntentionDeliberation and awaits its completion promise. So ANY new predicate type is drivable from an LLM tool simply by calling `command([<type>, ...args], ok)`.
- Topology for PDDL is declared once per map in context.js onMap (context.js:300-314) into the global `beliefset` (tile/delivery/right/left/up/down facts). `beliefset.objects` and `beliefset.toPddlString()` are reused by PddlMove.#buildProblem. Reuse verbatim.
- Reusable JS utilities (utils/astar.js): `findRoute(start, goal, blockedKeys?)` -> direction array | null; `reachableFrom(start)` -> Set "x_y"; `tilesThatReach(goals)`; `pushAwareCost`; `waitForArrival(tx,ty)` (currently just a MOVEMENT_DURATION sleep). Manhattan distance is inline `Math.abs(dx)+Math.abs(dy)` everywhere.
- Mission state plumbing: missionState.js `applyMissionConfig(config)` + FIELD_MAP + dropMissionField/dropAllMissions. missionConstraints lives in context.js:125. forbiddenStackSizes is a Set; requiredStackSize/maxStackSize are number|null.
- Carrying count at runtime: `parcels.carriedBy(me.id).length` (used throughout commandTools.js).

---

## PART A — PDDL-planned "distance" mission (PRIMARY DELIVERABLE)

### A.1 What it does
LLM resolves a target tile (x,y) and a distance spec (exactly/at-least/at-most D). The
agent navigates, via a PDDL plan, to SOME walkable tile whose A* distance to (x,y) satisfies
the spec. This reuses the entire PddlMove navigation machinery; only goal-tile SELECTION and
the trigger differ.

### A.2 STRIPS encoding decision (the key design point)
STRIPS has no arithmetic, and this solver does not safely support quantified/disjunctive
goals. Therefore DO NOT try to express "distance == D" inside PDDL. Instead:

1. In JS, compute the acceptable goal-tile SET:
   - candidates = walkableTiles filtered by `Math.abs(t.x-cx)+Math.abs(t.y-cy)` against the
     spec (==D / >=D / <=D). (Manhattan is the natural metric and matches gather_near.)
   - keep only tiles in `reachableFrom(me)` (drop walled-off pockets).
   - rank by `findRoute(me, t).length` (true A* travel cost) ascending; pick the cheapest.
   - This yields ONE concrete goalTile.
2. Emit a PLAIN single-atom goal `(at me t<gx>_<gy>)` — identical in shape to the current
   PddlMove goal. The solver still does real PDDL pathfinding (and crate-pushing if crates
   block), so PDDL is genuinely doing the planning; JS only chose WHICH reachable tile.

TRADEOFF (state this in the report): the disjunctive-goal alternative (declare a `(goaltile t)`
fact set in :init and goal `(exists (?t)(and (goaltile ?t)(at me ?t)))`) is more "PDDL-pure"
because the planner picks the nearest acceptable tile itself. But it depends on quantified-goal
support the dual-bfws-ffparser backend does not reliably provide, and it is strictly worse for
plan length unless costs are modelled. The JS-precompute + single ground goal is the simplest
CORRECT approach and is recommended. (Optional: mention the disjunctive form in the report as
"considered and rejected for solver-compatibility".)

### A.3 New code

NEW FILE `myAgent/plans/PddlGoalMove.js`
- Generalizes PddlMove. Rather than duplicate the ~250 lines of #runPlan / #buildProblem /
  replan loop, REFACTOR: have PddlGoalMove import and reuse the same private logic. Cleanest
  approach for the exam without over-engineering: extract the shared internals.
  Option 1 (recommended, least churn): make PddlGoalMove a thin subclass-style wrapper that
  resolves a goalTile then DELEGATES to a shared navigation routine. Concretely, export a
  helper from PddlMove.js, e.g. `export async function pddlNavigateTo(plan, goalTile, isStopped)`
  containing the existing MAX_REPLANS loop + #buildProblem + #runPlan (move them to module
  scope or a small NavCore). PddlMove.execute and PddlGoalMove.execute both call it.
  Option 2 (more isolated, more duplication): copy the loop into PddlGoalMove. Acceptable for a
  time-boxed exam but flagged as duplication.
- `static isApplicableTo(intent, cx, cy, spec, D)` returns `intent === 'go_near'`.
  IMPORTANT: gate on a DISTINCT predicate name (`go_near`) so this never competes with the
  existing `go_to` PddlMove/AStarMove chain.
- `execute(intent, cx, cy, spec, D)`:
  1. compute candidate set + pick goalTile (A.2). If none, `throw ['no-acceptable-tile']`.
  2. if already on an acceptable tile, return true.
  3. delegate to the shared PDDL navigate routine targeting goalTile (gets crate-pushing for free).

MODIFY `myAgent/plans/planLibrary.js`
- import PddlGoalMove; register it. Because it triggers on a new predicate (`go_near`), order
  vs PddlMove/AStarMove is irrelevant for correctness, but place it before AStarMove for clarity:
  `[GoPickUp, GoDeliver, GoExplore, PddlGoalMove, PddlMove, AStarMove]`.
- ALSO register a fallback so `go_near` still works when no crates: add a tiny applicability in
  PddlGoalMove that handles the no-crate case too (it can still emit a plain `(at me t)` PDDL
  problem and let the solver produce straight moves — this is exactly the breadth the exam wants:
  PDDL used for ordinary navigation under a spatial constraint, not only for crates). So
  PddlGoalMove.isApplicableTo should be simply `intent === 'go_near'` (no crate precondition).

NEW LLM TOOL in `myAgent/llm/commandTools.js` (inside buildTools, alongside go_to):
```
async go_near(input) {
    // parse "x,y" + optional "dist=D" + optional "mode=exact|atleast|atmost" (default atmost, D=3)
    const { x, y } = parseXY(input);
    if (x == null) return 'Error: go_near needs "x,y" (optionally dist=D mode=atmost).';
    const D = <parse dist=, default 3>;
    const mode = <parse mode=, default 'atmost'>;
    return command(['go_near', x, y, mode, D],
        () => `Reached a tile within ${mode} ${D} of (${x},${y}); now at (${me.x},${me.y}).`);
}
```
Reuse existing parseXY; add a tiny regex for `dist=`/`mode=` mirroring parseRewardToken's style.
Routing is automatic: command() -> commandAndAwait -> IntentionDeliberation -> PddlGoalMove.

Add `go_near` to the LLM tool catalogue/prompt description (wherever buildTools' tools are
listed for the model — same place go_to is documented) so the model knows to call it for
"be at distance N from (x,y)", "go near (x,y)", "stay D tiles away from (x,y)".

OPTIONAL persistence: if "maintain distance" should survive across directives (like a Level-2
mission), add a `maintainDistance` field to missionConstraints + applyMissionConfig + FIELD_MAP,
and have the strategy loop re-issue `go_near` when the agent drifts. This is a stretch goal;
the one-shot go_near tool is enough to demonstrate the capability. Recommend deferring the
persistent variant.

### A.4 Sample PDDL problem emitted by PddlGoalMove (no crates case)
Identical structure to PddlMove.#buildProblem, single ground goal:
```
(define (problem deliveroo)
  (:domain default)
  (:objects me t3_4 t3_5 ... )            ; me + beliefset.objects
  (:init (me me) (agent me) (at me t7_7)
         <beliefset.toPddlString(): tile/delivery/right/left/up/down>
         (free t3_4) (free t3_5) ...)     ; free facts for all non-crate walkable tiles
  (:goal (at me t3_4)))                    ; the JS-chosen acceptable tile
```
When crates block, the SAME crate/pushable facts PddlMove already emits are added, and the
existing push actions in domain-deliveroo.pddl handle it. No domain change needed for Part A.

---

## PART B — Stack-size constraints as PDDL PRECONDITIONS (SCOPED DEMO)

### B.1 Scope decision (be explicit)
This is a task-level planner over parcels, far heavier than per-move navigation. RECOMMENDATION:
build it as a SEPARATE, self-contained "PDDL task-planner demo" invoked by an LLM tool over a
BOUNDED set of sensed parcels. DO NOT replace the strategy layer. The strategy layer's
value-based scoring (reward decay over time, competitor-contest factor, EMA pacing) cannot be
expressed in STRIPS; PDDL here AUGMENTS, demonstrating constraint reasoning, not optimization.
Keep it off the autonomous loop: it runs only when the LLM calls the demo tool.

### B.2 STRIPS modelling of a carrying count (no numeric fluents)
The dual-bfws-ffparser backend is a classical STRIPS planner. Model the count as a chain of
mutually-exclusive count predicates plus a successor relation (standard STRIPS counter idiom):
- objects: `c0 c1 c2 ... cK` (K = sensed-parcel cap for the demo, small, e.g. 5).
- `(count ?ci)` — exactly one true at a time (current carried count).
- `(succ ?ci ?cj)` — c0->c1->c2... declared in :init.
- `(deliverable ?ci)` — a count at which delivering is ALLOWED. Precompute in JS from
  requiredStackSize/maxStackSize/forbiddenStackSizes and assert as :init facts. This pushes ALL
  the arithmetic into JS (where it already lives) and keeps the domain arithmetic-free.

### B.3 New domain `domain-deliveroo-tasks.pddl` (separate file)
Predicates (additions over a movement core, or a minimal standalone task domain):
```
(at ?obj ?tile) (me ?a) (parcel ?p) (delivery ?t)
(count ?c) (succ ?lo ?hi) (deliverable ?c)
(carrying ?p)            ; parcel currently held
(free-parcel ?p ?t)      ; parcel p lies free on tile t
```
Actions:
```
(:action pickup
  :parameters (?me ?p ?t ?lo ?hi)
  :precondition (and (me ?me) (at ?me ?t) (free-parcel ?p ?t)
                     (count ?lo) (succ ?lo ?hi))      ; hi <= K guaranteed by chain length
  :effect (and (carrying ?p) (not (free-parcel ?p ?t))
               (count ?hi) (not (count ?lo))))

(:action deliver
  :parameters (?me ?t ?c)
  :precondition (and (me ?me) (at ?me ?t) (delivery ?t)
                     (count ?c) (deliverable ?c))     ; <-- forbidden/required/max enforced here
  :effect (and <drop all carried; see note>))
```
KEY POINTS:
- forbiddenStackSizes: simply DO NOT assert `(deliverable cN)` for any N in the set. deliver's
  precondition then makes delivering at a forbidden count unsatisfiable -> the planner is forced
  to pick up another parcel first (raising the count past the forbidden value). This is exactly
  the intended semantics ("if holding 2 and 2 is forbidden, grab a 3rd").
- requiredStackSize (floor): only assert `(deliverable cN)` for N >= requiredStackSize.
- maxStackSize (cap): make the chain length K = maxStackSize, so `(succ cK ?)` does not exist
  and pickup is unsatisfiable at the cap. Also assert deliverable only for N <= maxStackSize.
- "exactly N" (requiredStackSize==maxStackSize==N): deliverable set = {N} only; chain capped at N.
- deliver effect: in STRIPS you must drop the held parcels. Simplest demo modelling: make the
  GOAL `(count c0)` together with all parcels delivered, and let deliver reset to a base count.
  Two viable simplifications:
  (a) Model a single deliver that consumes the whole stack: precondition the count, effect sets
      `(count c0)` and marks `(delivered ?p)` for held parcels via a separate per-parcel action.
  (b) Simpler: have deliver be per-parcel decrement (`count hi -> lo`, mark that parcel delivered),
      with the deliverable precondition checked at the moment delivery STARTS. For the exam,
      model "deliver the whole stack at a deliverable count" as one action whose precondition is
      `(deliverable ?c)` — cleanest demonstration of the constraint.
- GOAL: e.g. `(and (delivered p1) (delivered p2) (count c0))` for the bounded parcel set, OR a
  scenario goal like "deliver as many as possible without ever passing through a forbidden
  count". Keep the demo scenario SMALL (2-4 parcels) so FF returns a plan quickly.

### B.4 Sample :init / :goal for the stack demo
Mission: requiredStackSize=2, forbiddenStackSizes={3}, maxStackSize=4. Parcels p1,p2 free.
```
(:objects me p1 p2 c0 c1 c2 c3 c4 t1_1 t2_1 tD <delivery>)
(:init
  (me me) (at me t1_1)
  (parcel p1) (parcel p2)
  (free-parcel p1 t1_1) (free-parcel p2 t2_1)
  (delivery tD)
  (count c0)
  (succ c0 c1) (succ c1 c2) (succ c2 c3) (succ c3 c4)   ; capped at 4 = maxStackSize
  ; deliverable: N in [requiredStackSize..maxStackSize] minus forbidden  = {2,4}
  (deliverable c2) (deliverable c4)
  <movement facts: tile/right/left/up/down/free, reuse beliefset.toPddlString()>)
(:goal (and (delivered p1) (delivered p2)))
```
The planner is forced to: pick up p1 (c0->c1), pick up p2 (c1->c2), travel to tD, deliver at
count 2 (c2 deliverable) — it can NEVER deliver while holding exactly 3 because (deliverable c3)
is absent. That is the academic payoff: a hard constraint discharged by the SOLVER, not by
post-hoc filtering.

NOTE on movement integration: the demo can either (a) include the full movement action set
(reuse the 4 move actions from the existing domain so the planner produces a single combined
move+pickup+deliver plan), or (b) keep the task domain abstract (pickup/deliver only, assume
"at" is achieved by sub-navigation) and let the EXECUTOR call existing navigateTo/PddlMove
between pickup/deliver steps. Recommendation for the exam: (a) full combined domain is the more
impressive single-solver demonstration but larger; (b) is faster to build and more robust.
CONFIRMED CHOICE: (b) — a thin executor that walks the plan, and for each pickup/deliver step
issues the existing `go_pick_up`/`go_deliver` (or navigateTo + emitPickup/emitPutdown)
sub-intentions. This reuses all proven navigation and keeps the PDDL focused on the constraint logic.

### B.5 New code for Part B  (ABSTRACT executor; ENV-GATED registration)
Confirmed: abstract domain (B.4 option (b)) — PDDL plans pickup/deliver/count only; movement
is delegated to existing sub-intentions. Confirmed: the whole Part B surface is gated behind an
env flag so it can be turned off cleanly.

- ENV FLAG: `const TASK_DEMO = process.env.PDDL_TASK_DEMO === '1'` (read once, e.g. in context.js
  alongside other env-derived flags, exported; or read locally in commandTools + planLibrary).
- NEW FILE `domain-deliveroo-tasks.pddl` (abstract pickup/deliver/count domain from B.3, NO move
  actions — `(at me ?t)` for pickup/deliver tiles is assumed achieved by the executor's
  sub-navigation).
- NEW FILE `myAgent/plans/PddlTaskPlan.js`:
  - `static isApplicableTo(intent) { return intent === 'pddl_stack_demo'; }`
  - `execute(intent, ...)`:
    1. snapshot a bounded set of free parcels (`parcels.free()`, cap K).
    2. read requiredStackSize/maxStackSize/forbiddenStackSizes from missionConstraints.
    3. build problem string (count chain, deliverable set, parcel/free-parcel + delivery facts).
       Movement facts NOT needed (abstract domain).
    4. `plan = await onlineSolver(taskDomain, problem)`.
    5. set `pddl.busy=true` (take the lock so revision won't interrupt) and execute steps:
       for each `pickup` step call `subIntention(['go_pick_up', px, py, pid])`, for each `deliver`
       step call `subIntention(['go_deliver', dx, dy])` (these reuse all proven navigation,
       including PddlMove crate-pushing if needed). Release the lock in `finally`.
- MODIFY `myAgent/plans/planLibrary.js`: register PddlTaskPlan ONLY when `TASK_DEMO` is set
  (conditional push), so with the flag off the predicate is inert.
- NEW LLM TOOL `run_stack_plan` in commandTools.js buildTools: only ADD it to the tool catalogue
  when `TASK_DEMO` is set; body is `command(['pddl_stack_demo'], ...)`. Gate behind the autonomy
  gate exactly like other action tools. With the flag off, the model never sees the tool.

### B.6 Honest limitations of Part B
- Combinatorial: STRIPS counter + movement can blow up; keep K and the parcel set tiny.
- No optimization: the plan satisfies constraints but ignores decay/reward — that is why it must
  not replace the strategy layer. Frame as a constraint-satisfaction demonstration.
- The dual-bfws-ffparser latency: each solve is a network round-trip; the demo is
  invoked on demand, not per tick.

---

## PART C — Recommended minimal subset for the exam

IMPLEMENT, in order:
1. PART A `go_near` distance mission (PRIMARY, always on). Concrete, reuses PddlMove navigation +
   crate pushing, adds a clean new predicate + LLM tool. Demonstrates PDDL for spatial-constraint
   navigation — clear breadth beyond crate-only use. One-shot tool (no persistent constraint).
2. PART B scoped `run_stack_plan` demo (SECONDARY, the academic highlight, ENV-GATED behind
   `PDDL_TASK_DEMO=1`). Separate abstract domain + plan + tool; executor reuses existing
   go_pick_up/go_deliver navigation. Demonstrates PDDL PRECONDITIONS discharging mission
   constraints (forbidden/required/max stack sizes). Disabled by default; flip the flag to demo.

DO NOT attempt:
- Red/green light as PDDL. HONEST ASSESSMENT: it is a purely reactive boolean gate
  (trafficLight.red checked by optionsGeneration / command()). There is no search problem, no
  sequencing, no constraint to discharge — PDDL adds nothing and would be contrived. State this
  in the report as a deliberate, justified exclusion (knowing when NOT to use a planner is itself
  a defensible design point).
- Replacing the strategy layer's scoring with PDDL (cannot express decay/contest in STRIPS).

---

## Integration points summary (exact)

| Concern | File | Change |
|---|---|---|
| Distance plan | myAgent/plans/PddlGoalMove.js | NEW; isApplicableTo intent==='go_near'; picks goalTile in JS, reuses PDDL navigate |
| Shared nav | myAgent/plans/PddlMove.js | REFACTOR: export shared navigate routine (replan loop + buildProblem + runPlan) for reuse |
| Plan registry | myAgent/plans/planLibrary.js | import + register PddlGoalMove (always); PddlTaskPlan (only when PDDL_TASK_DEMO=1) |
| Distance tool | myAgent/llm/commandTools.js | NEW go_near tool in buildTools -> command(['go_near',x,y,mode,D],...) |
| Task domain | domain-deliveroo-tasks.pddl | NEW STRIPS domain: pickup/deliver with count chain + deliverable preconditions |
| Task plan | myAgent/plans/PddlTaskPlan.js | NEW; isApplicableTo intent==='pddl_stack_demo'; builds problem from missionConstraints + parcels |
| Task tool | myAgent/llm/commandTools.js | NEW run_stack_plan tool (env-gated) -> command(['pddl_stack_demo'],...) |
| LLM prompt | wherever buildTools tools are described to the model | document go_near (+ run_stack_plan when env-gated) |

Key REUSE (do not re-implement): findRoute, reachableFrom (goal-tile filtering); Manhattan inline;
beliefset.objects + beliefset.toPddlString() (topology); onlineSolver; pddl.busy lock pattern;
command()/commandAndAwait routing; PlanBase.subIntention (Part B step execution);
waitForArrival + ACTION_DIR + #runPlan (movement); applyMissionConfig/FIELD_MAP (if persistent
distance added); parcels.free()/carriedBy.

---

## Risks / limitations

- Quantified/disjunctive goals unsafe on dual-bfws-ffparser -> Part A uses JS precompute + single
  ground goal (mitigated).
- Part B state explosion -> bound K and parcel count; on-demand only (mitigated).
- Refactoring PddlMove to share the navigate routine risks regressing the working crate demo ->
  keep the refactor mechanical (extract, no behaviour change); if time-boxed, duplicate instead.
- pddl.busy must wrap any long PDDL execution (Part B) or revision interrupts it.
- go_near Manhattan vs A* mismatch: a tile can be Manhattan-D but A*-far; ranking by findRoute
  length handles "closest reachable", and reachableFrom filtering prevents picking unreachable tiles.

---

## Verification approach (end-to-end, with running agent)

Setup: `node myAgent/launch.js` (or the documented run command); watch the `pddl`/`move:pddl`
logger namespaces. Part B requires `PDDL_TASK_DEMO=1` in the environment.

PART A:
1. No-crate map: LLM-message "go near 7,7 within 3" (or call go_near directly). Expect: a chosen
   goalTile with Manhattan<=3 of (7,7), a posted PDDL problem (log "goal: t..."), a plan of plain
   moves, agent arrives on an acceptable tile. Confirm final `me` satisfies the spec.
2. Crate map: place target so the only acceptable tiles are reachable solely by pushing a crate.
   Expect PDDL plan to include pushRight/etc. and agent to push then arrive. Confirms crate reuse.
3. Edge: spec with no acceptable reachable tile -> tool returns the 'no-acceptable-tile' failure
   string (describeFailure path), agent does not move.
4. mode variants: exact/atleast/atmost produce different goalTiles; verify each.

PART B (with PDDL_TASK_DEMO=1):
1. apply_mission {"requiredStackSize":2,"maxStackSize":4,"forbiddenStackSizes":[3]}; ensure 2-3
   free parcels are sensed; call run_stack_plan.
2. Inspect logged problem string: deliverable set = {2,4}, no (deliverable c3), chain capped c4.
3. Expect plan: pickup, pickup, deliver at count 2 (never deliver at 3). Watch the agent execute
   pickups then a delivery; me.score increases.
4. Negative test: forbiddenStackSizes={1,2} with only deliverable {3} and just 2 parcels present
   -> solver returns no plan (cannot reach a deliverable count) -> tool reports 'pddl-no-plan'.
   Demonstrates the constraint truly gates the solver.
5. Compare against strategy layer OFF (directive gate held) to show PDDL alone produced the
   constraint-respecting sequence.

Offline sanity (no agent): pipe a hand-written problem+domain through onlineSolver in a tiny
scratch invocation to confirm the FF parser accepts the count-chain domain before wiring the tool.

---

## Critical files for implementation
- myAgent/plans/PddlMove.js
- myAgent/plans/planLibrary.js
- myAgent/llm/commandTools.js
- domain-deliveroo.pddl
- myAgent/context.js
- (NEW) myAgent/plans/PddlGoalMove.js
- (NEW) myAgent/plans/PddlTaskPlan.js
- (NEW) domain-deliveroo-tasks.pddl
