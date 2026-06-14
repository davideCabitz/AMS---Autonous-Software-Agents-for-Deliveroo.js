import { socket } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:partner');

/*
 * Coordinator side of the partner link (see myAgent/worker_agent.js for the
 * worker side). The coordinator commands the worker over the normal chat channel
 * with small JSON payloads:
 *
 *   -> {"type":"order","orderId":"o1","predicate":["go_to",5,3]}
 *   -> {"type":"putdown","orderId":"o2"}
 *   -> {"type":"halt"} / {"type":"resume"}
 *   -> {"type":"constraint","op":"apply"|"drop"|"dropAll", ...}
 *   -> {"type":"status_req"}
 *   <- {"type":"hello","role":"worker","name":...}            (worker, shouted until acked)
 *   <- {"type":"result","orderId":"o1","ok":true,"detail":...}
 *   <- {"type":"status","x":..,"y":..,"score":..,"carrying":[...],"frozen":..}
 *
 * Orders are await-able: sendOrder resolves with the worker's `detail` string
 * (success or failure), which the ReAct loop uses directly as the observation.
 */

export const partner = { id: null, name: null, lastStatus: null };

let nextOrderId = 1;
// orderId -> { resolve, timer }; one extra well-known key for the status request.
const pending = new Map();
const STATUS_KEY = '__status__';

function sendJson(payload) {
    if (!partner.id) return false;
    socket.emitSay(partner.id, JSON.stringify(payload))
        .catch?.(err => log.error('emitSay to partner failed:', err?.message ?? err));
    return true;
}

/**
 * Handle a partner-protocol JSON message addressed to the coordinator.
 * Called from the route() JSON intercept in llm/index.js.
 * @returns {boolean} true when the message was a partner message and was consumed
 */
export function handlePartnerMessage(msg, sender) {
    switch (msg.type) {
        case 'hello': {
            const isNew = partner.id !== sender;
            partner.id   = sender;
            partner.name = msg.name ?? null;
            if (isNew) log(`partner connected: ${partner.name ?? '?'} (${sender})`);
            sendJson({ type: 'hello_ack' });
            return true;
        }
        case 'result': {
            const entry = pending.get(msg.orderId);
            if (entry) {
                pending.delete(msg.orderId);
                clearTimeout(entry.timer);
                // Uniform 'Failed:' prefix so callers (handoff loop, LLM
                // observations) can detect failure the same way as local tools.
                entry.resolve(msg.ok
                    ? String(msg.detail ?? 'Done.')
                    : `Failed: ${msg.detail ?? 'order failed'}`);
            }
            return true;
        }
        case 'status': {
            partner.lastStatus = msg;
            const entry = pending.get(STATUS_KEY);
            if (entry) {
                pending.delete(STATUS_KEY);
                clearTimeout(entry.timer);
                const { type, ...status } = msg;
                entry.resolve(JSON.stringify(status));
            }
            return true;
        }
        default:
            return false;
    }
}

/** Await a keyed reply, resolving with a readable string on timeout. */
function awaitReply(key, timeoutMs, timeoutMsg) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            pending.delete(key);
            resolve(timeoutMsg);
        }, timeoutMs);
        pending.set(key, { resolve, timer });
    });
}

/**
 * Send a BDI predicate to the worker and await its result observation.
 * @param {Array} predicate e.g. ['go_to', 5, 3] — or the special ['putdown']
 * @returns {Promise<string>} the worker's detail string (success or failure)
 */
export async function sendOrder(predicate, timeoutMs = 45_000) {
    if (!partner.id) return 'No partner connected yet.';
    const orderId = `o${nextOrderId++}`;
    const type = predicate[0] === 'putdown' ? 'putdown' : 'order';
    sendJson(type === 'putdown'
        ? { type, orderId }
        : { type, orderId, predicate });
    log(`order ${orderId} -> ${predicate.join(' ')}`);
    return awaitReply(orderId, timeoutMs,
        `Failed: partner did not report back on '${predicate.join(' ')}' within ${timeoutMs / 1000}s.`);
}

/** Freeze the worker: halts its current plan and gates its autonomy. */
export function sendHalt() {
    return sendJson({ type: 'halt' })
        ? 'Partner halted (frozen until resume_partner).'
        : 'No partner connected yet.';
}

/** Unfreeze the worker: clears the gate and re-triggers its deliberation. */
export function sendResume() {
    return sendJson({ type: 'resume' })
        ? 'Partner resumed autonomous work.'
        : 'No partner connected yet.';
}

/**
 * Mirror a mission-constraint mutation to the worker (fire-and-forget — the
 * coordinator already applied it locally and reported to the chat).
 * @param {'apply'|'drop'|'dropAll'} op
 * @param {object|string} [payload] config object for apply, field name for drop
 */
export function sendConstraint(op, payload) {
    if (!partner.id) return;
    if (op === 'apply')        sendJson({ type: 'constraint', op, config: payload });
    else if (op === 'drop')    sendJson({ type: 'constraint', op, field: payload });
    else                       sendJson({ type: 'constraint', op: 'dropAll' });
}

/** Ask the worker for a live status snapshot (position, carrying, frozen). */
export async function requestStatus(timeoutMs = 5_000) {
    if (!partner.id) return 'No partner connected yet.';
    sendJson({ type: 'status_req' });
    return awaitReply(STATUS_KEY, timeoutMs, 'Failed: partner status request timed out.');
}
