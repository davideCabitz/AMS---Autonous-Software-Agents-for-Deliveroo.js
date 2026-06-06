import 'dotenv/config';
import { DjsConnect }  from '@unitn-asa/deliveroo-js-sdk/client';
import { Beliefset }   from '@unitn-asa/pddl-client';
import { Me }          from './beliefs/Me.js';
import { Parcels }     from './beliefs/Parcels.js';
import { isDirectional } from './utils/directions.js';

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

/* Other agents currently sensed (excluding self), as {x,y} (rounded). Treated as
 * impassable obstacles by A* (see utils/astar.js). Fully replaced each sensing
 * event — agents move, so stale positions must not linger. */
export const otherAgents = [];

/* Directional ("arrow") tiles sensed on the map, keyed "x_y" -> arrow char
 * ('↑'|'→'|'↓'|'←'). A* and the PDDL edge generator consult this to avoid
 * planning an illegal entry (entering opposite the arrow). See utils/directions.js. */
export const directionalTiles = new Map();

/* Shared PDDL execution state. PddlMove sets busy=true once a plan is found and
 * executing; IntentionRevisionReplace refuses to stop the current intention while
 * busy is true, ensuring the full macro-plan (including crate pushes) runs to
 * completion before the agent switches to a new goal. */
export const pddl = { busy: false };

/* For PDDL beliefset, we maintain a single global instance that we update on each map event. */
export let beliefset = new Beliefset();

export let OBSERVATION_DISTANCE   = 5;
export let DECAY_STEPS_PER_REWARD = 10;
export let MOVEMENT_DURATION      = 100; // Time per step
/* Max parcels the agent can carry at once (server config player.capacity).
 * Default Infinity ⇒ no cap when the config omits it (behaviour unchanged). */
export let CARRYING_CAPACITY      = Infinity;

const DECAY_EVENT_MS = {
    'frame': 50, '1s': 1000, '2s': 2000,
    '5s': 5000, '10s': 10000, 'infinite': Infinity
};

/* Decay interval in ms (how often the server drops 1 reward point), from config.
 * Infinity ⇒ parcels never decay. Used together with the *measured* time-per-tile
 * to compute the real decay rate (see moveTiming below). */
export let DECAY_INTERVAL_MS = 1000;

/* Empirically-measured real time per tile.
 *
 * The scoring needs to know how much reward a parcel loses while we walk to it,
 * and decay is wall-clock based (1 point per DECAY_INTERVAL_MS). Pacing is left
 * to the server's movement_duration (emitMove resolves only when the move
 * completes), so the real cost of a tile is movement_duration plus network
 * latency, replanning and blocked-tile waits. We time each real emitMove cycle
 * and keep an exponential moving average; `msPerTile` starts at MOVEMENT_DURATION
 * and converges to the true value as the agent moves. */
export const moveTiming = {
    msPerTile: MOVEMENT_DURATION,
    _alpha: 0.2,                       // EMA weight for the newest sample
    record(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        // Ignore absurd samples (long stalls/blocks) so one freeze doesn't poison
        // the average; those are handled as outliers, not the steady-state pace.
        if (ms > 10 * MOVEMENT_DURATION) return;
        this.msPerTile = this._alpha * ms + (1 - this._alpha) * this.msPerTile;
    },
    /** Reward lost per parcel per tile travelled (0 when parcels never decay). */
    decayPerTile() {
        return Number.isFinite(DECAY_INTERVAL_MS) && DECAY_INTERVAL_MS > 0
            ? this.msPerTile / DECAY_INTERVAL_MS
            : 0;
    },
};

