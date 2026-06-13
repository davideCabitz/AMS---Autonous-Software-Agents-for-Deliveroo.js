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
 * At start, the worker is posted at the WAITING POST: the tile halfway along the
 * shortest spawn→delivery route. The coordinator then shuttles spawn↔post while
 * the worker shuttles post↔delivery — the two legs run in parallel, and on
 * single-lane (corridor) maps the agents never need to swap places.
 *
 * One cycle:
 *   1. worker frozen (it must never pick up parcels itself — those deliveries
 *      would not qualify for the cross-agent bonus) and sent to the post;
 *   2. coordinator picks up the nearest reachable free parcel;
 *   3. carries it to a meeting tile M chosen NEXT TO THE WORKER (wherever it
 *      is — the agents reach for each other), falling back to a tile adjacent
 *      to the delivery nearest the worker if the worker is boxed in. M must NOT
 *      itself be a delivery tile, or the coordinator's putdown would count as
 *      ITS OWN delivery and void the bonus;
 *   4. puts the parcel down and steps off M (two agents cannot share a tile);
 *   5. orders the worker: pick up at M, then deliver at the delivery tile
 *      nearest it → cross-agent bonus for both; then back to the post.
 * Any failed step skips to the next cycle with fresh state; no parcels → idle.
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
 * walkable map. Unlike findRoute it IGNORES other agents: the post must be
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
 * The worker's standard waiting post: the tile halfway along the shortest
 * spawn→delivery route. Splits the shuttle evenly — coordinator works the
 * spawn↔post leg, worker the post↔delivery leg. Null when no route exists.
 */
function workerPost() {
    const pairs = [];
    for (const s of spawnerTiles)
        for (const d of deliveryTiles)
            pairs.push({ s, d, md: Math.abs(s.x - d.x) + Math.abs(s.y - d.y) });
    pairs.sort((a, b) => a.md - b.md);
    // The Manhattan-closest pairs almost always contain the A*-closest one;
    // checking a handful bounds the BFS cost on large maps.
    for (const { s, d } of pairs.slice(0, 10)) {
        const path = staticRoute(s, d);
        if (!path || path.length < 3) continue;
        return path[Math.floor(path.length / 2)];
    }
    return null;
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

/** Delivery tile nearest to (x,y) by Manhattan distance, or null. */
function deliveryNearest(x, y) {
    if (!deliveryTiles.length) return null;
    return [...deliveryTiles]
        .sort((a, b) => (Math.abs(a.x - x) + Math.abs(a.y - y)) - (Math.abs(b.x - x) + Math.abs(b.y - y)))[0];
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

    // Post the worker at the spawn↔delivery midpoint (fire-and-forget: the
    // coordinator starts fetching immediately; the worker travels in parallel).
    const post = workerPost();
    if (post) {
        log(`worker post (spawn↔delivery midpoint): (${post.x},${post.y})`);
        sendOrder(['go_to', post.x, post.y])
            .then(r => log(`worker → post: ${r}`)).catch(() => {});
    }

    // Step-5 pipeline of the PREVIOUS cycle (worker pickup → delivery → back to
    // post). It runs detached so the coordinator fetches the next parcel while
    // the worker delivers; the loop re-synchronizes on it before the next drop.
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

            // 3. choose the meeting point NEXT TO THE WORKER — anchored on its
            //    POST (its standing destination), not its live position, so the
            //    coordinator starts toward the exchange the moment it has cargo
            //    even while the worker is still walking back from a delivery
            //    (observed live: B idled at the spawn until A reached the post).
            //    Only without a post do we wait for the worker to settle and
            //    anchor on its live position instead.
            let wpos = post;
            if (!wpos) {
                await workerChain;
                if (!running || directive.aborted) break;
                wpos = await workerPosition() ?? me;
            }
            const dTile = deliveryNearest(wpos.x, wpos.y);
            if (!dTile) { log('no delivery tile known — next cycle'); await idle(IDLE_RETRY_MS); continue; }
            // findRoute only treats SENSED agents as obstacles, but the worker is
            // known from the status protocol even from across the map: block its
            // tile explicitly, or a far coordinator picks a meeting BEHIND the
            // worker that the walk can never reach (observed live: hallway loop).
            const wx = Math.round(wpos.x), wy = Math.round(wpos.y);
            const wBlock = new Set([`${wx}_${wy}`]);
            let meeting = freeNeighbours(wpos).find(n => findRoute(me, n, wBlock));
            // Fallback (worker boxed in, e.g. parked in a delivery nook): a free
            // tile adjacent to the delivery nearest the worker.
            if (!meeting)
                meeting = freeNeighbours(dTile)
                    .filter(n => !(n.x === wx && n.y === wy))
                    .find(n => findRoute(me, n, wBlock));
            if (!meeting) { log(`no free meeting tile next to the worker (${wpos.x},${wpos.y}) or (${dTile.x},${dTile.y})`); await idle(IDLE_RETRY_MS); continue; }
            log(`meeting next to worker at (${meeting.x},${meeting.y})`);

            // 4. travel to M, opportunistically grabbing any sensed parcel that
            //    costs at most ENROUTE_SLACK extra tiles (one more parcel per
            //    exchange at ~zero travel cost); re-check after every pickup.
            //    Then sync on the worker chain BEFORE dropping: the putdown must
            //    happen with the worker parked in front, or its pickup order
            //    races its own return trip.
            //    Single-spawner maps skip this entirely: every parcel appears at
            //    the one tile B already fetches from, so nothing can spawn
            //    "on the way" — no point re-evaluating after leaving.
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
            // pickup can never path onto M. Prefer a neighbour; fall back to the
            // nearest reachable walkable tile that isn't M, the delivery tile, or
            // the worker's own tile (which sensing may not see from here).
            const notWorkerOrDelivery = n =>
                !(n.x === dTile.x && n.y === dTile.y) && !(n.x === wx && n.y === wy);
            const aside = freeNeighbours(meeting).find(notWorkerOrDelivery)
                ?? freeNeighbours(meeting, { excludeDelivery: false }).find(notWorkerOrDelivery)
                ?? walkableTiles
                    .filter(t => !(t.x === meeting.x && t.y === meeting.y) && notWorkerOrDelivery(t))
                    .map(t => ({ t, d: Math.abs(t.x - meeting.x) + Math.abs(t.y - meeting.y) }))
                    .sort((a, b) => a.d - b.d)
                    .map(({ t }) => t)
                    .find(t => findRoute(me, t, wBlock));
            if (aside) await withTimeout(myAgent.commandAndAwait(['go_to', aside.x, aside.y])).catch(() => {});
            if (!running || directive.aborted) break;

            // 5. worker: collect at M, deliver, return to the post — DETACHED, so
            //    the coordinator heads straight back for the next parcel instead
            //    of idling at the meeting while the worker travels (observed
            //    live). The worker-side steps stay strictly sequential: a new
            //    order would supersede the previous one.
            workerChain = (async () => {
                const pickRes = await sendOrder(['go_pick_up', meeting.x, meeting.y]);
                log(`worker pickup: ${pickRes}`);
                if (!running || directive.aborted) return;
                if (!/^Failed|no parcel/i.test(pickRes)) {       // stolen/decayed → skip delivery
                    const delivRes = await sendOrder(['go_deliver', dTile.x, dTile.y]);
                    log(`worker delivery: ${delivRes}`);
                    if (!running || directive.aborted) return;
                }
                if (post) await sendOrder(['go_to', post.x, post.y]);
            })().catch(() => {});
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
