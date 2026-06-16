/**
 * Map-topology recognition for strategy selection.
 *
 * Detects "comb / hallway" maps: parallel parcel-spawner fingers ("teeth")
 * separated by walls and joined only by a spine corridor. On these maps each
 * tooth is its own spawner group (teeth are walled off and > D_CLUSTER walkable
 * steps apart), so the group count is high and selectStrategy would pick the
 * stochastic explorer. Stochastic samples groups at random, which wastes movement
 * on a linear layout — the agent should instead sweep the teeth sequentially,
 * exactly what StrategyLookAhead's deterministic nearest-next exploration does.
 *
 * The defining structural feature — and what separates a true comb from a maze,
 * crossroads, or open spawner field — is that consecutive tooth-lines are
 * SEPARATED BY WALL BANDS. A row/column of spawners, then a mostly-wall band,
 * then the next row/column, repeating. We detect exactly that: many periodic
 * tooth-lines, each pair separated by a high-wall-fraction band.
 *
 * Detection is intentionally conservative (see constants) and runs once at map
 * load from static geometry — no per-tick cost.
 */

// Need several teeth before a layout is called a comb.
const MIN_LINES = 4;
// Teeth must span a wide extent on the tooth axis (not a tight cluster).
const MIN_SPAN = 6;
// Max gap (tiles) between adjacent teeth to count the spacing as "regular".
const MAX_TOOTH_GAP = 3;
// Fraction of consecutive-tooth gaps that must be regular.
const REGULAR_FRAC = 0.7;
// Minimum number of wall-separator bands between consecutive tooth-lines. This is
// the comb signature: a maze/crossroads/atom has spawners bunched on a few lines
// and thus few separators (≤3); a true comb has one between every pair of teeth
// (the real hallway maps have 7 and 14). 4 cleanly splits the two populations.
const MIN_SEPARATORS = 4;
// A separator band counts as "walled" when at least this fraction of its cells
// (across the tooth span) are walls.
const MIN_WALL_FRAC = 0.6;
// Fraction of separator bands that must be walled for the layout to be a comb.
const SEP_WALL_FRAC = 0.7;
// Each tooth-line must itself be a near-solid walkable corridor: the average
// walkable fraction along the tooth-lines (across the cross-span) must reach this.
// This is what rules out mazes/vortices whose spawner-bearing lines look periodic
// but are actually broken by walls (real comb teeth measure ≥0.97; maze/vortex
// "teeth" measure ≤0.69).
const MIN_TOOTH_WALK = 0.85;

/**
 * Detect comb/hallway topology from spawner and walkable tile distributions
 * @param {Array<{x: number, y: number}>} spawnerTiles - Spawner positions
 * @param {Array<{x: number, y: number}>} walkableTiles - Walkable tile positions
 * @param {Array<Array<{x: number, y: number}>>|null} groups - Spawner groups (unused, for convenience)
 * @returns {{isComb: boolean, axis: ('horizontal'|'vertical'|'both'|null), reason: string}} Comb detection result
 */
export function detectCombTopology(spawnerTiles, walkableTiles, groups = null) {
    if (!spawnerTiles || spawnerTiles.length < MIN_LINES)
        return { isComb: false, axis: null, reason: 'too few spawners' };

    const walkableSet = new Set(walkableTiles.map(t => `${t.x}_${t.y}`));

    // Map bounds — any in-bounds tile that is not walkable is treated as a wall.
    const all = walkableTiles.concat(spawnerTiles);
    const minX = Math.min(...all.map(t => t.x)), maxX = Math.max(...all.map(t => t.x));
    const minY = Math.min(...all.map(t => t.y)), maxY = Math.max(...all.map(t => t.y));
    const bounds = { minX, maxX, minY, maxY };

    // Vertical teeth share columns (x); separator bands are columns between them.
    const vertical = testAxis(spawnerTiles, walkableSet, bounds, 'x');
    // Horizontal teeth share rows (y); separator bands are rows between them.
    const horizontal = testAxis(spawnerTiles, walkableSet, bounds, 'y');

    if (vertical.pass && horizontal.pass)
        return { isComb: true, axis: 'both', reason: `V[${vertical.reason}] + H[${horizontal.reason}]` };
    if (vertical.pass)
        return { isComb: true, axis: 'vertical', reason: vertical.reason };
    if (horizontal.pass)
        return { isComb: true, axis: 'horizontal', reason: horizontal.reason };

    return { isComb: false, axis: null, reason: `V:${vertical.reason} | H:${horizontal.reason}` };
}

