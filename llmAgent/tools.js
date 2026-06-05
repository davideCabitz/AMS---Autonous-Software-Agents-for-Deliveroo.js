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

export const TOOLS = {
    move,
    pick_up,
    put_down,
    get_my_position,
    sense_parcels,
    sense_delivery_tiles,
};
