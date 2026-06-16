import { StrategyLookAhead } from './StrategyLookAhead.js';
import { me, spawnerTiles } from '../context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('single-parcel');

/**
 * @class StrategySingleParcel
 * Single-spawner maps: camp on sole spawner and react to spawn events
 */
export class StrategySingleParcel extends StrategyLookAhead {
    /** @type {number} No heartbeat needed (event-driven via onSensing) */
    tickIntervalMs = 0;

    /**
     * Camp on single spawner (no exploration)
     * @param {Array|null} currentIntent - Current intention predicate
     * @returns {Array|null} Next intention, or null to stay idle
     */
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
