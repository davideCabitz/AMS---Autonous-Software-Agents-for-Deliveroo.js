import {
    socket, me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, DECAY_STEPS_PER_REWARD
} from './context.js';
import { distance }                from './utils/distance.js';
import { IntentionRevisionReplace } from './intentions/IntentionRevisionReplace.js';

const MIN_DELIVERY_REWARD = 5;
const IDLE_WAIT_MS        = 2000; // ms to wait before exploring away (skipped when on a spawner)

let idleWaitStart = null; // timestamp when agent became idle at a spawner

// ─── BELIEF REVISION ──────────────────────────────────────────────────────────

socket.onYou(data => {
    me.update(data);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels);
    optionsGeneration();
});

// ─── SHARED UTILITIES ─────────────────────────────────────────────────────────

function nearestDelivery(from = me) {
    return [...deliveryTiles].sort((a, b) => distance(from, a) - distance(from, b))[0];
}

function scoreOf(parcel) {
    return parcel.reward / Math.max(1, distance(me, parcel));
}

/**
 * Reward still available when the agent reaches the parcel then delivers it.
 * Reward decays −1 every DECAY_STEPS_PER_REWARD movement steps.
 */
function estimatedRewardAtDelivery(parcel) {
    const toParcel   = distance(me, parcel);
    const delTile    = nearestDelivery(parcel);
    const toDelivery = delTile ? distance(parcel, delTile) : Infinity;
    return parcel.reward - Math.ceil((toParcel + toDelivery) / DECAY_STEPS_PER_REWARD);
}

// ─── STRATEGY 1: simple (deliver as soon as carrying, pick best parcel) ───────

function strategySimple() {
    const carrying = parcels.carriedBy(me.id);

    if (carrying.length > 0) {
        idleWaitStart = null;
        const target = nearestDelivery();
        if (target) {
            console.log(`[simple] → go_deliver to ${target.x},${target.y}`);
            myAgent.push(['go_deliver', target.x, target.y]);
            return;
        }
    }

    const best = parcels.free()
        .map(p => ({ ...p, score: scoreOf(p) }))
        .sort((a, b) => b.score - a.score)[0];

    if (best) {
        idleWaitStart = null;
        console.log(`[simple] → go_pick_up ${best.id} score:${best.score.toFixed(2)}`);
        myAgent.push(['go_pick_up', best.x, best.y, best.id]);
        return;
    }

    exploreIfIdle();
}

// ─── STRATEGY 2: greedy multi-pickup (accumulate parcels, then deliver) ───────

function strategyGreedy() {
    const carrying = parcels.carriedBy(me.id);

    // Parcels in sensing range still worth picking up
    const worthwhileInRange = parcels.free()
        .filter(p =>
            distance(me, p) <= OBSERVATION_DISTANCE &&
            estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD
        )
        .sort((a, b) => scoreOf(b) - scoreOf(a));

    if (carrying.length > 0) {
        idleWaitStart = null;
        if (worthwhileInRange.length > 0) {
            const next = worthwhileInRange[0];
            console.log(`[greedy] → multi-pickup ${next.id} est:${estimatedRewardAtDelivery(next).toFixed(1)}`);
            myAgent.push(['go_pick_up', next.x, next.y, next.id]);
            return;
        }

        const target = nearestDelivery();
        if (target) {
            console.log(`[greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
            myAgent.push(['go_deliver', target.x, target.y]);
            return;
        }
    }

    const best = parcels.free()
        .filter(p => estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD)
        .sort((a, b) => scoreOf(b) - scoreOf(a))[0];

    if (best) {
        idleWaitStart = null;
        console.log(`[greedy] → go_pick_up ${best.id} score:${scoreOf(best).toFixed(2)} est:${estimatedRewardAtDelivery(best).toFixed(1)}`);
        myAgent.push(['go_pick_up', best.x, best.y, best.id]);
        return;
    }

    exploreIfIdle();
}

// ─── EXPLORATION (shared) ─────────────────────────────────────────────────────

function exploreIfIdle() {
    const current = myAgent.intention_queue.at(-1);

    if (current) {
        const [intent, tx, ty] = current.predicate;

        // never interrupt an active pickup or delivery
        if (intent === 'go_pick_up' || intent === 'go_deliver') {
            idleWaitStart = null;
            return;
        }

        // already heading to an out-of-range spawner — still moving, not idle
        if (intent === 'go_explore' && distance(me, { x: tx, y: ty }) > OBSERVATION_DISTANCE) {
            idleWaitStart = null;
            return;
        }

        // explore target is now inside vision → agent has arrived, start idle timer below
    }

    // On a spawner tile — wait 2 s for a parcel to potentially spawn
    const onSpawner = spawnerTiles.some(
        t => Math.round(me.x) === t.x && Math.round(me.y) === t.y
    );

    if (onSpawner) {
        if (idleWaitStart === null) {
            idleWaitStart = Date.now();
            console.log('[explore] on spawner — waiting 2 s for parcel to appear');
            return;
        }
        if (Date.now() - idleWaitStart < IDLE_WAIT_MS) return;
    }

    idleWaitStart = null;

    const pool       = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
    const outOfRange = pool.filter(t => distance(me, t) > OBSERVATION_DISTANCE);
    const candidates = outOfRange.length > 0 ? outOfRange : pool;

    const target = [...candidates].sort((a, b) => distance(me, a) - distance(me, b))[0];
    if (target) {
        console.log(`[explore] → out-of-range spawner ${target.x},${target.y} dist:${distance(me, target)}`);
        myAgent.push(['go_explore', target.x, target.y]);
    }
}

// ─── ACTIVE STRATEGY — comment/uncomment to switch ───────────────────────────

function optionsGeneration() {
    if (!me.isReady) return;

    //strategySimple();   // deliver immediately after each pickup
     strategyGreedy();   // accumulate parcels in sensing range, then deliver
}

// ─── START ────────────────────────────────────────────────────────────────────

const myAgent = new IntentionRevisionReplace();
myAgent.loop();
