import { socket } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:partner');

/**
 * @typedef { {id: string|null, name: string|null, lastStatus: Object|null} } PartnerState
 */

const workerId = process.env.WORKER_ID ?? null;

/**
 * Coordinator-side partner link (JSON protocol over the chat channel). Sends orders,
 * constraints, halt/resume; receives results and status updates.
 */

/** @type {PartnerState} Live state of the connected partner */
export const partner = { id: null, name: null, lastStatus: null };

/** @type {number} Counter for unique order IDs */
let nextOrderId = 1;

/** @type {Map<string, {resolve: Function, timer: any}>} Pending orders awaiting results */
const pending = new Map();

/** @type {string} Key tracking the in-flight status request */
const STATUS_KEY = '__status__';

/**
 * Send a JSON payload to the partner (fire-and-forget)
 * @param {Object} payload - JSON-serializable message
 * @returns {boolean} False if no partner is connected
 */
function sendJson(payload) {
    if (!partner.id) return false;
    socket.emitSay(partner.id, JSON.stringify(payload))
        .catch?.(err => log.error('emitSay to partner failed:', err?.message ?? err));
    return true;
}

/**
 * Handle a partner-protocol JSON message to the coordinator
 * @param {Object} msg - Parsed JSON message with a type field
 * @param {string} sender - Sender socket ID
 * @returns {boolean} True if recognized and consumed
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
                // Uniform 'Failed:' prefix so callers detect failure like local tools.
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
 * Await a keyed reply, resolving with a timeout message if the partner is silent
 * @param {string} key - Map key for the pending promise
 * @param {number} timeoutMs - Ms before timing out
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
 * Send a BDI predicate to the worker and await its result
 * @param {Array} predicate - e.g. ['go_to', 5, 3] or ['putdown']
 * @param {number} [timeoutMs] - Max wait (ms)
 * @returns {Promise<string>} Worker's result detail (success or failure)
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
 * Freeze the worker (halt its plan and gate its autonomy)
 * @returns {string} Confirmation or no-partner notice
 */
export function sendHalt() {
    return sendJson({ type: 'halt' })
        ? 'Partner halted (frozen until resume_partner).'
        : 'No partner connected yet.';
}

/**
 * Unfreeze the worker and re-trigger its deliberation
 * @returns {string} Confirmation or no-partner notice
 */
export function sendResume() {
    return sendJson({ type: 'resume' })
        ? 'Partner resumed autonomous work.'
        : 'No partner connected yet.';
}

/**
 * Mirror a mission-constraint mutation to the worker (fire-and-forget)
 * @param {'apply'|'drop'|'dropAll'} op - Operation type
 * @param {Object|string} [payload] - Config for apply, field name for drop
 */
export function sendConstraint(op, payload) {
    if (!partner.id) return;
    if (op === 'apply')        sendJson({ type: 'constraint', op, config: payload });
    else if (op === 'drop')    sendJson({ type: 'constraint', op, field: payload });
    else                       sendJson({ type: 'constraint', op: 'dropAll' });
}

/**
 * Request a live status snapshot from the worker (position, cargo, frozen state)
 * @param {number} [timeoutMs] - Max wait (ms)
 * @returns {Promise<string>} JSON status, or timeout/no-partner message
 */
export async function requestStatus(timeoutMs = 5_000) {
    if (!partner.id) return 'No partner connected yet.';
    sendJson({ type: 'status_req' });
    return awaitReply(STATUS_KEY, timeoutMs, 'Failed: partner status request timed out.');
}
