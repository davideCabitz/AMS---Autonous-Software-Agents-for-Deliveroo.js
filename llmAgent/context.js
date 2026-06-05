import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/*
 * Standalone LLM-agent context.
 *
 * Intentionally independent of myAgent/context.js: the BDI loop reacts to every
 * onYou/onSensing event by pushing its own intention, which would fight the LLM
 * for control of the same socket. Here we keep our own socket + a minimal belief
 * snapshot that the tools and the prompt read from. Run this agent INSTEAD of the
 * BDI agent (same TOKEN), not alongside it.
 */

export const socket = DjsConnect();              // HOST / TOKEN / NAME from .env

/** Self-state. Coordinates are rounded to the tile grid (server reports
 *  fractional values mid-move; we never let those leak into the prompt). */
export const me = { id: null, name: null, x: null, y: null, score: 0 };

/** Live parcel beliefs: id -> { id, x, y, reward, carriedBy }. */
export const parcels = new Map();

/** Delivery tiles ({x,y}) — static, taken from the map once on connect. */
export const deliveryTiles = [];

/** Resolves once the server has sent our identity (id known). */
export const ready = new Promise(resolve => {
    socket.onceYou(() => resolve());
});

socket.onYou(you => {
    me.id    = you.id   ?? me.id;
    me.name  = you.name ?? me.name;
    if (you.x != null) me.x = Math.round(you.x);
    if (you.y != null) me.y = Math.round(you.y);
    me.score = you.score ?? me.score;
});

socket.onMap((_w, _h, tiles) => {
    deliveryTiles.length = 0;
    deliveryTiles.push(
        ...tiles
            .filter(t => t.delivery || t.type === '2' || t.type === 2)
            .map(t => ({ x: t.x, y: t.y }))
    );
    console.log(`[ctx] map loaded — ${deliveryTiles.length} delivery tile(s)`);
});

socket.onSensing(sensing => {
    const sensed = sensing.parcels ?? [];
    // Refresh the snapshot from what we currently see. Carried-by-us parcels are
    // kept so a delivery objective doesn't lose track of its cargo mid-trip when
    // the parcel stops being reported (it's on our own tile).
    const seenIds = new Set(sensed.map(p => p.id));
    for (const p of sensed) parcels.set(p.id, p);
    for (const [id, p] of parcels)
        if (!seenIds.has(id) && p.carriedBy !== me.id) parcels.delete(id);
});
