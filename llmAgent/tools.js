import { socket, me, parcels, deliveryTiles } from './context.js';

/*
 * Tool catalogue. Every tool is an async function that returns a STRING
 * observation (including failures) so the ReAct loop can reason about the
 * outcome. The LLM only ever names a tool; the runtime executes it here.
 *
 * Single-step movement: the LLM drives the agent tile-by-tile through the loop,
 * which mirrors how lab8's DeliverooJS agent works and keeps the model in the
 * sensing/acting cycle of a partially observable game.
 */

const DIRECTIONS = ['up', 'down', 'left', 'right'];

async function move(direction) {
    const d = String(direction).trim().toLowerCase();
    if (!DIRECTIONS.includes(d))
        return `Error: invalid direction '${direction}'. Valid: up, down, left, right.`;
    const res = await socket.emitMove(d);          // {x,y} on success, false if blocked
    return res
        ? `Moved ${d}. Now at (${res.x}, ${res.y}).`
        : `Failed: move ${d} blocked (wall, edge, or another agent).`;
}

async function pick_up() {
    const picked = await socket.emitPickup();      // array of {id}
    const n = picked?.length ?? 0;
    return n > 0
        ? `Picked up ${n} parcel(s): ${picked.map(p => p.id).join(', ')}.`
        : 'Nothing to pick up on this tile.';
}

async function put_down() {
    const dropped = await socket.emitPutdown();    // array of {id}
    const n = dropped?.length ?? 0;
    if (n === 0) return 'Nothing to put down (not carrying anything).';
    const onDelivery = deliveryTiles.some(t => t.x === me.x && t.y === me.y);
    return `Put down ${n} parcel(s)${onDelivery ? ' on a delivery tile (scored!)' : ' (NOT on a delivery tile, no points)'}.`;
}

async function get_my_position() {
    if (me.x == null || me.y == null) return 'Position not available yet.';
    return JSON.stringify({ x: me.x, y: me.y, score: me.score });
}

async function sense_parcels() {
    const free = [...parcels.values()].filter(p => !p.carriedBy);
    if (free.length === 0) return 'No free parcels currently in view.';
    return JSON.stringify(
        free.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward }))
    );
}

async function sense_delivery_tiles() {
    if (deliveryTiles.length === 0) return 'No delivery tiles known yet.';
    return JSON.stringify(deliveryTiles);
}

/*
 * General-purpose tools from the lab tutorial (steps 3–6). They let the agent
 * solve mixed objectives such as "go to x+2, y-3" or "extract the hour in Rome,
 * subtract 10, and move up by the result" — the Step 9 exercises.
 */

// Safe arithmetic evaluator. The tutorial uses raw eval() but warns it is unsafe
// (step 3 exercise); we whitelist characters so only arithmetic can run. Results
// still use JS Number, so huge products lose precision — that is the intended
// lesson of the "377834873478 * 974829994" exercise.
async function calculate(expression) {
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

// Tutorial scope is Rome/Roma; we return the current Europe/Rome time as a
// parseable HH:MM:SS field so the model can extract the hour.
async function get_current_time(location) {
    const where = String(location ?? 'Rome').trim() || 'Rome';
    const timezone = 'Europe/Rome';
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    return JSON.stringify({ location: where, timezone, time });
}

export const TOOLS = {
    move,
    pick_up,
    put_down,
    get_my_position,
    sense_parcels,
    sense_delivery_tiles,
    calculate,
    get_current_time,
};
