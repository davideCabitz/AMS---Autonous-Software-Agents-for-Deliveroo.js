import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, otherAgents, directive, trafficLight, runtime, missionConstraints } from '../context.js';
import { findRoute, navigateTo } from '../utils/astar.js';
import { selectStrategy } from '../strategies/selectStrategy.js';
import { partner, sendOrder, sendHalt, sendResume, requestStatus } from './partner.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:handoff');

/**
 * Cross-agent handoff routine for pick-and-deliver bonus missions.
 * Coordinator (B) gathers parcels with its BDI strategy, then hands them to the
 * worker (A) to deliver. Live rendezvous steering; works on any map topology.
 */

/** @type {number} Ms between retries when idle or after a cycle failure */
const IDLE_RETRY_MS = 2_000;

/** @type {number} Hard cap on a single own-navigation step (anti-freeze) */
const STEP_TIMEOUT_MS = 60_000;

/** @type {number} Ms B waits for A before abandoning a meet and retrying */
const MEET_TIMEOUT_MS = 25_000;

/** @type {number} Slack tiles before forcing a handoff when a pickup would pass a drop */
const HANDOFF_PASS_MARGIN = 3;

/** @type {number} Ms between re-ordering A toward B during gather (pre-positioning) */
const DRIFT_MS = 500;

/** @type {boolean} True while the loop owns the coordinator agent */
let running = false;

/**
 * Race a promise against a step timeout
 * @param {Promise} promise - Promise to race
 * @param {number} [ms] - Timeout (ms)
 * @returns {Promise} Promise result, or rejects with ['timeout']
 */
