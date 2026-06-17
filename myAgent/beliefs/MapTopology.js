/**
 * Comb/hallway map recognition. Detects parallel spawner "teeth" separated by
 * wall bands and joined by a spine corridor — routes these to LookAhead's
 * sequential sweep instead of the stochastic explorer. Runs once at map load.
 */

const MIN_LINES = 4;          // min teeth to qualify as a comb
const MIN_SPAN = 6;           // min extent teeth must span on the tooth axis
const MAX_TOOTH_GAP = 3;      // max gap (tiles) for a tooth spacing to count as "regular"
const REGULAR_FRAC = 0.7;     // min fraction of gaps that must be regular
const MIN_SEPARATORS = 4;     // min wall-separator bands between teeth (combs have one per pair)
const MIN_WALL_FRAC = 0.6;    // wall fraction for a separator band to count as "walled"
const SEP_WALL_FRAC = 0.7;    // min fraction of separators that must be walled
const MIN_TOOTH_WALK = 0.85;  // min avg walkable fraction along teeth (rejects mazes/vortices)

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

    // Map bounds — any in-bounds non-walkable tile is treated as a wall.
    const all = walkableTiles.concat(spawnerTiles);
    const minX = Math.min(...all.map(t => t.x)), maxX = Math.max(...all.map(t => t.x));
    const minY = Math.min(...all.map(t => t.y)), maxY = Math.max(...all.map(t => t.y));
    const bounds = { minX, maxX, minY, maxY };

    const vertical = testAxis(spawnerTiles, walkableSet, bounds, 'x');   // teeth share columns
    const horizontal = testAxis(spawnerTiles, walkableSet, bounds, 'y'); // teeth share rows

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

    // 1. Bucket spawners by tooth-axis coord → lines (immune to ±1 cross-axis jitter).
    const lineCoords = [...new Set(spawnerTiles.map(t => t[toothAxis]))].sort((a, b) => a - b);
    const lineCount = lineCoords.length;
    if (lineCount < MIN_LINES)
        return { pass: false, reason: `${lineCount} lines < ${MIN_LINES}` };

    // 2. Lines must span a wide extent.
    const span = lineCoords[lineCount - 1] - lineCoords[0] + 1;
    if (span < MIN_SPAN)
        return { pass: false, reason: `span ${span} < ${MIN_SPAN}` };

    // 3. Regular spacing: most consecutive-line gaps small and uniform.
    const gaps = [];
    for (let i = 1; i < lineCount; i++) gaps.push(lineCoords[i] - lineCoords[i - 1]);
    const regular = gaps.filter(g => g <= MAX_TOOTH_GAP).length;
    const regFrac = regular / gaps.length;
    if (regFrac < REGULAR_FRAC)
        return { pass: false, reason: `regular ${(regFrac * 100).toFixed(0)}% < ${REGULAR_FRAC * 100}%` };

    // Cross-span: clamp to extent teeth occupy, so partial-map combs aren't penalised
    // by empty border rows/columns.
    const spawnerCross = spawnerTiles.map(t => t[crossAxis]);
    const crossLo = Math.min(...spawnerCross);
    const crossHi = Math.max(...spawnerCross);
    const crossLen = crossHi - crossLo + 1;
    const key = (toothCoord, crossCoord) =>
        toothAxis === 'x' ? `${toothCoord}_${crossCoord}` : `${crossCoord}_${toothCoord}`;

    // 4. Tooth corridors: each line must be near-solid walkable across the cross-span
    //    (rejects mazes/vortices whose spawner lines are broken by walls).
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

    // 5. Wall separators: for each tooth pair with room (gap ≥ 2), the best
    //    in-between line must be mostly wall — confirms teeth are isolated fingers.
    let separators = 0, walledSeparators = 0;
    for (let i = 1; i < lineCount; i++) {
        const a = lineCoords[i - 1], b = lineCoords[i];
        if (b - a < 2) continue; // teeth adjacent — no room for a separator
        separators++;
        // Most-walled line strictly between the two teeth.
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
