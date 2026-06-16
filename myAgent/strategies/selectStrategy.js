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

/** @type {number} Fraction of walkable tiles that must be spawners to trigger StrategyHurry */
const HURRY_SPAWNER_RATIO = 0.5;

/** @type {number} Carrying capacity above which the farm-then-bank StrategyHighCapacity is used */
const HIGH_CAPACITY_MIN = 5;

/** @type {number} Maximum parcel generation interval (ms) for StrategyHighCapacityRush */
const RUSH_MAX_GENERATION_MS = 1000;

/** @type {number} Minimum parcels-max population cap for StrategyHighCapacityRush */
const RUSH_MIN_PARCELS_MAX   = 15;

/** @type {number} Minimum spawner tiles in the largest group to justify StrategyHighCapacityRush */
const RUSH_MIN_GROUP_SIZE = 5;

/** @type {number} Minimum spawner tiles in the largest group to justify StrategyHighCapacity */
const HC_MIN_GROUP_SIZE   = 3;

/**
 * Select the best strategy based on game map properties and server configuration
 * @returns {import('./Strategy.js').Strategy} Instantiated strategy appropriate for the current map
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

    // Abundance maps: high capacity (incl. infinite) + fast spawning + high
    // population cap → fill the hold completely, then deliver in a straight
    // line (no detours, no early banking). Infinite capacity banks at 10.
    // Only worthwhile when there is a dense group to farm (≥ RUSH_MIN_GROUP_SIZE);
    // sparse groups can't fill the hold and the agent just idles at one cluster.
    if (CARRYING_CAPACITY > HIGH_CAPACITY_MIN
            && PARCEL_GENERATION_MS <= RUSH_MAX_GENERATION_MS
            && PARCELS_MAX >= RUSH_MIN_PARCELS_MAX
            && maxGroupSize >= RUSH_MIN_GROUP_SIZE) {
        log(`capacity=${CARRYING_CAPACITY} parcelGen=${PARCEL_GENERATION_MS}ms parcelsMax=${PARCELS_MAX} maxGroup=${maxGroupSize} → StrategyHighCapacityRush`);
        return new StrategyHighCapacityRush();
    }

    // High-capacity maps: farm the richest spawner cluster, bank in bulk.
    // Takes precedence over stochastic exploration — with a big hold, staying
    // on the densest group beats spreading visits across many groups.
    // Skip when all groups are very small (< HC_MIN_GROUP_SIZE): HighCapacity's
    // farm loop stalls immediately and hopping/stochastic exploration is better.
    if (Number.isFinite(CARRYING_CAPACITY) && CARRYING_CAPACITY > HIGH_CAPACITY_MIN
            && maxGroupSize >= HC_MIN_GROUP_SIZE) {
        log(`capacity=${CARRYING_CAPACITY} > ${HIGH_CAPACITY_MIN} maxGroup=${maxGroupSize} → StrategyHighCapacity`);
        return new StrategyHighCapacity();
    }

    // Comb / hallway topology: many regularly-spaced spawner "teeth" along a
    // spine corridor. Each tooth is its own group, so the stochastic gate below
    // would fire — but on a linear layout random group sampling wastes movement.
    // A deterministic nearest-next sweep (StrategyLookAhead) covers the teeth in
    // spatial order instead. Checked here so it only ever diverts the would-be
    // stochastic case; Blind/Hurry/HighCapacity above keep precedence.
    const topo = detectCombTopology(spawnerTiles, walkableTiles, groups);
    if (topo.isComb) {
        log(`comb topology (${topo.axis}: ${topo.reason}) → StrategyLookAhead`);
        return new StrategyLookAhead();
    }

    // Probabilistic group-based exploration: worthwhile only when the map has
    // enough distinct spatial groups. With < 3 groups the weighted sampler gives
    // no real diversity gain over the deterministic _prevExploreKey mechanism.
    if (groups.length >= 3) {
        log(`${groups.length} groups → StrategyLookAheadStochastic`);
        return new StrategyLookAheadStochastic();
    }
    log(`only ${groups.length} group(s) — falling back to StrategyLookAhead`);

    log(`OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} spawnerRatio=${spawnerRatio.toFixed(2)} → StrategyLookAhead`);
    return new StrategyLookAhead();
}
