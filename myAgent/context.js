import 'dotenv/config';
import { DjsConnect }  from '@unitn-asa/deliveroo-js-sdk/client';
import { Beliefset }   from '@unitn-asa/pddl-client';
import { Me }          from './beliefs/Me.js';
import { Parcels }     from './beliefs/Parcels.js';
import { isDirectional } from './utils/directions.js';
import { tilesThatReach, findRoute } from './utils/astar.js';
import { createLogger } from './utils/logger.js';

const configLog  = createLogger('config');
const mapLog     = createLogger('map');
const crateLog   = createLogger('crate');
const sensingLog = createLogger('sensing');

export const socket  = DjsConnect();
export const me      = new Me();

/* Resilience: socket.io auto-reconnects after transport errors, but NOT after a
 * server-initiated disconnect ('io server disconnect' — observed live: the server
 * bounced the worker mid-game and the process became a zombie). Reconnect
 * manually; the same token re-authenticates as the same agent, onMap/onConfig
 * re-fire, and the worker's hello keepalive re-registers with the coordinator. */
socket.on('disconnect', (reason) => {
    console.warn(`[socket] disconnected (${reason})`);
    if (reason === 'io server disconnect') {
        setTimeout(() => {
            console.warn('[socket] reconnecting...');
            socket.connect();
        }, 1000);
    }
});

/* Which of the two challenge-2 processes this is. Set by myAgent/launch.js before
 * this module loads. 'coordinator' runs the LLM command layer and orders the
 * worker around; 'worker' runs plain BDI plus the partner-order handler. A direct
 * `node myAgent/coordinator_agent.js` run (single-agent, .env TOKEN) stays a coordinator. */
export const role = process.env.AGENT_ROLE ?? 'coordinator';

/* The coordinator's CHOSEN strategy instance, set by coordinator_agent.js on its
 * first deliberation. Shared here so the handoff routine can drive B's parcel
 * acquisition with the SAME map-chosen strategy it uses for autonomous play. */
export const runtime = { strategy: null };
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

/* Per-id velocity history for competitor-aware scoring (see
 * docs/COMPETITOR_AWARENESS_IMPLEMENTATION.md). Keyed by agent id, holds last
 * position + one-tick velocity. Unlike otherAgents (a positional snapshot for A*),
 * this persists across ticks so we can reason about where an agent is GOING.
 * Pruned when an id isn't re-sensed within AGENT_STALE_MS. */
const agentHistory = new Map();   // id -> { x, y, vx, vy, lastSeen }
const AGENT_STALE_MS = 2000;
/* Agents farther than this (Manhattan) from a scored target can't realistically
 * contest it; we skip the A* call for them. Bounds the per-tick findRoute cost on
 * crowded maps — the concrete answer to "A* cost unchanged in spirit". */
const AGENT_DIST_MANH_GATE = 8;

/* Trap-avoidance sets for directional ("arrow") mazes, computed once per map in
 * onMap from walls + arrow tiles only (static geometry — agents/crates excluded so
 * the verdict can't flicker). usableDeliverySet: "x_y" of deliveries that sit in a
 * sustainable pick-up→deliver loop (not one-way dead-ends). safeTargetSet: tiles
 * from which a usable delivery is still reachable — gates pickups/explore so the
 * agent never commits to a zone it can't get back out of.
 * See docs/DIRECTIONAL_TRAP_AVOIDANCE.md. */
export let usableDeliverySet = new Set();
export let safeTargetSet     = new Set();

/* Directional ("arrow") tiles sensed on the map, keyed "x_y" -> arrow char
 * ('↑'|'→'|'↓'|'←'). A* and the PDDL edge generator consult this to avoid
 * planning an illegal entry (entering opposite the arrow). See utils/directions.js. */
export const directionalTiles = new Map();

/* Shared PDDL execution state. PddlMove sets busy=true once a plan is found and
 * executing; IntentionRevisionReplace refuses to stop the current intention while
 * busy is true, ensuring the full macro-plan (including crate pushes) runs to
 * completion before the agent switches to a new goal. */
export const pddl = { busy: false };

