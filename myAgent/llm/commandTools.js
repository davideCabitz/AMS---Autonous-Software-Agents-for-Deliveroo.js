import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles } from '../context.js';
import { reachableFrom } from '../utils/astar.js';

/*
 * Tool catalogue for the LLM command layer. Every tool returns a STRING
 * observation (including failures) so the ReAct loop can reason about the result.
 *
 * Three kinds of tools:
 *  - reasoning (pure): calculate, get_current_time — no world effect.
 *  - read: get_my_position, sense_parcels, sense_delivery_tiles — read beliefs.
 *  - command: go_to, go_pickup, deliver — push a BDI intention and AWAIT its
 *    completion (the BDI plan library does the actual A-star/PDDL navigation). There
 *    is deliberately NO raw move/pick_up actuator: the LLM commands, BDI executes.
 *  - chat: say — reply to the directive sender.
 */

// Safety net: a wedged navigation must never hang the ReAct loop forever.
const COMMAND_TIMEOUT_MS = 60_000;
// Cap on the wait tool so a bad number can't freeze the agent indefinitely.
const MAX_WAIT_SECONDS = 30;

// ---- reasoning tools (copied from llmAgent/tools.js; that module must NOT be
// imported because it opens a second socket via its own context.js) ------------

function calculate(expression) {
    const expr = String(expression ?? '').trim();
    if (!/^[\d\s+\-*/().]+$/.test(expr))
        return `Error: invalid expression '${expression}'. Only numbers and + - * / ( ) are allowed.`;
    try {
        const result = Function(`"use strict"; return (${expr});`)();
        if (typeof result !== 'number' || !Number.isFinite(result))
            return `Error: '${expr}' did not evaluate to a finite number.`;
        return String(result);
    } catch (err) {
        return `Error: ${err.message}`;
    }
}

function get_current_time(location) {
    const where = String(location ?? 'Rome').trim() || 'Rome';
    const timezone = 'Europe/Rome';
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    return JSON.stringify({ location: where, timezone, time });
}

// ---- helpers ------------------------------------------------------------------

/** Parse "5,3" / "(5, 3)" / "x=5 y=3" / "5 3" into {x,y} (numbers) or {x:null}. */
function parseXY(input) {
    const nums = String(input ?? '').match(/-?\d+/g);
    if (!nums || nums.length < 2) return { x: null, y: null };
    return { x: parseInt(nums[0], 10), y: parseInt(nums[1], 10) };
}

/** A known free parcel sitting on (x,y), highest reward first; null if none. */
function resolveParcelId(x, y) {
    const here = parcels.free().filter(p => Math.round(p.x) === x && Math.round(p.y) === y);
    if (!here.length) return null;
    return here.sort((a, b) => b.reward - a.reward)[0].id;
}

/** Keep only tiles the agent can actually reach from its current position, so
 *  "leftmost/rightmost/nearest X" directives never resolve to a walled-off tile.
 *  Falls back to the full list if nothing is reachable (so a tool never lies by
 *  returning empty when tiles do exist). */
function onlyReachable(tiles) {
    const reach = reachableFrom(me);
    const filtered = tiles.filter(t => reach.has(`${t.x}_${t.y}`));
    return filtered.length ? filtered : tiles;
}

/** Nearest delivery tile to the agent (Manhattan), or null if none known. */
function nearestDelivery() {
    if (!deliveryTiles.length) return null;
    return deliveryTiles
        .map(t => ({ t, d: Math.abs(t.x - me.x) + Math.abs(t.y - me.y) }))
        .sort((a, b) => a.d - b.d)[0].t;
}

function withTimeout(promise, ms, tag) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout', tag]), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Map an intention rejection tag to a readable observation. */
function describeFailure(err) {
    const tag = Array.isArray(err) ? err[0] : err;
    switch (tag) {
        case 'stopped':      return 'Failed: the command was interrupted before completing.';
        case 'no path to':   return `Failed: target (${err[1]},${err[2]}) is unreachable (no path).`;
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

export function buildTools(myAgent, replySender) {
    // Push a BDI intention, await completion, return ok() string or a failure string.
    const command = (predicate, ok) =>
        withTimeout(myAgent.commandAndAwait(predicate), COMMAND_TIMEOUT_MS, predicate[0])
            .then(() => ok())
            .catch(err => describeFailure(err));

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
            // Report only reachable tiles so edges are the reachable extremes.
            const reach = onlyReachable(walkableTiles);
            const xs = reach.map(t => t.x);
            const ys = reach.map(t => t.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const at = (pred) => reach.filter(pred).map(t => ({ x: t.x, y: t.y }));
            // Reachable tiles on each extreme, so "leftmost/rightmost/top/bottom tile"
            // directives resolve to a real tile the agent can get to, not a guess.
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

        // command
        async go_to(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_to needs "x,y" (got '${input}').`;
            return command(['go_to', x, y], () => `Arrived at (${me.x}, ${me.y}).`);
        },
        async go_pickup(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_pickup needs "x,y" (got '${input}').`;
            const id = resolveParcelId(x, y);
            // Known parcel -> proper go_pick_up (updates beliefs by id). Unknown ->
            // just navigate there and report, so the LLM can sense + retry.
            const predicate = id != null ? ['go_pick_up', x, y, id] : ['go_to', x, y];
            return command(predicate, () => {
                if (id == null)
                    return `Reached (${x},${y}) but no known parcel there. Call sense_parcels and retry.`;
                const carrying = parcels.carriedBy(me.id).length;
                return `Picked up parcel ${id} at (${x},${y}); now carrying ${carrying}.`;
            });
        },
        async deliver() {
            const carrying = parcels.carriedBy(me.id).length;
            if (carrying === 0) return 'Nothing to deliver (not carrying any parcel).';
            const t = nearestDelivery();
            if (!t) return 'Failed: no delivery tile known. Call sense_delivery_tiles first.';
            return command(['go_deliver', t.x, t.y], () =>
                `Delivered at (${t.x},${t.y}); score now ${me.score}.`);
        },
        async wait(input) {
            const n = String(input ?? '').match(/-?\d+(\.\d+)?/);
            const secs = Math.max(0, Math.min(MAX_WAIT_SECONDS, n ? parseFloat(n[0]) : 0));
            // Halt any in-flight movement so the agent genuinely holds position
            // (the autonomy gate only blocks NEW autonomous goals, not a running one).
            myAgent.haltCurrent();
            await new Promise(resolve => setTimeout(resolve, secs * 1000));
            return `Waited ${secs} second(s) holding position at (${me.x}, ${me.y}).`;
        },

        // chat
        async say(input) {
            const text = String(input ?? '');
            if (replySender) await socket.emitSay(replySender, text);
            return `Said to ${replySender ?? 'console'}: ${text}`;
        },
    };
}