function withTimeout(promise, ms = STEP_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout']), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether the handoff loop is running
 * @returns {boolean} True while it owns the agent (runDirective must not release the gate)
 */
export function handoffRunning() { return running; }

/**
 * Set of "x_y" keys for all known delivery tiles
 * @returns {Set<string>}
 */
const deliveryKeys = () => new Set(deliveryTiles.map(t => `${t.x}_${t.y}`));

/**
 * Sleep that resolves early when stopped or aborted
 * @param {number} ms - Max sleep duration (ms)
 * @returns {Promise<void>}
 */
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
 * BFS path (tiles, start included) ignoring other agents
 * @param {{x: number, y: number}} from - Start position
 * @param {{x: number, y: number}} to - Goal position
 * @returns {Array<{x: number, y: number}>|null} Path, or null if unreachable
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
 * BFS distance map from a position to every walkable tile, ignoring agents
 * @param {{x: number, y: number}} from - Start position
 * @returns {Map<string, number>|null} "x_y" → step count, or null if start is off-map
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
 * Interior tile on a carry route that minimizes the agents' meet time
 * @param {Array<{x: number, y: number}>} route - Carry route from cargo to delivery
 * @param {Map<string, number>|null} wDist - Worker BFS distance map, or null if unknown
 * @returns {{tile: {x: number, y: number}, i: number}|null} Best rendezvous tile + route index, or null
 */
function midpointTile(route, wDist) {
    const L = route.length - 1;
    if (L < 2) return null;                           // no interior tile to meet on
    const deliv = deliveryKeys();
    const mid = L / 2;
    let best = null;
    for (let i = 1; i < L; i++) {                      // skip cargo (0) and delivery (L)
        const t = route[i];
        const k = `${t.x}_${t.y}`;
        if (deliv.has(k)) continue;
        const aDist = wDist ? wDist.get(k) : null;
        if (wDist && aDist == null) continue;          // worker can't reach it
        // Cost = later of the two arrivals; tie-break toward the middle.
        const meet   = wDist ? Math.max(i, aDist) : 0;
        const center = Math.abs(i - mid);
        if (!best || meet < best.meet || (meet === best.meet && center < best.center))
            best = { tile: t, i, meet, center };
    }
    return best ? { tile: best.tile, i: best.i } : null;
}

/**
 * Plan the delivery route and initial rendezvous midpoint for the current cargo
 * @param {{x: number, y: number}} cargo - Current coordinator tile (load point)
 * @param {{x: number, y: number}} wpos - Worker anchor position
 * @returns {{D: {x:number,y:number}, route: Array, mid: {x:number,y:number}, meetB: {x:number,y:number}}|null} Plan, or null if no valid midpoint
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

/**
 * Route distance to the nearest delivery tile (agents ignored)
 * @param {{x: number, y: number}} from - Start position
 * @returns {number} Steps to nearest reachable delivery, or Infinity if none
 */
function nearestDeliveryDist(from) {
    let best = Infinity;
    for (const d of deliveryTiles) {
        const r = staticRoute(from, d);
        if (r) best = Math.min(best, r.length - 1);
    }
    return best;
}

/**
 * Live A↔B meet tile: geometric midpoint snapped to a legal rendezvous
 * @param {{x: number, y: number}} bPos - Coordinator position
 * @param {{x: number, y: number}} aPos - Worker position
 * @returns {{x: number, y: number}|null} Best legal meet tile, or null if none
 */
function liveMeet(bPos, aPos) {
    const cx = (bPos.x + aPos.x) / 2, cy = (bPos.y + aPos.y) / 2;
    const deliv = deliveryKeys();
    const ok = t => !deliv.has(`${t.x}_${t.y}`) && findRoute(me, t);
    return walkableTiles
        .filter(ok)
        .map(t => ({ t, d: Math.abs(t.x - cx) + Math.abs(t.y - cy) }))
        .sort((a, b) => a.d - b.d)[0]?.t ?? null;
}

/**
 * Whether two tiles are Manhattan-adjacent (one step apart)
 * @param {{x: number, y: number}} a - First position
 * @param {{x: number, y: number}} b - Second position
 * @returns {boolean}
 */
const manhattanAdj = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

/**
 * Worker's live tile from its most recent streamed status
 * @returns {{x: number, y: number}|null} Rounded worker tile, or null if unknown
 */
function partnerTile() {
    const s = partner.lastStatus;
    return s && s.x != null ? { x: Math.round(s.x), y: Math.round(s.y) } : null;
}

/**
 * Whether a sensed agent is now adjacent to the coordinator (meet trigger)
 * @param {{x: number, y: number}|null} aPos - Worker's last known position (sanity check)
 * @returns {boolean} True when a sensed neighbour matches the worker's expected location
 */
function partnerAdjacent(aPos) {
    const here = { x: Math.round(me.x), y: Math.round(me.y) };
    return otherAgents.some(a =>
        manhattanAdj(a, here) &&
        (!aPos || Math.abs(a.x - aPos.x) + Math.abs(a.y - aPos.y) <= 3));
}

/**
 * Drift target for the worker while the coordinator is still gathering
 * @param {{x: number, y: number}} bPos - Coordinator position
 * @param {{x: number, y: number}|null} aPos - Worker position (null if unknown)
 * @returns {{x: number, y: number}|null} Tile to send the worker toward, or null
 */
function driftTowardB(bPos, aPos) {
    const neigh = freeNeighbours(bPos, { excludeDelivery: false })
        .filter(n => findRoute(me, n));
    if (neigh.length) {
        if (!aPos) return neigh[0];
        return neigh.sort((p, q) =>
            (Math.abs(p.x - aPos.x) + Math.abs(p.y - aPos.y)) -
            (Math.abs(q.x - aPos.x) + Math.abs(q.y - aPos.y)))[0];
    }
    // All neighbours blocked — send A to the closest reachable tile to B.
    return walkableTiles
        .filter(t => !(t.x === bPos.x && t.y === bPos.y) && findRoute(me, t))
        .map(t => ({ t, d: Math.abs(t.x - bPos.x) + Math.abs(t.y - bPos.y) }))
        .sort((a, b) => a.d - b.d)[0]?.t ?? null;
}

/**
 * Coordinator's next navigation target while converging on the rendezvous
 * @param {{x: number, y: number}|null} aPos - Worker's live position
 * @param {{x: number, y: number}} meetB - Rendezvous tile (one step spawn-side of midpoint)
 * @param {{x: number, y: number}} here - Coordinator's current tile
 * @returns {{x: number, y: number}|null} Tile to navigate toward, or null to hold
 */
function chooseMeetTarget(aPos, meetB, here) {
    const atTile = here.x === meetB.x && here.y === meetB.y;
    // No fix on A, or A still far → head to meetB, then hold.
    if (!aPos || Math.abs(aPos.x - meetB.x) + Math.abs(aPos.y - meetB.y) > 2)
        return atTile ? null : meetB;
    // A is at/near the rendezvous → close onto a neighbour of A.
    const approach = freeNeighbours(aPos, { excludeDelivery: false })
        .map(n => ({ n, r: findRoute(me, n) }))
        .filter(x => x.r)
        .sort((a, b) => a.r.length - b.r.length)[0]?.n;
    return approach ?? (atTile ? null : meetB);
}

/**
 * Walkable, unoccupied neighbours of a tile, optionally excluding delivery tiles
 * @param {{x: number, y: number}} tile - Center tile
 * @param {{excludeDelivery?: boolean}} [options] - Exclude delivery-tile neighbours?
 * @returns {Array<{x: number, y: number}>} Valid neighbour tiles
 */
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
 * Where the coordinator steps after dropping at rendezvous tile M
 * @param {{x: number, y: number}} M - Drop tile to vacate
 * @param {number} i - Index of M in the carry route
 * @param {Array<{x:number,y:number}>} route - Carry route
 * @param {{x: number, y: number}} D - Delivery tile
 * @param {{x: number, y: number}} wpos - Worker position (avoid its tile)
 * @param {Set<string>} wBlock - Tile keys blocked by the worker
 * @returns {{x: number, y: number}|null} Tile to navigate to, or null if none reachable
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

/**
 * Request and parse the worker's live position
 * @returns {Promise<{x: number, y: number}|null>} Worker tile, or null on timeout/failure
 */
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
 * If the frozen worker blocks the coordinator's acquisition path, a delivery tile to park it on
 * @param {{x: number, y: number}|null} aTile - Worker's current tile
 * @returns {{x: number, y: number}|null} Parking delivery tile, or null if not the blocker
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

/**
 * Main handoff loop: farm parcels with BDI strategy, meet worker, drop, let it deliver
 * @param {Object} myAgent - Coordinator's IntentionRevisionReplace instance
 */
async function loop(myAgent) {
    sendHalt();                       // worker must not collect parcels on its own
    directive.active = true;          // coordinator autonomy stands down for the routine
    myAgent.haltCurrent();            // drop B's stale intention so we drive cleanly

    // Worker anchor: where it idles when it next needs an order. No fixed home — it
    // ends each cycle on the delivery tile it just used, and the next rendezvous is
    // computed around that. Seeded from live position, then the previous delivery.
    // Anchoring on this predicted spot (vs a blocking status round-trip per cycle)
    // lets the coordinator pick the next meet point the instant it has cargo.
    let workerAnchor = await workerPosition() ?? { x: Math.round(me.x), y: Math.round(me.y) };
    log(`worker anchor (initial): (${workerAnchor.x},${workerAnchor.y})`);

    // Previous cycle's worker pickup→delivery, detached so the coordinator fetches the
    // next parcel while the worker delivers; the loop re-syncs on it before the next drop.
    let workerChain = Promise.resolve();

    // Pre-positioning drift: while B gathers it re-orders A toward a tile beside B every
    // DRIFT_MS so A trails close. On its OWN detached chain (never workerChain) so the
    // await-workerChain is never blocked by a drift leg.
    //
    // CRITICAL: a drift order is newer, and newest-order-wins would SUPERSEDE an in-flight
    // delivery (A abandons a parcel). So drift is suppressed while the previous cycle's
    // pickup→deliver (workerChain) runs — deliveryInFlight gates it.
    let driftTarget = null;
    let lastDriftAt = 0;
    let deliveryInFlight = false;   // true while A is mid pickup→deliver — do NOT drift

    while (running && !directive.aborted) {
        try {
            // Red light: no movement — wait it out.
            if (trafficLight.red) { await idle(500); continue; }

            // 1.+2. ACQUIRE — drive B with the map's chosen strategy (same exploration,
            //    multi-pickup and value/decay decisions it makes autonomously). The
            //    instant it decides to BANK (go_deliver) we stop and hand the load to the
            //    worker — the handoff only replaces the final delivery, not acquisition.
            const strat = runtime.strategy ?? (runtime.strategy = selectStrategy());
            while (running && !directive.aborted) {
                if (trafficLight.red) { await idle(500); continue; }

                // Pre-position A: every DRIFT_MS re-order it beside B's current position
                // so it trails the gather. Detached + throttled (only when the target
                // moves). Skipped mid-delivery, else the drift order would make A drop
                // the parcel it's delivering.
                if (!deliveryInFlight && Date.now() - lastDriftAt >= DRIFT_MS) {
                    lastDriftAt = Date.now();
                    const bHere = { x: Math.round(me.x), y: Math.round(me.y) };
                    const d = driftTowardB(bHere, partnerTile());
                    if (d && (d.x !== driftTarget?.x || d.y !== driftTarget?.y)) {
                        driftTarget = { x: d.x, y: d.y };
                        sendOrder(['go_to', d.x, d.y]).catch(() => {});   // detached
                    }
                }

                const carrying = parcels.carriedBy(me.id).length;
                // Pass null, NOT the queue's current intention: a stale intention left
                // from before the handoff would make decide() return null and stall us.
                const decision = strat.decide(null);

                // Done gathering → hand off. B never delivers, so the instant it stops
                // PICKING UP while loaded (go_deliver, or no reachable delivery → explore/
                // idle) we hand over. planDelivery uses staticRoute (ignores agents).
                if (carrying > 0 && decision?.[0] !== 'go_pick_up') break;

                // Carrying, and the next pickup would carry the load PAST any drop (the
                // strategy proposes it because autonomous B banks in passing — but handoff
                // B never delivers). Hand off NOW rather than risk the whole load.
                if (carrying > 0 && decision?.[0] === 'go_pick_up') {
                    const here   = { x: Math.round(me.x), y: Math.round(me.y) };
                    const dNow   = nearestDeliveryDist(here);
                    const dNext  = nearestDeliveryDist({ x: decision[1], y: decision[2] });
                    if (dNext > dNow + HANDOFF_PASS_MARGIN) {
                        log(`next pickup (${decision[1]},${decision[2]}) is past the nearest drop `
                            + `(dNow=${dNow} dNext=${dNext}) — handing off ${carrying} parcel(s) now`);
                        break;
                    }
                }

                // Productively moving — pursue a pickup or an explore to a DIFFERENT tile.
                const camping = decision?.[0] === 'go_explore'
                    && Math.round(me.x) === decision[1] && Math.round(me.y) === decision[2];
                if (decision?.[0] === 'go_pick_up' || (decision?.[0] === 'go_explore' && !camping)) {
                    await withTimeout(myAgent.commandAndAwait(decision)).catch(() => {});
                    continue;
                }

                // Idle (nothing reachable, or camping our spawner): if the frozen worker
                // walls B off from a spawner/parcel, park it on a delivery to open the
                // corridor; else wait for a spawn.
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
            if (parcels.carriedBy(me.id).length === 0) continue;   // aborted/empty — restart

            // 3. plan THIS parcel's delivery and the initial rendezvous midpoint.
            const cargo = { x: Math.round(me.x), y: Math.round(me.y) };
            const plan = planDelivery(cargo, workerAnchor);
            if (!plan) {
                log(`no reachable delivery with a valid midpoint from cargo (${cargo.x},${cargo.y}) — next cycle`);
                await idle(IDLE_RETRY_MS); continue;
            }
            const { D, route, mid } = plan;
            log(`delivery (${D.x},${D.y}); seed midpoint (${mid.x},${mid.y}) — meet re-steered live from here`);

            // Re-sync the previous cycle's pickup+deliver before a new order, else it
            // would supersede the in-flight delivery and void it.
            await workerChain;
            if (!running || directive.aborted) break;

            // Ensure A's live position, then send it toward the live A↔B meet in parallel
            // so it travels while we carry; the carry loop re-steers it each pass. Detached.
            if (!partnerTile()) await requestStatus(2_000).catch(() => {});
            const here0 = { x: Math.round(me.x), y: Math.round(me.y) };
            const seed  = (partnerTile() && liveMeet(here0, partnerTile())) ?? mid;
            let aTarget = { x: seed.x, y: seed.y };   // last tile we steered A toward
            workerChain = sendOrder(['go_to', aTarget.x, aTarget.y]);

            // 4. carry to the rendezvous, homing onto A's live tile for the final step.
            //    DROP ONLY ON ADJACENCY — a hand-to-hand exchange, never a dead-drop.
            //    If A isn't there yet, hold and wait.
            let met = false;
            const meetDeadline = Date.now() + MEET_TIMEOUT_MS;
            while (running && !directive.aborted && Date.now() < meetDeadline) {
                const here = { x: Math.round(me.x), y: Math.round(me.y) };
                if (partnerAdjacent(partnerTile())) { met = true; break; }   // met → safe to drop

                // Re-steer A toward the live A↔B midpoint (legal tile), recomputed each
                // pass and NOT pinned to B's route, so the meet slides toward A and both
                // converge. Detached, newest-order-wins. Only re-issue when the tile moves.
                const aPos = partnerTile();
                if (aPos) {
                    const bm = liveMeet(here, aPos);
                    if (bm && (bm.x !== aTarget.x || bm.y !== aTarget.y)) {
                        aTarget = { x: bm.x, y: bm.y };
                        workerChain = sendOrder(['go_to', aTarget.x, aTarget.y]);
                        log(`re-steer A → live meet (${aTarget.x},${aTarget.y})`);
                    }
                }

                const tgt = chooseMeetTarget(partnerTile(), aTarget, here);
                if (!tgt || (tgt.x === here.x && tgt.y === here.y)) {        // at rendezvous → wait for A
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
                    if (tag !== 'stopped') await idle(400);   // transient block — wait, re-evaluate
                    // 'stopped' = adjacency fired; the loop top registers the meet
                }
            }
            if (!running || directive.aborted) break;

            // Fallback — no meet in time. DON'T drop. Freeze A so it stops walking to the
            // stale rendezvous, then retry the cycle keeping the load.
            if (!met) {
                log('no meet within timeout — freezing worker and retrying cycle');
                sendHalt();
                await idle(IDLE_RETRY_MS);
                continue;
            }

            // 5. drop on contact, wherever we stopped (reachable by the worker). NEVER a
            //    delivery tile (the server would score it as OUR delivery); if so, back off.
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
            for (const p of carried) parcels.ignore(p.id);   // handed off — never re-acquire
            log(`met worker — dropped ${carried.length} parcel(s) at (${dropTile.x},${dropTile.y})`);

            // Vacate the drop tile (MANDATORY, else the worker can't path onto it),
            // preferring the spawn side.
            const wBlock = new Set([`${aTile.x}_${aTile.y}`]);
            const dropIdx = route.findIndex(t => t.x === dropTile.x && t.y === dropTile.y);
            const aside = chooseAside(dropTile, dropIdx, route, D, aTile, wBlock);
            if (aside) await withTimeout(myAgent.commandAndAwait(['go_to', aside.x, aside.y])).catch(() => {});
            if (!running || directive.aborted) break;

            // 6. worker: collect our drop, deliver at D — DETACHED, so the coordinator
            //    heads straight back for the next parcel. Steps stay sequential; the
            //    worker ends at D. deliveryInFlight gates gather-phase drift OFF for the
            //    whole pickup→deliver so no drift order supersedes this delivery.
            deliveryInFlight = true;
            workerChain = (async () => {
                const pickRes = await sendOrder(['go_pick_up', dropTile.x, dropTile.y]);
                log(`worker pickup: ${pickRes}`);
                if (!running || directive.aborted) return;
                if (!/^Failed|no parcel/i.test(pickRes)) {       // stolen/decayed → skip delivery
                    const delivRes = await sendOrder(['go_deliver', D.x, D.y]);
                    log(`worker delivery: ${delivRes}`);
                }
            })().finally(() => {
                deliveryInFlight = false;
                driftTarget = null;   // A is at D — force a fresh drift re-aim next pass
            }).catch(() => {});
            workerAnchor = { x: D.x, y: D.y };   // predicted free spot for next rendezvous
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
 * Start the background handoff loop
 * @param {Object} myAgent - Coordinator's IntentionRevisionReplace instance
 * @param {Function} [resumeAutonomy] - Called when the routine stops
 * @returns {string} Observation for the LLM (success or decline reason)
 */
export function startHandoff(myAgent, resumeAutonomy) {
    if (!partner.id) return 'Cannot start handoff: no partner connected yet.';
    // Defence-in-depth: never run on a net-penalty handoff. The tool already gates
    // this, but a direct call must too. net >= 0 (incl. default 0) ⇒ run.
    if (missionConstraints.handoffNet < 0) return 'Mission declined.';
    if (running)     return 'Handoff routine already running.';
    running = true;
    loop(myAgent).finally(() => resumeAutonomy?.());
    return 'Handoff routine started: I fetch parcels, the partner delivers them (cross-agent bonus on every delivery). Use stop_handoff to end it.';
}

/**
 * Stop the handoff loop after the current step
 * @returns {string} Observation confirming the stop (or that it wasn't running)
 */
export function stopHandoff() {
    if (!running) return 'Handoff routine is not running.';
    running = false;
    return 'Handoff routine stopping — both agents will resume autonomous work.';
}
