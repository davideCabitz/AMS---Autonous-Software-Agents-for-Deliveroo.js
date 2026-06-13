import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles, directive, trafficLight, manualHold, moveTiming } from '../context.js';
import { reachableFrom, findRoute } from '../utils/astar.js';
import { applyMissionConfig, dropMissionField, dropAllMissions } from './missionState.js';
import { partner, sendOrder, sendHalt, sendResume, sendConstraint, requestStatus } from './partner.js';
import { startHandoff, stopHandoff } from './handoff.js';

/*
 * Tool catalogue for the LLM command layer. Every tool returns a STRING
 * observation (including failures) so the ReAct loop can reason about the result.
 *
 * Three kinds of tools:
 *  - reasoning (pure): calculate, get_current_time — no world effect.
 *  - read: get_my_position, sense_parcels, sense_delivery_tiles — read beliefs.
 *  - command: go_to, go_pickup, deliver — push a BDI intention and AWAIT its
 *    completion (the BDI plan library does the actual A-star/PDDL navigation). There
 *    is deliberately NO raw move/pick_up actuator: the LLM commands, BDI executes.
 *  - chat: say — reply to the directive sender.
 */

// Safety net: a wedged navigation must never block the agent for long. The agent
// is only "gated" (BDI paused) while a command actually runs, so keep this short.
const COMMAND_TIMEOUT_MS = 30_000;
// Cap on the wait tool so a bad number can't freeze the agent indefinitely.
const MAX_WAIT_SECONDS = 30;

// ---- reasoning tools (copied from llmAgent/tools.js; that module must NOT be
// imported because it opens a second socket via its own context.js) ------------

function calculate(expression) {
    // Strip surrounding quotes, then allow several comma-separated expressions in
    // one call (e.g. "(0+18)/2, (0+19)/2" for a centre tile -> "9, 9.5").
    const raw = String(expression ?? '').trim().replace(/^["']|["']$/g, '');
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return 'Error: empty expression.';
    const results = [];
    for (const expr of parts) {
        if (!/^[\d\s+\-*/().]+$/.test(expr))
            return `Error: invalid expression '${expr}'. Only numbers and + - * / ( ) are allowed.`;
        try {
            const result = Function(`"use strict"; return (${expr});`)();
            if (typeof result !== 'number' || !Number.isFinite(result))
                return `Error: '${expr}' did not evaluate to a finite number.`;
            results.push(String(result));
        } catch (err) {
            return `Error: ${err.message}`;
        }
    }
    return results.join(', ');
}

function get_current_time(location) {
    const where = String(location ?? 'Rome').trim() || 'Rome';
    const timezone = 'Europe/Rome';
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    return JSON.stringify({ location: where, timezone, time });
}

// ---- helpers ------------------------------------------------------------------

/** Parse "5,3" / "(5, 3)" / "x=5 y=3" / "5 3" into {x,y} (numbers) or {x:null}. */
function parseXY(input) {
    const nums = String(input ?? '').match(/-?\d+/g);
    if (!nums || nums.length < 2) return { x: null, y: null };
    return { x: parseInt(nums[0], 10), y: parseInt(nums[1], 10) };
}

/** A known free parcel sitting on (x,y), highest reward first; null if none. */
function resolveParcelId(x, y) {
    const here = parcels.free().filter(p => Math.round(p.x) === x && Math.round(p.y) === y);
    if (!here.length) return null;
    return here.sort((a, b) => b.reward - a.reward)[0].id;
}

/** Keep only tiles the agent can actually reach from its current position, so
 *  "leftmost/rightmost/nearest X" directives never resolve to a walled-off tile.
 *  Falls back to the full list if nothing is reachable (so a tool never lies by
 *  returning empty when tiles do exist). */
function onlyReachable(tiles) {
    const reach = reachableFrom(me);
    const filtered = tiles.filter(t => reach.has(`${t.x}_${t.y}`));
    return filtered.length ? filtered : tiles;
}

/** Nearest delivery tile to the agent (Manhattan), or null if none known. */
function nearestDelivery() {
    if (!deliveryTiles.length) return null;
    return deliveryTiles
        .map(t => ({ t, d: Math.abs(t.x - me.x) + Math.abs(t.y - me.y) }))
        .sort((a, b) => a.d - b.d)[0].t;
}

/** Sleep for `ms` milliseconds, but resolve early if directive.aborted is set.
 *  Returns how many ms actually elapsed. */
function abortableDelay(ms) {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (directive.aborted || Date.now() >= start + ms) resolve(Date.now() - start);
            else setTimeout(tick, 100);
        };
        setTimeout(tick, Math.min(100, ms));
    });
}

