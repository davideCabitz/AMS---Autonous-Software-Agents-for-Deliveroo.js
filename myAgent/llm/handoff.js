import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, otherAgents, directive, trafficLight, runtime } from '../context.js';
import { findRoute, navigateTo } from '../utils/astar.js';
import { selectStrategy } from '../strategies/selectStrategy.js';
import { partner, sendOrder, sendHalt, sendResume, requestStatus } from './partner.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:handoff');

/*
 * Cross-agent handoff routine for the "one agent picks up, another delivers"
 * mission (+bonus PER delivered parcel, repeating). The LLM starts/stops it via
 * the start_handoff/stop_handoff tools; the cycle itself is deterministic code —
 * a repeating per-parcel routine the LLM should NOT babysit.
 *
 * Coordination is EMERGENT, not a locked meeting tile. Per parcel:
 *   1. the coordinator (B) gathers parcels using the MAP'S chosen strategy — the
 *      same exploration, multi-pickup and value/decay-aware decisions it makes
 *      autonomously — until the strategy decides to bank the load; the worker (A)
 *      never collects on its own (those deliveries would not earn the bonus);
 *   2. B computes the cargo→delivery path and its MIDPOINT, and orders A to that
 *      midpoint NOW, so A travels there in parallel while B carries. Recomputed
 *      every cycle, the midpoint automatically follows B's active spawn zone;
 *   3. both close the gap: A heads for the midpoint, B carries toward it and then
 *      HOMES onto A's live tile (A streams its position while under order) for the
 *      final approach, so a detour by either is absorbed — no fixed carry path,
 *      full A* replanning the whole way;
 *   4. the instant B is adjacent to A it DROPS on the spot (never a delivery tile —
 *      that would score as B's OWN delivery and void the bonus) and steps back,
 *      preferring the spawn side so single-lane corridors stay deadlock-free;
 *   5. B orders A: pick up the drop, deliver at D → cross-agent bonus for both. The
 *      order runs DETACHED so B fetches the next parcel in parallel; the loop
 *      re-synchronizes on it before the next drop. A ends at D, its next anchor.
 * Any failed step skips to the next cycle with fresh state; no parcels → idle.
 *
 * All geometry is live, so the routine works on any map — multiple spawners,
 * multiple deliveries, walls, crates, or a third agent in the way.
 */

const IDLE_RETRY_MS = 2_000;
// Hard cap on any single own-navigation step, so one wedged/stale intention can
// never freeze the whole routine (worker orders carry their own 45s timeout).
const STEP_TIMEOUT_MS = 60_000;
// How long B waits to meet A before abandoning THIS attempt: it freezes A and
// retries (recompute, re-invite) rather than ever dropping the load unguarded.
const MEET_TIMEOUT_MS = 25_000;

let running = false;

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
 * The split tile on `route` nearest its middle that is a valid rendezvous: an
 * INTERIOR tile (never the cargo at index 0 nor the delivery at L), not itself a
 * delivery tile (a drop there would score as the coordinator's OWN delivery and
 * void the bonus), and reachable by the worker. Searches outward from the middle
 * so the carry is balanced. Returns { tile, i } or null when the route is too
 * short to have an interior tile.
 */
function midpointTile(route, wDist) {
    const L = route.length - 1;
    if (L < 2) return null;                           // no interior tile to meet on
    const deliv = deliveryKeys();
    const mid = Math.round(L / 2);
    for (let off = 0; off <= L; off++) {
        for (const i of (off === 0 ? [mid] : [mid - off, mid + off])) {
            if (i <= 0 || i >= L) continue;           // skip cargo (0) and delivery (L)
            const t = route[i];
            const k = `${t.x}_${t.y}`;
            if (deliv.has(k)) continue;
            if (wDist && wDist.get(k) == null) continue;  // worker cannot reach it
            return { tile: t, i };
        }
    }
    return null;
}

/**
 * Plan THIS cargo's delivery D and the initial rendezvous midpoint. Delivery
 * tiles are tried nearest-first by structural route (route-based, not Manhattan —
 * with walls the Manhattan-nearest delivery can be far or unreachable); the FIRST
 * one that yields a valid midpoint wins. Returns { D, route, mid, meetB } or null:
 * `mid` is where A anchors; `meetB` is the tile one step spawn-side of it where B
 * waits, so the two never target the same tile (no occupied-goal "no path").
 */
