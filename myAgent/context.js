import 'dotenv/config';
import { DjsConnect }  from '@unitn-asa/deliveroo-js-sdk/client';
import { Beliefset }   from '@unitn-asa/pddl-client';
import { Me }          from './beliefs/Me.js';
import { Parcels }     from './beliefs/Parcels.js';

export const socket  = DjsConnect();
export const me      = new Me();
export const parcels = new Parcels();
export const deliveryTiles = [];
export const spawnerTiles  = [];
export const walkableTiles = [];
/* Crates currently sensed on the map. These are movable obstacles the PDDL
 * planner may push aside (see PddlMove). Populated from `sensing.crates`. */
export const crateTiles    = [];
/* Static crate tiles from the map ('5!' crate spawner, '5' sliding tile).
 * Decided once in onMap: if the map has none, crates can never appear, so we
 * skip crate sensing and PddlMove entirely (never pay the online-solver cost). */
export const crateSpawnerTiles = [];
export let   mapHasCrates      = false;

/* For PDDL beliefset, we maintain a single global instance that we update on each map event. */
export let beliefset = new Beliefset();

export let OBSERVATION_DISTANCE   = 5;
export let DECAY_STEPS_PER_REWARD = 10;
export let MOVEMENT_DURATION      = 100; // Time per step

const DECAY_EVENT_MS = {
    'frame': 50, '1s': 1000, '2s': 2000,
    '5s': 5000, '10s': 10000, 'infinite': Infinity
};

socket.onConfig(config => {
    OBSERVATION_DISTANCE = config.GAME.player.observation_distance;
    MOVEMENT_DURATION    = config.GAME.player.movement_duration ?? 100;

    const decayMs          = DECAY_EVENT_MS[config.GAME.parcels.decaying_event] ?? 1000;
    DECAY_STEPS_PER_REWARD = decayMs / MOVEMENT_DURATION;

    console.log(`[config] obs=${OBSERVATION_DISTANCE} move=${MOVEMENT_DURATION}ms decay_step=${DECAY_STEPS_PER_REWARD.toFixed(1)}`);
});

socket.onMap((_w, _h, tiles) => {
    console.log('[map] sample tile:', JSON.stringify(tiles[0]));

    deliveryTiles.length = 0;
    deliveryTiles.push(...tiles.filter(t =>
        t.delivery || t.type === '2' || t.type === 2
    ));

    spawnerTiles.length = 0;
    spawnerTiles.push(...tiles.filter(t =>
        t.parcelSpawner || t.type === '1' || t.type === 1
    ));

    // Cascade gate: does this map have any crate infrastructure at all?
    // Check both string and numeric types — the server may send either form.
    crateSpawnerTiles.length = 0;
    crateSpawnerTiles.push(...tiles.filter(t =>
        t.crateSpawner || t.type === '5!' || t.type === '5' || t.type === 5
    ));
    mapHasCrates = crateSpawnerTiles.length > 0;
    console.log(`[map] mapHasCrates=${mapHasCrates} (${crateSpawnerTiles.length} crate tiles)`);

    walkableTiles.length = 0;
    walkableTiles.push(...tiles.filter(t =>
        t.walkable !== false && t.type !== '0' && t.type !== 0
    ));

    console.log(`[map] delivery: ${deliveryTiles.length} | spawners: ${spawnerTiles.length} | crateTiles: ${crateSpawnerTiles.length} | walkable: ${walkableTiles.length}`);

    // We build the beliefeset for the PDDL solver for now. Must be updated on each map event since the solver doesn't have direct access to the map data structure.
    beliefset = new Beliefset();
    const walkSet  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const delivSet = new Set(deliveryTiles.map(t => `${t.x}_${t.y}`));

    // PDDL object names must start with a letter (a leading digit is tokenized as a
    // number by the solver), so map tiles are named t<x>_<y>.
    for (const { x, y } of walkableTiles) {
        const t = `t${x}_${y}`;
        beliefset.declare(`tile ${t}`);
        if (delivSet.has(`${x}_${y}`))            beliefset.declare(`delivery ${t}`);
        if (walkSet.has(`${x + 1}_${y}`))         beliefset.declare(`right ${t} t${x + 1}_${y}`);
        if (walkSet.has(`${x - 1}_${y}`))         beliefset.declare(`left ${t} t${x - 1}_${y}`);
        if (walkSet.has(`${x}_${y + 1}`))         beliefset.declare(`up ${t} t${x}_${y + 1}`);
        if (walkSet.has(`${x}_${y - 1}`))         beliefset.declare(`down ${t} t${x}_${y - 1}`);
    }

    console.log(`[map] beliefset: ${beliefset.objects.length} objects`);
});

socket.onSensing(sensing => {
    // Fallback: if map detection missed crate tiles (type format mismatch) but
    // sensing actually sees crates, enable crate mode now so nothing is skipped.
    if (!mapHasCrates && sensing.crates?.length > 0) {
        mapHasCrates = true;
        console.log('[sensing] crates detected via sensing — enabling crate mode');
    }
    if (!mapHasCrates) return;
    // Track sensed crates (movable obstacles). PddlMove only runs when this is
    // non-empty, so we never pay the online-solver round-trip with no crate to push.
    crateTiles.length = 0;
    if (sensing.crates) crateTiles.push(...sensing.crates);
});
