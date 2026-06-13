# Plan 2 — Level-3 Gaps (odd-row red/green-light)

> **Global rule:** nothing already working may break. **`lab/` is the course's code and must stay
> untouched** — only my own code (everything outside `lab/`) changes. Verified by `node --check`
> (no live server test).

## Context
Two Level-3 mission types were flagged as not fully covered:
1. **"Move both agents near (x,y) within distance D and wait for each other"** (26c2_10).
2. **Odd-row red/green-light variant** — *"all agents must move to an odd-numbered row and wait
   for our message before moving again"*.

## Part A — both-near-and-wait: NO code change (scorer dropped)
A scorer/mission-agent is **course/grading tooling**, and the only sensible place for it is
`lab/missionAgents/` — which must remain untouched. It is therefore **not** mine to add, and
no scorer is written.

The **agent behaviour** that satisfies this mission already exists entirely in my code (no change
needed): the `prompt.js` MISSION PATTERNS line maps *"move both near (x,y) within D and wait"* to
`go_to` (self) + `order_partner_goto` (partner) + `halt_partner()` + `hold()`. Whether the bonus is
awarded is decided by the course's official scorer at grading time, not by anything I run.

## Part B — odd-numbered-row red/green-light  ✅ implemented (my code only)
- **Reflex: unchanged.** Stop-on-RED / go-on-GREEN already works in `myAgent/llm/index.js` and
  `myAgent/partnerWorker.js` (anchored regex fast-path).
- **Pre-positioning** added as an LLM directive — `myAgent/llm/prompt.js` MISSION PATTERNS:
  - `"Move to an odd-numbered row and wait for our message" -> a "row" is the y coordinate, so an
    ODD row = odd y. get_my_position; if y is even, go_to a reachable tile with odd y (x,y+1 or
    x,y-1); also order_partner_goto an odd-row tile; then acknowledge — the RED/GREEN reflex
    handles stop/go.`
  - Convention stated explicitly: **row = y**, and per the project's COORDINATES rule
    ("up = y+1") an "odd-numbered row" = **odd y**.

## Bug / smell review (done)
- Odd-row: y-parity convention is consistent with the project's `up = y+1` convention and with the
  prompt's COORDINATES section. The agent picks a *reachable* odd-row tile via `go_to`'s own
  pathing (it does not blindly assume `y±1` is walkable).

## Verification (no live server)
- `node --check myAgent/llm/prompt.js` — passes.
- The odd-row directive uses only existing tools (`get_my_position`, `go_to`,
  `order_partner_goto`) plus the unchanged RED/GREEN reflex, so it rides the already-verified
  command path.
- **Deferred (needs a server, and the course's own scorer)**: shout the odd-row prompt via
  `test/probe.js` → confirm both agents reach an odd row, then obey RED/GREEN; for 26c2_10, run
  the course's scorer (unchanged `lab/`) and confirm the gather-and-wait bonus is awarded.
