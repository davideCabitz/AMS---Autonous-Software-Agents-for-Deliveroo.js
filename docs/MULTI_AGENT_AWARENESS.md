# Multi-Agent Awareness

## The problem

The agent used to treat every other agent as a **wall that only matters on contact**.
Perception stored just each competitor's current position, replaced every tick — no
identity across ticks, no sense of where anyone was heading. And the decision layer
never even looked at competitors: it scored parcels and delivery zones as if it were
alone on the map. The only reaction to another agent was physical — when a move
literally failed because someone occupied the next tile.

That blindness caused four recurring losses: racing for parcels we'd never win,
committing to congested delivery routes, freezing behind parked agents, and two of
our own agents livelocking in corridors.

## The guiding principle

Every change follows one rule: **discount, never ban.** A sensed competitor lowers a
target's appeal in proportion to how likely we are to *lose* it, but never removes the
target outright. A competitor isn't proof of intent — if it turns away, we must be
free to re-acquire the target next tick. So all reasoning is probabilistic and
self-correcting, and every "switch target" decision still passes the pre-existing
anti-flip-flop margins so a wavering competitor can't make us oscillate.

The foundation for all of it: we now track each competitor **by identity across
ticks**, which lets us estimate its velocity — where it's going, not just where it is.

---

## The cases — before and after

### Case 1 — Racing for a parcel a competitor will reach first
**Before:** Two parcels in range; the agent commits to the nearest by raw value. A
competitor standing right next to that parcel beats us to it, and the whole trip is
wasted.
**Now:** Each parcel's value is scaled by an estimated win-probability based on *our*
distance versus the *nearest competitor's* distance to it. A parcel we're clearly
going to lose is deprioritized, so a slightly-farther but uncontested parcel wins.
**Why it works:** the comparison is real path distance for both racers, so a
competitor "close as the crow flies" but walled off doesn't scare us off.

### Case 2 — Insisting on a delivery zone a competitor has congested
**Before:** Once heading to a delivery zone, the agent kept going as long as the route
was merely *reachable*. A competitor clogging the only doorway turned a short trip into
a long crawl, and we never reconsidered.
**Now:** A delivery zone with a competitor sitting on or beside it carries a congestion
penalty, so a clearer slightly-farther zone can win. Crucially, switching only happens
when the alternative beats the current target by a real margin — which also lets us
*revert* to the original zone once the competitor steps aside, **without** ping-ponging
when a competitor merely hovers in the doorway.

### Case 3 — Freezing behind a parked competitor
**Before:** When an agent blocked our goal tile, we always waited a fixed budget
(several seconds) hoping it would move — even if that agent was parked or deadlocked
and never would.
**Now:** We check whether the blocker is actually moving. A moving agent is probably
passing through, so we still wait. A stationary one means waiting is wasted — we abandon
the wait immediately and let the agent pick a new target.

### Case 4 — Chasing a parcel a competitor is already carrying
**Before / Now:** This turned out to need *no new logic*. A parcel being carried is
already excluded from the pool of pickable parcels, so the agent never considered it.
We verified this rather than adding redundant code. (A competitor merely *standing on*
a free parcel is handled by Case 1.)

### Case 5 — Two agents livelocking in a corridor
**Before:** Two of our own agents meeting head-on in a narrow corridor each kept trying
the same blocked step forever — neither yielded, both stuck.
**First attempt (didn't fully work):** we made the blocked agent step "sideways, away
from the goal." This works in a 1-wide corridor, but in a **2-wide hallway** the
sideways tile is itself a valid lane — so the agent immediately rerouted through it and
re-blocked, and two mirror-image agents kept picking symmetric tiles and re-colliding.
**Now:** after repeated blocks on the same tile, the agent takes a **random** free step
and pauses to let the other pass. Randomness is the key: it breaks the symmetry that
made both agents repeat the same move, so they diverge. It's allowed a few attempts
before giving up, because one random step may not separate them on the first try.

### Case 6 — Camping a spawner a competitor already owns
**Before:** When idle and waiting for parcels to spawn, the agent picked the nearest
spawner regardless of whether a competitor was already sitting on it — so both waited on
the same tile, splitting nothing.
**Now:** a spawner occupied by a competitor carries a penalty in the idle-ranking, so we
prefer an unclaimed one. It's only a penalty, not a ban: if the camped spawner is the
*only* reachable option, we still go there.

---

## Why it's safe

- **Backward-compatible:** with no competitors sensed, every estimate collapses to its
  original value — the agent behaves exactly as it did before. The new logic only
  activates when another agent is actually nearby.
- **No flip-flopping:** small competitor movements are smoothed out, and all target
  switches must clear an existing stability margin, so a jittering competitor can't make
  the agent oscillate.
- **A late correction:** an early version discounted parcels even when we were *winning*
  the race, which made the agent skip a high-value parcel right under its feet. Fixed so
  the discount applies *only* when we're genuinely losing — a parcel we're closest to
  always keeps its full value.

## Status

All six cases are implemented and inherited by every strategy automatically. The work
is validated by logic tests and live multi-agent runs; tuning constants (how aggressive
the contest discount is, how soon the yield triggers) can still be adjusted from live
logs.
