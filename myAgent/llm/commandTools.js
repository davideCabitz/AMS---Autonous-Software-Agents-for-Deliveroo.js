import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, missionConstraints, directive, trafficLight, manualHold, lightMission, moveTiming, pddl, pddlGather, pddlGoto } from '../context.js';
import { reachableFrom, findRoute } from '../utils/astar.js';
import { applyMissionConfig, dropMissionField, dropAllMissions, armedByNet } from './missionState.js';
import { partner, sendOrder, sendHalt, sendResume, sendConstraint, requestStatus } from './partner.js';
import { startHandoff, stopHandoff } from './handoff.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('llm:tool');

// PddlMove is imported lazily inside gather_near (dynamic import) to avoid a circular
// module init: commandTools → PddlMove → PlanBase → IntentionDeliberation → planLibrary.

/**
 * LLM command tool catalogue. Every tool returns a STRING observation for the
 * ReAct loop. Categories: reasoning (calculate, time), read (position, parcels),
 * command (go_to/pickup/deliver), chat (say).
 */

/** @type {number} Max ms a single command may run before timing out */
const COMMAND_TIMEOUT_MS = 30_000;

/** @type {number} Max seconds wait() holds position (prevents indefinite freeze) */
const MAX_WAIT_SECONDS = 30;

/**
 * Evaluate a math expression
 * @param {string} expression - Expression using + - * / () — may be comma-separated
 * @returns {string} Numeric result(s) or an error message
 */
