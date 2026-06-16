import { socket } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:partner');

<<<<<<< HEAD
const workerId = process.env.WORKER_ID ?? null;

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
=======
/**
 * @typedef { {id: string|null, name: string|null, lastStatus: Object|null} } PartnerState
>>>>>>> 3aa6dd90928bcd9bcdfc0853f58ebbfe3e391d12
 */

/**
 * Coordinator-side partner agent link (JSON protocol over chat channel)
 * Commands worker with orders, constraints, halt/resume; receives results and status updates
 */

/** @type {PartnerState} Live state of the connected partner agent */
export const partner = { id: null, name: null, lastStatus: null };

/** @type {number} Counter for unique order IDs */
let nextOrderId = 1;

/** @type {Map<string, {resolve: Function, timer: any}>} Pending orders awaiting result callbacks */
const pending = new Map();

/** @type {string} Well-known key used to track in-flight status requests */
const STATUS_KEY = '__status__';

/**
 * Send a JSON payload to the partner over the chat channel (fire-and-forget)
 * @param {Object} payload - JSON-serializable message object
 * @returns {boolean} False if no partner is connected
 */
function sendJson(payload) {
    if (!partner.id) return false;
    socket.emitSay(partner.id, JSON.stringify(payload))
        .catch?.(err => log.error('emitSay to partner failed:', err?.message ?? err));
    return true;
}

/**
 * Handle a partner-protocol JSON message addressed to the coordinator
 * @param {Object} msg - Parsed JSON message with a type field
 * @param {string} sender - Socket ID of the sender
 * @returns {boolean} True when the message was a recognized partner message and was consumed
 */
export function handlePartnerMessage(msg, sender) {
    switch (msg.type) {
        case 'hello': {
            if (workerId && sender !== workerId) {
                log(`rejected hello from unknown sender ${sender}`);
                return false;
            }
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

/**
 * Await a keyed reply, resolving with a readable timeout message if the partner does not respond
 * @param {string} key - Map key to register the pending promise under
 * @param {number} timeoutMs - Milliseconds before timing out
 * @param {string} timeoutMsg - Message to resolve with on timeout
 * @returns {Promise<string>} Partner reply or timeout message
 */
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
 * Send a BDI predicate to the worker and await its result observation
 * @param {Array} predicate - Predicate to execute, e.g. ['go_to', 5, 3] or ['putdown']
 * @param {number} [timeoutMs] - Max wait time in milliseconds
 * @returns {Promise<string>} Worker's result detail string (success or failure)
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

/**
 * Freeze the worker by halting its current plan and gating its autonomy
 * @returns {string} Confirmation message or no-partner notice
 */
export function sendHalt() {
    return sendJson({ type: 'halt' })
        ? 'Partner halted (frozen until resume_partner).'
        : 'No partner connected yet.';
}

/**
 * Unfreeze the worker and re-trigger its deliberation
 * @returns {string} Confirmation message or no-partner notice
 */
export function sendResume() {
    return sendJson({ type: 'resume' })
        ? 'Partner resumed autonomous work.'
        : 'No partner connected yet.';
}

/**
 * Mirror a mission-constraint mutation to the worker (fire-and-forget)
 * @param {'apply'|'drop'|'dropAll'} op - Operation type
 * @param {Object|string} [payload] - Config object for apply, field name for drop
 */
export function sendConstraint(op, payload) {
    if (!partner.id) return;
    if (op === 'apply')        sendJson({ type: 'constraint', op, config: payload });
    else if (op === 'drop')    sendJson({ type: 'constraint', op, field: payload });
    else                       sendJson({ type: 'constraint', op: 'dropAll' });
}

/**
 * Request a live status snapshot from the worker (position, carrying, frozen state)
 * @param {number} [timeoutMs] - Max wait time in milliseconds
 * @returns {Promise<string>} JSON status string or timeout/no-partner message
 */
export async function requestStatus(timeoutMs = 5_000) {
    if (!partner.id) return 'No partner connected yet.';
    sendJson({ type: 'status_req' });
    return awaitReply(STATUS_KEY, timeoutMs, 'Failed: partner status request timed out.');
}
