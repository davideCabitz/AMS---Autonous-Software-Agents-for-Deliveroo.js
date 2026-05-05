export class Me {
    id = '';
    name = '';
    x = -1;
    y = -1;
    score = 0;

    update({ id, name, x, y, score }) {
        this.id = id ?? this.id;
        this.name = name ?? this.name;
        this.x = x ?? this.x;
        this.y = y ?? this.y;
        this.score = score ?? this.score;
    }

    get isReady() {
        return this.id !== '';
    }
}
