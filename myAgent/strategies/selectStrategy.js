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
import { createLogger } from '../utils/logger.js';

const log = createLogger('strategy');

// Other strategies are kept available for manual selection / future auto-rules.
export { StrategySimple }       from './StrategySimple.js';
export { StrategyNotTooGreedy } from './StrategyNotTooGreedy.js';
export { StrategyGreedy, StrategyBlind, StrategyHurry, StrategyMemory, StrategyLookAhead };

// Fraction of walkable tiles that must be spawners to switch to StrategyHurry.
const HURRY_SPAWNER_RATIO = 0.5;
// Carrying capacity above which the farm-then-bank StrategyHighCapacity is used.
const HIGH_CAPACITY_MIN = 5;
// Abundance gates for StrategyHighCapacityRush: parcels must spawn at least
// this fast AND the map population cap must be at least this high.
const RUSH_MAX_GENERATION_MS = 1000; // '1s' or 'frame'
const RUSH_MIN_PARCELS_MAX   = 15;

/**
 * Pick the strategy for the current game. Called once the agent is ready (so the
 * server config — and thus OBSERVATION_DISTANCE — has arrived).
 *
 * Order matters:
 *   1. Blind map (OBSERVATION_DISTANCE in -1..1)      → StrategyBlind
 *   2. Single spawner                                  → StrategySingleParcel
 *   3. Spawner-dense map (spawnerRatio > 0.5)          → StrategyHurry
 *   4. High capacity + fast spawn + parcelsMax ≥ 10    → StrategyHighCapacityRush
 *   5. High capacity (CARRYING_CAPACITY > 5)           → StrategyHighCapacity
 *   6. ≥3 spawner groups                               → StrategyLookAheadStochastic
 *   7. Default                                         → StrategyLookAhead
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

    // Abundance maps: high capacity (incl. infinite) + fast spawning + high
    // population cap → fill the hold completely, then deliver in a straight
    // line (no detours, no early banking). Infinite capacity banks at 10.
    if (CARRYING_CAPACITY > HIGH_CAPACITY_MIN
            && PARCEL_GENERATION_MS <= RUSH_MAX_GENERATION_MS
            && PARCELS_MAX >= RUSH_MIN_PARCELS_MAX) {
        log(`capacity=${CARRYING_CAPACITY} parcelGen=${PARCEL_GENERATION_MS}ms parcelsMax=${PARCELS_MAX} → StrategyHighCapacityRush`);
        return new StrategyHighCapacityRush();
    }

    // High-capacity maps: farm the richest spawner cluster, bank in bulk.
    // Takes precedence over stochastic exploration — with a big hold, staying
    // on the densest group beats spreading visits across many groups.
    if (Number.isFinite(CARRYING_CAPACITY) && CARRYING_CAPACITY > HIGH_CAPACITY_MIN) {
        log(`capacity=${CARRYING_CAPACITY} > ${HIGH_CAPACITY_MIN} → StrategyHighCapacity`);
        return new StrategyHighCapacity();
    }

    // EXPLORE_MODE=stochastic → probabilistic group-based exploration, but only
    // when the map has enough distinct spatial groups to make sampling worthwhile.
    // With < 4 groups the agent would just oscillate between 2-3 large clusters —
    // no real diversity gain over the deterministic _prevExploreKey mechanism.
        const groups = buildSpawnerGroups(spawnerTiles, 2);
        if (groups.length >= 3) {
            log(`EXPLORE_MODE=stochastic, ${groups.length} groups → StrategyLookAheadStochastic`);
            return new StrategyLookAheadStochastic();
        log(`EXPLORE_MODE=stochastic but only ${groups.length} group(s) — falling back to StrategyLookAhead`);
    }

    log(`OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} spawnerRatio=${spawnerRatio.toFixed(2)} → StrategyLookAhead`);
    return new StrategyLookAhead();
}
