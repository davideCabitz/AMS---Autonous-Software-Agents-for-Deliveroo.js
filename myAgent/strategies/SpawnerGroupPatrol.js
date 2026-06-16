/** @type {number} Cap on patrol waypoints (matches HighCapacity + LookAhead idle patrol). */
const MAX_WAYPOINTS = 6;

/**
 * Pure spawner-group patrol primitives shared by the farm patrol (HighCapacity)
 * and the idle patrol (LookAhead). Only the stateless, byte-for-byte-identical
 * pieces live here — the nearest-tile ranking COST is injected (HighCapacity ranks
 * by A* pathLen; LookAhead idle by exploreCost), and the surrounding orchestration
 * (group build/cache, en-route banking, exhaustion handling) deliberately stays in
 * each strategy because those differ.
 */
export class SpawnerGroupPatrol {
    /**
     * Nearest tile of a group from the agent, by a host-supplied cost function.
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @param {(t: {x: number, y: number}) => number} costFn - Tile cost (pathLen or exploreCost)
     * @returns {{tile: {x: number, y: number}|null, dist: number}} Nearest tile and its cost
     */
    nearestTile(group, costFn) {
        let best = { tile: null, dist: Infinity };
        for (const t of group) {
            const d = costFn(t);
            if (d < best.dist) best = { tile: t, dist: d };
        }
        return best;
    }

    /**
     * Centroid-angle clockwise waypoint loop for a group, capped at MAX_WAYPOINTS.
     * Pure function of the group (independent of agent position).
     * @param {Array<{x: number, y: number}>} group - Spawner group
     * @returns {Array<{x: number, y: number}>} Ordered patrol waypoints
     */
    buildPatrol(group) {
        if (group.length === 1) return [group[0]];

        // Centroid of all group spawner tiles.
        const cx = group.reduce((s, t) => s + t.x, 0) / group.length;
        const cy = group.reduce((s, t) => s + t.y, 0) / group.length;

        // If the group has only 2 tiles just use both.
        if (group.length === 2) return [...group];

        // Sort by angle around centroid → clockwise loop.
        const byAngle = [...group].sort((a, b) =>
            Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
        );

        // Cap the patrol length so the agent doesn't spend forever on large groups:
        // keep every k-th tile so we get at most MAX_WAYPOINTS stops.
        if (byAngle.length <= MAX_WAYPOINTS) return byAngle;
        const step = byAngle.length / MAX_WAYPOINTS;
        return Array.from({ length: MAX_WAYPOINTS }, (_, i) => byAngle[Math.round(i * step) % byAngle.length]);
    }
}
