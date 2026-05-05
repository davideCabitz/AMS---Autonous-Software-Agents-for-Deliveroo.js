/** Manhattan distance, rounded to whole tiles. */
export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    return Math.abs(Math.round(x1) - Math.round(x2))
         + Math.abs(Math.round(y1) - Math.round(y2));
}
