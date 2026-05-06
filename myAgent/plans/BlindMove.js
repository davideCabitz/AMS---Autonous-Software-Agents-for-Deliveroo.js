import { PlanBase } from './PlanBase.js';
import { me, socket } from '../context.js';

export class BlindMove extends PlanBase {
    static isApplicableTo(intent) {
        return intent === 'go_to';
    }

    async execute(intent, x, y) {
        while (me.x !== x || me.y !== y) {
            if (this.stopped) throw ['stopped'];

            let movedH, movedV;

            if (x > me.x)      movedH = await socket.emitMove('right');
            else if (x < me.x) movedH = await socket.emitMove('left');

            if (movedH) { me.x = movedH.x; me.y = movedH.y; }

            if (this.stopped) throw ['stopped'];

            if (y > me.y)      movedV = await socket.emitMove('up');
            else if (y < me.y) movedV = await socket.emitMove('down');

            if (movedV) { me.x = movedV.x; me.y = movedV.y; }

            if (!movedH && !movedV) throw 'stuck';
        }
        return true;
    }
}