/* Shared LLM-directive state. While the LLM command layer (myAgent/llm/) is
 * carrying out a chat directive it sets active=true; optionsGeneration() then
 * stands down so the autonomous strategy loop does not clobber the intention the
 * LLM pushed. Beliefs keep updating (parcels.sync still runs) — only autonomous
 * deciding/pushing is suspended. Cleared (and autonomy resumed) when the
 * directive finishes. Mirrors the pddl.busy live-singleton pattern. */
export const directive = { active: false, aborted: false };

/* Red-light/green-light enforcement state ("red light, green light" mission).
 * `red` is set by the LLM message classifier's STOP/GO verdict (see llm/index.js).
 * While red: optionsGeneration stands down, LLM commands are refused, and worker
 * orders are refused — every movement costs points. */
export const trafficLight = { red: false };

/* Whether a "red light, green light" mission has been STARTED. The live
 * "RED LIGHT!/GREEN LIGHT!" shouts only stop/resume the agents once the LLM has
 * read an announcement ("let's begin a red light green light game …") and armed
 * the mission via the start_light_mission tool. Before that, a stray "red light"
 * in chat is classified STOP but IGNORED — it must not freeze the agents. Cleared
 * by stop_light_mission or an abort. */
export const lightMission = { active: false };

/* Indefinite position hold, set by the LLM hold() tool (e.g. "move there and
 * wait for each other"). Unlike directive.active — which is released when the
 * directive ends — this gate persists across directives until release_hold().
 * Checked by optionsGeneration alongside the other gates. */
export const manualHold = { active: false };

/* Persistent Level-2 mission constraints. Updated by the LLM apply_mission tool;
 * read by every strategy on each decide() call. All fields are null/empty by
 * default (= no constraint). dropMissions() resets them all. */
export const missionConstraints = {
    requiredStackSize:    null,      // number | null — deliver only at this stack depth
    allowedDeliveryTiles: null,      // Set<"x_y"> | null — null = all tiles allowed
    allowedSpawnerTiles:  null,      // Set<"x_y"> | null — restrict exploration targets to these spawners
    avoidTiles:           new Set(), // Set<"x_y"> — empty = no avoidance
    maxParcelReward:      null,      // number | null — null = no ceiling
    maxBundleValue:       null,      // number | null — total reward per delivery must be ≤ this
    deliveryMultipliers:  null,      // Map<"x_y", number> | null — per-tile delivery reward scale; null = every tile 1×
    descriptions:         [],        // tagged strings "text [field1,field2]" shown in the LLM prompt
};

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

/* How often the server spawns a new parcel, in ms (config parcels generation
 * interval, same 'frame'/'1s'/... vocabulary as decay). Default '2s'. */
export let PARCEL_GENERATION_MS = 2000;

/* Max parcels alive on the map at once (config PARCELS_MAX). Default 5 (server
 * default) so an absent value never activates abundance-based strategies. */
export let PARCELS_MAX = 5;

/* Mean reward a freshly spawned parcel gets (config PARCEL_REWARD_AVG).
 * Default 30 (server default). Used as the quality bar in the rush strategy. */
export let PARCEL_REWARD_AVG = 30;

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
    configLog('raw:', JSON.stringify(config));

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

    // Parcel spawn pacing and population cap — both config shapes, like above.
    const genEvent = parcelCfg.generation_event ?? parcelCfg.generation_interval
        ?? game?.PARCELS_GENERATION_INTERVAL ?? config?.PARCELS_GENERATION_INTERVAL;
    PARCEL_GENERATION_MS = DECAY_EVENT_MS[genEvent] ?? 2000;
    const maxRaw = Number(parcelCfg.max ?? parcelCfg.parcels_max ?? game?.PARCELS_MAX ?? config?.PARCELS_MAX);
    PARCELS_MAX  = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 5;
    const avgRaw = Number(parcelCfg.reward_avg ?? game?.PARCEL_REWARD_AVG ?? config?.PARCEL_REWARD_AVG);
    PARCEL_REWARD_AVG = Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : 30;
    // Reset the measured pace to the server's movement_duration whenever config
    // changes; it re-converges to the real per-tile cost as the agent moves.
    moveTiming.msPerTile   = MOVEMENT_DURATION;

    configLog(`obs=${OBSERVATION_DISTANCE} move=${MOVEMENT_DURATION}ms decayInterval=${decayMs}ms decay_step=${DECAY_STEPS_PER_REWARD.toFixed(1)} capacity=${CARRYING_CAPACITY} parcelGen=${PARCEL_GENERATION_MS}ms parcelsMax=${PARCELS_MAX} rewardAvg=${PARCEL_REWARD_AVG}`);
});

