import { spawnerTiles, walkableTiles, missionConstraints } from '../context.js';
import { buildSpawnerGroups } from '../beliefs/SpawnerGroups.js';

/**
 * Shared spawner-group machinery used by the group-patrol strategies
 * (StrategyHighCapacity, StrategyLookAhead, StrategyLookAheadStochastic).
 *
 * These were three near-identical copies of the same two operations — building
 * path-clustered spawner groups and turning a group into a centroid-angle patrol
 * loop. Centralised here so the strategies share one implementation; each caller
 * keeps its own clustering distance and waypoint cap (passed as arguments) so no
 * behaviour shifts.
 */

/**
 * The signature string that detects when an allowedSpawnerTiles mission constraint
 * has changed (so cached groups can be rebuilt). Empty string ⇒ no constraint.
 * @returns {string} Stable signature of the current allowedSpawnerTiles set
 */
export function spawnerConstraintSig() {
    return missionConstraints.allowedSpawnerTiles?.size > 0
        ? [...missionConstraints.allowedSpawnerTiles].sort().join('|')
        : '';
}

/**
 * Build path-clustered spawner groups, applying the allowedSpawnerTiles mission
 * constraint (falling back to the full spawner set if the filter empties it), and
 * return them alongside the constraint signature for rebuild detection. Mirrors the
 * old StrategyHighCapacity#initGroups / StrategyLookAhead._initIdleGroups bodies.
 * @param {number} dCluster - Max walkable steps to merge two spawners into one group
 * @returns {{ groups: Array<Array<{x: number, y: number}>>, sig: string }}
 */
export function buildGroupsWithSig(dCluster) {
    const sig = spawnerConstraintSig();
    if (spawnerTiles.length === 0) return { groups: [], sig };
    let pool = spawnerTiles;
    if (missionConstraints.allowedSpawnerTiles?.size > 0) {
        const f = spawnerTiles.filter(t => missionConstraints.allowedSpawnerTiles.has(`${t.x}_${t.y}`));
        if (f.length > 0) pool = f;
    }
    const walkableSet = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    return { groups: buildSpawnerGroups(pool, walkableSet, dCluster), sig };
}

/**
 * Build path-clustered spawner groups from the full spawner set, with NO mission
 * constraint applied (the stochastic sampler caches once and never rebuilds).
 * Mirrors the old StrategyLookAheadStochastic#initGroups body.
 * @param {number} dCluster - Max walkable steps to merge two spawners into one group
 * @returns {Array<Array<{x: number, y: number}>>} Spawner groups
 */
export function buildGroups(dCluster) {
    if (spawnerTiles.length === 0) return [];
    const walkableSet = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    return buildSpawnerGroups(spawnerTiles, walkableSet, dCluster);
}

/**
 * Turn a spawner group into an ordered patrol loop: a clockwise sweep of the
 * group's tiles by angle around the centroid, capped at `maxWaypoints` stops so
 * large groups stay snappy. Singletons and pairs are returned as-is. Identical
 * output to the old StrategyHighCapacity#buildPatrol / StrategyLookAhead._buildIdlePatrol.
 * @param {Array<{x: number, y: number}>} group - Spawner group
 * @param {number} maxWaypoints - Maximum number of patrol stops
 * @returns {Array<{x: number, y: number}>} Ordered patrol waypoints
 */
export function buildCentroidPatrol(group, maxWaypoints) {
    if (group.length === 1) return [group[0]];
    if (group.length === 2) return [...group];
    const cx = group.reduce((s, t) => s + t.x, 0) / group.length;
    const cy = group.reduce((s, t) => s + t.y, 0) / group.length;
    const byAngle = [...group].sort((a, b) =>
        Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    if (byAngle.length <= maxWaypoints) return byAngle;
    const step = byAngle.length / maxWaypoints;
    return Array.from({ length: maxWaypoints }, (_, i) => byAngle[Math.round(i * step) % byAngle.length]);
}