function calculate(expression) {
    // Strip quotes; allow several comma-separated expressions per call
    // (e.g. "(0+18)/2, (0+19)/2" -> "9, 9.5").
    const raw = String(expression ?? '').trim().replace(/^["']|["']$/g, '');
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return 'Error: empty expression.';
    const results = [];
    for (const expr of parts) {
        if (!/^[\d\s+\-*/().]+$/.test(expr))
            return `Error: invalid expression '${expr}'. Only numbers and + - * / ( ) are allowed.`;
        try {
            const result = Function(`"use strict"; return (${expr});`)();
            if (typeof result !== 'number' || !Number.isFinite(result))
                return `Error: '${expr}' did not evaluate to a finite number.`;
            results.push(String(result));
        } catch (err) {
            return `Error: ${err.message}`;
        }
    }
    return results.join(', ');
}

/**
 * Current local time in Rome as a JSON string
 * @param {string} location - Location label for the response (cosmetic only)
 * @returns {string} JSON with location, timezone, time fields
 */
function get_current_time(location) {
    const where = String(location ?? 'Rome').trim() || 'Rome';
    const timezone = 'Europe/Rome';
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    return JSON.stringify({ location: where, timezone, time });
}

// ---- helpers ------------------------------------------------------------------

/**
 * Parse coordinate input in various formats into {x, y}
 * @param {string} input - e.g. "5,3" / "(5, 3)" / "x=5 y=3" / "5 3"
 * @returns {{x: number|null, y: number|null}} Coordinates, or nulls if parsing fails
 */
function parseXY(input) {
    const nums = String(input ?? '').match(/-?\d+/g);
    if (!nums || nums.length < 2) return { x: null, y: null };
    return { x: parseInt(nums[0], 10), y: parseInt(nums[1], 10) };
}

/**
 * Parse an optional signed reward token ("pts=N"/"points=N") from Level-3 input
 * @param {string} input - Raw tool input string
 * @returns {number|null} Reward value, or null if no token present
 */
function parseRewardToken(input) {
    const m = String(input ?? '').match(/(?:pts|points)\s*=\s*(-?\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Highest-reward free parcel on tile (x, y)
 * @param {number} x - Tile x
 * @param {number} y - Tile y
 * @returns {string|null} Parcel ID, or null if none free there
 */
function resolveParcelId(x, y) {
    const here = parcels.free().filter(p => Math.round(p.x) === x && Math.round(p.y) === y);
    if (!here.length) return null;
    return here.sort((a, b) => b.reward - a.reward)[0].id;
}

/**
 * Filter a tile list to those the agent can currently A*-reach
 * @param {Array<{x: number, y: number}>} tiles - Full tile list
 * @returns {Array<{x: number, y: number}>} Reachable subset (or original if none reachable)
 */
function onlyReachable(tiles) {
    const reach = reachableFrom(me);
    const filtered = tiles.filter(t => reach.has(`${t.x}_${t.y}`));
    return filtered.length ? filtered : tiles;
}

/**
 * Delivery tile nearest the agent by Manhattan distance
 * @returns {{x: number, y: number}|null} Nearest delivery tile, or null if none known
 */
function nearestDelivery() {
    if (!deliveryTiles.length) return null;
    return deliveryTiles
        .map(t => ({ t, d: Math.abs(t.x - me.x) + Math.abs(t.y - me.y) }))
        .sort((a, b) => a.d - b.d)[0].t;
}

/**
 * Sleep for ms, resolving early if directive.aborted is set
 * @param {number} ms - Max sleep duration (ms)
 * @returns {Promise<number>} Actual elapsed time (ms)
 */
function abortableDelay(ms) {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (directive.aborted || Date.now() >= start + ms) resolve(Date.now() - start);
            else setTimeout(tick, 100);
        };
        setTimeout(tick, Math.min(100, ms));
    });
}

/**
 * Race a promise against a timeout, rejecting with a tagged error on expiry
 * @param {Promise} promise - Promise to race
 * @param {number} ms - Timeout (ms)
 * @param {string} tag - Tag included in the timeout rejection
 * @returns {Promise} Promise result, or rejects with ['timeout', tag]
 */
function withTimeout(promise, ms, tag) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout', tag]), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Best-effort chat send that cannot throw or hang (bounded by timeout)
 * @param {string} target - Recipient socket ID
 * @param {string} text - Message text
 * @param {number} [ms] - Max wait for server ack (ms)
 * @returns {Promise<boolean>} True if the ack arrived in time
 */
async function safeSay(target, text, ms = 5_000) {
    if (!target) return false;
    try {
        await withTimeout(socket.emitSay(target, text), ms, 'say');
        return true;
    } catch {
        return false;
    }
}

/**
 * Map an intention rejection tag to a readable "Failed:" observation
 * @param {Array|string} err - Rejection value from commandAndAwait
 * @returns {string} Readable failure string prefixed with "Failed:"
 */
function describeFailure(err) {
    const tag = Array.isArray(err) ? err[0] : err;
    switch (tag) {
        case 'stopped':      return 'Failed: the command was interrupted before completing.';
        case 'no path to':   return `Failed: target (${err[1]},${err[2]}) is unreachable — a wall, or a tile currently occupied/blocked by an agent.`;
        case 'goal blocked': return `Failed: target (${err[1]},${err[2]}) is blocked by another agent.`;
        case 'busy':         return 'Failed: agent is finishing a previous plan; try again in a moment.';
        case 'timeout':      return `Failed: command timed out after ${COMMAND_TIMEOUT_MS}ms.`;
        case 'no plan for':  return `Failed: no plan applies to ${err.slice(1).join(' ')}.`;
        default:
            if (typeof tag === 'string' && tag.startsWith('pddl-'))
                return `Failed: navigation planner error (${tag}).`;
            return `Failed: ${Array.isArray(err) ? err.join(' ') : String(err)}`;
    }
}

// ---- tool catalogue -----------------------------------------------------------

/**
 * Read-only tool subset safe in any context (no world effects)
 * @returns {Object} Map of tool name to async function
 */
function readTools() {
    return {
        // reasoning
        async calculate(input)        { return calculate(input); },
        async get_current_time(input) { return get_current_time(input); },

        // read
        async get_my_position() {
            if (me.x == null || me.y == null) return 'Position not available yet.';
            return JSON.stringify({ x: me.x, y: me.y, score: me.score });
        },
        async sense_parcels() {
            const free = parcels.free();
            return free.length
                ? JSON.stringify(free.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward })))
                : 'No free parcels currently in view.';
        },
        async sense_delivery_tiles() {
            if (!deliveryTiles.length) return 'No delivery tiles known yet.';
            return JSON.stringify(onlyReachable(deliveryTiles).map(t => ({ x: t.x, y: t.y })));
        },
        async sense_spawn_tiles() {
            if (!spawnerTiles.length) return 'No spawn tiles known yet.';
            return JSON.stringify(onlyReachable(spawnerTiles).map(t => ({ x: t.x, y: t.y })));
        },
        async get_map_info() {
            if (!walkableTiles.length) return 'Map not loaded yet.';
            // Only reachable tiles, so edges are the reachable extremes and
            // "leftmost/rightmost/top/bottom" resolve to a real reachable tile.
            const reach = onlyReachable(walkableTiles);
            const xs = reach.map(t => t.x);
            const ys = reach.map(t => t.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const at = (pred) => reach.filter(pred).map(t => ({ x: t.x, y: t.y }));
            return JSON.stringify({
                bounds: { minX, maxX, minY, maxY },
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                counts: { delivery: deliveryTiles.length, spawn: spawnerTiles.length, walkable: walkableTiles.length },
                edges: {
                    leftmost:  at(t => t.x === minX),
                    rightmost: at(t => t.x === maxX),
                    bottom:    at(t => t.y === minY),
                    top:       at(t => t.y === maxY),
                },
            });
        },
    };
}