function withTimeout(promise, ms, tag) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(['timeout', tag]), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** emitSay that can neither throw nor hang. The SDK promise resolves only when
 *  the server acks; a disconnected recipient can leave it pending FOREVER, which
 *  wedged the whole serialized directive lane. The chat is best-effort — bound
 *  it and move on. @returns {Promise<boolean>} delivered (ack within timeout) */
async function safeSay(target, text, ms = 5_000) {
    if (!target) return false;
    try {
        await withTimeout(socket.emitSay(target, text), ms, 'say');
        return true;
    } catch {
        return false;
    }
}

/** Map an intention rejection tag to a readable observation. */
function describeFailure(err) {
    const tag = Array.isArray(err) ? err[0] : err;
    switch (tag) {
        case 'stopped':      return 'Failed: the command was interrupted before completing.';
        case 'no path to':   return `Failed: target (${err[1]},${err[2]}) is unreachable — a wall, or a tile currently occupied/blocked by an agent.`;
        case 'goal blocked': return `Failed: target (${err[1]},${err[2]}) is blocked by another agent.`;
        case 'busy':         return 'Failed: agent is finishing a previous plan; try again in a moment.';
        case 'timeout':      return `Failed: command timed out after ${COMMAND_TIMEOUT_MS}ms.`;
        case 'no plan for':  return `Failed: no plan applies to ${err.slice(1).join(' ')}.`;
        default:
            if (typeof tag === 'string' && tag.startsWith('pddl-'))
                return `Failed: navigation planner error (${tag}).`;
            return `Failed: ${Array.isArray(err) ? err.join(' ') : String(err)}`;
    }
}

// ---- tool catalogue -----------------------------------------------------------

/* Reasoning + read tools — safe to expose anywhere because they have NO world
 * effect. Shared by the action toolset (buildTools) and the read-only
 * conversational toolset (buildChatTools). */
function readTools() {
    return {
        // reasoning
        async calculate(input)        { return calculate(input); },
        async get_current_time(input) { return get_current_time(input); },

        // read
        async get_my_position() {
            if (me.x == null || me.y == null) return 'Position not available yet.';
            return JSON.stringify({ x: me.x, y: me.y, score: me.score });
        },
        async sense_parcels() {
            const free = parcels.free();
            return free.length
                ? JSON.stringify(free.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward })))
                : 'No free parcels currently in view.';
        },
        async sense_delivery_tiles() {
            if (!deliveryTiles.length) return 'No delivery tiles known yet.';
            return JSON.stringify(onlyReachable(deliveryTiles).map(t => ({ x: t.x, y: t.y })));
        },
        async sense_spawn_tiles() {
            if (!spawnerTiles.length) return 'No spawn tiles known yet.';
            return JSON.stringify(onlyReachable(spawnerTiles).map(t => ({ x: t.x, y: t.y })));
        },
        async get_map_info() {
            if (!walkableTiles.length) return 'Map not loaded yet.';
            // Report only reachable tiles so edges are the reachable extremes.
            const reach = onlyReachable(walkableTiles);
            const xs = reach.map(t => t.x);
            const ys = reach.map(t => t.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const at = (pred) => reach.filter(pred).map(t => ({ x: t.x, y: t.y }));
            // Reachable tiles on each extreme, so "leftmost/rightmost/top/bottom tile"
            // directives resolve to a real tile the agent can get to, not a guess.
            return JSON.stringify({
                bounds: { minX, maxX, minY, maxY },
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                counts: { delivery: deliveryTiles.length, spawn: spawnerTiles.length, walkable: walkableTiles.length },
                edges: {
                    leftmost:  at(t => t.x === minX),
                    rightmost: at(t => t.x === maxX),
                    bottom:    at(t => t.y === minY),
                    top:       at(t => t.y === maxY),
                },
            });
        },
    };
}

