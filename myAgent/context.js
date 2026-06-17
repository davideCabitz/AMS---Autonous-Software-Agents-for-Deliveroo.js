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
 * server-initiated disconnect ('io server disconnect' — leaves a zombie process).
 * Reconnect manually; the same token re-authenticates, onMap/onConfig re-fire, and
 * the worker's hello keepalive re-registers with the coordinator. */
socket.on('disconnect', (reason) => {
    console.warn(`[socket] disconnected (${reason})`);
    if (reason === 'io server disconnect') {
        setTimeout(() => {
            console.warn('[socket] reconnecting...');
            socket.connect();
        }, 1000);
    }
});

/* Which of the two processes this is, set by launch.js before this module loads.
 * 'coordinator' runs the LLM command layer and orders the worker; 'worker' runs
 * plain BDI plus the partner-order handler. A direct coordinator_agent.js run stays
 * a coordinator. */
export const role = process.env.AGENT_ROLE ?? 'coordinator';

/* The coordinator's chosen strategy, set by coordinator_agent.js on first
 * deliberation. Shared so the handoff routine drives B's acquisition with the SAME
 * strategy used for autonomous play. */
export const runtime = { strategy: null };
export const parcels = new Parcels();
export const deliveryTiles = [];
export const spawnerTiles  = [];
export const walkableTiles = [];
/* Crates currently sensed — movable obstacles the PDDL planner may push (see
 * PddlMove). Populated from `sensing.crates`. */
export const crateTiles    = [];
/* Static crate tiles from the map ('5!' spawner, '5' sliding). Decided once in onMap:
 * no crate tiles ⇒ crates can never appear, so crate sensing and PddlMove are skipped
 * (never pay the solver cost). */
export const crateSpawnerTiles = [];
export let   mapHasCrates      = false;

/* Other sensed agents (excluding self), rounded {x,y}. Impassable to A*. Fully
 * replaced each sensing event so stale positions don't linger. */
export const otherAgents = [];

/* Per-id velocity history for competitor-aware scoring. Unlike otherAgents (a
 * positional snapshot), this persists across ticks so we can reason about where an
 * agent is GOING. Pruned when not re-sensed within AGENT_STALE_MS. */
const agentHistory = new Map();   // id -> { x, y, vx, vy, lastSeen }
const AGENT_STALE_MS = 2000;
/* Agents beyond this Manhattan distance from a scored target can't realistically
 * contest it, so we skip the A* call — bounds per-tick findRoute cost on crowded maps. */
const AGENT_DIST_MANH_GATE = 8;

/* Trap-avoidance sets for directional mazes, computed once per map in onMap from
 * static geometry only (agents/crates excluded so the verdict can't flicker).
 * usableDeliverySet: deliveries in a sustainable pickup→deliver loop (not dead-ends).
 * safeTargetSet: tiles from which a usable delivery is still reachable — gates pickups/
 * explore so the agent never commits to a zone it can't escape. */
export let usableDeliverySet = new Set();
export let safeTargetSet     = new Set();

/* Sensed arrow tiles, "x_y" -> arrow char ('↑'|'→'|'↓'|'←'). A* and the PDDL edge
 * generator consult this to avoid an illegal entry (opposite the arrow). */
export const directionalTiles = new Map();

/* Shared PDDL state. PddlMove sets busy=true while a plan executes;
 * IntentionRevisionReplace then refuses to stop the current intention, so the full
 * macro-plan (incl. crate pushes) finishes before switching goals. */
export const pddl = { busy: false };

/* Shared LLM-directive state. While the LLM layer runs a directive it sets
 * active=true and optionsGeneration() stands down so the strategy doesn't clobber its
 * intention. Beliefs keep updating — only deciding/pushing pauses. Cleared on finish. */
export const directive = { active: false, aborted: false };

/* Red-light enforcement. `red` is set by the LLM classifier's STOP/GO verdict (see
 * llm/index.js). While red: optionsGeneration stands down and LLM/worker movement is
 * refused — every move costs points. */
export const trafficLight = { red: false };