socket.onMap((_w, _h, tiles) => {
    mapLog('sample tile:', JSON.stringify(tiles[0]));

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
    mapLog(`mapHasCrates=${mapHasCrates} (${crateSpawnerTiles.length} crate tiles)`);

    // Seed live crate positions from the '5!' spawner tiles: they start the game
    // with a crate on them. Without this the agent believes far-away spawner
    // tiles are free, A* plans a "crate-free" route through them, and PDDL only
    // engages after a wasted detour. A stale seed (spawner without a crate) is
    // self-correcting: sensing, 'crate' dispose events and walk-through cleanup
    // all remove it on first contact.
    crateTiles.length = 0;
    crateTiles.push(...crateSpawnerTiles
        .filter(t => t.crateSpawner || t.type === '5!')
        .map(t => ({ x: t.x, y: t.y })));
    if (crateTiles.length > 0)
        mapLog(`seeded ${crateTiles.length} crates from '5!' spawners: [${crateTiles.map(c => `${c.x}_${c.y}`).join(', ')}]`);

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

    mapLog(`delivery: ${deliveryTiles.length} | spawners: ${spawnerTiles.length} | crateTiles: ${crateSpawnerTiles.length} | walkable: ${walkableTiles.length} | directional: ${directionalTiles.size}`);

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

    mapLog(`beliefset: ${beliefset.objects.length} objects`);

    // Trap avoidance (directional mazes): find the sustainable pick-up→deliver
    // region via a greatest fixpoint — keep only deliveries that can still reach a
    // usable spawner and spawners that can still reach a usable delivery, until
    // stable. Each pass only shrinks the sets, so it terminates in a few iterations.
    // Static (walls + arrows only), so it's computed once here, not per tick.
    {
        let spawn = [...spawnerTiles], deliv = [...deliveryTiles];
        while (true) {
            const reachDeliv = tilesThatReach(deliv);
            const newSpawn   = spawn.filter(s => reachDeliv.has(`${s.x}_${s.y}`));
            const reachSpawn = tilesThatReach(newSpawn);
            const newDeliv   = deliv.filter(d => reachSpawn.has(`${d.x}_${d.y}`));
            if (newSpawn.length === spawn.length && newDeliv.length === deliv.length) break;
            spawn = newSpawn; deliv = newDeliv;
        }
        usableDeliverySet = new Set(deliv.map(d => `${d.x}_${d.y}`));
        // All-traps fallback: if no sustainable delivery exists (whole map is a trap,
        // or there are no spawners to loop with), treat every delivery as a valid
        // target so the agent still works instead of freezing.
        safeTargetSet = tilesThatReach(deliv.length ? deliv : deliveryTiles);
    }
});

// Primary crate tracking via server events (global, not range-limited).
socket.on('crate', (action, { x, y }) => {
    if (!mapHasCrates) return;
    const rx = Math.round(x), ry = Math.round(y);
    if (action === 'create') {
        if (!crateTiles.some(c => Math.round(c.x) === rx && Math.round(c.y) === ry))
            crateTiles.push({ x: rx, y: ry });
        crateLog(`appeared at ${rx}_${ry} | total: ${crateTiles.length}`);
    } else if (action === 'dispose') {
        const idx = crateTiles.findIndex(c => Math.round(c.x) === rx && Math.round(c.y) === ry);
        if (idx !== -1) crateTiles.splice(idx, 1);
        crateLog(`removed at ${rx}_${ry} | total: ${crateTiles.length}`);
    }
});