/** Read-only toolset for the conversational fast-lane: observe + answer, but
 *  NEVER move the agent or touch the autonomy gate, so it is safe to run
 *  concurrently with an action directive. */
export function buildChatTools() {
    return {
        ...readTools(),
        // Read-only and safe concurrently with an action directive: it only sends
        // a status_req over chat. The chat lane needs it so partner position/cargo
        // questions are answered live, never from memory.
        async ask_partner_status() { return requestStatus(); },
    };
}

export function buildTools(myAgent, replySender, resumeAutonomy) {
    // Run a BDI command. The gate is released OPTIMISTICALLY the instant each
    // command finishes (see finally) rather than being held through the whole
    // directive: otherwise the autonomy gate stays shut across the confirmation
    // round-trip (the LLM call that decides whether another command follows), and
    // on a single-command directive like "go to the bottom spawn" the agent idles
    // at the destination for seconds instead of letting its strategy start picking
    // up parcels. If the LLM does issue a follow-up command, this helper re-takes
    // the gate and halts whatever the strategy began during the gap, so each
    // command still starts from a clean state.
    //
    // Trade-off vs. holding the gate: the agent may do its own BDI work — and thus
    // physically move — during the inter-command think. A move-then-stay sequence
    // ("go to X, then hold/wait/put_down") can drift in that gap before the
    // stationary command re-grabs. Stationary commands manage their own gate and
    // don't go through this helper.
    const command = async (predicate, ok) => {
        if (trafficLight.red)
            return 'Failed: RED LIGHT in force — movement is forbidden until the GREEN LIGHT message.';
        directive.active = true;                       // (re)take control
        myAgent.haltCurrent();                         // drop any BDI intention started in the gap
        try {
            await withTimeout(myAgent.commandAndAwait(predicate), COMMAND_TIMEOUT_MS, predicate[0]);
            return ok();                               // built while the gate is still ours (live pos)
        } catch (err) {
            return describeFailure(err);
        } finally {
            // Hand control back to BDI immediately; a follow-up command re-takes it above.
            directive.active = false;
            resumeAutonomy?.();
        }
    };

    return {
        ...readTools(),

        // command
        async go_to(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_to needs "x,y" (got '${input}').`;
            return command(['go_to', x, y], () => `Arrived at (${me.x}, ${me.y}).`);
        },
        async go_pickup(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: go_pickup needs "x,y" (got '${input}').`;
            const id = resolveParcelId(x, y);
            // Known parcel -> proper go_pick_up (updates beliefs by id). Unknown ->
            // navigate there and try a blind pickup anyway: a parcel may have spawned
            // during the walk, or sit outside the last sensing snapshot.
            const predicate = id != null ? ['go_pick_up', x, y, id] : ['go_to', x, y];
            return command(predicate, () => {
                const carrying = parcels.carriedBy(me.id).length;
                if (id != null)
                    return `Picked up parcel ${id} at (${x},${y}); now carrying ${carrying}.`;
                return socket.emitPickup().then(picked =>
                    picked?.length
                        ? `Picked up ${picked.length} parcel(s) at (${x},${y}); now carrying ${carrying + picked.length}.`
                        : `Reached (${x},${y}) but no parcel here. To wait for one to spawn: wait(5), sense_parcels, retry.`);
            });
        },
        async pickup_next_parcel() {
            // "Pick up the next parcel": release the autonomy gate and let the
            // SELECTED BDI STRATEGY hunt — it explores spawners and reacts to
            // sensing in real time (picks up the instant a parcel enters range),
            // which no LLM wait/sense polling loop can match. We watch the carried
            // set and take control back the moment a NEW parcel id appears.
            if (trafficLight.red)
                return 'Failed: RED LIGHT in force — movement is forbidden until the GREEN LIGHT message.';
            const before = new Set(parcels.carriedBy(me.id).map(p => p.id));
            directive.active = false;
            resumeAutonomy?.();
            while (!directive.aborted) {
                const fresh = parcels.carriedBy(me.id).find(p => !before.has(p.id));
                if (fresh) {
                    directive.active = true;        // take control back from BDI
                    myAgent.haltCurrent();          // it may already be heading off to deliver
                    return `Picked up parcel ${fresh.id} at (${me.x},${me.y}); now carrying ${parcels.carriedBy(me.id).length}.`;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            return 'Failed: the command was interrupted before completing.';
        },
        async deliver(input) {
            const carrying = parcels.carriedBy(me.id).length;
            if (carrying === 0) return 'Nothing to deliver (not carrying any parcel).';
            // Optional "x,y" → deliver at that specific tile (e.g. "deliver in 1,1"
            // missions); without coordinates fall back to the nearest delivery tile.
            const { x, y } = parseXY(input);
            let t;
            if (x != null) {
                t = deliveryTiles.find(d => d.x === x && d.y === y);
                if (!t) return `Failed: (${x},${y}) is not a delivery tile. Call sense_delivery_tiles to list them.`;
            } else {
                t = nearestDelivery();
                if (!t) return 'Failed: no delivery tile known. Call sense_delivery_tiles first.';
            }
            return command(['go_deliver', t.x, t.y], () =>
                `Delivered at (${t.x},${t.y}); score now ${me.score}.`);
        },
        async put_down() {
            // Drop cargo on the CURRENT tile without navigating anywhere. On a plain
            // tile this is a handoff drop (no score); on a delivery tile it scores.
            const carried = parcels.carriedBy(me.id);
            if (carried.length === 0) return 'Nothing to put down (not carrying any parcel).';
            // Gate autonomy: without this, BDI resumes the instant the directive ends
            // and re-picks the parcel from under us — the drop looks like a no-op.
            directive.active = true;
            myAgent.haltCurrent();
            // Pass the explicit id list: the SDK default is [] and the server treats
            // an empty selection as "nothing", not "everything".
            const dropped = await withTimeout(
                socket.emitPutdown(carried.map(p => p.id)), 5_000, 'putdown'
            ).catch(() => null);
            if (!dropped || dropped.length === 0)
                return 'Failed: the server did not confirm the drop.';
            for (const p of carried) parcels.remove(p.id);
            return `Dropped ${dropped.length} parcel(s) at (${me.x},${me.y}).`;
        },
        async path_cost(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: path_cost needs "x,y" (got '${input}').`;
            const route = findRoute(me, { x, y });
            if (!route) return `Unreachable: no path from (${me.x},${me.y}) to (${x},${y}).`;
            const steps = route.length;
            return JSON.stringify({
                steps,
                estSeconds: +(steps * moveTiming.msPerTile / 1000).toFixed(1),
                decayLostPerCarriedParcel: +(steps * moveTiming.decayPerTile()).toFixed(1),
            });
        },
        async wait(input) {
            const n = String(input ?? '').match(/-?\d+(\.\d+)?/);
            const secs = Math.max(0, Math.min(MAX_WAIT_SECONDS, n ? parseFloat(n[0]) : 0));
            directive.active = true;                   // hold still (gate held until directive ends)
            myAgent.haltCurrent();
            const elapsed = await abortableDelay(secs * 1000);
            if (directive.aborted)
                return `Wait interrupted after ${(elapsed / 1000).toFixed(1)}s (directive aborted).`;
            return `Waited ${secs} second(s) holding position at (${me.x}, ${me.y}).`;
        },
        async hold() {
            // Indefinite hold: persists AFTER the directive ends (unlike wait), until
            // release_hold. For "go there and wait for each other" missions.
            manualHold.active = true;
            myAgent.haltCurrent();
            return `Holding position at (${me.x}, ${me.y}) indefinitely — use release_hold to resume.`;
        },
        async release_hold() {
            manualHold.active = false;
            resumeAutonomy?.();
            return 'Hold released — autonomous work resumed.';
        },
        // chat
        async say(input) {
            const text = String(input ?? '');
            const ok = await safeSay(replySender, text);
            return ok ? `Said to ${replySender}: ${text}`
                      : `Sent to ${replySender ?? 'console'} (delivery not confirmed): ${text}`;
        },

        // partner (the second, worker agent) — orders run on the worker and return
        // its result; they do NOT move this agent, so autonomy here is not gated.
        async order_partner_goto(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: order_partner_goto needs "x,y" (got '${input}').`;
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            return sendOrder(['go_to', x, y]);
        },
        async order_partner_pickup(input) {
            const { x, y } = parseXY(input);
            if (x == null) return `Error: order_partner_pickup needs "x,y" (got '${input}').`;
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            return sendOrder(['go_pick_up', x, y]);
        },
        async order_partner_deliver(input) {
            const { x, y } = parseXY(input);
            if (trafficLight.red) return 'Failed: RED LIGHT in force — the partner must not move either.';
            if (x != null) return sendOrder(['go_deliver', x, y]);
            // No coordinates: send the worker to the delivery tile nearest ITS position.
            const wpos = partner.lastStatus ?? me;
            const t = deliveryTiles.length
                ? [...deliveryTiles].sort((a, b) =>
                    (Math.abs(a.x - wpos.x) + Math.abs(a.y - wpos.y)) - (Math.abs(b.x - wpos.x) + Math.abs(b.y - wpos.y)))[0]
                : null;
            if (!t) return 'Failed: no delivery tile known. Call sense_delivery_tiles first.';
            return sendOrder(['go_deliver', t.x, t.y]);
        },
        async order_partner_putdown() {
            return sendOrder(['putdown']);
        },
        async halt_partner()   { return sendHalt(); },
        async resume_partner() { return sendResume(); },
        async ask_partner_status() { return requestStatus(); },

        // cross-agent handoff routine ("one picks up, the other delivers" missions)
        async start_handoff() { return startHandoff(myAgent, resumeAutonomy); },
        async stop_handoff()  { return stopHandoff(); },

        // Level-2 persistent mission management. The mutation logic lives in
        // missionState.js (shared with the worker); every change is mirrored to
        // the partner so persistent missions bind BOTH agents.
        async apply_mission(input) {
            let config;
            try { config = JSON.parse(String(input ?? '{}')); }
            catch { return `Error: expected JSON — e.g. {"requiredStackSize":3}. Got: ${input}`; }

            const obs = applyMissionConfig(config);
            sendConstraint('apply', config);
            return obs;
        },

        async dropMissions() {
            const obs = dropAllMissions();
            sendConstraint('dropAll');
            return obs;
        },

        async restrict_exploration(input) {
            const zone = String(input ?? '').trim().toLowerCase();
            if (!['left', 'right', 'top', 'bottom'].includes(zone))
                return `Error: unknown zone '${zone}'. Use: left, right, top, bottom.`;
            if (!spawnerTiles.length) return 'Error: spawner tiles not loaded yet.';
            const xs  = walkableTiles.map(t => t.x), ys = walkableTiles.map(t => t.y);
            const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
            const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
            const FILTERS = {
                left:   t => t.x <= midX,
                right:  t => t.x >  midX,
                top:    t => t.y >  midY,
                bottom: t => t.y <= midY,
            };
            const filtered = spawnerTiles.filter(FILTERS[zone]);
            if (!filtered.length) return `Error: no spawner tiles found in the ${zone} half.`;
            applyMissionConfig({
                allowedSpawnerTiles: filtered.map(t => [t.x, t.y]),
                description: `explore only ${zone}-half spawners`,
            });
            sendConstraint('apply', {
                allowedSpawnerTiles: filtered.map(t => [t.x, t.y]),
                description: `explore only ${zone}-half spawners`,
            });
            return `Spawner zone restricted to ${zone} half (${filtered.length} spawners).`;
        },

        async dropMission(input) {
            const { ok, label, observation } = dropMissionField(input);
            if (!ok) return observation;
            sendConstraint('drop', input);
            return observation;
        },
    };
}
