import { StrategyLookAhead } from './StrategyLookAhead.js';
import { me, spawnerTiles } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('single-parcel');

/**
 * Strategy for maps with exactly one parcel spawner.
 *
 * The only sensible idle behaviour on such maps is to camp on the single
 * spawner and react the instant a parcel appears.  The agent needs no timer
 * and no exploration tour — it just navigates to the spawner once and stays.
 *
 * All pickup / delivery / memory / look-ahead logic is inherited from
 * StrategyLookAhead unchanged.  Only exploreIfIdle() is overridden.
 *
 * No tickIntervalMs heartbeat is needed: the server's onSensing event fires
 * the moment a parcel spawns, which triggers optionsGeneration() and the
 * agent reacts immediately via the inherited decide() logic. This camps on a
 * fixed tile (no patrol), so we pin tickIntervalMs back to 0 — the 500ms idle
 * heartbeat StrategyLookAhead adds for its group patrol is unnecessary here.
 *
 * Selected automatically by selectStrategy() when spawnerTiles.length === 1.
 */
export class StrategySingleParcel extends StrategyLookAhead {
    tickIntervalMs = 0;

    exploreIfIdle(currentIntent) {
        const [intent] = currentIntent ?? [];

        // Productive work in progress — nothing to do here.
        if (intent === 'go_pick_up' || intent === 'go_deliver') {
            this._lastExploreKey = null;
            this._prevExploreKey = null;
            return null;
        }

        // Already navigating to the spawner — let the move plan complete.
        if (intent === 'go_explore') return null;

        const spawner = spawnerTiles[0];
        if (!spawner || !this.isReachable(spawner)) return null;

        // Already on the spawner — camp here and wait for a parcel to spawn.
        if (Math.round(me.x) === spawner.x && Math.round(me.y) === spawner.y) {
            return null;
        }

        log(`→ heading to spawner (${spawner.x},${spawner.y})`);
        return ['go_explore', spawner.x, spawner.y];
    }
}
