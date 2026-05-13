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

    walkableTiles.length = 0;
    walkableTiles.push(...tiles.filter(t =>
        t.walkable !== false && t.type !== '0' && t.type !== 0
    ));

    console.log(`[map] delivery: ${deliveryTiles.length} | spawners: ${spawnerTiles.length} | walkable: ${walkableTiles.length}`);

    // We build the beliefeset for the PDDL solver for now. Must be updated on each map event since the solver doesn't have direct access to the map data structure.
    beliefset = new Beliefset();
    const walkSet  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const delivSet = new Set(deliveryTiles.map(t => `${t.x}_${t.y}`));

    for (const { x, y } of walkableTiles) {
        const t = `${x}_${y}`;
        beliefset.declare(`tile ${t}`);
        if (delivSet.has(t))                      beliefset.declare(`delivery ${t}`);
        if (walkSet.has(`${x + 1}_${y}`))         beliefset.declare(`right ${t} ${x + 1}_${y}`);
        if (walkSet.has(`${x - 1}_${y}`))         beliefset.declare(`left ${t} ${x - 1}_${y}`);
        if (walkSet.has(`${x}_${y + 1}`))         beliefset.declare(`up ${t} ${x}_${y + 1}`);
        if (walkSet.has(`${x}_${y - 1}`))         beliefset.declare(`down ${t} ${x}_${y - 1}`);
    }

    console.log(`[map] beliefset: ${beliefset.objects.length} objects`);
});
