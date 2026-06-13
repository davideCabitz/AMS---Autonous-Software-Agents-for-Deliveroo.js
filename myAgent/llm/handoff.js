import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, otherAgents, directive, trafficLight, CARRYING_CAPACITY } from '../context.js';
import { findRoute } from '../utils/astar.js';
import { partner, sendOrder, sendHalt, sendResume, requestStatus } from './partner.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:handoff');

/*
 * Cross-agent handoff routine for the "one agent picks up, another delivers"
 * mission (+bonus PER delivered parcel, repeating). The LLM starts/stops it via
 * the start_handoff/stop_handoff tools; the cycle itself is deterministic code —
 * a repeating per-parcel routine is exactly what the LLM should NOT babysit.
 *
 * The rendezvous is computed PER PARCEL from live geometry, so the routine works
 * on any map — multiple spawners, multiple delivery tiles, walls — not just a
 * single corridor. There is no fixed "post": for each parcel the coordinator
 *   - picks D = the delivery tile with the shortest ROUTE from the cargo (so the
 *     parcel takes its natural shortest journey across the map and decays least,
 *     and every delivery tile is in play — Manhattan-nearest could be far or
 *     walled off);
 *   - picks M = the split point ALONG that cargo→D shortest path that balances
 *     the coordinator's carry leg (cargo→M) against the worker's leg
 *     (worker→M→D), so neither agent idles waiting for the other. Together the
 *     two legs traverse exactly the shortest cargo path — no detour is added.
 *
 * One cycle:
 *   1. worker frozen (it must never pick up parcels itself — those deliveries
 *      would not qualify for the cross-agent bonus);
 *   2. coordinator picks up the nearest reachable free parcel;
 *   3. computes D and M from the cargo's position and the worker's anchor;
 *   4. carries the parcel to M, puts it down and steps OFF M — preferring to back
 *      up one tile along the carry route (the spawn side), which keeps single-lane
 *      corridors deadlock-free (coordinator retreats toward spawn, worker advances
 *      toward delivery, the two never need to pass). M is never a delivery tile,
 *      or the coordinator's putdown would count as ITS OWN delivery and void the
 *      bonus;
 *   5. orders the worker: pick up at M, then deliver at D → cross-agent bonus for
 *      both. The worker has NO return-to-post leg — it ends at D, which becomes
 *      its anchor for the next rendezvous.
 * Any failed step skips to the next cycle with fresh state; no parcels → idle.
 *
 * The worker's leg (step 5) runs detached so the coordinator fetches the next
 * parcel in parallel; the loop re-synchronizes on it before the next drop (a new
 * worker order would supersede the in-flight delivery and void that bonus).
 */

const IDLE_RETRY_MS = 2_000;
// Extra tiles over the direct route to the meeting that an opportunistic
// en-route pickup may add (mirrors the strategies' detour slack).
const ENROUTE_SLACK = 3;
// Hard cap on any single own-navigation step, so one wedged/stale intention can
// never freeze the whole routine (worker orders carry their own 45s timeout).
const STEP_TIMEOUT_MS = 60_000;

let running = false;

// Parcel ids the coordinator has put down for the worker. They are back on the
// ground (sensing re-reports them as free), but fetching one again would steal
// the worker's pickup — observed live: B re-grabbed its own drop and stood on
// the meeting tile, blocking A forever. Ignored by pickTargetParcel.
const handedOff = new Set();

function withTimeout(promise, ms = STEP_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout']), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True while the handoff loop owns the agent (runDirective must not release the gate). */
export function handoffRunning() { return running; }

const deliveryKeys = () => new Set(deliveryTiles.map(t => `${t.x}_${t.y}`));

/** Resolve early when stopped/aborted so a stop never waits out a full idle delay. */
function idle(ms) {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (!running || directive.aborted || Date.now() >= start + ms) resolve();
            else setTimeout(tick, 100);
        };
        setTimeout(tick, 100);
    });
}

/** Nearest reachable parcel. Live sightings always beat remembered ones: a
 *  remembered parcel may be a ghost (already taken/decayed — observed live:
 *  the routine trekked the whole map chasing them), so they only matter when
 *  nothing at all is in view. Null if none. */