/* Whether a red-light-green-light mission has been STARTED. Live RED/GREEN shouts only
 * stop/resume the agents once the LLM has armed the mission via start_light_mission;
 * before that a stray "red light" is classified STOP but IGNORED. Cleared by
 * stop_light_mission or abort. */
export const lightMission = { active: false };

/* Indefinite hold (LLM hold() tool). Unlike directive.active, this persists across
 * directives until release_hold(). Checked by optionsGeneration. */
export const manualHold = { active: false };

/* Persistent Level-2 mission constraints. Updated by apply_mission; read by every
 * strategy on each decide(). Null/empty = no constraint; dropMissions() resets all. */
export const missionConstraints = {
    requiredStackSize:    null,      // FLOOR: deliver only once carrying ≥ this ("at least N")
    maxStackSize:         null,      // CAP: never carry more than this ("exactly N" sets both)
    forbiddenStackSizes:  new Set(), // counts never to DELIVER at ("deliver N = penalty"). NOT a cap:
                                     //   holding a forbidden count forces more pickups, so {2} = "1 ok,
                                     //   3+ ok, never deliver exactly 2 — if holding 2, grab a 3rd".
    allowedDeliveryTiles: null,      // Set<"x_y"> | null — null = all allowed
    allowedSpawnerTiles:  null,      // Set<"x_y"> | null — restrict exploration to these
    avoidTiles:           new Set(), // Set<"x_y"> — empty = no avoidance
    maxParcelReward:      null,      // null = no ceiling
    maxBundleValue:       null,      // delivery total must be ≤ this ("< T" → T−1)
    minBundleValue:       null,      // delivery total must be ≥ this ("> T" → T+1; keep stacking)
    exactBundleValue:     null,      // delivery total must EQUAL this ("= T"); stack toward it, never overshoot
    deliveryMultipliers:  null,      // Map<"x_y", number> | null — per-tile reward scale; null = 1×
    oneShotBonus:         null,      // { x, y, points, perAgent } | null — go-there reward; `points`
                                     //   competes with parcel income in bonusGoalValue.
    penaltyTiles:         new Map(), // Map<"x_y", number> — point penalty for entering/delivering a tile.
                                     //   Keys also folded into avoidTiles (hard ban); magnitude feeds the
                                     //   worth-gate and recall.
    // Per-type running totals for Level-3 routines. Each same-type OFFER adds its signed
    // value; armed/kept while ≥ 0, declined/stopped while < 0 (armedByNet). Default 0 ⇒
    // a no-reward routine is followed as before. "−500 then +1000" nets +500 (run).
    handoffNet:           0,         // Σ of "one picks up / other delivers" offers
    gatherNet:            0,         // Σ of "move both near (x,y) and wait" offers
    lightNet:             0,         // Σ of red-light-green-light offers
    // Running Σ of (mult − 1.0) for reward-scaling missions ("5×", "0.3×"). Arms when
    // net ≥ 0 (armedByNet), at which point start_multiplier_mission applies the
    // accompanying Level-2 constraint.
    multiplierNet:        0,         // Σ (mult−1.0) of reward-scaling offers
    descriptions:         [],        // tagged "text [field1,field2]" shown in the LLM prompt
};

/* Single global PDDL beliefset, updated on each map event. */
export let beliefset = new Beliefset();

export let OBSERVATION_DISTANCE   = 5;
export let DECAY_STEPS_PER_REWARD = 10;
export let MOVEMENT_DURATION      = 100; // time per step
/* Max carry capacity (config player.capacity). Default Infinity ⇒ no cap. */
export let CARRYING_CAPACITY      = Infinity;

const DECAY_EVENT_MS = {
    'frame': 50, '1s': 1000, '2s': 2000,
    '5s': 5000, '10s': 10000, 'infinite': Infinity
};

/* Decay interval in ms (how often the server drops 1 point), from config. Infinity ⇒
 * no decay. Combined with the measured time-per-tile for the real decay rate. */
export let DECAY_INTERVAL_MS = 1000;

/* Parcel spawn interval in ms (config, same vocabulary as decay). Default 2s. */
export let PARCEL_GENERATION_MS = 2000;