/**
 * Test if spawners form comb pattern along a given axis
 * @param {Array<{x: number, y: number}>} spawnerTiles - Spawner positions
 * @param {Set<string>} walkableSet - Set of "x_y" walkable tile keys
 * @param {{minX: number, maxX: number, minY: number, maxY: number}} bounds - Map bounds
 * @param {'x'|'y'} toothAxis - Axis for tooth lines ('x' for vertical, 'y' for horizontal)
 * @returns {{pass: boolean, reason: string}} Whether pattern matches comb signature
 */
function testAxis(spawnerTiles, walkableSet, bounds, toothAxis) {
    const crossAxis = toothAxis === 'x' ? 'y' : 'x';

    // 1. Bucket spawners by their tooth-axis coordinate → distinct "lines".
    //    Bucketing on the tooth axis makes detection immune to ±1 jitter of a
    //    tooth on the cross axis — a shifted tooth keeps its line.
    const lineCoords = [...new Set(spawnerTiles.map(t => t[toothAxis]))].sort((a, b) => a - b);
    const lineCount = lineCoords.length;
    if (lineCount < MIN_LINES)
        return { pass: false, reason: `${lineCount} lines < ${MIN_LINES}` };

    // 2. Lines must span a wide extent.
    const span = lineCoords[lineCount - 1] - lineCoords[0] + 1;
    if (span < MIN_SPAN)
        return { pass: false, reason: `span ${span} < ${MIN_SPAN}` };

    // 3. Regular spacing: most consecutive-line gaps are small and uniform.
    const gaps = [];
    for (let i = 1; i < lineCount; i++) gaps.push(lineCoords[i] - lineCoords[i - 1]);
    const regular = gaps.filter(g => g <= MAX_TOOTH_GAP).length;
    const regFrac = regular / gaps.length;
    if (regFrac < REGULAR_FRAC)
        return { pass: false, reason: `regular ${(regFrac * 100).toFixed(0)}% < ${REGULAR_FRAC * 100}%` };

    // Cross-span: limit to the extent the teeth actually occupy, so a comb that
    // fills only part of the map isn't penalised by empty border rows/columns.
    const spawnerCross = spawnerTiles.map(t => t[crossAxis]);
    const crossLo = Math.min(...spawnerCross);
    const crossHi = Math.max(...spawnerCross);
    const crossLen = crossHi - crossLo + 1;
    const key = (toothCoord, crossCoord) =>
        toothAxis === 'x' ? `${toothCoord}_${crossCoord}` : `${crossCoord}_${toothCoord}`;

    // 4. Tooth corridors: each tooth-line must itself be a near-solid walkable
    //    corridor across the cross-span. Mazes/vortices produce periodic-looking
    //    spawner lines that are actually broken by walls — this rejects them.
    let toothWalkSum = 0;
    for (const c of lineCoords) {
        let walk = 0;
        for (let cc = crossLo; cc <= crossHi; cc++)
            if (walkableSet.has(key(c, cc))) walk++;
        toothWalkSum += walk / crossLen;
    }
    const toothWalk = toothWalkSum / lineCount;
    if (toothWalk < MIN_TOOTH_WALK)
        return { pass: false, reason: `tooth walkable ${(toothWalk * 100).toFixed(0)}% < ${MIN_TOOTH_WALK * 100}%` };

    // 5. Wall separators: between each pair of consecutive tooth-lines whose gap
    //    leaves room (gap ≥ 2), the best in-between line must be mostly wall
    //    across the tooth cross-span. A comb has a walled band between every pair
    //    of teeth; this confirms the teeth are genuinely isolated fingers.
    let separators = 0, walledSeparators = 0;
    for (let i = 1; i < lineCount; i++) {
        const a = lineCoords[i - 1], b = lineCoords[i];
        if (b - a < 2) continue; // teeth adjacent — no room for a separator band
        separators++;
        // Best (most-walled) candidate line strictly between the two teeth.
        let bestWall = 0;
        for (let c = a + 1; c < b; c++) {
            let walls = 0;
            for (let cc = crossLo; cc <= crossHi; cc++)
                if (!walkableSet.has(key(c, cc))) walls++;
            const frac = walls / crossLen;
            if (frac > bestWall) bestWall = frac;
        }
        if (bestWall >= MIN_WALL_FRAC) walledSeparators++;
    }

    if (separators < MIN_SEPARATORS)
        return { pass: false, reason: `${separators} separators < ${MIN_SEPARATORS}` };

    const walledFrac = walledSeparators / separators;
    if (walledFrac < SEP_WALL_FRAC)
        return { pass: false, reason: `walled separators ${(walledFrac * 100).toFixed(0)}% < ${SEP_WALL_FRAC * 100}%` };

    return {
        pass: true,
        reason: `${lineCount} ${crossAxis}-teeth span=${span} reg=${(regFrac * 100).toFixed(0)}% `
            + `tooth=${(toothWalk * 100).toFixed(0)}% sep=${walledSeparators}/${separators} walled`,
    };
}
