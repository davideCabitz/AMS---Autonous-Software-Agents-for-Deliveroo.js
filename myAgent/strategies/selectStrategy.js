import { OBSERVATION_DISTANCE, spawnerTiles, walkableTiles, parcels, DECAY_INTERVAL_MS } from '../context.js';
import { StrategyGreedy }              from './StrategyGreedy.js';
import { StrategyBlind }               from './StrategyBlind.js';
import { StrategyHurry }               from './StrategyHurry.js';
import { StrategyMemory }              from './StrategyMemory.js';
import { StrategyLookAhead }           from './StrategyLookAhead.js';
import { StrategyLookAheadStochastic } from './StrategyLookAheadStochastic.js';
import { StrategySingleParcel }        from './StrategySingleParcel.js';
import { buildSpawnerGroups }          from '../beliefs/SpawnerGroups.js';

// Other strategies are kept available for manual selection / future auto-rules.
export { StrategySimple }       from './StrategySimple.js';
export { StrategyNotTooGreedy } from './StrategyNotTooGreedy.js';
export { StrategyGreedy, StrategyBlind, StrategyHurry, StrategyMemory, StrategyLookAhead };

// Fraction of walkable tiles that must be spawners to switch to StrategyHurry.
const HURRY_SPAWNER_RATIO = 0.5;

/**
 * Pick the strategy for the current game. Called once the agent is ready (so the
 * server config — and thus OBSERVATION_DISTANCE — has arrived).
 *
 * Order matters:
 *   1. Blind map (OBSERVATION_DISTANCE in -1..1)      → StrategyBlind
 *   2. Single spawner                                  → StrategySingleParcel
 *   3. Spawner-dense map (spawnerRatio > 0.5)          → StrategyHurry
 *   4. EXPLORE_MODE=stochastic                         → StrategyLookAheadStochastic
 *   5. Default                                         → StrategyLookAhead
 */
export function selectStrategy() {
    const blind = OBSERVATION_DISTANCE >= -1 && OBSERVATION_DISTANCE <= 1;
    if (blind) {
        console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} → StrategyBlind`);
        return new StrategyBlind();
    }

    // Single spawner: camp on it and react instantly when a parcel appears.
    if (spawnerTiles.length === 1) {
        parcels.enableMemory(DECAY_INTERVAL_MS);
        console.log(`[strategy] single spawner → StrategySingleParcel`);
        return new StrategySingleParcel();
    }

    const spawnerRatio = walkableTiles.length > 0 ? spawnerTiles.length / walkableTiles.length : 0;
    if (spawnerRatio > HURRY_SPAWNER_RATIO) {
        console.log(`[strategy] spawnerRatio=${spawnerRatio.toFixed(2)} > ${HURRY_SPAWNER_RATIO} → StrategyHurry`);
        return new StrategyHurry();
    }

    // Enable parcel memory in the belief layer — required by both LookAhead variants.
    parcels.enableMemory(DECAY_INTERVAL_MS);

    // EXPLORE_MODE=stochastic → probabilistic group-based exploration, but only
    // when the map has enough distinct spatial groups to make sampling worthwhile.
    // With < 4 groups the agent would just oscillate between 2-3 large clusters —
    // no real diversity gain over the deterministic _prevExploreKey mechanism.
    if (process.env.EXPLORE_MODE === 'stochastic') {
        const groups = buildSpawnerGroups(spawnerTiles, 2);
        if (groups.length >= 3) {
            console.log(`[strategy] EXPLORE_MODE=stochastic, ${groups.length} groups → StrategyLookAheadStochastic`);
            return new StrategyLookAheadStochastic();
        }
        console.log(`[strategy] EXPLORE_MODE=stochastic but only ${groups.length} group(s) — falling back to StrategyLookAhead`);
    }

    console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} spawnerRatio=${spawnerRatio.toFixed(2)} → StrategyLookAhead`);
    return new StrategyLookAhead();
}