function pickTargetParcel() {
    const GHOST_PENALTY = 10_000; // any live parcel outranks every remembered one
    const candidates = [
        ...parcels.free().map(p => ({ p, bias: 0 })),
        ...parcels.remembered().filter(r => !parcels.get(r.id)).map(p => ({ p, bias: GHOST_PENALTY })),
    ].filter(({ p }) => !handedOff.has(p.id));   // never re-fetch own drops
    return candidates
        .map(({ p, bias }) => {
            const route = findRoute(me, p);
            return route ? { p, len: route.length + bias } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.len - b.len || b.p.reward - a.p.reward)[0]?.p ?? null;
}

/**
 * Structure-only BFS path (array of {x,y} tiles, start included) over the
 * walkable map. Unlike findRoute it IGNORES other agents: the rendezvous must be
 * computable even when the worker itself sits mid-route (single-lane maps).
 */
function staticRoute(from, to) {
    const walk  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const start = `${Math.round(from.x)}_${Math.round(from.y)}`;
    const goal  = `${Math.round(to.x)}_${Math.round(to.y)}`;
    if (!walk.has(start) || !walk.has(goal)) return null;
    const prev = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === goal) {
            const path = [];
            for (let k = goal; k; k = prev.get(k)) path.unshift(k);
            return path.map(k => { const [x, y] = k.split('_').map(Number); return { x, y }; });
        }
        const [x, y] = cur.split('_').map(Number);
        for (const nk of [`${x + 1}_${y}`, `${x - 1}_${y}`, `${x}_${y + 1}`, `${x}_${y - 1}`]) {
            if (walk.has(nk) && !prev.has(nk)) { prev.set(nk, cur); queue.push(nk); }
        }
    }
    return null;
}

/**
 * Structure-only BFS distance map from `from` to every walkable tile ("x_y" ->
 * step count). One sweep, so the rendezvous search can score every candidate
 * handoff tile by the worker's distance to it in O(1). Ignores other agents,
 * like staticRoute. Null when `from` is off the walkable map.
 */
