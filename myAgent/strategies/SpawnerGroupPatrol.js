import { spawnerTiles, walkableTiles, missionConstraints } from '../context.js';
import { buildSpawnerGroups } from '../beliefs/SpawnerGroups.js';

/**
 * Shared spawner-group machinery for the group-patrol strategies
 * (StrategyHighCapacity, StrategyLookAhead, StrategyLookAheadStochastic): build
 * path-clustered groups and turn a group into a centroid-angle patrol loop. Each
 * caller passes its own clustering distance and waypoint cap, so no behaviour shifts.
 */

/**
 * Signature detecting when allowedSpawnerTiles changed (to rebuild cached groups)
 * @returns {string} Stable signature of the current set; empty ⇒ no constraint
 */
export function spawnerConstraintSig() {
    return missionConstraints.allowedSpawnerTiles?.size > 0
        ? [...missionConstraints.allowedSpawnerTiles].sort().join('|')
        : '';
}

/**
 * Build path-clustered groups under the allowedSpawnerTiles constraint (falling back
 * to the full set if the filter empties it), with the constraint signature
 * @param {number} dCluster - Max walkable steps to merge two spawners into a group
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
 * Build path-clustered groups from the full spawner set, NO mission constraint
 * applied (the stochastic sampler caches once and never rebuilds)
 * @param {number} dCluster - Max walkable steps to merge two spawners into a group
 * @returns {Array<Array<{x: number, y: number}>>} Spawner groups
 */
export function buildGroups(dCluster) {
    if (spawnerTiles.length === 0) return [];
    const walkableSet = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));
    return buildSpawnerGroups(spawnerTiles, walkableSet, dCluster);
}

/**
 * Turn a group into an ordered patrol loop: a clockwise sweep by angle around the
 * centroid, capped at maxWaypoints stops. Singletons and pairs returned as-is.
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