/* Max parcels alive at once (config PARCELS_MAX). Default 5 so an absent value never
 * activates abundance strategies. */
export let PARCELS_MAX = 5;

/* Mean fresh-parcel reward (config PARCEL_REWARD_AVG). Default 30; the rush strategy's
 * quality bar. */
export let PARCEL_REWARD_AVG = 30;

/* Empirically-measured real time per tile. Decay is wall-clock (1 point per
 * DECAY_INTERVAL_MS), and the real per-tile cost is movement_duration plus latency,
 * replanning and blocked-tile waits. We EMA each emitMove cycle; `msPerTile` starts at
 * MOVEMENT_DURATION and converges as the agent moves. */
export const moveTiming = {
    msPerTile: MOVEMENT_DURATION,
    _alpha: 0.2,                       // EMA weight for the newest sample
    record(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        // Ignore absurd samples (long stalls) so one freeze doesn't poison the average.
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
    // Dump the raw config once so the runtime shape is visible in the log.
    configLog('raw:', JSON.stringify(config));

    // Config comes in two shapes by SDK/server version: nested under GAME
    // (config.GAME.player.*) or flat (config.player.*). Read both — a hard GAME path
    // threw when GAME was absent and silently left every value at its default.
    const game   = config?.GAME ?? config;
    const player = game?.player ?? config?.player ?? {};
    const parcelCfg = game?.parcels ?? config?.parcels ?? {};

    OBSERVATION_DISTANCE = player.observation_distance ?? OBSERVATION_DISTANCE;
    MOVEMENT_DURATION    = player.movement_duration ?? game?.movement_duration ?? MOVEMENT_DURATION;
    CARRYING_CAPACITY    = player.capacity ?? CARRYING_CAPACITY;

    const decayMs          = DECAY_EVENT_MS[parcelCfg.decaying_event] ?? 1000;
    DECAY_INTERVAL_MS      = decayMs;
    DECAY_STEPS_PER_REWARD = decayMs / MOVEMENT_DURATION;

    // Parcel spawn pacing and population cap — both config shapes.
    const genEvent = parcelCfg.generation_event ?? parcelCfg.generation_interval
        ?? game?.PARCELS_GENERATION_INTERVAL ?? config?.PARCELS_GENERATION_INTERVAL;
    PARCEL_GENERATION_MS = DECAY_EVENT_MS[genEvent] ?? 2000;
    const maxRaw = Number(parcelCfg.max ?? parcelCfg.parcels_max ?? game?.PARCELS_MAX ?? config?.PARCELS_MAX);
    PARCELS_MAX  = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 5;
    const avgRaw = Number(parcelCfg.reward_avg ?? game?.PARCEL_REWARD_AVG ?? config?.PARCEL_REWARD_AVG);
    PARCEL_REWARD_AVG = Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : 30;
    // Reset the measured pace on config change; it re-converges as the agent moves.
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

    // Cascade gate: does the map have any crate infrastructure? (string or numeric type.)
    crateSpawnerTiles.length = 0;
    crateSpawnerTiles.push(...tiles.filter(t =>
        t.crateSpawner || t.type === '5!' || t.type === '5' || t.type === 5
    ));
    mapHasCrates = crateSpawnerTiles.length > 0;
    mapLog(`mapHasCrates=${mapHasCrates} (${crateSpawnerTiles.length} crate tiles)`);

    // Seed live crates from '5!' spawners (they start with a crate). Without this the
    // agent thinks those tiles are free, A* routes through them, and PDDL engages only
    // after a wasted detour. A stale seed self-corrects (sensing / dispose / walk-through).
    crateTiles.length = 0;
    crateTiles.push(...crateSpawnerTiles
        .filter(t => t.crateSpawner || t.type === '5!')
        .map(t => ({ x: t.x, y: t.y })));
    if (crateTiles.length > 0)
        mapLog(`seeded ${crateTiles.length} crates from '5!' spawners: [${crateTiles.map(c => `${c.x}_${c.y}`).join(', ')}]`);

    walkableTiles.length = 0;
    walkableTiles.push(...tiles.filter(t => {
        if (t.type === '0' || t.type === 0) return false;           // wall — exclude
        if (t.type === '5!' || t.type === '5' || t.type === 5) return true; // crate zone — always include (PDDL needs these for push planning, even when server marks walkable:false)
        return t.walkable !== false;
    }));

    // Arrow tiles: record type by coordinate so pathfinding and the PDDL edge
    // generator enforce the one-way entry rule.
    directionalTiles.clear();
    for (const t of walkableTiles)
        if (isDirectional(t.type)) directionalTiles.set(`${t.x}_${t.y}`, t.type);

    mapLog(`delivery: ${deliveryTiles.length} | spawners: ${spawnerTiles.length} | crateTiles: ${crateSpawnerTiles.length} | walkable: ${walkableTiles.length} | directional: ${directionalTiles.size}`);

    // Rebuild the PDDL beliefset each map event (the solver has no direct map access).
    beliefset = new Beliefset();
    const walkSet  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const delivSet = new Set(deliveryTiles.map(t => `${t.x}_${t.y}`));

    // PDDL object names must start with a letter (a leading digit tokenizes as a
    // number), so tiles are named t<x>_<y>.
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

    // Trap avoidance (directional mazes): greatest-fixpoint on the sustainable
    // pickup→deliver region — keep only deliveries that can still reach a usable
    // spawner and vice-versa, until stable (each pass only shrinks, so it terminates).
    // Static, so computed once here, not per tick.
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
        // All-traps fallback: if no sustainable delivery exists, treat every delivery
        // as valid so the agent works instead of freezing.
        safeTargetSet = tilesThatReach(deliv.length ? deliv : deliveryTiles);
    }
});

