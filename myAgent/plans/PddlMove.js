import { readFileSync }  from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { onlineSolver }   from '@unitn-asa/pddl-client';

import { PlanBase } from './PlanBase.js';
import {
    me, socket, beliefset, mapHasCrates, MOVEMENT_DURATION,
    crateTiles, crateSpawnerTiles, walkableTiles, deliveryTiles, spawnerTiles
} from '../context.js';
import { findRoute } from '../utils/astar.js';

const __dirname         = dirname(fileURLToPath(import.meta.url));
const domain            = readFileSync(join(__dirname, '../../domain-deliveroo.pddl'),  'utf8');
const problemTemplate   = readFileSync(join(__dirname, '../../problem-deliveroo.pddl'), 'utf8');

// PDDL object names must start with a letter (a leading digit is read as a number
// by the solver), so tiles are named t<x>_<y> and crates c<x>_<y>.
// rawKey is the un-prefixed "<x>_<y>" form used only as an internal A* map key.
const pTile   = (x, y) => `t${Math.round(x)}_${Math.round(y)}`;
const rawKey  = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
const crateId = (x, y) => `c${Math.round(x)}_${Math.round(y)}`;

// Plan action name -> game move direction. Walking and pushing are both a single
// directional move (you push a crate by walking into it).
const ACTION_DIR = {
    right: 'right', left: 'left', up: 'up', down: 'down',
    pushright: 'right', pushleft: 'left', pushup: 'up', pushdown: 'down',
};

const MAX_REPLANS = 6;

/**
 * Reach a target tile, pushing crates out of the way when (and only when) a crate
 * actually blocks the route. A single solver call returns the full macro-plan
 * (every push + move needed); we only contact the solver again if a new, unforeseen
 * crate blocks a step mid-execution.
 */
export class PddlMove extends PlanBase {
    // Applicable only if a crate genuinely blocks the path to the target:
    // reachable when crates are treated as removable, but NOT reachable around them.
    // If a crate-free route exists, this returns false and the cheap AStarMove runs
    // instead — so merely being near a crate never triggers the solver.
    static isApplicableTo(intent, x, y) {
        if (intent !== 'go_to' || !mapHasCrates || crateTiles.length === 0) return false;

        const crateKeys = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        // A route that avoids every crate exists -> no need to push, let A* handle it.
        if (findRoute(me, { x, y }, crateKeys)) return false;
        // Otherwise: only reachable if crates move. Worth pushing iff a route exists at all.
        return !!findRoute(me, { x, y });
    }

    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefset || beliefset.objects.length === 0) throw ['pddl-beliefset-empty'];

        const goalTile = pTile(x, y);

        for (let attempt = 0; attempt < MAX_REPLANS; attempt++) {
            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            // Build the problem from the CURRENT state (so a replan picks up new crates).
            const problem = this.#buildProblem(goalTile);

            let plan;
            try {
                plan = await onlineSolver(domain, problem);
            } catch (e) {
                throw ['pddl-solver-failed', e?.message ?? String(e)];
            }

            if (this.stopped) throw ['stopped'];
            if (!plan || plan.length === 0) throw ['pddl-no-plan'];

            // Execute the whole macro-plan; stop early only if a move is blocked.
            const blocked = await this.#runPlan(plan);

            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            // Plan ran to completion but we're not at the goal and nothing blocked us:
            // the world disagrees with our model — hand back so another plan can try.
            if (!blocked) throw ['pddl-plan-incomplete'];

            // A step was blocked (a crate appeared / shifted): loop and replan from here.
            console.log('[pddl] route blocked mid-plan — replanning from current state');
        }

        throw ['pddl-too-many-replans'];
    }

    /** Run the plan step by step. Returns true if a step was blocked (replan needed). */
    async #runPlan(plan) {
        for (const step of plan) {
            if (this.stopped) throw ['stopped'];

            const dir = ACTION_DIR[String(step.action).toLowerCase()];
            if (!dir) continue; // unknown action — skip defensively

            const r = await socket.emitMove(dir);
            if (!r) return true; // blocked by an unforeseen obstacle -> needs replan

            me.x = r.x;
            me.y = r.y;
            await new Promise(res => setTimeout(res, MOVEMENT_DURATION));
        }
        return false;
    }

    /** Encode the current world (agent, crates, free/pushable tiles) as a PDDL problem. */
    #buildProblem(goalTile) {
        const myTile       = pTile(me.x, me.y);
        const crateSet     = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        // Crates can only be pushed onto crate-zone tiles (the yellow sliding/spawner
        // tiles). Pushing onto delivery or regular walkable tiles is not allowed by the
        // game physics, so only crateSpawnerTiles get the (pushable) fact.
        const crateZoneSet = new Set(crateSpawnerTiles.map(t => `${t.x}_${t.y}`));

        const crateObjects = [];
        const crateFacts   = [];
        for (const c of crateTiles) {
            const id = crateId(c.x, c.y);
            crateObjects.push(id);
            crateFacts.push(`(crate ${id}) (at ${id} ${pTile(c.x, c.y)})`);
        }

        const freeFacts = [];
        for (const tile of walkableTiles) {
            const raw  = `${tile.x}_${tile.y}`;
            const name = `t${raw}`;
            if (!crateSet.has(raw))    freeFacts.push(`(free ${name})`);
            // A crate-zone tile that already has a crate on it is not free,
            // so it won't receive (free) above — and (pushable) without (free)
            // is harmless (the domain requires both to allow a push).
            if (crateZoneSet.has(raw)) freeFacts.push(`(pushable ${name})`);
        }

        const objects = `me ${crateObjects.join(' ')} ${beliefset.objects.join(' ')}`.trim();

        return problemTemplate
            .replace('{{OBJECTS}}',        objects)
            .replace('{{MY_TILE}}',        myTile)
            .replace('{{CRATE_FACTS}}',    crateFacts.join(' '))
            .replace('{{TOPOLOGY_FACTS}}', beliefset.toPddlString())
            .replace('{{FREE_FACTS}}',     freeFacts.join(' '))
            .replace('{{GOAL_TILE}}',      goalTile);
    }
}