function planDelivery(cargo, wpos) {
    const wDist = bfsDistances(wpos);
    const ranked = deliveryTiles
        .map(d => { const r = staticRoute(cargo, d); return r ? { d, route: r } : null; })
        .filter(Boolean)
        .sort((a, b) => a.route.length - b.route.length);
    for (const { d, route } of ranked) {
        const mp = midpointTile(route, wDist);
        if (mp) return { D: d, route, mid: mp.tile, meetB: route[mp.i - 1] };
    }
    return null;
}

/** Manhattan-adjacent — the two agents stand on neighbouring tiles. */
const manhattanAdj = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

/** The worker's live tile from its streamed status, or null if unknown yet. */
function partnerTile() {
    const s = partner.lastStatus;
    return s && s.x != null ? { x: Math.round(s.x), y: Math.round(s.y) } : null;
}

/**
 * The meet trigger, detected from B's OWN live sensing: a sensed agent sits on a
 * tile neighbouring us. The streamed status (aPos) is NOT used for the adjacency
 * test — it lags by a tile (200ms throttle, and the worker stops the instant it
 * arrives so its resting tile may never get streamed), which made B fail to notice
 * the meet and detour around the worker as if it were just an obstacle. aPos is now
 * only a loose sanity check (the sensed neighbour must be near the worker's
 * last-known spot) so an unrelated third agent brushing past can't fire a phantom
 * drop. When aPos is unknown yet, any adjacent sensed agent counts.
 */
function partnerAdjacent(aPos) {
    const here = { x: Math.round(me.x), y: Math.round(me.y) };
    return otherAgents.some(a =>
        manhattanAdj(a, here) &&
        (!aPos || Math.abs(a.x - aPos.x) + Math.abs(a.y - aPos.y) <= 3));
}

/**
 * Where the coordinator should head next while converging on the rendezvous tile
 * `meetB` (one step spawn-side of the midpoint, where A anchors). B carries to
 * meetB; once A is at/near it, B HOMES onto a reachable neighbour of A's live tile
 * (never A's tile — that's blocked) for the final adjacent step, absorbing any
 * detour A took. Returns the tile to navigate toward, or null to HOLD and wait for
 * A (B is at the rendezvous and A hasn't arrived — we never chase past it or drop
 * unguarded).
 */