socket.onSensing(sensing => {
    // Other agents are obstacles for A*. Full replace (not merge): agents move, so
    // a stale position would wrongly block a tile. Runs before any crate-related
    // early-return below so agent tracking is independent of mapHasCrates.
    otherAgents.length = 0;
    const now = Date.now();
    for (const a of sensing.agents ?? []) {
        if (a.id === me.id) continue;
        const x = Math.round(a.x), y = Math.round(a.y);
        otherAgents.push({ x, y });                  // positional snapshot for A*
        // Per-id velocity: delta over the last tick only. Zero on first sight or
        // after a gap (a stale prev would yield a bogus huge velocity).
        const prev = agentHistory.get(a.id);
        const fresh = prev && (now - prev.lastSeen) <= AGENT_STALE_MS;
        agentHistory.set(a.id, {
            x, y,
            vx: fresh ? x - prev.x : 0,
            vy: fresh ? y - prev.y : 0,
            lastSeen: now,
        });
    }
    // Prune ids not re-sensed recently so a vanished agent stops biasing scoring.
    for (const [id, h] of agentHistory)
        if (now - h.lastSeen > AGENT_STALE_MS) agentHistory.delete(id);
    if (otherAgents.length)
        sensingLog(`agents: ${otherAgents.length} at [${otherAgents.map(a => `${a.x},${a.y}`).join(' ')}]`);

    if (sensing.crates?.length) sensingLog('crates in range:', JSON.stringify(sensing.crates));
    if (!mapHasCrates) {
        if (sensing.crates?.length > 0) {
            mapHasCrates = true;
            sensingLog('crates detected via sensing — enabling crate mode');
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

// ─── competitor-awareness helpers (Phase 0) ─────────────────────────────────
// Consumed by the Strategy scoring layer. All degrade to "no competitors" when
// agentHistory is empty, preserving current behavior (backward-compat invariant).

/**
 * Min A* distance from ANY sensed agent to `tile`; Infinity if none in range.
 * Manhattan pre-filter (AGENT_DIST_MANH_GATE) bounds findRoute calls per tick.
 *
 * findRoute treats every other-agent tile as blocked and returns null when an
 * agent stands ON the goal (astar.js:135-136,143) — so an agent sitting on a
 * still-free parcel would yield Infinity, the OPPOSITE of the contest signal we
 * want. Special-case manh===0 -> 0 (max contest) before any findRoute call; this
 * also avoids a wasted A*.
 */
export function otherAgentDistTo(tile) {
    let best = Infinity;
    for (const h of agentHistory.values()) {
        const manh = Math.abs(h.x - tile.x) + Math.abs(h.y - tile.y);
        if (manh === 0) return 0;                    // agent ON the tile = max contest
        if (manh >= best) continue;                  // can't beat best (A* >= Manhattan)
        if (manh > AGENT_DIST_MANH_GATE) continue;
        const route = findRoute({ x: h.x, y: h.y }, tile);
        const len = route ? route.length : Infinity;
        if (len < best) best = len;
    }
    return best;
}

/** Id of the nearest sensed agent to `tile` (Manhattan), or null if none. */
export function nearestAgentId(tile) {
    let best = Infinity, id = null;
    for (const [aid, h] of agentHistory) {
        const manh = Math.abs(h.x - tile.x) + Math.abs(h.y - tile.y);
        if (manh < best) { best = manh; id = aid; }
    }
    return id;
}

/**
 * True if `agentId`'s velocity is closing on `tile` (positive dot product of
 * velocity with the bearing to the tile). Used as a Phase-1 quality softener and
 * by Phase-3 Case 3. False for unknown/stationary agents.
 */
export function isAgentMovingToward(agentId, tile) {
    const h = agentHistory.get(agentId);
    if (!h) return false;
    const bx = tile.x - h.x, by = tile.y - h.y;
    return (h.vx * bx + h.vy * by) > 0;
}

/** True when the nearest sensed agent to `tile` has ~zero velocity (Case 3). */
export function nearestAgentIsStationary(tile) {
    let best = Infinity, stat = false;
    for (const h of agentHistory.values()) {
        const manh = Math.abs(h.x - tile.x) + Math.abs(h.y - tile.y);
        if (manh < best) { best = manh; stat = (h.vx === 0 && h.vy === 0); }
    }
    return stat;
}
