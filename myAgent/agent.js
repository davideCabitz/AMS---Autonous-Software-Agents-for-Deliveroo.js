import {
    socket, me, parcels,
    deliveryTiles, spawnerTiles, walkableTiles,
    OBSERVATION_DISTANCE, DECAY_STEPS_PER_REWARD
} from './context.js';
import { distance }                from './utils/distance.js';
import { IntentionRevisionReplace } from './intentions/IntentionRevisionReplace.js';

const MIN_DELIVERY_REWARD    = 5;
const IDLE_WAIT_MS           = 2000; // IDLE time that agent waits on a parcel spawner, maybe other parcel will spawn and it will increase its total score
const DETOUR_SPAWNER_MAX_DIST = 5;   // extra tiles beyond OBSERVATION_DISTANCE within which a nearby unseen spawner triggers a detour

let _detourDone = false; // true once the detour has been attempted for the current delivery trip

let idleWaitStart = null; // var for tracking when the agent started waiting on a spawner.

socket.onYou(data => {
    me.update(data);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels);
    optionsGeneration();
});

function nearestDelivery(from = me) {
    return [...deliveryTiles].sort((a, b) => distance(from, a) - distance(from, b))[0];
}

function scoreOf(parcel) {
    return parcel.reward / Math.max(1, distance(me, parcel));
}

/** Here we compute the estimated reward at delivery for a given parcel */
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

// In this strategy we try to accumulate parcels in the inventory if they are worth picking up (i.e. they have a positive estimated reward at delivery),
// and only deliver when we don't have any worthwhile parcel in sensing range. The intuition is that maybe it's better to pick up multiple parcels and deliver
//  them together before the reward starts decaying, rather than delivering immediately after each pickup.

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

// Exploration plan in case if idlness. Important when in a spawner zone of parcel there is no parcel coming for 2/3s, we prioritize
// exploring other spawners NOT IN SENSING ZONE to increase the chances of finding valid parcels. RightNow this strategy is valid only if
// the agent doesn't carry any parcel, because in this case he will only deliver it to the delivery zone

function strategyNotTooGreedy() {
    const carrying = parcels.carriedBy(me.id);

    if (carrying.length === 0) _detourDone = false;

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
            console.log(`[not-too-greedy] → multi-pickup ${next.id} est:${estimatedRewardAtDelivery(next).toFixed(1)}`);
            myAgent.push(['go_pick_up', next.x, next.y, next.id]);
            return;
        }

        // One-time detour: peek at the closest spawner just outside sensing range.
        // _detourDone prevents re-entering this block for the rest of the delivery trip.
        if (!_detourDone) {
            const nearbyUnseenSpawner = spawnerTiles
                .filter(t =>
                    distance(me, t) >  OBSERVATION_DISTANCE &&
                    distance(me, t) <= OBSERVATION_DISTANCE + DETOUR_SPAWNER_MAX_DIST
                )
                .sort((a, b) => distance(me, a) - distance(me, b))[0];

            if (nearbyUnseenSpawner) {
                _detourDone = true;
                console.log(`[not-too-greedy] → detour to nearby spawner ${nearbyUnseenSpawner.x},${nearbyUnseenSpawner.y} dist:${distance(me, nearbyUnseenSpawner).toFixed(1)}`);
                myAgent.push(['go_explore', nearbyUnseenSpawner.x, nearbyUnseenSpawner.y]);
                return;
            }
        }

        // If the detour go_explore is still running, don't replace it with go_deliver yet.
        const currentIntent = myAgent.intention_queue.at(-1)?.predicate[0];
        if (_detourDone && currentIntent === 'go_explore') return;

        const target = nearestDelivery();
        if (target) {
            console.log(`[not-too-greedy] → go_deliver (${carrying.length} parcels) to ${target.x},${target.y}`);
            myAgent.push(['go_deliver', target.x, target.y]);
            return;
        }
    }

    const best = parcels.free()
        .filter(p => estimatedRewardAtDelivery(p) >= MIN_DELIVERY_REWARD)
        .sort((a, b) => scoreOf(b) - scoreOf(a))[0];

    if (best) {
        idleWaitStart = null;
        console.log(`[not-too-greedy] → go_pick_up ${best.id} score:${scoreOf(best).toFixed(2)} est:${estimatedRewardAtDelivery(best).toFixed(1)}`);
        myAgent.push(['go_pick_up', best.x, best.y, best.id]);
        return;
    }

    exploreIfIdle();
}

function exploreIfIdle() {
    const current = myAgent.intention_queue.at(-1);

    if (current) {
        const [intent, tx, ty] = current.predicate;

        if (intent === 'go_pick_up' || intent === 'go_deliver') {
            idleWaitStart = null;
            return;
        }

        if (intent === 'go_explore' && distance(me, { x: tx, y: ty }) > OBSERVATION_DISTANCE) {
            idleWaitStart = null;
            return;
        }
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

function optionsGeneration() {
    if (!me.isReady) return;

    //strategySimple();          // deliver immediately after each pickup
    strategyGreedy();          // accumulate parcels in sensing range, then deliver
    // strategyNotTooGreedy();    // like greedy but detours to nearby unseen spawners before delivering
}

const myAgent = new IntentionRevisionReplace();
myAgent.loop();
