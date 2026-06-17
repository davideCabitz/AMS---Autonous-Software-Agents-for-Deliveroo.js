import { readFileSync }  from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { onlineSolver }   from '@unitn-asa/pddl-client';

import { PlanBase } from './PlanBase.js';
import { createLogger } from '../utils/logger.js';

const log     = createLogger('pddl');
const moveLog = createLogger('move:pddl');
import {
    me, socket, parcels, beliefset, mapHasCrates, pddl, moveTiming,
    crateTiles, crateSpawnerTiles, walkableTiles
} from '../context.js';
import { findRoute, waitForArrival } from '../utils/astar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const domain    = readFileSync(join(__dirname, '../../domain-deliveroo.pddl'), 'utf8');

// PDDL object names must start with a letter (a leading digit reads as a number), so
// tiles are t<x>_<y> and crates c<x>_<y>. rawKey is the un-prefixed "<x>_<y>" A* key.
const pTile   = (x, y) => `t${Math.round(x)}_${Math.round(y)}`;
const rawKey  = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
const crateId = (x, y) => `c${Math.round(x)}_${Math.round(y)}`;

// Plan action name -> game move direction. Walking and pushing are both one
// directional move (you push a crate by walking into it).
const ACTION_DIR = {
    right: 'right', left: 'left', up: 'up', down: 'down',
    pushright: 'right', pushleft: 'left', pushup: 'up', pushdown: 'down',
};

const MAX_REPLANS = 6;

/**
 * @class PddlMove
 * Navigate to a target via PDDL crate-pushing when crates block the route.
 */
export class PddlMove extends PlanBase {
    /**
     * Applies when crates block every crate-free path but a push could clear one
     * @param {string} intent - Intention type
     * @param {number} x - Target x
     * @param {number} y - Target y
     * @returns {boolean}
     */
    static isApplicableTo(intent, x, y) {
        if (intent !== 'go_to' || !mapHasCrates || crateTiles.length === 0) return false;
        const crateKeys = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        if (findRoute(me, { x, y }, crateKeys)) return false; // crate-free path exists
        return !!findRoute(me, { x, y });                     // reachable if crates move
    }

    /**
     * Solve and run a crate-pushing plan, replanning on mid-plan blocks
     * @param {string} intent - 'go_to'
     * @param {number} x - Target x
     * @param {number} y - Target y
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefset || beliefset.objects.length === 0) throw ['pddl-beliefset-empty'];

        const goalTile = pTile(x, y);

        for (let attempt = 0; attempt < MAX_REPLANS; attempt++) {
            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            // Build from the CURRENT state so a replan picks up new crates.
            const problem = this.#buildProblem(goalTile);

            let plan;
            try {
                plan = await onlineSolver(domain, problem);
            } catch (e) {
                throw ['pddl-solver-failed', e?.message ?? String(e)];
            }

            if (this.stopped) throw ['stopped'];
            if (!plan || plan.length === 0) throw ['pddl-no-plan'];

            // Lock: once a plan is in hand, block intention replacement until done.
            pddl.busy = true;
            let blocked;
            try {
                blocked = await this.#runPlan(plan);
            } finally {
                pddl.busy = false;
            }

            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            if (!blocked) throw ['pddl-plan-incomplete'];

            log('route blocked mid-plan — replanning from current state');
        }

        throw ['pddl-too-many-replans'];
    }

    /**
     * Execute plan steps, detecting mid-plan obstacles
     * @param {Array<Object>} plan - PDDL plan actions
     * @returns {Promise<boolean>} True if a step was blocked (replan needed)
     */
    async #runPlan(plan) {
        const DIR_DELTA = { right: [1,0], left: [-1,0], up: [0,1], down: [0,-1] };
        const ck = (x, y) => `${Math.round(x)}_${Math.round(y)}`;

