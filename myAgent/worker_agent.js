import { socket, me, parcels, directive, trafficLight } from './context.js';
import { applyMissionConfig, dropMissionField, dropAllMissions } from './llm/missionState.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('worker');

/*
 * Worker side of the partner link (coordinator side + protocol in llm/partner.js).
 * A plain BDI agent — no LLM — that the coordinator commands over chat with JSON:
 * one-shot orders (go_to / go_pick_up / go_deliver / putdown), halt/resume, and
 * mission-constraint mirroring so persistent missions bind both agents.
 *
 * Non-JSON chat is ignored; the worker reacts only to the coordinator's relayed
 * halt/resume (one-brain design — see the dispatch handler below).
 */

const HELLO_RETRY_MS     = 5_000;   // until first ack
const HELLO_KEEPALIVE_MS = 30_000;  // after ack — re-registers if the coordinator restarts
const ORDER_TIMEOUT_MS   = 40_000;  // hard cap on one order (coordinator awaits 45s)

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout']), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Map an intention rejection tag to a readable detail for the coordinator. */
function describeFailure(err) {
    const tag = Array.isArray(err) ? err[0] : err;
    switch (tag) {
        case 'stopped':      return 'order was interrupted before completing';
        case 'no path to':   return `target (${err[1]},${err[2]}) is unreachable — a wall, or occupied/blocked by an agent (is the coordinator standing on it?)`;
        case 'goal blocked': return `target (${err[1]},${err[2]}) is blocked by another agent`;
        case 'busy':         return 'agent is finishing a previous plan';
        case 'timeout':      return `order timed out after ${ORDER_TIMEOUT_MS / 1000}s`;
        case 'no plan for':  return `no plan applies to ${err.slice(1).join(' ')}`;
        default:             return Array.isArray(err) ? err.join(' ') : String(err);
    }
}

