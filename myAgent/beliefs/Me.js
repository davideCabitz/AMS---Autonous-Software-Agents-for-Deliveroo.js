/**
 * @class Me
 * Agent's own state (position, score, identity)
 */
export class Me {
    /** @type {string} Agent unique identifier */
    id = '';

    /** @type {string} Agent display name */
    name = '';

    /** @type {number} Rounded x coordinate (tile grid) */
    x = -1;

    /** @type {number} Rounded y coordinate (tile grid) */
    y = -1;

    /** @type {number} Fractional x coordinate from server (in-transit values) */
    rawX = -1;

    /** @type {number} Fractional y coordinate from server (in-transit values) */
    rawY = -1;

    /** @type {number} Current score */
    score = 0;

    /**
     * Update agent state from server message
     * @param {{id?: string, name?: string, x?: number, y?: number, score?: number}} data
     */
    update({ id, name, x, y, score }) {
        this.id = id ?? this.id;
        this.name = name ?? this.name;
        if (x != null) { this.rawX = x; this.x = Math.round(x); }
        if (y != null) { this.rawY = y; this.y = Math.round(y); }
        this.score = score ?? this.score;
    }

    /** @type {boolean} True when agent identity has been assigned */
    get isReady() {
        return this.id !== '';
    }
}
