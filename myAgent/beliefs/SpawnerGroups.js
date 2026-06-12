/**
 * Spatial clustering of spawner tiles into groups.
 *
 * Two spawners belong to the same group when there exists a walkable path of at
 * most maxPathLen steps connecting them. Tiles separated only by a wall therefore
 * end up in distinct groups even if their Euclidean distance is ≤ maxPathLen.
 *
 * Built once at map-load time — spawner positions are static.
 *
 * @param {Array<{x:number,y:number}>} tiles      - spawner tile list
 * @param {Set<string>}               walkableSet - set of "x_y" walkable tile keys
 * @param {number}                    maxPathLen  - max walkable steps to merge two spawners (default 2)
 */
export function buildSpawnerGroups(tiles, walkableSet, maxPathLen = 2) {
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

    const DIRS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

    // BFS from tile t, expanding through walkableSet up to maxPathLen steps.
    // Returns a Set of "x_y" keys reachable within that depth.
    function reachableWithin(t) {
        const seen  = new Map([[`${t.x}_${t.y}`, 0]]);
        const queue = [{ x: t.x, y: t.y, d: 0 }];
        let head = 0;
        while (head < queue.length) {
            const { x, y, d } = queue[head++];
            if (d >= maxPathLen) continue;
            for (const { dx, dy } of DIRS) {
                const nx = x + dx, ny = y + dy, nk = `${nx}_${ny}`;
                if (!seen.has(nk) && walkableSet.has(nk)) {
                    seen.set(nk, d + 1);
                    queue.push({ x: nx, y: ny, d: d + 1 });
                }
            }
        }
        return seen;
    }

    for (let i = 0; i < tiles.length; i++) {
        const reachable = reachableWithin(tiles[i]);
        for (let j = i + 1; j < tiles.length; j++) {
            if (reachable.has(`${tiles[j].x}_${tiles[j].y}`)) union(i, j);
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
