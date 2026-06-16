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
 * @class PddlMove
 * Navigate to target using PDDL crate-pushing when crates block the route
 */
export class PddlMove extends PlanBase {
    /**
     * Check if PDDL planning is needed (crates block all paths)
     * @param {string} intent - Intention type
     * @param {number} x - Target x coordinate
     * @param {number} y - Target y coordinate
     * @returns {boolean}
     */
    static isApplicableTo(intent, x, y) {
        if (intent !== 'go_to' || !mapHasCrates || crateTiles.length === 0) return false;
        const crateKeys = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        if (findRoute(me, { x, y }, crateKeys)) return false; // crate-free path exists
        return !!findRoute(me, { x, y });                     // reachable if crates move
    }

    /**
     * Execute PDDL crate-pushing plan
     * @param {string} intent - 'go_to'
     * @param {number} x - Target x coordinate
     * @param {number} y - Target y coordinate
     * @returns {Promise<boolean>}
     */
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

            // For push actions, capture old/new crate positions before the move.
            // Agent is at me.x/me.y; crate is one step ahead; destination is two steps ahead.
            let newCrateTile = null;
            if (isPush) {
                newCrateTile = {
                    x: Math.round(me.x) + dx * 2,
                    y: Math.round(me.y) + dy * 2,
                };
            }

            // Target tile of this step (agent advances one tile, into the crate's
            // old position on a push).
            const tx = Math.round(me.x) + dx;
            const ty = Math.round(me.y) + dy;

            const fromX = Math.round(me.x), fromY = Math.round(me.y);

            // Pre-step: if sensing added a crate to the next planned tile since this plan
            // was built (happens when the crate was outside observation range at plan time),
            // abort before moving and let execute() replan with the crate now in crateTiles.
            // Skip push steps: for those, the crate at nextKey is expected and intended —
            // the push action works by walking INTO the crate tile.
            const nextKey = rawKey(tx, ty);
            if (!isPush && crateTiles.some(c => rawKey(c.x, c.y) === nextKey)) {
                log(`crate now on planned tile ${nextKey} — replanning`);
                return true;
            }

            const tStep = Date.now();
            const r = await socket.emitMove(dir);
            if (!r) return true;

            // Wait until the agent has actually arrived before the next step — the
            // ack fires mid-transition, so continuing immediately overlaps moves
            // and drifts diagonally. `me` is updated (rounded) by onYou.
            const ok = await waitForArrival(tx, ty);
            moveLog(`${dir}${isPush ? '(push)' : ''} `
                + `(${fromX},${fromY})→(${tx},${ty}) ${ok ? 'arrived' : 'TIMEOUT'} `
                + `in ${Date.now() - tStep}ms now raw=(${me.rawX},${me.rawY}) tile=(${me.x},${me.y})`);

            // The agent just moved onto a tile — if it was tracked as a crate (the old
            // crate position after a push), remove it now.
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

            // Opportunistic pickup: grab any free parcel sitting on this tile
            // without deviating from the plan — costs only the pickup emit.
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

            // Pacing is governed by the server's movement_duration (emitMove
            // resolves only when the move completes), not a client-side sleep.
            moveTiming.record(Date.now() - tStep);
        }
        return false;
    }

    /**
     * Build PDDL problem from current world state
     * @param {string} goalTile - PDDL tile name of goal
     * @returns {string} PDDL problem definition
     */
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
