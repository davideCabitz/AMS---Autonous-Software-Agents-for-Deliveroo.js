/**
 * Manhattan distance between two points (rounded to tile coordinates)
 * @param {{x: number, y: number}} p1 - First point
 * @param {{x: number, y: number}} p2 - Second point
 * @returns {number} Manhattan distance in tiles
 */
export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    return Math.abs(Math.round(x1) - Math.round(x2))
         + Math.abs(Math.round(y1) - Math.round(y2));
}
