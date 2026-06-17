/**
 * @class Me
 * Agent's own state: identity, position, score.
 */
export class Me {
    /** @type {string} Unique identifier */
    id = '';

    /** @type {string} Display name */
    name = '';

    /** @type {number} Rounded x (tile grid) */
    x = -1;

    /** @type {number} Rounded y (tile grid) */
    y = -1;

    /** @type {number} Fractional x from server (in-transit) */
    rawX = -1;

    /** @type {number} Fractional y from server (in-transit) */
    rawY = -1;

    /** @type {number} Current score */
    score = 0;

    /**
     * Update state from a server message
     * @param {{id?: string, name?: string, x?: number, y?: number, score?: number}} data
     */
    update({ id, name, x, y, score }) {
        this.id = id ?? this.id;
        this.name = name ?? this.name;
        if (x != null) { this.rawX = x; this.x = Math.round(x); }
        if (y != null) { this.rawY = y; this.y = Math.round(y); }
        this.score = score ?? this.score;
    }

    /** @type {boolean} True once an identity has been assigned */
    get isReady() {
        return this.id !== '';
    }
}
