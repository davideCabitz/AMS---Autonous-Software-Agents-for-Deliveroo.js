import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, otherAgents, directive, trafficLight } from '../context.js';
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
 * One cycle:
 *   1. worker frozen (it must never pick up parcels itself — those deliveries
 *      would not qualify for the cross-agent bonus);
 *   2. coordinator picks up the nearest reachable free parcel;
 *   3. carries it to a meeting tile M adjacent to the delivery tile nearest the
 *      worker — M must NOT itself be a delivery tile, or the coordinator's
 *      putdown would count as ITS OWN delivery and void the bonus;
 *   4. puts the parcel down and steps off M (two agents cannot share a tile);
 *   5. orders the worker: pick up at M, then deliver at the adjacent delivery
 *      tile → cross-agent bonus for both.
 * Any failed step skips to the next cycle with fresh state; no parcels → idle.
 */

const IDLE_RETRY_MS = 2_000;
// Hard cap on any single own-navigation step, so one wedged/stale intention can
// never freeze the whole routine (worker orders carry their own 45s timeout).
const STEP_TIMEOUT_MS = 60_000;

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

/** Nearest reachable parcel. Live sightings always beat remembered ones: a
 *  remembered parcel may be a ghost (already taken/decayed — observed live:
 *  the routine trekked the whole map chasing them), so they only matter when
 *  nothing at all is in view. Null if none. */
function pickTargetParcel() {
    const GHOST_PENALTY = 10_000; // any live parcel outranks every remembered one
    const candidates = [
        ...parcels.free().map(p => ({ p, bias: 0 })),
        ...parcels.remembered().filter(r => !parcels.get(r.id)).map(p => ({ p, bias: GHOST_PENALTY })),
    ];
    return candidates
        .map(({ p, bias }) => {
            const route = findRoute(me, p);
            return route ? { p, len: route.length + bias } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.len - b.len || b.p.reward - a.p.reward)[0]?.p ?? null;
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

    while (running && !directive.aborted) {
        try {
            // Red light: no movement at all — wait it out.
            if (trafficLight.red) { await idle(500); continue; }

            // 1. find a parcel to fetch; with the worker frozen and nobody
            //    exploring, an empty view would stall the routine forever, so
            //    tour the spawners until something shows up.
            const target = pickTargetParcel();
            if (!target) {
                const spots = spawnerTiles.filter(t => findRoute(me, t));
                if (!spots.length) { await idle(IDLE_RETRY_MS); continue; }
                const s = spots[exploreIdx++ % spots.length];
                log(`no parcel in sight — checking spawner (${s.x},${s.y})`);
                await withTimeout(myAgent.commandAndAwait(['go_to', s.x, s.y])).catch(() => {});
                continue;
            }

            // 2. pick it up
            log(`cycle: fetching parcel ${target.id} at (${target.x},${target.y})`);
            await withTimeout(myAgent.commandAndAwait(['go_pick_up', target.x, target.y, target.id]));
            if (!running || directive.aborted) break;
            if (parcels.carriedBy(me.id).length === 0) {
                log('parcel gone before pickup — next cycle');
                continue;
            }

            // 3. choose the meeting point: a free non-delivery tile adjacent to the
            //    delivery tile nearest the worker, reachable by the coordinator.
            //    Exclude the worker's own tile: it is frozen in place and sensing
            //    can't see it from across the map (observed live: meeting tile was
            //    chosen ON the parked worker and the cycle failed on arrival).
            const wpos = await workerPosition() ?? me;
            const dTile = deliveryNearest(wpos.x, wpos.y);
            if (!dTile) { log('no delivery tile known — next cycle'); await idle(IDLE_RETRY_MS); continue; }
            const meeting = freeNeighbours(dTile)
                .filter(n => !(n.x === Math.round(wpos.x) && n.y === Math.round(wpos.y)))
                .find(n => findRoute(me, n));
            if (!meeting) { log(`no free meeting tile next to (${dTile.x},${dTile.y})`); await idle(IDLE_RETRY_MS); continue; }

            // 4. drop the cargo at M and step aside so the worker can stand on M
            await withTimeout(myAgent.commandAndAwait(['go_to', meeting.x, meeting.y]));
            if (!running || directive.aborted) break;
            const carried = parcels.carriedBy(me.id);
            await socket.emitPutdown();
            for (const p of carried) parcels.remove(p.id);
            log(`dropped ${carried.length} parcel(s) at meeting (${meeting.x},${meeting.y})`);

            // Vacating M is MANDATORY — if the coordinator stays put, the worker's
            // pickup can never path onto M. Prefer a neighbour; fall back to the
            // nearest reachable walkable tile that isn't M or the delivery tile.
            const aside = freeNeighbours(meeting).find(n => !(n.x === dTile.x && n.y === dTile.y))
                ?? freeNeighbours(meeting, { excludeDelivery: false })
                    .find(n => !(n.x === dTile.x && n.y === dTile.y))
                ?? walkableTiles
                    .filter(t => !(t.x === meeting.x && t.y === meeting.y) && !(t.x === dTile.x && t.y === dTile.y))
                    .map(t => ({ t, d: Math.abs(t.x - meeting.x) + Math.abs(t.y - meeting.y) }))
                    .sort((a, b) => a.d - b.d)
                    .map(({ t }) => t)
                    .find(t => findRoute(me, t));
            if (aside) await withTimeout(myAgent.commandAndAwait(['go_to', aside.x, aside.y])).catch(() => {});
            if (!running || directive.aborted) break;

            // 5. worker: collect at M, deliver next door — bonus for both
            const pickRes = await sendOrder(['go_pick_up', meeting.x, meeting.y]);
            log(`worker pickup: ${pickRes}`);
            if (!running || directive.aborted) break;
            if (/^Failed|no parcel/i.test(pickRes)) continue;   // parcel stolen/decayed — next cycle

            const delivRes = await sendOrder(['go_deliver', dTile.x, dTile.y]);
            log(`worker delivery: ${delivRes}`);
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