function bfsDistances(from) {
    const walk  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const start = `${Math.round(from.x)}_${Math.round(from.y)}`;
    if (!walk.has(start)) return null;
    const dist = new Map([[start, 0]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        const d = dist.get(cur);
        const [x, y] = cur.split('_').map(Number);
        for (const nk of [`${x + 1}_${y}`, `${x - 1}_${y}`, `${x}_${y + 1}`, `${x}_${y - 1}`]) {
            if (walk.has(nk) && !dist.has(nk)) { dist.set(nk, d + 1); queue.push(nk); }
        }
    }
    return dist;
}

/**
 * Plan the whole handoff for the current cargo: pick the delivery D and the
 * meeting tile M together. Delivery tiles are tried nearest-first by structural
 * route (route-based, not Manhattan — with walls the Manhattan-nearest delivery
 * can be far or unreachable), and the FIRST one that admits a valid handoff tile
 * is taken. Falling through to the next-nearest delivery matters when the closest
 * one has no non-delivery split point (e.g. the cargo already sits on or next to
 * it). Returns { D, m, i, route } or null when no delivery yields a handoff.
 */
function planHandoff(cargo, wpos) {
    const ranked = deliveryTiles
        .map(d => { const r = staticRoute(cargo, d); return r ? { d, len: r.length - 1 } : null; })
        .filter(Boolean)
        .sort((a, b) => a.len - b.len);
    for (const { d } of ranked) {
        const rendez = chooseMeeting(cargo, d, wpos);
        if (rendez) return { D: d, ...rendez };
    }
    return null;
}

/**
 * Choose the handoff tile M along the cargo's shortest path to the delivery D.
 * For each tile R[i] on that path, the coordinator's carry leg is i steps and the
 * worker's leg is (anchor→M) + (M→D); M is the split that minimizes the larger of
 * the two (makespan), so the agents share the work instead of one idling. M is
 * never a delivery tile (a drop there would score as the coordinator's own
 * delivery) nor the worker's own anchor tile, and the worker must be able to
 * reach it. Returns { m, i, route } or null.
 */
function chooseMeeting(from, D, wpos) {
    const route = staticRoute(from, D);
    if (!route || route.length < 1) return null;
    const L = route.length - 1;                       // structural steps cargo→D
    const deliv = deliveryKeys();
    const wKey  = `${wpos.x}_${wpos.y}`;
    const wDist = bfsDistances(wpos);
    if (!wDist) return null;

    let best = null;
    for (let i = 0; i <= L; i++) {
        const m  = route[i];
        const mk = `${m.x}_${m.y}`;
        if (deliv.has(mk)) continue;                  // putdown there would be B's own delivery → no bonus
        if (mk === wKey)   continue;                  // never hand off on the tile the worker is parked on
        const dM = wDist.get(mk);
        if (dM == null) continue;                     // worker cannot reach this handoff tile
        const aLeg = dM + (L - i);                    // worker: anchor→M→D
        const bLeg = i;                               // coordinator: cargo→M
        const cost = Math.max(aLeg, bLeg);
        if (!best || cost < best.cost) best = { m, i, route, cost };
    }
    return best;
}

/**
 * Nearest live parcel worth a small detour on the way to `meeting`: sensed,
 * not one of our own drops, and adding at most ENROUTE_SLACK tiles over the
 * direct route. Null when carrying at capacity or nothing qualifies.
 */
function enRouteParcel(meeting, wBlock) {
    if (parcels.carriedBy(me.id).length >= CARRYING_CAPACITY) return null;
    const direct = findRoute(me, meeting, wBlock);
    if (!direct) return null;
    return parcels.free()
        .filter(p => !handedOff.has(p.id))
        .map(p => {
            const toP  = findRoute(me, p, wBlock);
            const pToM = toP && findRoute(p, meeting, wBlock);
            return toP && pToM ? { p, cost: toP.length + pToM.length } : null;
        })
        .filter(Boolean)
        .filter(({ cost }) => cost <= direct.length + ENROUTE_SLACK)
        .sort((a, b) => a.cost - b.cost)[0]?.p ?? null;
}

/** Walkable, non-delivery, unoccupied neighbours of a tile. */
function freeNeighbours(tile, { excludeDelivery = true } = {}) {
    const walk  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const deliv = deliveryKeys();
    const occupied = new Set(otherAgents.map(a => `${a.x}_${a.y}`));
    return [
        { x: tile.x + 1, y: tile.y }, { x: tile.x - 1, y: tile.y },
        { x: tile.x, y: tile.y + 1 }, { x: tile.x, y: tile.y - 1 },
    ].filter(n => {
        const k = `${n.x}_${n.y}`;
        if (!walk.has(k) || occupied.has(k)) return false;
        if (excludeDelivery && deliv.has(k)) return false;
        return true;
    });
}

/**
 * Where the coordinator steps after dropping at M (it MUST vacate M, or the
 * worker's pickup can never path onto it). Preference order:
 *   1. back up one tile along the carry route — the spawn side, away from the
 *      worker's approach from D. This is what keeps single-lane corridors
 *      deadlock-free: B retreats toward spawn while A advances toward delivery.
 *   2. a free neighbour of M farthest from both the worker's anchor and D (stay
 *      out of the worker's M→D path).
 *   3. any neighbour (delivery tiles allowed now — B is empty, standing on one is
 *      harmless), then the nearest reachable walkable tile that isn't M/worker.
 */
function chooseAside(M, i, route, D, wpos, wBlock) {
    const deliv = deliveryKeys();
    const ok = n => !(n.x === wpos.x && n.y === wpos.y) && !(n.x === M.x && n.y === M.y);

    if (i >= 1) {
        const back = route[i - 1];
        if (ok(back) && !deliv.has(`${back.x}_${back.y}`) && findRoute(me, back, wBlock)) return back;
    }
    const farFrom = n =>
        Math.abs(n.x - D.x) + Math.abs(n.y - D.y) + Math.abs(n.x - wpos.x) + Math.abs(n.y - wpos.y);
    const neigh = freeNeighbours(M).filter(ok).sort((a, b) => farFrom(b) - farFrom(a));
    if (neigh.length && findRoute(me, neigh[0], wBlock)) return neigh[0];

    const any = freeNeighbours(M, { excludeDelivery: false }).find(ok);
    if (any && findRoute(me, any, wBlock)) return any;

    return walkableTiles
        .filter(ok)
        .map(t => ({ t, d: Math.abs(t.x - M.x) + Math.abs(t.y - M.y) }))
        .sort((a, b) => a.d - b.d)
        .map(({ t }) => t)
        .find(t => findRoute(me, t, wBlock)) ?? null;
}

async function workerPosition() {
    const res = await requestStatus(3_000);
    try {
        const s = JSON.parse(res);
        if (s.x != null) return { x: Math.round(s.x), y: Math.round(s.y) };
    } catch { /* timed out — fall back below */ }
    if (partner.lastStatus?.x != null)
        return { x: Math.round(partner.lastStatus.x), y: Math.round(partner.lastStatus.y) };
    return null;
}

async function loop(myAgent) {
    sendHalt();                       // worker must not collect parcels on its own
    directive.active = true;          // coordinator autonomy stands down for the whole routine
    let exploreIdx = 0;               // cycles through spawners when no parcel is in sight

    // The worker's anchor: where it will be standing, idle, when it next needs an
    // order. It has no fixed home post — it ends each cycle on the delivery tile
    // it just used, and the next rendezvous is computed around that. Seeded from
    // its live position; thereafter set to the previous cycle's delivery. Anchoring
    // on this predicted spot (rather than a blocking status round-trip per cycle)
    // lets the coordinator pick the next meeting point the instant it has cargo,
    // even while the worker is still finishing the previous delivery.
    let workerAnchor = await workerPosition() ?? { x: Math.round(me.x), y: Math.round(me.y) };
    log(`worker anchor (initial): (${workerAnchor.x},${workerAnchor.y})`);

    // Step-5 pipeline of the PREVIOUS cycle (worker pickup → delivery). It runs
    // detached so the coordinator fetches the next parcel while the worker
    // delivers; the loop re-synchronizes on it before the next drop.
    let workerChain = Promise.resolve();

    while (running && !directive.aborted) {
        try {
            // Red light: no movement at all — wait it out.
            if (trafficLight.red) { await idle(500); continue; }

            // 1.+2. fetch a parcel — but ONLY when not already carrying: cargo may
            //    predate start_handoff or survive a failed cycle, and must reach
            //    the worker first, not wait for yet another spawn. With the worker
            //    frozen and nobody exploring, an empty view would stall the routine
            //    forever, so tour the spawners until something shows up.
            if (parcels.carriedBy(me.id).length === 0) {
                const target = pickTargetParcel();
                if (!target) {
                    const spots = spawnerTiles.filter(t => findRoute(me, t));
                    if (!spots.length) { await idle(IDLE_RETRY_MS); continue; }
                    const s = spots[exploreIdx++ % spots.length];
                    if (Math.round(me.x) === s.x && Math.round(me.y) === s.y) {
                        await idle(IDLE_RETRY_MS); // already on the spawner — wait for a spawn
                    } else {
                        log(`no parcel in sight — checking spawner (${s.x},${s.y})`);
                        await withTimeout(myAgent.commandAndAwait(['go_to', s.x, s.y])).catch(() => {});
                    }
                    continue;
                }

                log(`cycle: fetching parcel ${target.id} at (${target.x},${target.y})`);
                await withTimeout(myAgent.commandAndAwait(['go_pick_up', target.x, target.y, target.id]));
                if (!running || directive.aborted) break;
                if (parcels.carriedBy(me.id).length === 0) {
                    log('parcel gone before pickup — next cycle');
                    continue;
                }
            }

            // 3. choose THIS parcel's delivery and rendezvous from live geometry.
            const cargo = { x: Math.round(me.x), y: Math.round(me.y) };
            const plan = planHandoff(cargo, workerAnchor);
            if (!plan) {
                log(`no reachable delivery with a valid meeting from cargo (${cargo.x},${cargo.y}) — next cycle`);
                await idle(IDLE_RETRY_MS); continue;
            }
            const { D, m: meeting, i: carryLen, route } = plan;
            log(`delivery (${D.x},${D.y}); meeting (${meeting.x},${meeting.y}) [B carries ${carryLen}, A: approach + ${route.length - 1 - carryLen}]`);

            // 4. travel to M, opportunistically grabbing any sensed parcel that
            //    costs at most ENROUTE_SLACK extra tiles (one more parcel per
            //    exchange at ~zero travel cost); re-check after every pickup.
            //    Then sync on the worker chain BEFORE dropping: the putdown must
            //    happen with the worker free, or its pickup order races its own
            //    in-flight delivery.
            //    Single-spawner maps skip this entirely: every parcel appears at
            //    the one tile B already fetches from, so nothing can spawn
            //    "on the way" — no point re-evaluating after leaving.
            const wBlock = new Set([`${workerAnchor.x}_${workerAnchor.y}`]);
            if (spawnerTiles.length > 1) {
                for (let extra = enRouteParcel(meeting, wBlock); extra; extra = enRouteParcel(meeting, wBlock)) {
                    log(`en-route pickup ${extra.id} at (${extra.x},${extra.y})`);
                    await withTimeout(myAgent.commandAndAwait(['go_pick_up', extra.x, extra.y, extra.id]));
                    if (!running || directive.aborted) break;
                }
                if (!running || directive.aborted) break;
            }
            await withTimeout(myAgent.commandAndAwait(['go_to', meeting.x, meeting.y]));
            if (!running || directive.aborted) break;
            await workerChain;
            if (!running || directive.aborted) break;
            const carried = parcels.carriedBy(me.id);
            await socket.emitPutdown();
            for (const p of carried) { parcels.remove(p.id); handedOff.add(p.id); }
            log(`dropped ${carried.length} parcel(s) at meeting (${meeting.x},${meeting.y})`);

            // Vacating M is MANDATORY — if the coordinator stays put, the worker's
            // pickup can never path onto M.
            const aside = chooseAside(meeting, carryLen, route, D, workerAnchor, wBlock);
            if (aside) await withTimeout(myAgent.commandAndAwait(['go_to', aside.x, aside.y])).catch(() => {});
            if (!running || directive.aborted) break;

            // 5. worker: collect at M, deliver at D — DETACHED, so the coordinator
            //    heads straight back for the next parcel instead of idling at the
            //    meeting while the worker travels. The worker-side steps stay
            //    strictly sequential: a new order would supersede the previous one.
            //    No return-to-post leg — the worker ends at D, its next anchor.
            workerChain = (async () => {
                const pickRes = await sendOrder(['go_pick_up', meeting.x, meeting.y]);
                log(`worker pickup: ${pickRes}`);
                if (!running || directive.aborted) return;
                if (!/^Failed|no parcel/i.test(pickRes)) {       // stolen/decayed → skip delivery
                    const delivRes = await sendOrder(['go_deliver', D.x, D.y]);
                    log(`worker delivery: ${delivRes}`);
                }
            })().catch(() => {});
            workerAnchor = { x: D.x, y: D.y };   // predicted free spot for the next rendezvous
        } catch (err) {
            const tag = Array.isArray(err) ? err.join(' ') : (err?.message ?? String(err));
            log.warn(`cycle failed (${tag}) — retrying with fresh state`);
            await idle(IDLE_RETRY_MS);
        }
    }

    // teardown — both agents back to autonomous work
    running = false;
    sendResume();
    directive.active = false;
    log('handoff routine stopped');
}

/**
 * Start the background handoff loop. Returns an observation string for the LLM.
 * @param {object} myAgent the coordinator's IntentionRevisionReplace instance
 * @param {function} [resumeAutonomy] called when the routine eventually stops
 */
export function startHandoff(myAgent, resumeAutonomy) {
    if (!partner.id) return 'Cannot start handoff: no partner connected yet.';
    if (running)     return 'Handoff routine already running.';
    running = true;
    handedOff.clear();
    loop(myAgent).finally(() => resumeAutonomy?.());
    return 'Handoff routine started: I fetch parcels, the partner delivers them (cross-agent bonus on every delivery). Use stop_handoff to end it.';
}

/** Stop the loop after the current step; the loop's teardown resumes both agents. */
export function stopHandoff() {
    if (!running) return 'Handoff routine is not running.';
    running = false;
    return 'Handoff routine stopping — both agents will resume autonomous work.';
}
