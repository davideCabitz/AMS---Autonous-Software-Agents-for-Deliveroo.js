import { socket, me, parcels, directive, trafficLight } from './context.js';
import { applyMissionConfig, dropMissionField, dropAllMissions } from './llm/missionState.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('worker');

/*
 * Worker side of the partner link (see myAgent/llm/partner.js for the
 * coordinator side and the protocol shapes). The worker is a plain BDI agent —
 * no LLM — that the coordinator can command over chat with JSON payloads:
 * one-shot orders (go_to / go_pick_up / go_deliver / putdown), halt/resume
 * (freeze autonomy, e.g. during a parcel handoff or while waiting together),
 * and mission-constraint mirroring so persistent missions bind both agents.
 *
 * Non-JSON chat is ignored EXCEPT the red/green-light keywords: the worker
 * hears the mission agent's shout directly and must stop within the grace
 * period — it cannot afford to wait for the coordinator's relayed halt.
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
    // While frozen (halt order or red light) the autonomy gate stays held even
    // after an order completes, so the worker holds position between orders —
    // exactly what the handoff and "wait for each other" missions need.
    let frozen = false;
    // Newest-order-wins: each incoming order bumps this. A running order whose seq
    // is no longer current was superseded (the coordinator re-steered us toward a
    // moving rendezvous), so it must NOT report a result — the newer order owns the
    // reply. Lets the coordinator re-target us continuously without racing two plans.
    let orderSeq = 0;

    const send = (payload) => {
        if (!coordinatorId) return;
        socket.emitSay(coordinatorId, JSON.stringify(payload))
            .catch?.(err => log.error('emitSay to coordinator failed:', err?.message ?? err));
    };

    // --- hello loop: announce ourselves until the coordinator acks, then keepalive ---
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

    // While executing a coordinator order (directive.active), stream our position so
    // the coordinator can track us id-certainly at any distance — otherAgents is
    // id-less and range-limited, but a handoff needs to know exactly where we are.
    // Throttled, and only fires on real movement (onYou).
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
        // Claim the latest sequence and pre-empt any plan still running for an older
        // order, so only ONE intention executes at a time even under rapid re-targeting.
        const seq = ++orderSeq;
        myAgent.haltCurrent();
        const superseded = () => seq !== orderSeq;
        directive.active = true;       // hold the gate while the order runs
        try {
            // A pickup order may target a parcel the worker has not sensed yet
            // (e.g. one the coordinator just put down far away). Known parcel →
            // full go_pick_up plan (belief-safe). Unknown → walk there and pick
            // up whatever is on the tile; the next sensing event reconciles.
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
            // order will report, so stay silent rather than spuriously failing this one.
            if (!superseded()) send({ type: 'result', orderId, ok: false, detail: describeFailure(err) });
        } finally {
            // Stream our RESTING tile: the throttled onYou stream can skip the final
            // step when we stop right after arriving, leaving the coordinator a tile
            // behind exactly where it needs to know we've reached the rendezvous.
            // Only release the gate if WE are still the current order — a newer one
            // running must keep directive.active held.
            sendStatus();
            if (!frozen && !superseded()) {
                directive.active = false;
                resumeAutonomy?.();
            }
        }
    }

    async function runPutdown(orderId) {
        const carried = parcels.carriedBy(me.id);
        await socket.emitPutdown();
        for (const p of carried) parcels.remove(p.id);
        send({ type: 'result', orderId, ok: true,
               detail: `dropped ${carried.length} parcel(s) at (${me.x},${me.y})` });
    }

    // --- message dispatch -----------------------------------------------------------
    socket.onMsg((id, _name, msg, replyAck) => {
        const text = typeof msg === 'string' ? msg : (msg?.text ?? JSON.stringify(msg));
        replyAck?.('ack');

        let j = null;
        try { j = JSON.parse(text); } catch { /* not protocol JSON */ }

        if (!j?.type) {
            // Red/green-light fast-path on the raw shout — no LLM, no relay needed.
            // ANCHORED match: the mission announcement contains "red light" mid-
            // sentence and must NOT freeze the worker; the real shouts start with it.
            if (/^\s*red light\b/i.test(text)) {
                trafficLight.red = true;
                myAgent.haltCurrent();
                log('RED LIGHT — holding position');
            } else if (/^\s*green light\b/i.test(text)) {
                trafficLight.red = false;
                log('GREEN LIGHT — resuming');
                if (!frozen && !directive.active) resumeAutonomy?.();
            }
            return; // all other plain chat is for the coordinator, not the worker
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