socket.onConfig(config => {
    // Dump the raw config once so the exact runtime shape is visible in the log.
    console.log('[config] raw:', JSON.stringify(config));

    // The config has been seen in two shapes depending on SDK/server version:
    // nested under GAME (config.GAME.player.*) or flat at the root (config.player.*).
    // Reading the previous hard-coded GAME path threw when GAME was absent, which
    // aborted the whole handler and silently left every value at its default
    // (that's why movement_duration stuck at 100 when the server sent 50).
    const game   = config?.GAME ?? config;
    const player = game?.player ?? config?.player ?? {};
    const parcelCfg = game?.parcels ?? config?.parcels ?? {};

    OBSERVATION_DISTANCE = player.observation_distance ?? OBSERVATION_DISTANCE;
    MOVEMENT_DURATION    = player.movement_duration ?? game?.movement_duration ?? MOVEMENT_DURATION;
    CARRYING_CAPACITY    = player.capacity ?? CARRYING_CAPACITY;

    const decayMs          = DECAY_EVENT_MS[parcelCfg.decaying_event] ?? 1000;
    DECAY_INTERVAL_MS      = decayMs;
    DECAY_STEPS_PER_REWARD = decayMs / MOVEMENT_DURATION;
    // Reset the measured pace to the server's movement_duration whenever config
    // changes; it re-converges to the real per-tile cost as the agent moves.
    moveTiming.msPerTile   = MOVEMENT_DURATION;

    console.log(`[config] obs=${OBSERVATION_DISTANCE} move=${MOVEMENT_DURATION}ms decayInterval=${decayMs}ms decay_step=${DECAY_STEPS_PER_REWARD.toFixed(1)} capacity=${CARRYING_CAPACITY}`);
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
    walkableTiles.push(...tiles.filter(t => {
        if (t.type === '0' || t.type === 0) return false;           // wall — always exclude
        if (t.type === '5!' || t.type === '5' || t.type === 5) return true; // crate zone — always include (server may mark walkable:false when a crate is on it, but the PDDL planner needs these tiles for push planning)
        return t.walkable !== false;
    }));

    // Directional arrow tiles: record type by coordinate so pathfinding and the
    // PDDL edge generator can enforce the one-way entry rule.
    directionalTiles.clear();
    for (const t of walkableTiles)
        if (isDirectional(t.type)) directionalTiles.set(`${t.x}_${t.y}`, t.type);

    console.log(`[map] delivery: ${deliveryTiles.length} | spawners: ${spawnerTiles.length} | crateTiles: ${crateSpawnerTiles.length} | walkable: ${walkableTiles.length} | directional: ${directionalTiles.size}`);

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

// Primary crate tracking via server events (global, not range-limited).
socket.on('crate', (action, { x, y }) => {
    if (!mapHasCrates) return;
    const rx = Math.round(x), ry = Math.round(y);
    if (action === 'create') {
        if (!crateTiles.some(c => Math.round(c.x) === rx && Math.round(c.y) === ry))
            crateTiles.push({ x: rx, y: ry });
        console.log(`[crate] appeared at ${rx}_${ry} | total: ${crateTiles.length}`);
    } else if (action === 'dispose') {
        const idx = crateTiles.findIndex(c => Math.round(c.x) === rx && Math.round(c.y) === ry);
        if (idx !== -1) crateTiles.splice(idx, 1);
        console.log(`[crate] removed at ${rx}_${ry} | total: ${crateTiles.length}`);
    }
});

socket.onSensing(sensing => {
    // Other agents are obstacles for A*. Full replace (not merge): agents move, so
    // a stale position would wrongly block a tile. Runs before any crate-related
    // early-return below so agent tracking is independent of mapHasCrates.
    otherAgents.length = 0;
    for (const a of sensing.agents ?? []) {
        if (a.id === me.id) continue;
        otherAgents.push({ x: Math.round(a.x), y: Math.round(a.y) });
    }
    if (otherAgents.length)
        console.log(`[sensing] agents: ${otherAgents.length} at [${otherAgents.map(a => `${a.x},${a.y}`).join(' ')}]`);

    if (sensing.crates?.length) console.log('[sensing] crates in range:', JSON.stringify(sensing.crates));
    if (!mapHasCrates) {
        if (sensing.crates?.length > 0) {
            mapHasCrates = true;
            console.log('[sensing] crates detected via sensing — enabling crate mode');
        } else return;
    }
    if (!sensing.crates?.length) return;
    // Merge: add newly sensed crates without clearing inferred ones.
    // Inferred crates (from physical blocks) may be outside sensing range —
    // clearing them here causes the blocked→infer→clear→blocked loop.
    // Removal only happens via socket 'dispose' events or when the agent
    // successfully walks through a tile (see astar.js).
    for (const c of sensing.crates) {
        const rx = Math.round(c.x), ry = Math.round(c.y);
        if (!crateTiles.some(t => Math.round(t.x) === rx && Math.round(t.y) === ry))
            crateTiles.push({ x: rx, y: ry });
    }
});
