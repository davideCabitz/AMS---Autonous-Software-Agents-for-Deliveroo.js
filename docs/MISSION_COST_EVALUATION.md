# Mission ⇄ Cost-Function Evaluation

How a natural-language mission becomes a number the BDI agent maximizes, and how
the system decides whether a mission is *worth doing* — including the rule that
sums the `+`/`−` points of repeated offers of the same mission to find the net worth.

This document covers two coupled mechanisms:

1. **Point-magnitude coordination** — a mission's literal `+N`/`−N` points are pushed
   into the same value scale the BDI cost function already optimizes, so "is this worth
   it?" is a real numeric comparison, not the LLM guessing from English.
2. **Net-sum mission evaluation** — the same mission offered repeatedly with different
   signs (e.g. `−500` then `+1000`) accumulates into a per-mission-type running total;
   the mission is followed while that total is non-negative and refused/stopped otherwise.

---

## 1. The two layers and why they must be wired together

| Layer | Decides | Unit of thought |
|-------|---------|-----------------|
| **LLM command layer** (`myAgent/llm/`) | **WHAT** to do — reads chat missions, classifies, translates them into tool calls / constraints | natural language, mission categories |
| **BDI cost function** (`myAgent/strategies/Strategy.js`) | **HOW / WHETHER** — ranks parcels and deliveries by value, picks the next intention | points (parcel income ≈ tens) |

The BDI value functions speak in **points net of travel decay**. The LLM speaks in
**mission text**. Before this work, a mission's literal points (`+700`, `−1000`) never
entered the BDI's number scale — the LLM accepted or declined by reading the English
sign. The wiring below makes the literal points *cross into* the cost function so the
agent acts on maximization, not on text heuristics.

The shared channel is **`missionConstraints`** in `myAgent/context.js`: the LLM tools
write it, every `Strategy.decide()` reads it, and `sendConstraint` mirrors it to the
worker so both agents evaluate identically.

---

## 2. The BDI cost function (the numbers everything is compared against)

`Strategy.js` ranks options with decay-aware value functions (all in points):

- `bankNowValue()` — value of delivering the current load now:
  `scale·R − n·ρ·d0` (R = carried reward, n = parcels, ρ = decay/tile, d0 = dist to delivery).
- `pickupValue(parcel)` — value of detouring to grab one more, then delivering the lot.
- `bankFirstValue(parcel)` — value of banking now, then fetching the parcel solo.

These already drive autonomous play. The mission work feeds the **same scale** so a
mission's points compete head-to-head with parcel income.

---

## 3. Wiring point magnitudes into the cost function

### 3a. One-shot go-there bonus (`oneShotBonus`)

A mission like *"there is a +700 reward at (8,3)"* becomes a constraint
`oneShotBonus = {x, y, points}` (via `apply_mission`). The BDI then judges it with a
value function in the **same units** as `bankNowValue`:

```js
// Strategy.bonusGoalValue() — net value of diverting to the bonus, in parcel-income units
bonusGoalValue() {
    const b = missionConstraints.oneShotBonus;
    if (!b) return null;
    const d = this.pathLen(me, { x: b.x, y: b.y });
    if (!Number.isFinite(d)) return null;            // unreachable → ignore
    const n = parcels.carriedBy(me.id).length;
    return b.points - n * this.decayRate() * d;      // points minus the decay the detour costs
}
```

The decision to actually divert is gated against the cost function, not taken blindly:

```js
// Strategy.bonusDiversion() — returns ['go_to', x, y] only when the bonus beats the parcel loop
bonusDiversion(currentIntent) {
    const b = missionConstraints.oneShotBonus;
    if (!b) return null;
    if (Math.round(me.x) === b.x && Math.round(me.y) === b.y) return null;  // already there
    const net = this.bonusGoalValue();
    if (net == null) return null;
    const baseline = this.bankNowValue();            // what we'd otherwise do this tick
    if (net - baseline <= SWITCH_MARGIN) return null; // not worth more than banking → ignore
    if (currentIntent?.[0] === 'go_to'
        && currentIntent[1] === b.x && currentIntent[2] === b.y) return null; // already en route
    return ['go_to', b.x, b.y];
}
```