// Crate tracking via server events (global, not range-limited).
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
    // Other agents are A* obstacles. Full replace (not merge) so a stale position
    // can't wrongly block a tile. Runs before the crate early-returns below so
    // agent tracking is independent of mapHasCrates.
    otherAgents.length = 0;
    const now = Date.now();
    for (const a of sensing.agents ?? []) {
        if (a.id === me.id) continue;
        const x = Math.round(a.x), y = Math.round(a.y);
        otherAgents.push({ x, y });                  // positional snapshot for A*
        // Per-id velocity: last-tick delta only. Zero on first sight or after a
        // gap (a stale prev would yield a bogus huge velocity).
        const prev = agentHistory.get(a.id);
        const fresh = prev && (now - prev.lastSeen) <= AGENT_STALE_MS;
        agentHistory.set(a.id, {
            x, y,
            vx: fresh ? x - prev.x : 0,
            vy: fresh ? y - prev.y : 0,
            lastSeen: now,
        });
    }
    // Prune stale ids so a vanished agent stops biasing scoring.
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
    // Merge (not replace): inferred crates from physical blocks may lie outside
    // sensing range, so clearing here causes a blocked→infer→clear→blocked loop.
    // Removal happens only via 'dispose' events or walk-through (see astar.js).
    for (const c of sensing.crates) {
        const rx = Math.round(c.x), ry = Math.round(c.y);
        if (!crateTiles.some(t => Math.round(t.x) === rx && Math.round(t.y) === ry))
            crateTiles.push({ x: rx, y: ry });
    }
});

// ─── competitor-awareness helpers (Phase 0) ─────────────────────────────────
// Consumed by the Strategy scoring layer; all degrade to "no competitors" when
// agentHistory is empty (backward-compat invariant).

/**
 * Min A* distance from any sensed agent to `tile`; Infinity if none in range.
 * Manhattan pre-filter (AGENT_DIST_MANH_GATE) bounds findRoute calls per tick.
 *
 * findRoute blocks every other-agent tile and returns null when an agent sits ON
 * the goal (astar.js:135-136,143) — so an agent on a still-free parcel yields
 * Infinity, the opposite of the contest signal we want. manh===0 → 0 (max
 * contest) short-circuits before any findRoute call.
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
 * True if `agentId` is closing on `tile` (velocity·bearing > 0). Phase-1 quality
 * softener and Phase-3 Case 3. False for unknown/stationary agents.
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