export function registerWorker(myAgent, { resumeAutonomy } = {}) {
    let coordinatorId = null;
    let acked  = false;
    // While frozen (halt or red light) the gate stays held even after an order
    // completes, so the worker holds position between orders (handoff / "wait").
    let frozen = false;
    // Newest-order-wins: each order bumps this. A running order whose seq is no longer
    // current was superseded, so it must NOT report — the newer order owns the reply.
    let orderSeq = 0;

    const send = (payload) => {
        if (!coordinatorId) return;
        socket.emitSay(coordinatorId, JSON.stringify(payload))
            .catch?.(err => log.error('emitSay to coordinator failed:', err?.message ?? err));
    };

    // --- hello loop: announce until the coordinator acks, then keepalive ---
    const hello = () => {
        const payload = JSON.stringify({ type: 'hello', role: 'worker', name: me.name ?? null });
        socket.emitShout(payload).catch?.(() => {});
    };
    const helloTimer = setInterval(() => {
        if (!me.isReady) return;
        hello();
        if (acked) {
            clearInterval(helloTimer);
            setInterval(hello, HELLO_KEEPALIVE_MS);
        }
    }, HELLO_RETRY_MS);

    // --- freeze / unfreeze --------------------------------------------------------
    function halt() {
        frozen = true;
        directive.active = true;       // autonomous strategy stands down
        myAgent.haltCurrent();         // stop the plan already executing
        log('frozen (halt)');
    }
    function resume() {
        frozen = false;
        directive.active = false;
        log('resumed');
        resumeAutonomy?.();
    }

    /** Current worker status snapshot (position, score, cargo, frozen). */
    const sendStatus = () => send({
        type: 'status',
        x: me.x, y: me.y, score: me.score,
        carrying: parcels.carriedBy(me.id).map(p => ({ id: p.id, reward: p.reward })),
        frozen,
    });

    // While executing an order, stream our position so the coordinator can track us
    // id-certainly at any distance (otherAgents is id-less and range-limited).
    // Throttled, fires only on real movement (onYou).
    let lastStreamAt = 0;
    socket.onYou(() => {
        if (!directive.active || !coordinatorId) return;
        const now = Date.now();
        if (now - lastStreamAt < 200) return;
        lastStreamAt = now;
        sendStatus();
    });

    // --- one-shot orders ----------------------------------------------------------
    async function runOrder(orderId, predicate) {
        if (trafficLight.red) {
            send({ type: 'result', orderId, ok: false, detail: 'RED LIGHT in force — movement is forbidden' });
            return;
        }
        // Claim the latest sequence and pre-empt any older order's plan, so only ONE
        // intention runs at a time even under rapid re-targeting.
        const seq = ++orderSeq;
        myAgent.haltCurrent();
        const superseded = () => seq !== orderSeq;
        directive.active = true;       // hold the gate while the order runs
        try {
            // A pickup order may target a not-yet-sensed parcel (e.g. one the
            // coordinator just put down). Known → full go_pick_up plan. Unknown →
            // walk there and grab whatever's on the tile; sensing reconciles next.
            if (predicate[0] === 'go_pick_up' && predicate[3] == null) {
                const [, x, y] = predicate;
                const here = parcels.free().filter(p => Math.round(p.x) === x && Math.round(p.y) === y);
                const known = here.sort((a, b) => b.reward - a.reward)[0];
                if (known) {
                    predicate = ['go_pick_up', x, y, known.id];
                } else {
                    await withTimeout(myAgent.commandAndAwait(['go_to', x, y]), ORDER_TIMEOUT_MS);
                    if (superseded()) return;   // a newer order owns the reply
                    const picked = await socket.emitPickup();
                    const n = picked?.length ?? 0;
                    send({ type: 'result', orderId, ok: n > 0,
                           detail: n > 0 ? `picked up ${n} parcel(s) at (${x},${y})`
                                         : `reached (${x},${y}) but found no parcel to pick up` });
                    return;
                }
            }
            if (predicate[0] === 'go_deliver' && predicate.length < 3) {
                send({ type: 'result', orderId, ok: false, detail: 'go_deliver order needs explicit x,y' });
                return;
            }
            await withTimeout(myAgent.commandAndAwait(predicate), ORDER_TIMEOUT_MS);
            if (superseded()) return;           // a newer order owns the reply
            send({ type: 'result', orderId, ok: true,
                   detail: `done: ${predicate.join(' ')} — now at (${me.x},${me.y})` });
        } catch (err) {
            // A halt from the superseding order surfaces as 'stopped'/'timeout'; that
            // order reports, so stay silent rather than spuriously failing this one.
            if (!superseded()) send({ type: 'result', orderId, ok: false, detail: describeFailure(err) });
        } finally {
            // Stream our RESTING tile: the throttled onYou can skip the final step when
            // we stop right after arriving, leaving the coordinator a tile behind at
            // the rendezvous. Release the gate only if WE are still the current order.
            sendStatus();
            if (!frozen && !superseded()) {
                directive.active = false;
                resumeAutonomy?.();
            }
        }
    }

    async function runPutdown(orderId) {
        // Gate BDI and stop any in-flight plan so the drop isn't immediately undone
        // (without this the strategy re-picks the parcel the instant it lands).
        myAgent.haltCurrent();
        directive.active = true;
        const carried = parcels.carriedBy(me.id);
        try {
            const dropped = await socket.emitPutdown().catch(() => null);
            const n = dropped?.length ?? 0;
            // ignore() (not remove()): the parcels still exist on the tile; this worker
            // must stop targeting them, but the coordinator (separate beliefs) can still
            // sense and pick them up (handoff drop). Re-pick is prevented permanently.
            for (const p of carried) parcels.ignore(p.id);
            send({ type: 'result', orderId, ok: n > 0,
                   detail: n > 0 ? `dropped ${n} parcel(s) at (${me.x},${me.y})`
                                 : `nothing to drop at (${me.x},${me.y})` });
        } finally {
            if (!frozen) { directive.active = false; resumeAutonomy?.(); }
        }
    }

    // --- message dispatch -----------------------------------------------------------
    socket.onMsg((id, _name, msg, replyAck) => {
        const text = typeof msg === 'string' ? msg : (msg?.text ?? JSON.stringify(msg));
        replyAck?.('ack');

        let j = null;
        try { j = JSON.parse(text); } catch { /* not protocol JSON */ }

        if (!j?.type) {
            // Plain chat (incl. live RED/GREEN-LIGHT shouts) is for the coordinator's
            // LLM to interpret (one-brain design — the worker has no model). The worker
            // reacts only to the coordinator's relayed halt/resume, so the light mission
            // stays LLM-driven (trade-off: the worker waits out the relay before freezing).
            return;
        }

        switch (j.type) {
            case 'hello_ack':
                acked = true;
                if (coordinatorId !== id) log(`coordinator connected: ${id}`);
                coordinatorId = id;
                break;
            case 'order':      runOrder(j.orderId, j.predicate); break;
            case 'putdown':    runPutdown(j.orderId); break;
            case 'halt':       halt(); break;
            case 'resume':     resume(); break;
            case 'constraint': {
                let obs;
                if (j.op === 'apply')      obs = applyMissionConfig(j.config ?? {});
                else if (j.op === 'drop')  obs = dropMissionField(j.field).observation;
                else                       obs = dropAllMissions();
                log(`constraint ${j.op}: ${obs}`);
                break;
            }
            case 'status_req':
                sendStatus();
                break;
            default:
                log(`unknown partner message type '${j.type}' from ${id}`);
        }
    });

    log('worker ready — announcing to coordinator and awaiting orders.');
}