**Where it plugs into the agent loop** — once, before the strategy's own `decide()`, so
*every* strategy is bonus-aware with zero per-subclass code:

```js
// coordinator_agent.js — optionsGeneration()
const option = runtime.strategy.bonusDiversion(currentIntent)
            ?? runtime.strategy.decide(currentIntent);
if (option) myAgent.push(option);
```

Consequence: a `+700` bonus 8 tiles away easily beats the parcel loop and the agent
diverts; a `−500` "bonus" yields a negative `bonusGoalValue`, never beats `bankNowValue`,
and the agent simply never diverts — the penalty is avoided as a *byproduct of
maximization*, not a hard-coded rule.

### 3b. Penalty tiles and delivery multipliers

The same principle applies to other point-bearing missions, also via `missionConstraints`:

- `penaltyTiles: Map<"x_y", points>` — *"going to (x,y) costs 1000"* — the magnitude is
  recorded **and** the key is folded into `avoidTiles`, so A* never routes there.
- `deliveryMultipliers: Map<"x_y", m>` — *"5× pts at (x,y)"* — scales the delivery reward
  inside `bankNowValue`/`pickupValue`, so the agent both routes to and values the bonus tile.

---

## 4. Net-sum evaluation of repeated `+`/`−` missions

Some missions are not a one-tile reward but a **whole routine** (Level-3, multi-agent):

| Mission text | Tool | Net field |
|---|---|---|
| "one picks up, the other delivers — N pts" | `start_handoff` | `handoffNet` |
| "move both near (x,y) and wait — N pts" | `gather_near` | `gatherNet` |
| "red light green light — N pts" | `start_light_mission` | `lightNet` |

These have no single tile to price, so instead of a per-tile value function they use a
**running point total per mission type**, in `missionConstraints` (`context.js`):

```js
handoffNet: 0,   // Σ of point values of all "one picks up / other delivers" offers
gatherNet:  0,   // Σ of point values of all "move both near (x,y) and wait" offers
lightNet:   0,   // Σ of point values of all red-light-green-light offers
```

### 4a. The rule

A single helper expresses the whole policy (`missionState.js`):

```js
// armed unless the running total is negative
export function armedByNet(net) {
    return net >= 0;
}
```

- **net ≥ 0 → armed**: arm/keep the routine. This includes the default `0` and the
  **no-reward** case (a mission that mentions no points contributes nothing → stays armed
  → followed normally, e.g. "let's play red light green light" with no prize stated).
- **net < 0 → declined**: refuse a fresh offer, and **stop** the routine if it is already
  running (so a penalty can pull the agent back out).

### 4b. Accumulation (the `+`/`−` sum)

Each new offer of a type **adds** its signed value to that type's total — it does not
replace it (`missionState.applyMissionConfig`):

```js
if (config.handoffNet != null) { missionConstraints.handoffNet += Number(config.handoffNet); }
if (config.gatherNet  != null) { missionConstraints.gatherNet  += Number(config.gatherNet);  }
if (config.lightNet   != null) { missionConstraints.lightNet   += Number(config.lightNet);   }
```

The tool ties parse, accumulate, mirror, and decide together (`commandTools.js`):

```js
// reward is ONLY an explicit "pts=N" token — a bare geometry number is never a reward
function parseRewardToken(input) {
    const m = String(input ?? '').match(/(?:pts|points)\s*=\s*(-?\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

const applyRoutineNet = (field, input) => {
    const pts = parseRewardToken(input);
    if (pts != null) {
        const cfg = { [field]: pts };
        applyMissionConfig(cfg);     // ADD to the running total
        sendConstraint('apply', cfg); // mirror to the worker
    }
    return armedByNet(missionConstraints[field]);  // armed? → caller arms; else declines/stops
};
```

Each Level-3 tool calls it and acts on the result, e.g. handoff:

```js
async start_handoff(input) {
    if (!applyRoutineNet('handoffNet', input)) {
        stopHandoff();              // stop it if a penalty flipped the net negative
        return 'Mission declined.';
    }
    return startHandoff(myAgent, resumeAutonomy);
}
```

`startHandoff` also re-checks `handoffNet < 0` directly (defense-in-depth), and
`gather_near`/`start_light_mission` likewise release their hold / disarm when the net
goes negative.

### 4c. Worked example — the `+`/`−` sum deciding worth

> Admin: *"red light green light — you lose 500 pts."* → LLM calls
> `start_light_mission("pts=-500")` → `lightNet = 0 + (−500) = −500` → `armedByNet(−500)`
> is **false** → **"Mission declined."**, mission not armed.
>
> Later, same session: *"red light green light — +1000 pts."* →
> `start_light_mission("pts=1000")` → `lightNet = −500 + 1000 = +500` →
> `armedByNet(+500)` is **true** → **armed and followed**.

So the agent does the mission precisely when the **sum of all its offers is worth it**.
The reverse also holds: an armed `+200` handoff that later receives a `−300` offer nets
`−100` → the running handoff is **stopped**.

Conventions: only an explicit `−N` / "you lose" / "penalty" is negative; a bare number
("500") is `+500`; an absent reward contributes `0` (neutral → still followed).

---

## 5. End-to-end decision flow

```
chat mission ──▶ LLM classify ──▶ tool call
                                    │
            ┌───────────────────────┴───────────────────────────┐
            │ point-magnitude mission        │ Level-3 routine    │
            ▼                                 ▼                    │
   apply_mission writes              applyRoutineNet adds points  │
   missionConstraints                to handoffNet/gatherNet/     │
   (oneShotBonus /                   lightNet, then armedByNet:   │
    penaltyTiles /                     net ≥ 0 → arm/keep         │
    deliveryMultipliers)               net < 0 → decline / stop   │
            │                                 │                    │
            ▼                                 ▼                    │
   BDI value functions read missionConstraints each tick:         │
     bonusDiversion() vs bankNowValue()  →  divert only if it wins │
     pathLen avoids penaltyTiles, scale boosts multiplier tiles    │
            │                                                      │
            ▼                                                      │
   runtime.strategy pushes the next intention ── BDI executes ─────┘
                                    │
                                    ▼
        constraints mirrored to the worker via sendConstraint
```

**Decline is silent and behavioural, not just verbal.** A refused mission returns
`"Mission declined."`, which `commandLoop.js` does NOT count as an applied mission
(so it never gets overridden by a stray `"Mission accepted."`), and which the chat
layer's `SILENT` filter suppresses — the refusal changes behaviour (routine not armed /
stopped, bonus never pursued) without a spoken acknowledgement.

---

## 6. File map

| File | Role |
|---|---|
| `myAgent/context.js` | `missionConstraints`: `oneShotBonus`, `penaltyTiles`, `deliveryMultipliers`, `handoffNet`/`gatherNet`/`lightNet` |
| `myAgent/strategies/Strategy.js` | cost function: `bankNowValue`/`pickupValue`/`bankFirstValue`, `bonusGoalValue`, `bonusDiversion` |
| `myAgent/coordinator_agent.js` | `optionsGeneration`: `bonusDiversion()` checked before `decide()` |
| `myAgent/llm/missionState.js` | `applyMissionConfig` (ADD-to-net), `armedByNet`, drop/reset, worker mirroring |
| `myAgent/llm/commandTools.js` | `parseRewardToken`, `applyRoutineNet`, the 3 Level-3 tools |
| `myAgent/llm/handoff.js` | `startHandoff` net guard |
| `myAgent/llm/prompt.js` | teaches the LLM to pass `pts=N` and the net-sum/decline rules |
| `myAgent/llm/commandLoop.js` | decline vs "Mission accepted." ack handling |
| `test/level3_net.test.js` | offline test of the net-sum gate (incl. the −500→+1000 re-arm) |