        for (const step of plan) {
            if (this.stopped) throw ['stopped'];

            const actionName = String(step.action).toLowerCase();
            const dir = ACTION_DIR[actionName];
            if (!dir) continue;

            const isPush = actionName.startsWith('push');
            const [dx, dy] = DIR_DELTA[dir];

            // On a push, the crate's new position is two tiles ahead of the agent.
            let newCrateTile = null;
            if (isPush) {
                newCrateTile = {
                    x: Math.round(me.x) + dx * 2,
                    y: Math.round(me.y) + dy * 2,
                };
            }

            // This step's target (one tile ahead; the crate's old tile on a push).
            const tx = Math.round(me.x) + dx;
            const ty = Math.round(me.y) + dy;

            const fromX = Math.round(me.x), fromY = Math.round(me.y);

            // If sensing added a crate to the next planned tile since the plan was built
            // (it was out of range at plan time), abort and let execute() replan. Skip
            // push steps: there the crate at nextKey is intended (you push into it).
            const nextKey = rawKey(tx, ty);
            if (!isPush && crateTiles.some(c => rawKey(c.x, c.y) === nextKey)) {
                log(`crate now on planned tile ${nextKey} — replanning`);
                return true;
            }

            const tStep = Date.now();
            const r = await socket.emitMove(dir);
            if (!r) return true;

            // Wait for actual arrival before the next step — the ack fires mid-transition,
            // so continuing immediately overlaps moves and drifts diagonally.
            const ok = await waitForArrival(tx, ty);
            moveLog(`${dir}${isPush ? '(push)' : ''} `
                + `(${fromX},${fromY})→(${tx},${ty}) ${ok ? 'arrived' : 'TIMEOUT'} `
                + `in ${Date.now() - tStep}ms now raw=(${me.rawX},${me.rawY}) tile=(${me.x},${me.y})`);

            // If the tile just entered was tracked as a crate (the old position after a
            // push), clear it.
            const movedKey = ck(me.x, me.y);
            const staleIdx = crateTiles.findIndex(c => ck(c.x, c.y) === movedKey);
            if (staleIdx !== -1) {
                crateTiles.splice(staleIdx, 1);
                log(`cleared old crate at ${movedKey}`);
            }

            // Track where the crate landed after a push.
            if (isPush && newCrateTile) {
                const nk = ck(newCrateTile.x, newCrateTile.y);
                if (!crateTiles.some(c => ck(c.x, c.y) === nk)) {
                    crateTiles.push(newCrateTile);
                    log(`crate pushed to ${nk} — crateTiles: ${crateTiles.length}`);
                }
            }

            // Opportunistic pickup: grab any free parcel on this tile (costs only the emit).
            if (!this.stopped) {
                const mx = Math.round(me.x), my = Math.round(me.y);
                const here = parcels.free().filter(
                    p => Math.round(p.x) === mx && Math.round(p.y) === my
                );
                if (here.length > 0) {
                    const picked = await socket.emitPickup();
                    if (picked?.length > 0) {
                        for (const pp of picked) parcels.setCarriedBy(pp.id, me.id);
                        log(`opportunistic pickup [${picked.map(p => p.id).join(',')}] at ${movedKey}`);
                    }
                }
            }

            // Pacing comes from the server's movement_duration (emitMove resolves only
            // on completion), not a client-side sleep.
            moveTiming.record(Date.now() - tStep);
        }
        return false;
    }

    /**
     * Build the PDDL problem from the current world state
     * @param {string} goalTile - PDDL tile name of the goal
     * @returns {string} PDDL problem definition
     */
    #buildProblem(goalTile) {
        const myTile       = pTile(me.x, me.y);
        const crateSet     = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        // Crates push only onto crate-zone tiles (game physics), so only
        // crateSpawnerTiles get the (pushable) fact.
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
            // An occupied crate-zone tile isn't free, so it skips (free) above;
            // (pushable) without (free) is harmless (the domain requires both).
            if (crateZoneSet.has(raw)) freeFacts.push(`(pushable ${name})`);
        }

        const freePushable = [...crateZoneSet].filter(k => !crateSet.has(k));
        log(`crates: [${[...crateSet].join(', ')}]`);
        log(`crate zones (pushable): [${[...crateZoneSet].join(', ')}]`);
        log(`free pushable targets: [${freePushable.join(', ')}]`);
        log(`goal: ${goalTile} | me: ${myTile}`);

        const objects = `me ${crateObjects.join(' ')} ${beliefset.objects.join(' ')}`.trim();
        const init = [
            `(me me) (agent me) (at me ${myTile})`,
            crateFacts.join(' '),
            beliefset.toPddlString(),
            freeFacts.join(' '),
        ].filter(Boolean).join(' ');

        return `\
(define (problem deliveroo)
    (:domain default)
    (:objects ${objects})
    (:init ${init})
    (:goal (at me ${goalTile}))
)`;
    }
}
