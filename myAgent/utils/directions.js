// Directional ("arrow") tiles. The grid is y-up (north = +y), matching the
// server and this project's A* DIRS (up is dy:+1, down is dy:-1), so no
// sign-flipping is needed.
//
// An arrow tile blocks entry only when you move in the direction exactly
// opposite to its arrow; entering along the arrow or perpendicular to it is
// allowed. Exit is never restricted. See docs/DIRECTIONAL_TILES_PLAN.md.

export const ARROW_VECTORS = {
    '↑': { dx: 0,  dy: 1 },
    '→': { dx: 1,  dy: 0 },
    '↓': { dx: 0,  dy: -1 },
    '←': { dx: -1, dy: 0 },
};

/** Is this tile type one of the four arrow tiles? */
export const isDirectional = (type) =>
    Object.prototype.hasOwnProperty.call(ARROW_VECTORS, type);

/**
 * Can an agent stepping from (fromX,fromY) enter a tile of `type` at (toX,toY)?
 * Blocked iff the movement vector is exactly opposite the arrow. Non-directional
 * (or undefined) types are unrestricted here — walkability is checked elsewhere.
 */
export function canEnterDir(type, fromX, fromY, toX, toY) {
    if (!isDirectional(type)) return true;
    const a = ARROW_VECTORS[type];
    return !((toX - fromX) === -a.dx && (toY - fromY) === -a.dy);
}
