import { PlanBase } from './PlanBase.js';

export class BlindMove extends PlanBase {
    /** @param {object} me - shared belief reference */
    constructor(parent, me) {
        super(parent);
        this.me = me;
    }

    static isApplicableTo(intent) {
        return intent === 'go_to';
    }

    async execute(intent, x, y, socket) {
        while (this.me.x !== x || this.me.y !== y) {
            if (this.stopped) throw ['stopped'];

            let movedH, movedV;

            if (x > this.me.x)      movedH = await socket.emitMove('right');
            else if (x < this.me.x) movedH = await socket.emitMove('left');

            if (movedH) { this.me.x = movedH.x; this.me.y = movedH.y; }

            if (this.stopped) throw ['stopped'];

            if (y > this.me.y)      movedV = await socket.emitMove('up');
            else if (y < this.me.y) movedV = await socket.emitMove('down');

            if (movedV) { this.me.x = movedV.x; this.me.y = movedV.y; }

            if (!movedH && !movedV) throw 'stuck';
        }
        return true;
    }
}
