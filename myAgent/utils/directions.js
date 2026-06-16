/**
 * @type {Array<{dx: number, dy: number, dir: string}>} The four cardinal step vectors.
 * Order is significant: A* expands neighbours in this order, so it participates in
 * path tie-breaking (lowest-f, then earliest-expanded). Do not reorder.
 */
export const STEP_DIRS = [
    { dx:  1, dy:  0, dir: 'right' },
    { dx: -1, dy:  0, dir: 'left'  },
    { dx:  0, dy:  1, dir: 'up'    },
    { dx:  0, dy: -1, dir: 'down'  },
];

/** @type {Object<string, {dx: number, dy: number}>} Arrow tile direction vectors (y-up grid) */
export const ARROW_VECTORS = {
    '↑': { dx: 0,  dy: 1 },
    '→': { dx: 1,  dy: 0 },
    '↓': { dx: 0,  dy: -1 },
    '←': { dx: -1, dy: 0 },
};

/**
 * Is this tile type one of the four arrow tiles?
 * @param {string|undefined} type - Tile type to check
 * @returns {boolean}
 */
export const isDirectional = (type) =>
    Object.prototype.hasOwnProperty.call(ARROW_VECTORS, type);

/**
 * Can an agent step from (fromX,fromY) to (toX,toY) when that tile has arrow direction `type`?
 * Entry is blocked iff the movement vector is exactly opposite the arrow. Non-directional tiles are always passable.
 * @param {string|undefined} type - Arrow tile type
 * @param {number} fromX - Starting x coordinate
 * @param {number} fromY - Starting y coordinate
 * @param {number} toX - Target x coordinate
 * @param {number} toY - Target y coordinate
 * @returns {boolean} True if entry is allowed
 */
export function canEnterDir(type, fromX, fromY, toX, toY) {
    if (!isDirectional(type)) return true;
    const a = ARROW_VECTORS[type];
    return !((toX - fromX) === -a.dx && (toY - fromY) === -a.dy);
}
