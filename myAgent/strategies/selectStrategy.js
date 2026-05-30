import { OBSERVATION_DISTANCE } from '../context.js';
import { StrategyGreedy } from './StrategyGreedy.js';
import { StrategyBlind }  from './StrategyBlind.js';

// Other strategies are kept available for manual selection / future auto-rules.
export { StrategySimple }       from './StrategySimple.js';
export { StrategyNotTooGreedy } from './StrategyNotTooGreedy.js';
export { StrategyGreedy, StrategyBlind };

/**
 * Pick the strategy for the current game. Called once the agent is ready (so the
 * server config — and thus OBSERVATION_DISTANCE — has arrived).
 *
 * Conservative for now: a genuine (near-)zero sensing map gets StrategyBlind;
 * everything else keeps the previous default behaviour (StrategyGreedy), so
 * non-blind maps are unchanged by this refactor.
 *
 * Note: observation_distance < 0 is the "infinite sensing" sentinel (full-map
 * visibility), NOT a blind map — so only 0..1 counts as blind.
 */
export function selectStrategy() {
    const blind = OBSERVATION_DISTANCE >= -1 && OBSERVATION_DISTANCE <= 1;
    if (blind) {
        console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} → StrategyBlind`);
        return new StrategyBlind();
    }
    console.log(`[strategy] OBSERVATION_DISTANCE=${OBSERVATION_DISTANCE} → StrategyGreedy`);
    return new StrategyGreedy();
}
