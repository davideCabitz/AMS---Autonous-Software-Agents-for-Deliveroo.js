import {
    OBSERVATION_DISTANCE, CARRYING_CAPACITY, PARCEL_GENERATION_MS, PARCELS_MAX,
    spawnerTiles, walkableTiles, parcels, DECAY_INTERVAL_MS,
} from '../context.js';
import { StrategyGreedy }              from './StrategyGreedy.js';
import { StrategyBlind }               from './StrategyBlind.js';
import { StrategyHurry }               from './StrategyHurry.js';
import { StrategyMemory }              from './StrategyMemory.js';
import { StrategyLookAhead }           from './StrategyLookAhead.js';
import { StrategyLookAheadStochastic } from './StrategyLookAheadStochastic.js';
import { StrategySingleParcel }        from './StrategySingleParcel.js';
import { StrategyHighCapacity }        from './StrategyHighCapacity.js';
import { StrategyHighCapacityRush }    from './StrategyHighCapacityRush.js';
import { buildSpawnerGroups }          from '../beliefs/SpawnerGroups.js';
import { detectCombTopology }           from '../beliefs/MapTopology.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('strategy');

// Other strategies are kept available for manual selection / future auto-rules.
export { StrategySimple }       from './StrategySimple.js';
export { StrategyNotTooGreedy } from './StrategyNotTooGreedy.js';
export { StrategyGreedy, StrategyBlind, StrategyHurry, StrategyMemory, StrategyLookAhead };

/** @type {number} Spawner fraction of walkable tiles that triggers StrategyHurry */
const HURRY_SPAWNER_RATIO = 0.5;

/** @type {number} Capacity above which farm-then-bank StrategyHighCapacity is used */
const HIGH_CAPACITY_MIN = 5;

/** @type {number} Max parcel generation interval (ms) for StrategyHighCapacityRush */
const RUSH_MAX_GENERATION_MS = 1000;

/** @type {number} Min population cap for StrategyHighCapacityRush */
const RUSH_MIN_PARCELS_MAX   = 15;

/** @type {number} Min largest-group size to justify StrategyHighCapacityRush */
const RUSH_MIN_GROUP_SIZE = 5;

/** @type {number} Min largest-group size to justify StrategyHighCapacity */
const HC_MIN_GROUP_SIZE   = 3;

/**
 * Select the best strategy for the current map and server configuration
 * @returns {import('./Strategy.js').Strategy} Instantiated strategy
 */
export function selectStrategy() {
    const blind = OBSERVATION_DISTANCE >= -1 && OBSERVATION_DISTANCE <= 1;
    if (blind) {
        log(`OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} → StrategyBlind`);
        return new StrategyBlind();
    }

    // Single spawner: camp on it and react instantly when a parcel appears.
    if (spawnerTiles.length === 1) {
        parcels.enableMemory(DECAY_INTERVAL_MS);
        log(`single spawner → StrategySingleParcel`);
        return new StrategySingleParcel();
    }

    const spawnerRatio = walkableTiles.length > 0 ? spawnerTiles.length / walkableTiles.length : 0;
    if (spawnerRatio > HURRY_SPAWNER_RATIO) {
        log(`spawnerRatio=${spawnerRatio.toFixed(2)} > ${HURRY_SPAWNER_RATIO} → StrategyHurry`);
        return new StrategyHurry();
    }

    // Enable parcel memory in the belief layer — required by all LookAhead variants.
    parcels.enableMemory(DECAY_INTERVAL_MS);

    // Build path-based spawner groups once — used by all remaining checks.
    const walkableSet  = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    const groups       = buildSpawnerGroups(spawnerTiles, walkableSet, 2);
    const maxGroupSize = groups.reduce((m, g) => Math.max(m, g.length), 0);

    // Abundance maps: high capacity + fast spawning + high population cap → fill the
    // hold, then deliver straight (no detours/early banking). Infinite capacity banks
    // at 10. Only worthwhile with a dense group to farm (≥ RUSH_MIN_GROUP_SIZE).
    if (CARRYING_CAPACITY > HIGH_CAPACITY_MIN
            && PARCEL_GENERATION_MS <= RUSH_MAX_GENERATION_MS
            && PARCELS_MAX >= RUSH_MIN_PARCELS_MAX
            && maxGroupSize >= RUSH_MIN_GROUP_SIZE) {
        log(`capacity=${CARRYING_CAPACITY} parcelGen=${PARCEL_GENERATION_MS}ms parcelsMax=${PARCELS_MAX} maxGroup=${maxGroupSize} → StrategyHighCapacityRush`);
        return new StrategyHighCapacityRush();
    }

    // High-capacity maps: farm the richest cluster, bank in bulk. Precedes
    // stochastic exploration — with a big hold, camping the densest group beats
    // spreading visits. Skip when all groups are tiny (< HC_MIN_GROUP_SIZE): the
    // farm loop stalls and hopping/stochastic is better.
    if (Number.isFinite(CARRYING_CAPACITY) && CARRYING_CAPACITY > HIGH_CAPACITY_MIN
            && maxGroupSize >= HC_MIN_GROUP_SIZE) {
        log(`capacity=${CARRYING_CAPACITY} > ${HIGH_CAPACITY_MIN} maxGroup=${maxGroupSize} → StrategyHighCapacity`);
        return new StrategyHighCapacity();
    }

    // Comb / hallway topology: regularly-spaced spawner "teeth" along a spine. Each
    // tooth is its own group, so the stochastic gate below would fire — but on a
    // linear layout random sampling wastes movement. A deterministic nearest-next
    // sweep (LookAhead) covers the teeth in order. Only diverts the stochastic case.
    const topo = detectCombTopology(spawnerTiles, walkableTiles, groups);
    if (topo.isComb) {
        log(`comb topology (${topo.axis}: ${topo.reason}) → StrategyLookAhead`);
        return new StrategyLookAhead();
    }

    // Probabilistic group exploration: only worthwhile with ≥ 3 distinct groups.
    // Fewer than that gives no diversity gain over the deterministic _prevExploreKey.
    if (groups.length >= 3) {
        log(`${groups.length} groups → StrategyLookAheadStochastic`);
        return new StrategyLookAheadStochastic();
    }
    log(`only ${groups.length} group(s) — falling back to StrategyLookAhead`);

    log(`OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} spawnerRatio=${spawnerRatio.toFixed(2)} → StrategyLookAhead`);
    return new StrategyLookAhead();
}
