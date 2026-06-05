export class Me {
    id = '';
    name = '';
    x = -1;
    y = -1;
    // Raw (un-rounded) coordinates as reported by the server. While a move is in
    // transit the server reports fractional values (0.6 then 0.4 split), so these
    // only equal an integer once the move has fully completed. Used by the mover's
    // arrival wait to pace movement tile-by-tile. Beliefs/scoring/A* use x/y.
    rawX = -1;
    rawY = -1;
    score = 0;

    update({ id, name, x, y, score }) {
        this.id = id ?? this.id;
        this.name = name ?? this.name;
        // Round to the tile grid for beliefs: the fractional in-transit values must
        // never leak into scoring / A* / position comparisons.
        if (x != null) { this.rawX = x; this.x = Math.round(x); }
        if (y != null) { this.rawY = y; this.y = Math.round(y); }
        this.score = score ?? this.score;
    }

    get isReady() {
        return this.id !== '';
    }
}
