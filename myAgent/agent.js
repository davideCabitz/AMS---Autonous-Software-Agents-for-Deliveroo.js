import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { Me }     from './beliefs/Me.js';
import { Parcels } from './beliefs/Parcels.js';
import { distance } from './utils/distance.js';
import { IntentionRevisionReplace } from './intentions/IntentionRevisionReplace.js';

const socket = DjsConnect();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

let OBSERVATION_DISTANCE = 5;
/** @type {{ x: number, y: number, delivery: boolean }[]} */
let deliveryTiles = [];

socket.onConfig(config => {
    OBSERVATION_DISTANCE = config.GAME.player.observation_distance;
});

socket.onMap((_w, _h, tiles) => {
    deliveryTiles = tiles.filter(t => t.delivery);
});

// ─── BELIEFS ──────────────────────────────────────────────────────────────────

const me      = new Me();
const parcels = new Parcels();

socket.onYou(data => {
    me.update(data);
    optionsGeneration();
});

socket.onSensing(sensing => {
    parcels.sync(sensing.parcels);
    optionsGeneration();
});

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function nearestDelivery() {
    return [...deliveryTiles].sort((a, b) => distance(me, a) - distance(me, b))[0];
}

// ─── OPTIONS GENERATION ───────────────────────────────────────────────────────

function optionsGeneration() {
    if (!me.isReady) return;

    // if carrying parcels, go deliver to the nearest delivery tile
    const carrying = parcels.carriedBy(me.id);
    if (carrying.length > 0) {
        const target = nearestDelivery();
        if (target) {
            myAgent.push(['go_deliver', target.x, target.y, socket]);
            return;
        }
    }

    // otherwise pick up the parcel with the best reward/distance ratio
    const best = parcels.free()
        .map(p => ({ ...p, score: p.reward / Math.max(1, distance(me, p)) }))
        .sort((a, b) => b.score - a.score)[0];

    if (best) myAgent.push(['go_pick_up', best.x, best.y, best.id, socket]);
}

// ─── START ────────────────────────────────────────────────────────────────────

const myAgent = new IntentionRevisionReplace();
myAgent.loop();
