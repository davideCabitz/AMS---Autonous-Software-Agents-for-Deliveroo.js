/**
 * Spatial clustering of spawner tiles into groups.
 *
 * Two spawners belong to the same group when their Euclidean distance is
 * at or below dCluster. Transitive connections form the final groups, so a
 * "line" of adjacent spawners (each 1 tile from the next) becomes one group.
 *
 * Built once at map-load time — spawner positions are static.
 */
export function buildSpawnerGroups(tiles, dCluster = 2) {
    if (tiles.length === 0) return [];

    // Union-Find with path compression and union by rank.
    const parent = tiles.map((_, i) => i);
    const rank   = new Array(tiles.length).fill(0);

    function find(i) {
        if (parent[i] !== i) parent[i] = find(parent[i]);
        return parent[i];
    }

    function union(a, b) {
        const ra = find(a), rb = find(b);
        if (ra === rb) return;
        if      (rank[ra] < rank[rb]) parent[ra] = rb;
        else if (rank[ra] > rank[rb]) parent[rb] = ra;
        else { parent[rb] = ra; rank[ra]++; }
    }

    for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
            const dx = tiles[i].x - tiles[j].x;
            const dy = tiles[i].y - tiles[j].y;
            if (Math.sqrt(dx * dx + dy * dy) <= dCluster) union(i, j);
        }
    }

    const map = new Map();
    for (let i = 0; i < tiles.length; i++) {
        const root = find(i);
        if (!map.has(root)) map.set(root, []);
        map.get(root).push(tiles[i]);
    }

    return [...map.values()];
}