function chooseMeetTarget(aPos, meetB, here) {
    const atTile = here.x === meetB.x && here.y === meetB.y;
    // No fix on A yet, or A still far from the rendezvous → head there, then hold.
    if (!aPos || Math.abs(aPos.x - meetB.x) + Math.abs(aPos.y - meetB.y) > 2)
        return atTile ? null : meetB;
    // A is at/near the rendezvous → close the final tile onto a neighbour of A.
    const approach = freeNeighbours(aPos, { excludeDelivery: false })
        .map(n => ({ n, r: findRoute(me, n) }))
        .filter(x => x.r)
        .sort((a, b) => a.r.length - b.r.length)[0]?.n;
    return approach ?? (atTile ? null : meetB);
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

/**
 * Handoff-only deadlock break. The worker is frozen in place at the start of the
 * routine; on a tight corridor it can sit between B and the parcels, and since A*
 * (findRoute) treats it as a wall, B's strategy finds NOTHING reachable and idles
 * forever while the worker waits for an order that never comes. When that's the
 * case — a spawner/parcel is reachable ONLY if agents are ignored — return the
 * delivery tile to park the worker on (its eventual anchor anyway) so B's path
 * opens. Null when the worker isn't the blocker, is already on a delivery, or has
 * no reachable delivery.
 */
function workerParkingSpot(aTile) {
    if (!aTile || deliveryKeys().has(`${aTile.x}_${aTile.y}`)) return null;
    const reachableOnlyWithoutAgents = [...spawnerTiles, ...parcels.free()]
        .some(t => staticRoute(me, t) && !findRoute(me, t));
    if (!reachableOnlyWithoutAgents) return null;
    return [...deliveryTiles]
        .map(d => ({ d, r: staticRoute(aTile, d) }))
        .filter(x => x.r)
        .sort((x, y) => x.r.length - y.r.length)[0]?.d ?? null;
}

async function loop(myAgent) {
    sendHalt();                       // worker must not collect parcels on its own
    directive.active = true;          // coordinator autonomy stands down for the whole routine
    myAgent.haltCurrent();            // drop B's stale autonomous intention so we drive cleanly

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

            // 1.+2. ACQUIRE — drive B with the map's CHOSEN strategy (the same
            //    exploration, multi-pickup and value/decay-aware decisions it makes
            //    autonomously), pursuing each pickup/explore to completion. The instant
            //    the strategy decides to BANK (go_deliver) we stop and hand the
            //    accumulated load to the worker instead of delivering it — the handoff
            //    only replaces the final delivery, never B's acquisition behaviour.
            const strat = runtime.strategy ?? (runtime.strategy = selectStrategy());
            while (running && !directive.aborted) {
                if (trafficLight.red) { await idle(500); continue; }
                const carrying = parcels.carriedBy(me.id).length;
                // Pass null, NOT the queue's current intention: we run each decision to
                // completion, and a STALE autonomous intention left in the queue from
                // before the handoff would make decide() return null ("keep current") and
                // silently stall the whole routine.
                const decision = strat.decide(null);

                // Done gathering → hand off. B never delivers, so the strategy's DELIVERY
                // logic must not gate the routine: the instant it stops PICKING UP while
                // we're loaded (go_deliver, or "no reachable delivery" → explore/idle), we
                // hand the load over. planDelivery routes with staticRoute, which ignores
                // agents, so the worker blocking B's own delivery path is irrelevant.
                if (carrying > 0 && decision?.[0] !== 'go_pick_up') break;

                // Productively moving — pursue a pickup, or an explore to a DIFFERENT tile.
                const camping = decision?.[0] === 'go_explore'
                    && Math.round(me.x) === decision[1] && Math.round(me.y) === decision[2];
                if (decision?.[0] === 'go_pick_up' || (decision?.[0] === 'go_explore' && !camping)) {
                    await withTimeout(myAgent.commandAndAwait(decision)).catch(() => {});
                    continue;
                }

                // Idle (nothing reachable, or camping our own spawner): if the FROZEN
                // worker is walling B off from a productive spawner/parcel, park it on a
                // delivery to open the corridor; otherwise just wait for a spawn.
                const park = workerParkingSpot(partnerTile());
                if (park) {
                    log(`worker blocking acquisition — parking it at delivery (${park.x},${park.y})`);
                    await withTimeout(sendOrder(['go_to', park.x, park.y]), 30_000).catch(() => {});
                    workerAnchor = { x: park.x, y: park.y };
                } else {
                    await idle(IDLE_RETRY_MS);
                }
            }
            if (!running || directive.aborted) break;
            if (parcels.carriedBy(me.id).length === 0) continue;   // aborted/empty acquire — restart cycle

            // 3. plan THIS parcel's delivery and the initial rendezvous midpoint.
            const cargo = { x: Math.round(me.x), y: Math.round(me.y) };
            const plan = planDelivery(cargo, workerAnchor);
            if (!plan) {
                log(`no reachable delivery with a valid midpoint from cargo (${cargo.x},${cargo.y}) — next cycle`);
                await idle(IDLE_RETRY_MS); continue;
            }
            const { D, route, mid, meetB } = plan;
            log(`delivery (${D.x},${D.y}); A→midpoint (${mid.x},${mid.y}); B→rendezvous (${meetB.x},${meetB.y})`);

            // Re-sync the previous cycle's worker pickup+deliver before issuing a new
            // order: a fresh order would supersede an in-flight delivery and void it.
            await workerChain;
            if (!running || directive.aborted) break;

            // Send the worker to the midpoint NOW, in parallel, so it travels there
            // while we carry — and re-homes automatically each cycle when our spawn
            // zone moves. Detached. The worker streams its live position while under
            // the order; seed it once in case streaming hasn't started yet.
            workerChain = sendOrder(['go_to', mid.x, mid.y]);
            if (!partnerTile()) await requestStatus(2_000).catch(() => {});

            // 4. carry to the rendezvous (meetB) while A anchors on the midpoint, homing
            //    onto A's live tile for the final step. DROP ONLY ON ADJACENCY — a
            //    hand-to-hand exchange, never an unguarded dead-drop. If A isn't there
            //    yet, hold and wait for it.
            let met = false;
            const meetDeadline = Date.now() + MEET_TIMEOUT_MS;
            while (running && !directive.aborted && Date.now() < meetDeadline) {
                const here = { x: Math.round(me.x), y: Math.round(me.y) };
                if (partnerAdjacent(partnerTile())) { met = true; break; }   // met → safe to drop
                const tgt = chooseMeetTarget(partnerTile(), meetB, here);
                if (!tgt || (tgt.x === here.x && tgt.y === here.y)) {        // at the rendezvous → wait for A
                    await idle(400);
                    continue;
                }
                try {
                    await withTimeout(navigateTo(tgt.x, tgt.y, () => {
                        if (!running || directive.aborted) return true;
                        return partnerAdjacent(partnerTile());
                    }));
                } catch (err) {
                    if (!running || directive.aborted) break;
                    const tag = Array.isArray(err) ? err[0] : (err?.message ?? '');
                    if (tag !== 'stopped') await idle(400);   // transient block — wait, then re-evaluate
                    // 'stopped' = stoppedFn fired (adjacency); the loop top registers the meet
                }
            }
            if (!running || directive.aborted) break;

            // Fallback — no hand-to-hand meet in time. DON'T drop. Freeze A so it stops
            // walking to the now-stale rendezvous, then retry the cycle keeping the load
            // (re-acquire / recompute the midpoint and re-invite A for a fresh meetup).
            if (!met) {
                log('no meet within timeout — freezing worker and retrying cycle');
                sendHalt();
                await idle(IDLE_RETRY_MS);
                continue;
            }

            // 5. drop on contact. The drop tile is wherever we stopped — always
            //    reachable by the worker. It must NEVER be a delivery tile (the
            //    server would score it as OUR delivery); if it is, back off first.
            const aTile = partnerTile() ?? workerAnchor;
            let dropTile = { x: Math.round(me.x), y: Math.round(me.y) };
            if (deliveryKeys().has(`${dropTile.x}_${dropTile.y}`)) {
                const nb = freeNeighbours(dropTile).find(n => !(n.x === aTile.x && n.y === aTile.y) && findRoute(me, n));
                if (nb) {
                    await withTimeout(myAgent.commandAndAwait(['go_to', nb.x, nb.y])).catch(() => {});
                    dropTile = { x: Math.round(me.x), y: Math.round(me.y) };
                }
            }
            if (!running || directive.aborted) break;

            const carried = parcels.carriedBy(me.id);
            await socket.emitPutdown();
            for (const p of carried) parcels.ignore(p.id);   // handed to the worker — never re-acquire
            log(`met worker — dropped ${carried.length} parcel(s) at (${dropTile.x},${dropTile.y})`);

            // Vacating the drop tile is MANDATORY — otherwise the worker's pickup can
            // never path onto it. Prefer backing toward the spawn side (chooseAside).
            const wBlock = new Set([`${aTile.x}_${aTile.y}`]);
            const dropIdx = route.findIndex(t => t.x === dropTile.x && t.y === dropTile.y);
            const aside = chooseAside(dropTile, dropIdx, route, D, aTile, wBlock);
            if (aside) await withTimeout(myAgent.commandAndAwait(['go_to', aside.x, aside.y])).catch(() => {});
            if (!running || directive.aborted) break;

            // 6. worker: collect our drop, deliver at D — DETACHED, so the coordinator
            //    heads straight back for the next parcel instead of idling while the
            //    worker travels. Worker steps stay sequential (a new order supersedes
            //    the previous). No return-to-post leg — the worker ends at D.
            workerChain = (async () => {
                const pickRes = await sendOrder(['go_pick_up', dropTile.x, dropTile.y]);
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
    loop(myAgent).finally(() => resumeAutonomy?.());
    return 'Handoff routine started: I fetch parcels, the partner delivers them (cross-agent bonus on every delivery). Use stop_handoff to end it.';
}

/** Stop the loop after the current step; the loop's teardown resumes both agents. */
export function stopHandoff() {
    if (!running) return 'Handoff routine is not running.';
    running = false;
    return 'Handoff routine stopping — both agents will resume autonomous work.';
}
