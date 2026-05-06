import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import { Me }      from './beliefs/Me.js';
import { Parcels } from './beliefs/Parcels.js';

export const socket  = DjsConnect();
export const me      = new Me();
export const parcels = new Parcels();

/**
 * Tile type reference (from IOTile.js):
 *   '0' = wall   '1' = parcel spawner   '2' = delivery
 *   '3' = plain walkable   '4' = base   '5' / '5!' = crate tiles
 *   '←' '↑' '→' '↓' = directional
 */

/** Delivery zones — agent scores by stepping here while carrying parcels. */
export const deliveryTiles = [];

/** Parcel spawner tiles — parcels appear here. */
export const spawnerTiles = [];

/** All non-wall tiles — used for exploration. */
export const walkableTiles = [];

export let OBSERVATION_DISTANCE = 5;

socket.onConfig(config => {
    OBSERVATION_DISTANCE = config.GAME.player.observation_distance;
});

socket.onMap((_w, _h, tiles) => {
    deliveryTiles.length = 0;
    deliveryTiles.push(...tiles.filter(t => t.type === '2'));
    console.log('[map] delivery tiles:', deliveryTiles.length);

    spawnerTiles.length = 0;
    spawnerTiles.push(...tiles.filter(t => t.type === '1'));
    console.log('[map] spawner tiles:', spawnerTiles.length);

    walkableTiles.length = 0;
    walkableTiles.push(...tiles.filter(t => t.type !== '0'));
    console.log('[map] walkable tiles:', walkableTiles.length);
});
