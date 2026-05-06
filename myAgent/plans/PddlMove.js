import { readFileSync }                         from 'fs';
import { dirname, join }                        from 'path';
import { fileURLToPath }                        from 'url';
import { onlineSolver, PddlExecutor, PddlProblem } from '@unitn-asa/pddl-client';

import { PlanBase }           from './PlanBase.js';
import { me, socket, beliefset } from '../context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const domain    = readFileSync(join(__dirname, '../../domain-deliveroo.pddl'), 'utf8');

export class PddlMove extends PlanBase {
    static isApplicableTo(intent) { return intent === 'go_to'; }

    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefset || beliefset.objects.length === 0) throw ['pddl-beliefset-empty'];

        const myTile   = `${Math.round(me.x)}_${Math.round(me.y)}`;
        const goalTile = `${Math.round(x)}_${Math.round(y)}`;

        const problem = new PddlProblem(
            'deliveroo',
            `me ${beliefset.objects.join(' ')}`,
            `(me me) (agent me) (at me ${myTile}) ${beliefset.toPddlString()}`,
            `at me ${goalTile}`
        );

        let plan;
        try {
            plan = await onlineSolver(domain, problem.toPddlString());
        } catch (e) {
            throw ['pddl-solver-failed', e?.message ?? String(e)];
        }

        if (this.stopped) throw ['stopped'];
        if (!plan || plan.length === 0) throw ['pddl-no-plan'];

        const executor = new PddlExecutor(
            { name: 'right', executor: async () => { const r = await socket.emitMove('right'); if (r) { me.x = r.x; me.y = r.y; } } },
            { name: 'left',  executor: async () => { const r = await socket.emitMove('left');  if (r) { me.x = r.x; me.y = r.y; } } },
            { name: 'up',    executor: async () => { const r = await socket.emitMove('up');    if (r) { me.x = r.x; me.y = r.y; } } },
            { name: 'down',  executor: async () => { const r = await socket.emitMove('down');  if (r) { me.x = r.x; me.y = r.y; } } }
        );

        await executor.exec(plan);
        return true;
    }
}
