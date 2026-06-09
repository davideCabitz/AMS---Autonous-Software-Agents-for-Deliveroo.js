import { OBSERVATION_DISTANCE, spawnerTiles, walkableTiles, parcels, DECAY_INTERVAL_MS } from '../context.js';
import { StrategyGreedy } from './StrategyGreedy.js';
import { StrategyBlind }  from './StrategyBlind.js';
import { StrategyHurry }  from './StrategyHurry.js';
import { StrategyMemory } from './StrategyMemory.js';

// Other strategies are kept available for manual selection / future auto-rules.
export { StrategySimple }       from './StrategySimple.js';
export { StrategyNotTooGreedy } from './StrategyNotTooGreedy.js';
export { StrategyGreedy, StrategyBlind, StrategyHurry, StrategyMemory };

// Fraction of walkable tiles that must be spawners to switch to StrategyHurry.
const HURRY_SPAWNER_RATIO = 0.5;

/**
 * Pick the strategy for the current game. Called once the agent is ready (so the
 * server config — and thus OBSERVATION_DISTANCE — has arrived).
 *
 * Order matters:
 *   1. (near-)zero sensing (OBSERVATION_DISTANCE in -1..1) → StrategyBlind. A blind
 *      map is checked first because the other strategies rely on sensing parcels.
 *   2. spawner-dense map (spawners are a large fraction of walkable tiles) →
 *      StrategyHurry: don't wait on spawners, just keep touring them.
 *   3. otherwise → StrategyMemory: extends StrategyGreedy with a persistent
 *      parcel memory so high-value targets are pursued even after leaving the
 *      sensing zone. Memory is activated in the belief layer via enableMemory().
 *
 * Note: observation_distance <= 1 (including the -1 sentinel) means the agent
 * senses only its own tile, i.e. blind.
 */
export function selectStrategy() {
    const blind = OBSERVATION_DISTANCE >= -1 && OBSERVATION_DISTANCE <= 1;
    if (blind) {
        console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} → StrategyBlind`);
        return new StrategyBlind();
    }

    const spawnerRatio = walkableTiles.length > 0 ? spawnerTiles.length / walkableTiles.length : 0;
    if (spawnerRatio > HURRY_SPAWNER_RATIO) {
        console.log(`[strategy] spawnerRatio=${spawnerRatio.toFixed(2)} > ${HURRY_SPAWNER_RATIO} → StrategyHurry`);
        return new StrategyHurry();
    }

    // Enable parcel memory in the belief layer, then use the memory-aware strategy.
    parcels.enableMemory(DECAY_INTERVAL_MS);
    console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} spawnerRatio=${spawnerRatio.toFixed(2)} → StrategyMemory`);
    return new StrategyMemory();
}
