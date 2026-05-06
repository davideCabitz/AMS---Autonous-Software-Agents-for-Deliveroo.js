// context.js must be imported first — it creates the socket and belief singletons
import { socket, me, parcels, deliveryTiles, spawnerTiles, walkableTiles } from './context.js';
import { distance } from './utils/distance.js';
import { IntentionRevisionReplace } from './intentions/IntentionRevisionReplace.js';

// ─── BELIEF REVISION ──────────────────────────────────────────────────────────

socket.onYou(data => {
    me.update(data);
    console.log('[you] pos:', me.x, me.y, '| score:', me.score);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels);
    console.log('[sensing] parcels visible:', sensing.parcels.length, '| in map:', parcels.size);
    optionsGeneration();
});

// ─── OPTIONS GENERATION ───────────────────────────────────────────────────────

function optionsGeneration() {
    if (!me.isReady) { console.log('[options] me not ready yet'); return; }

    // priority 1: if carrying parcels, deliver to nearest delivery tile
    const carrying = parcels.carriedBy(me.id);
    if (carrying.length > 0) {
        const target = [...deliveryTiles]
            .sort((a, b) => distance(me, a) - distance(me, b))[0];
        if (target) {
            console.log('[options] → go_deliver to', target.x, target.y);
            myAgent.push(['go_deliver', target.x, target.y]);
            return;
        }
    }

    // priority 2: pick up the free parcel with the best reward/distance score
    const best = parcels.free()
        .map(p => ({ ...p, score: p.reward / Math.max(1, distance(me, p)) }))
        .sort((a, b) => b.score - a.score)[0];

    if (best) {
        console.log('[options] → go_pick_up', best.id, 'at', best.x, best.y, '| score:', best.score.toFixed(2));
        myAgent.push(['go_pick_up', best.x, best.y, best.id]);
        return;
    }

    // no parcels visible — patrol spawner tiles (most likely place parcels will appear)
    // fallback to random walkable tile if no spawners are known yet
    // only push if not already exploring (avoids re-rolling target every sensing tick)
    const current = myAgent.intention_queue.at(-1);
    const alreadyExploring = current && current.predicate[0] === 'go_explore';
    if (!alreadyExploring) {
        const pool = spawnerTiles.length > 0 ? spawnerTiles : walkableTiles;
        if (pool.length > 0) {
            const target = pool[Math.floor(Math.random() * pool.length)];
            console.log('[options] → go_explore (patrol spawner)', target.x, target.y);
            myAgent.push(['go_explore', target.x, target.y]);
        }
    }
}

// ─── START ────────────────────────────────────────────────────────────────────

const myAgent = new IntentionRevisionReplace();
myAgent.loop();
