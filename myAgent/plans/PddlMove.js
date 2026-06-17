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
    crateTiles, crateSpawnerTiles, walkableTiles, otherAgents,
    missionConstraints, pddlGoto, pddlGather
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

// Structural-deadlock budget: crate blocks that never clear. An agent block is
// transient (the blocker moves) and is retried separately, off this budget.
const MAX_REPLANS = 6;

// Pause before replanning around an agent that blocked a step — parity with the A*
// navigator's YIELD_PAUSE_MS (astar.js, module-private there).
const AGENT_YIELD_MS = 400;

// Overall wall-clock cap for transient agent-block retries on a mission goal, so a
// permanently-parked blocker can't loop forever; the intention being superseded
// (this.stopped) ends it sooner in practice.
const AGENT_BLOCK_TIMEOUT_MS = 30_000;

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
        if (intent !== 'go_to') return false;

        // Mission paths (env-gated): PDDL path-plans a go_to that belongs to an accepted
        // mission even with no crates blocking. Requires only that the goal is reachable;
        // on solver failure execute() throws and IntentionDeliberation falls through to
        // AStarMove (always applicable to go_to) — the transparent fallback.
        if (PddlMove.#isMissionGoTo(x, y)) return !!findRoute(me, { x, y });

        // Crate path (original): only when crates wall off every crate-free route but a
        // push could open one.
        if (!mapHasCrates || crateTiles.length === 0) return false;
        const crateKeys = new Set(crateTiles.map(c => rawKey(c.x, c.y)));
        if (findRoute(me, { x, y }, crateKeys)) return false; // crate-free path exists
        return !!findRoute(me, { x, y });                     // reachable if crates move
    }

    /**
     * Whether this go_to target is an env-enabled, LLM-accepted mission goal:
     *   PDDL_GOTO   — the active oneShotBonus coordinate (persistent acceptance record)
     *                 OR the short-lived pddl.gotoTarget set by the go_to command tool
     *                 (a direct "go there for N pts" instruction the LLM runs as a command,
     *                 not an apply_mission).
     *   PDDL_GATHER — the short-lived pddl.gatherTarget set by gather_near.
     * @param {number} x - Target x
     * @param {number} y - Target y
     * @returns {boolean}
     */
    static #isMissionGoTo(x, y) {
        const at = (t) => t && Math.round(t.x) === Math.round(x) && Math.round(t.y) === Math.round(y);
        if (pddlGoto   && (at(missionConstraints.oneShotBonus) || at(pddl.gotoTarget))) return true;
        if (pddlGather && at(pddl.gatherTarget)) return true;
        return false;
    }

    /**
     * Navigate a go_to via PDDL (crate-pushing and/or mission path-planning)
     * @param {string} intent - 'go_to'
     * @param {number} x - Target x
     * @param {number} y - Target y
     * @returns {Promise<boolean>}
     */
    async execute(intent, x, y) {
        return this.runToGoal(pTile(x, y));
    }

    /**
     * Solve and run a plan to a grounded goal tile, replanning on mid-plan blocks.
     * Crate blocks consume MAX_REPLANS (a structural dead-end gives up); agent blocks are
     * transient (the blocker moves), so they yield-and-retry the SAME goal off that budget
     * until the goal is reached, the intention is superseded, or AGENT_BLOCK_TIMEOUT_MS.
     * @param {string} goalTile - PDDL tile name of the goal (e.g. 't8_8')
     * @returns {Promise<boolean>}
     */
    async runToGoal(goalTile) {
        if (this.stopped) throw ['stopped'];
        if (!beliefset || beliefset.objects.length === 0) throw ['pddl-beliefset-empty'];

        const agentDeadline = Date.now() + AGENT_BLOCK_TIMEOUT_MS;
        let crateAttempts = 0;

        while (crateAttempts < MAX_REPLANS) {
            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            // Build from the CURRENT state so a replan picks up new crates/agents.
            const problem = this.#buildProblem(goalTile);

            let plan;
            try {
                plan = await onlineSolver(domain, problem);
            } catch (e) {
                throw ['pddl-solver-failed', e?.message ?? String(e)];
            }

            if (this.stopped) throw ['stopped'];
            if (!plan || plan.length === 0) {
                // No plan can mean the goal tile is momentarily agent-occupied (excluded
                // from free in #buildProblem). Treat that as a transient agent block and
                // retry the same goal; otherwise it's a genuine no-plan (→ A* fallback).
                const [gx, gy] = goalTile.slice(1).split('_').map(Number);
                const goalAgentBlocked = otherAgents.some(a => rawKey(a.x, a.y) === rawKey(gx, gy));
                if (goalAgentBlocked && Date.now() <= agentDeadline) {
                    log('goal tile agent-occupied — yielding then replanning to same goal');
                    await new Promise(r => setTimeout(r, AGENT_YIELD_MS));
                    continue;
                }
                throw ['pddl-no-plan'];
            }

            // Lock: once a plan is in hand, block intention replacement until done.
            pddl.busy = true;
            let status;
            try {
                status = await this.#runPlan(plan);
            } finally {
                pddl.busy = false;
            }

            if (this.stopped) throw ['stopped'];
            if (pTile(me.x, me.y) === goalTile) return true;

            if (status === 'done') throw ['pddl-plan-incomplete'];

            if (status === 'agent') {
                // Transient: do NOT consume the structural budget. Pause so the blocker can
                // move, then replan toward the same goal (the agent's tile is excluded in
                // #buildProblem, so the new plan routes around it).
                if (Date.now() > agentDeadline) throw ['pddl-agent-block-timeout'];
                log('blocked by agent — yielding then replanning to same goal');
                await new Promise(r => setTimeout(r, AGENT_YIELD_MS));
                continue;
            }

            // status === 'crate': structural — count against MAX_REPLANS.
            crateAttempts++;
            log(`route blocked by crate mid-plan — replanning (${crateAttempts}/${MAX_REPLANS})`);
        }

        throw ['pddl-too-many-replans'];
    }

    /**
     * Execute plan steps, detecting mid-plan obstacles
     * @param {Array<Object>} plan - PDDL plan actions
     * @returns {Promise<'done'|'crate'|'agent'>} 'done' if the plan ran out; otherwise the
     *   block cause: 'agent' (transient — retried off the structural budget) or 'crate'.
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
                return 'crate';
            }

            const tStep = Date.now();
            const r = await socket.emitMove(dir);
            if (!r) {
                // Move refused: classify the blocker so runToGoal retries an agent block
                // off the structural budget. An agent on the next tile ⇒ transient.
                const agentBlocked = otherAgents.some(a => rawKey(a.x, a.y) === nextKey);
                log(`step blocked at ${nextKey} by ${agentBlocked ? 'agent' : 'crate/unknown'} — replanning`);
                return agentBlocked ? 'agent' : 'crate';
            }

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
        return 'done';
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
        // Other agents are impassable: mark their tiles not-free so a replan routes around
        // a blocker instead of re-deriving the same path into it. Never our own tile.
        const agentSet     = new Set(
            otherAgents.map(a => rawKey(a.x, a.y)).filter(k => k !== rawKey(me.x, me.y))
        );

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
            // Free unless a crate or another agent occupies it (both impassable).
            if (!crateSet.has(raw) && !agentSet.has(raw)) freeFacts.push(`(free ${name})`);
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