/**
 * Read-only toolset for the conversational fast-lane (no movement/gate changes)
 * @returns {Object} Map of tool name to async function
 */
export function buildChatTools() {
    return {
        ...readTools(),
        // Read-only, safe concurrently with an action directive (only sends a
        // status_req). The chat lane needs it to answer partner pos/cargo live.
        async ask_partner_status() { return requestStatus(); },
    };
}

/**
 * Full action toolset for the directive execution lane
 * @param {Object} myAgent - IntentionRevisionReplace instance
 * @param {string|null} replySender - Chat ID of the directive sender (for say())
 * @param {Function} [resumeAutonomy] - Called when the gate releases after each command
 * @returns {Object} Map of tool name to async function
 */
export function buildTools(myAgent, replySender, resumeAutonomy) {
    // Run a BDI command, releasing the gate OPTIMISTICALLY the instant it finishes
    // (see finally) rather than holding it across the whole directive — otherwise the
    // gate stays shut through the confirmation round-trip and a single-command
    // directive idles at the destination instead of letting the strategy work. A
    // follow-up command re-takes the gate and halts whatever the strategy began.
    //
    // Trade-off: the agent may do its own BDI work (and move) during the inter-command
    // think, so a move-then-stay sequence can drift before the stationary command
    // re-grabs. Stationary commands manage their own gate and skip this helper.
    const command = async (predicate, ok) => {
        if (trafficLight.red)
            return 'Failed: RED LIGHT in force — movement is forbidden until the GREEN LIGHT message.';
        directive.active = true;                       // (re)take control
        myAgent.haltCurrent();                         // drop any BDI intention started in the gap
        try {
            await withTimeout(myAgent.commandAndAwait(predicate), COMMAND_TIMEOUT_MS, predicate[0]);
            return ok();                               // built while the gate is ours (live pos)
        } catch (err) {
            return describeFailure(err);
        } finally {
            // Hand control back to BDI; a follow-up command re-takes it above.
            directive.active = false;
            resumeAutonomy?.();
        }
    };

    // Add a Level-3 routine's reward to its running net total (mirrored to the
    // worker) and report whether it is now armed. `field` is the net key
    // ('handoffNet'|'gatherNet'|'lightNet'); reward comes from a pts=N token, absent ⇒
    // 0 (still armed). Armed iff net >= 0, so a later offer can re-arm or disarm.
    const applyRoutineNet = (field, input) => {
        const pts = parseRewardToken(input);
        if (pts != null) {
            const cfg = { [field]: pts };
            applyMissionConfig(cfg);
            sendConstraint('apply', cfg);
        }
        return armedByNet(missionConstraints[field]);
    };

    return {
        ...readTools(),

        // command
        async go_to(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_to needs "x,y" (got '${input}').`;
            // Under PDDL_GOTO, mark this as the go-to target so PddlMove path-plans the
            // leg (PddlMove failure → AStarMove fallback). Cleared once the command settles.
            if (pddlGoto) pddl.gotoTarget = { x, y };
            try {
                return await command(['go_to', x, y], () => `Arrived at (${me.x}, ${me.y}).`);
            } finally {
                pddl.gotoTarget = null;
            }
        },
        async go_pickup(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_pickup needs "x,y" (got '${input}').`;
            const id = resolveParcelId(x, y);
            // Known parcel -> go_pick_up (updates beliefs by id). Unknown -> navigate
            // and try a blind pickup (one may spawn during the walk or be off-snapshot).
            const predicate = id != null ? ['go_pick_up', x, y, id] : ['go_to', x, y];
            return command(predicate, () => {
                const carrying = parcels.carriedBy(me.id).length;
                if (id != null)
                    return `Picked up parcel ${id} at (${x},${y}); now carrying ${carrying}.`;
                return socket.emitPickup().then(picked =>
                    picked?.length
                        ? `Picked up ${picked.length} parcel(s) at (${x},${y}); now carrying ${carrying + picked.length}.`
                        : `Reached (${x},${y}) but no parcel here. To wait for one to spawn: wait(5), sense_parcels, retry.`);
            });
        },
        async pickup_next_parcel() {
            // Release the gate and let the selected BDI strategy hunt — it explores
            // and reacts to sensing in real time (no LLM poll loop can match it). We
            // watch the carried set and re-take control when a NEW parcel id appears.
            if (trafficLight.red)
                return 'Failed: RED LIGHT in force — movement is forbidden until the GREEN LIGHT message.';
            const before = new Set(parcels.carriedBy(me.id).map(p => p.id));
            directive.active = false;
            resumeAutonomy?.();
            while (!directive.aborted) {
                const fresh = parcels.carriedBy(me.id).find(p => !before.has(p.id));
                if (fresh) {
                    directive.active = true;        // take control back from BDI
                    myAgent.haltCurrent();          // it may already be off to deliver
                    return `Picked up parcel ${fresh.id} at (${me.x},${me.y}); now carrying ${parcels.carriedBy(me.id).length}.`;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            return 'Failed: the command was interrupted before completing.';
        },
        async deliver(input) {
            const carrying = parcels.carriedBy(me.id).length;
            if (carrying === 0) return 'Nothing to deliver (not carrying any parcel).';
            // Optional "x,y" → deliver at that tile; else the nearest delivery tile.
            const { x, y } = parseXY(input);
            let t;
            if (x != null) {
                t = deliveryTiles.find(d => d.x === x && d.y === y);
                if (!t) return `Failed: (${x},${y}) is not a delivery tile. Call sense_delivery_tiles to list them.`;
            } else {
                t = nearestDelivery();
                if (!t) return 'Failed: no delivery tile known. Call sense_delivery_tiles first.';
            }
            return command(['go_deliver', t.x, t.y], () =>
                `Delivered at (${t.x},${t.y}); score now ${me.score}.`);
        },
        async put_down() {
            // Drop cargo on the CURRENT tile without navigating. Plain tile = handoff
            // drop (no score); delivery tile = scores.
            const carried = parcels.carriedBy(me.id);
            if (carried.length === 0) return 'Nothing to put down (not carrying any parcel).';
            // Gate autonomy, else BDI resumes on directive end and re-picks the parcel.
            directive.active = true;
            myAgent.haltCurrent();
            // Explicit id list: the SDK default [] is treated as "nothing" by the server.
            const dropped = await withTimeout(
                socket.emitPutdown(carried.map(p => p.id)), 5_000, 'putdown'
            ).catch(() => null);
            if (!dropped || dropped.length === 0)
                return 'Failed: the server did not confirm the drop.';
            for (const p of carried) parcels.remove(p.id);
            return `Dropped ${dropped.length} parcel(s) at (${me.x},${me.y}).`;
        },
        async path_cost(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: path_cost needs "x,y" (got '${input}').`;
            const route = findRoute(me, { x, y });
            if (!route) return `Unreachable: no path from (${me.x},${me.y}) to (${x},${y}).`;
            const steps = route.length;
            return JSON.stringify({
                steps,
                estSeconds: +(steps * moveTiming.msPerTile / 1000).toFixed(1),
                decayLostPerCarriedParcel: +(steps * moveTiming.decayPerTile()).toFixed(1),
            });
        },
        async wait(input) {
            const n = String(input ?? '').match(/-?\d+(\.\d+)?/);
            const secs = Math.max(0, Math.min(MAX_WAIT_SECONDS, n ? parseFloat(n[0]) : 0));
            directive.active = true;                   // hold still (gate held until directive ends)
            myAgent.haltCurrent();
            const elapsed = await abortableDelay(secs * 1000);
            if (directive.aborted)
                return `Wait interrupted after ${(elapsed / 1000).toFixed(1)}s (directive aborted).`;
            return `Waited ${secs} second(s) holding position at (${me.x}, ${me.y}).`;
        },
        async hold() {
            // Indefinite hold: persists AFTER the directive ends (unlike wait), until
            // release_hold. For "go there and wait for each other" missions.
            manualHold.active = true;
            myAgent.haltCurrent();
            return `Holding position at (${me.x}, ${me.y}) indefinitely — use release_hold to resume.`;
        },
        async release_hold() {
            manualHold.active = false;
            // Also unfreeze the worker: a "wait for each other" hold (gather_near)
            // froze it via halt_partner, so a single "resume" must release BOTH.
            // Resuming an already-working worker just re-triggers its deliberation.
            sendResume();
            resumeAutonomy?.();
            return 'Hold released — both agents resumed autonomous work.';
        },
        // chat
        async say(input) {
            const text = String(input ?? '');
            const ok = await safeSay(replySender, text);
            return ok ? `Said to ${replySender}: ${text}`
                      : `Sent to ${replySender ?? 'console'} (delivery not confirmed): ${text}`;
        },

        // partner (worker agent) — orders run on the worker; they don't move this
        // agent, so autonomy is not gated here.
        async order_partner_goto(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: order_partner_goto needs "x,y" (got '${input}').`;
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            return sendOrder(['go_to', x, y]);
        },
        async order_partner_pickup(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: order_partner_pickup needs "x,y" (got '${input}').`;
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            return sendOrder(['go_pick_up', x, y]);
        },
        async order_partner_deliver(input) {
            const { x, y } = parseXY(input);
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            if (x != null) return sendOrder(['go_deliver', x, y]);
            // No coordinates: deliver at the tile nearest the worker's position.
            const wpos = partner.lastStatus ?? me;
            const t = deliveryTiles.length
                ? [...deliveryTiles].sort((a, b) =>
                    (Math.abs(a.x - wpos.x) + Math.abs(a.y - wpos.y)) - (Math.abs(b.x - wpos.x) + Math.abs(b.y - wpos.y)))[0]
                : null;
            if (!t) return 'Failed: no delivery tile known. Call sense_delivery_tiles first.';
            return sendOrder(['go_deliver', t.x, t.y]);
        },
        async order_partner_putdown() {
            return sendOrder(['putdown']);
        },
        async halt_partner()   { return sendHalt(); },
        async resume_partner() { return sendResume(); },
        async ask_partner_status() { return requestStatus(); },

        // Cross-agent handoff ("one picks up, the other delivers"). pts=N reward feeds
        // handoffNet; a net penalty declines and stops any running loop.
        async start_handoff(input) {
            if (!applyRoutineNet('handoffNet', input)) {
                stopHandoff();   // no-op if not running; stops it if a penalty flipped it off
                return 'Mission declined.';
            }
            return startHandoff(myAgent, resumeAutonomy);
        },
        async stop_handoff()  { return stopHandoff(); },

        // Red-light-green-light control. Arm on the admin's ANNOUNCEMENT; only once
        // armed do live RED/GREEN shouts (classified STOP/GO) stop/resume the agents —
        // so a stray "red light" before the mission starts is ignored.
        async start_light_mission(input) {
            // pts=N feeds lightNet; a net penalty declines and disarms.
            if (!applyRoutineNet('lightNet', input)) {
                lightMission.active = false;
                trafficLight.red = false;
                return 'Mission declined.';
            }
            lightMission.active = true;
            return 'Red-light-green-light mission STARTED: live RED LIGHT / GREEN LIGHT shouts will now stop / resume both agents.';
        },
        async stop_light_mission() {
            lightMission.active = false;
            trafficLight.red = false;
            return 'Red-light-green-light mission ended: light shouts no longer affect the agents.';
        },

        // Multiplier missions ("5× pts at (x,y)", "stacks of N for 0.3 reward").
        // Accumulates (mult − 1.0) into multiplierNet; arms when net ≥ 0 and only then
        // applies the Level-2 constraint — so a lone 0.3× is declined, a later 5× re-arms.
        async start_multiplier_mission(input) {
            let config;
            try { config = JSON.parse(String(input ?? '{}')); }
            catch {
                return `Error: expected JSON with "mult" field — e.g. {"mult":5,"deliveryMultipliers":[[1,1,5]]}. Got: ${input}`;
            }
            const mult = Number(config.mult ?? 1);
            if (!Number.isFinite(mult) || mult <= 0)
                return `Error: "mult" must be a positive finite number (got ${config.mult}).`;

            applyAndMirror({ multiplierNet: mult - 1.0 });

            if (!armedByNet(missionConstraints.multiplierNet)) {
                return `Mission declined. Multiplier net: ${missionConstraints.multiplierNet.toFixed(2)}.`;
            }

            // Armed: apply the constraint config (everything except mult itself).
            const { mult: _m, ...constraintConfig } = config;
            if (Object.keys(constraintConfig).length > 0)
                applyAndMirror(constraintConfig);

            return `Mission accepted. Multiplier net: ${missionConstraints.multiplierNet.toFixed(2)}.`;
        },

        // "Move both agents near (x,y) within distance D and wait." Deterministic:
        // enumerate walkable tiles within Manhattan distance D of (x,y) (centre may be
        // a wall), keep reachable ones, assign two DIFFERENT tiles (never each other's
        // current tile), park the worker on one, send B to the other, hold both. The
        // LLM only supplies (x,y[,D]) — it has no tool to enumerate tiles itself.
        async gather_near(input) {
            // Accumulate reward (pts=N) into gatherNet; a net penalty declines and
            // releases any hold this routine set.
            if (!applyRoutineNet('gatherNet', input)) {
                if (manualHold.active) { manualHold.active = false; sendResume(); }
                return 'Mission declined.';
            }
            // Strip pts=N before parsing geometry so the reward isn't read as a coordinate.
            const geom = String(input ?? '').replace(/(?:pts|points)\s*=\s*-?\d+/i, '');
            const nums = geom.match(/-?\d+/g);
            if (!nums || nums.length < 2)
                return `Error: gather_near needs "x,y" or "x,y,distance" (got '${input}').`;
            const cx = parseInt(nums[0], 10), cy = parseInt(nums[1], 10);
            const dist = nums.length >= 3 ? Math.max(1, parseInt(nums[2], 10)) : 3;
            if (trafficLight.red)
                return 'Failed: RED LIGHT in force — movement is forbidden until the GREEN LIGHT message.';
            if (!partner.id)
                return 'Failed: no partner connected — this mission needs both agents in position.';

            // Gate B and stop any in-flight move now, so B waits put while the worker
            // travels (the partner order below is awaited up to 45s).
            directive.active = true;
            myAgent.haltCurrent();

            // Refresh the worker's live position (cached status can be stale; it only
            // streams under an order) so its tile is chosen from where it actually is.
            await requestStatus().catch(() => {});
            const aPos = partner.lastStatus?.x != null
                ? { x: Math.round(partner.lastStatus.x), y: Math.round(partner.lastStatus.y) }
                : null;

            // 1. all walkable tiles within Manhattan distance `dist` of (cx,cy).
            const inRange = walkableTiles.filter(t => Math.abs(t.x - cx) + Math.abs(t.y - cy) <= dist);
            if (inRange.length < 2)
                return `Failed: fewer than two walkable tiles within distance ${dist} of (${cx},${cy}).`;

            // 2. keep only tiles each agent can actually reach (skip walled-off pockets).
            const reachB = reachableFrom(me);
            const candB  = inRange.filter(t => reachB.has(`${t.x}_${t.y}`));
            if (candB.length === 0)
                return `Failed: no tile within distance ${dist} of (${cx},${cy}) is reachable by you.`;
            let candA = inRange;
            if (aPos) {
                const reachA = reachableFrom(aPos);
                const f = inRange.filter(t => reachA.has(`${t.x}_${t.y}`));
                if (f.length) candA = f;   // fall back to all in-range if the worker reaches none
            }

            // 3. pick two DIFFERENT tiles, neither being the other agent's current tile.
            const meKey = `${Math.round(me.x)}_${Math.round(me.y)}`;
            const aKey  = aPos ? `${aPos.x}_${aPos.y}` : null;
            const nearestTo = p => (a, b) =>
                (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y));
            const tileB = [...candB].filter(t => `${t.x}_${t.y}` !== aKey).sort(nearestTo(me))[0];
            if (!tileB) return `Failed: no reachable tile for you within distance ${dist} of (${cx},${cy}).`;
            const tileA = [...candA]
                .filter(t => !(t.x === tileB.x && t.y === tileB.y) && `${t.x}_${t.y}` !== meKey)
                .sort(nearestTo(aPos ?? { x: cx, y: cy }))[0];
            if (!tileA)
                return `Failed: only one distinct tile is available within distance ${dist} of (${cx},${cy}); need two.`;

            // 4. park the worker first (halt so it stays put), then move B, then hold
            //    both. Worker first so it vacates any tile B is heading for.
            sendHalt();
            const aRes = await sendOrder(['go_to', tileA.x, tileA.y]);
            if (directive.aborted) return null;            // abort handler already replied

            // Coordinator's leg. Under PDDL_GATHER, hand PDDL the WHOLE candidate ring
            // (reachable by B, minus the worker's tile) and let the PLANNER pick which tile
            // to occupy — tile selection moves from JS into PDDL. JS's tileB stays as the
            // A* fallback target if the solver fails. Without the flag: A* to tileB as before.
            let bTile = tileB;
            if (pddlGather) {
                const nearKeys = candB
                    .map(t => `${t.x}_${t.y}`)
                    .filter(k => k !== `${tileA.x}_${tileA.y}`);
                try {
                    const { PddlMove } = await import('../plans/PddlMove.js');
                    await new PddlMove(null).runToGatherSpot(nearKeys);
                    bTile = { x: Math.round(me.x), y: Math.round(me.y) };  // wherever PDDL landed
                } catch (err) {
                    log(`gather PDDL failed (${describeFailure(err)}) — A* fallback to (${tileB.x},${tileB.y})`);
                    try {
                        await withTimeout(myAgent.commandAndAwait(['go_to', tileB.x, tileB.y]), COMMAND_TIMEOUT_MS, 'go_to');
                    } catch (e2) {
                        return `Partner ordered to (${tileA.x},${tileA.y}) [${aRes}], but I could not reach a gather tile: ${describeFailure(e2)}`;
                    }
                }
            } else {
                try {
                    await withTimeout(myAgent.commandAndAwait(['go_to', tileB.x, tileB.y]), COMMAND_TIMEOUT_MS, 'go_to');
                } catch (err) {
                    return `Partner ordered to (${tileA.x},${tileA.y}) [${aRes}], but I could not reach (${tileB.x},${tileB.y}): ${describeFailure(err)}`;
                }
            }
            manualHold.active = true;                      // B holds indefinitely (survives directive end)
            myAgent.haltCurrent();
            return `Both agents in position within distance ${dist} of (${cx},${cy}): you at (${bTile.x},${bTile.y}), partner at (${tileA.x},${tileA.y}) [${aRes}]. Both holding — say "resume" to release.`;
        },

        // Level-2 persistent missions. Mutation logic lives in missionState.js (shared
        // with the worker); every change is mirrored so missions bind BOTH agents.
        async apply_mission(input) {
            let config;
            try { config = JSON.parse(String(input ?? '{}')); }
            catch { return `Error: expected JSON — e.g. {"requiredStackSize":3}. Got: ${input}`; }

            const obs = applyMissionConfig(config);
            sendConstraint('apply', config);
            return obs;
        },

        async dropMissions() {
            const obs = dropAllMissions();
            sendConstraint('dropAll');
            return obs;
        },

        async restrict_exploration(input) {
            const zone = String(input ?? '').trim().toLowerCase();
            if (!['left', 'right', 'top', 'bottom'].includes(zone))
                return `Error: unknown zone '${zone}'. Use: left, right, top, bottom.`;
            if (!spawnerTiles.length) return 'Error: spawner tiles not loaded yet.';
            const xs  = walkableTiles.map(t => t.x), ys = walkableTiles.map(t => t.y);
            const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
            const FILTERS = {
                left:   t => t.x <= midX,
                right:  t => t.x >  midX,
                top:    t => t.y >  midY,
                bottom: t => t.y <= midY,
            };
            const filtered = spawnerTiles.filter(FILTERS[zone]);
            if (!filtered.length) return `Error: no spawner tiles found in the ${zone} half.`;
            applyMissionConfig({
                allowedSpawnerTiles: filtered.map(t => [t.x, t.y]),
                description: `explore only ${zone}-half spawners`,
            });
            sendConstraint('apply', {
                allowedSpawnerTiles: filtered.map(t => [t.x, t.y]),
                description: `explore only ${zone}-half spawners`,
            });
            return `Spawner zone restricted to ${zone} half (${filtered.length} spawners).`;
        },

        // Deterministic "don't deliver here" executor (penalty / 0-pts / never deliver
        // in ...). Resolves a side keyword or coordinates to real tiles and excludes
        // them by narrowing allowedDeliveryTiles — the LLM never does the arithmetic.
        async forbid_delivery(input) {
            const raw = String(input ?? '').trim();
            if (!raw)
                return 'Error: forbid_delivery needs a side keyword (leftmost|rightmost|top|bottom) or coordinates ("x,y", or a ";"-separated list).';
            if (!deliveryTiles.length) return 'Error: delivery tiles not loaded yet.';

            const SIDES = ['leftmost', 'rightmost', 'top', 'bottom'];
            const side  = raw.toLowerCase();
            let forbidden; // array of {x,y} delivery tiles to exclude

            if (SIDES.includes(side)) {
                // Named edges over the FULL deliveryTiles: leftmost=min x, rightmost=max
                // x, top=max y, bottom=min y. Ties → every tile at that extreme.
                const xs = deliveryTiles.map(t => t.x), ys = deliveryTiles.map(t => t.y);
                const PICK = {
                    leftmost:  { val: Math.min(...xs), key: t => t.x },
                    rightmost: { val: Math.max(...xs), key: t => t.x },
                    top:       { val: Math.max(...ys), key: t => t.y },
                    bottom:    { val: Math.min(...ys), key: t => t.y },
                }[side];
                forbidden = deliveryTiles.filter(t => PICK.key(t) === PICK.val);
            } else {
                // Explicit coordinates: "x,y" or a ";"-separated list of them.
                forbidden = [];
                for (const part of raw.split(';').map(s => s.trim()).filter(Boolean)) {
                    const { x, y } = parseXY(part);
                    if (x == null)
                        return `Error: '${part}' is not a coordinate. Use "x,y", a ";"-separated list, or a side keyword (leftmost|rightmost|top|bottom).`;
                    if (!deliveryTiles.some(d => d.x === x && d.y === y))
                        return `Error: (${x},${y}) is not a delivery tile. Call sense_delivery_tiles to list them.`;
                    forbidden.push({ x, y });
                }
                if (!forbidden.length) return 'Error: no coordinates parsed.';
            }

            const forbiddenKeys = new Set(forbidden.map(t => `${t.x}_${t.y}`));
            // Subtract from the CURRENT allowed set (or all tiles if none yet), so
            // repeated forbids stack instead of clobbering.
            const baseAllowed = missionConstraints.allowedDeliveryTiles?.size > 0
                ? [...missionConstraints.allowedDeliveryTiles]
                : deliveryTiles.map(t => `${t.x}_${t.y}`);
            const newAllowedKeys = baseAllowed.filter(k => !forbiddenKeys.has(k));

            const resolved = [...forbiddenKeys].map(k => `(${k.replace('_', ',')})`).join(', ');
            // Guard: never strand the agent with zero deliverable tiles.
            if (!newAllowedKeys.length)
                return `Error: forbidding ${resolved} would leave NO delivery tile available — refusing so the agent isn't stranded. Report that the mission cannot be satisfied.`;

            const newAllowed   = newAllowedKeys.map(k => k.split('_').map(Number));
            const sideLabel    = SIDES.includes(side) ? `${side} delivery tile ` : '';
            // Coordinate-bearing description so conversational recall can name the tiles.
            const description  = `never deliver in ${sideLabel}${resolved}`;
            applyMissionConfig({ allowedDeliveryTiles: newAllowed, description });
            sendConstraint('apply', { allowedDeliveryTiles: newAllowed, description });
            return `Delivery forbidden at ${resolved}. Allowed delivery tiles now: ${newAllowed.map(([x, y]) => `(${x},${y})`).join(', ')}.`;
        },

        async dropMission(input) {
            const { ok, label, observation } = dropMissionField(input);
            if (!ok) return observation;
            sendConstraint('drop', input);
            return observation;
        },
    };
}
