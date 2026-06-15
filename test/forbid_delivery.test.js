import assert from 'node:assert/strict';

/*
 * Offline logic test for the forbid_delivery resolver. It MIRRORS the pure
 * resolution + accumulation logic in myAgent/llm/commandTools.js (forbid_delivery)
 * so it can run with no server, no socket, no VPN. Keep the two in sync.
 *
 * Asserts:
 *  - named-edge convention: leftmost=min x, rightmost=max x, top=max y, bottom=min y
 *  - tie handling: every tile sitting at the extreme is excluded
 *  - inversion: allowed = (all delivery tiles) − forbidden
 *  - accumulation: a second forbid subtracts from the PRIOR allowed set
 *  - empty-set guard: forbidding the last allowed tile(s) refuses
 *
 * Run: node test/forbid_delivery.test.js
 */

const SIDES = ['leftmost', 'rightmost', 'top', 'bottom'];

/** Resolve a spec (side keyword OR "x,y"/";"-list) to forbidden "x_y" keys. */
function resolveForbidden(deliveryTiles, spec) {
    const side = String(spec).toLowerCase();
    if (SIDES.includes(side)) {
        const xs = deliveryTiles.map(t => t.x), ys = deliveryTiles.map(t => t.y);
        const PICK = {
            leftmost:  { val: Math.min(...xs), key: t => t.x },
            rightmost: { val: Math.max(...xs), key: t => t.x },
            top:       { val: Math.max(...ys), key: t => t.y },
            bottom:    { val: Math.min(...ys), key: t => t.y },
        }[side];
        return deliveryTiles.filter(t => PICK.key(t) === PICK.val).map(t => `${t.x}_${t.y}`);
    }
    return spec.split(';').map(s => s.trim()).filter(Boolean).map(part => {
        const nums = part.match(/-?\d+/g).map(Number);
        return `${nums[0]}_${nums[1]}`;
    });
}

/** allowed = (currentAllowed ?? all tiles) − forbidden; refuse on empty. */
function applyForbid(deliveryTiles, currentAllowed, spec) {
    const forbidden = new Set(resolveForbidden(deliveryTiles, spec));
    const base = currentAllowed ?? deliveryTiles.map(t => `${t.x}_${t.y}`);
    const newAllowed = base.filter(k => !forbidden.has(k));
    if (newAllowed.length === 0) return { ok: false, allowed: currentAllowed };
    return { ok: true, allowed: newAllowed };
}

const sorted = a => [...a].sort();

// Fixture: delivery tiles with a TIE on the left edge (two tiles at x=3).
const tiles = [
    { x: 3, y: 9 },   // leftmost (x=3) AND top (y=9)
    { x: 3, y: 5 },   // leftmost (x=3) tie
    { x: 7, y: 1 },   // rightmost (x=7) AND bottom (y=1)
    { x: 5, y: 5 },
];

// ── named edges + tie handling ──────────────────────────────────────────────
assert.deepEqual(sorted(resolveForbidden(tiles, 'leftmost')),  ['3_5', '3_9'], 'leftmost = least x (tie → both)');
assert.deepEqual(resolveForbidden(tiles, 'rightmost'),         ['7_1'],        'rightmost = greatest x');
assert.deepEqual(resolveForbidden(tiles, 'top'),               ['3_9'],        'top = greatest y');
assert.deepEqual(resolveForbidden(tiles, 'bottom'),            ['7_1'],        'bottom = least y');

// ── explicit coordinates + ";"-separated list ───────────────────────────────
assert.deepEqual(resolveForbidden(tiles, '3,3'),     ['3_3']);
assert.deepEqual(resolveForbidden(tiles, '3,9;7,1'), ['3_9', '7_1']);

// ── inversion: allowed = all − forbidden ────────────────────────────────────
const r1 = applyForbid(tiles, null, 'leftmost');
assert.equal(r1.ok, true);
assert.deepEqual(sorted(r1.allowed), ['5_5', '7_1'], 'allowed = all − leftmost(3_9,3_5)');

// ── accumulation: second forbid subtracts from the prior allowed set ─────────
const r2 = applyForbid(tiles, r1.allowed, 'rightmost');
assert.equal(r2.ok, true);
assert.deepEqual(sorted(r2.allowed), ['5_5'], 'accumulates: also removes rightmost 7_1');

// ── empty-set guard: forbidding the last allowed tile refuses ────────────────
const r3 = applyForbid(tiles, ['5_5'], '5,5');
assert.equal(r3.ok, false, 'forbidding the last allowed tile must refuse (no stranding)');
assert.deepEqual(r3.allowed, ['5_5'], 'on refusal the allowed set is left untouched');

// ── dry-run routing table (documentation: phrasing → expected tool) ──────────
// These are the LLM-routing expectations the taxonomy must satisfy. They are not
// executed here (they need the model), but recorded so the intent is checked by
// eye against prompt.js. None may resolve to "no tool / silent".
const DRY_RUN = [
    ['lose 50 in leftmost delivery tile',        'forbid_delivery(leftmost)'],
    ['0 pts delivering in (3,3)',                'forbid_delivery(3,3)'],
    ['never deliver in (x,y)',                   'forbid_delivery(x,y)'],
    ['5x pts in (x,y)',                          'apply_mission {"deliveryMultipliers":[[x,y,5]]}'],
    ['deliveries at the top row are penalized',  'forbid_delivery(top)'],
];
for (const [phrase, tool] of DRY_RUN) assert.ok(tool && tool !== 'silent', phrase);

console.log('forbid_delivery resolver: all assertions passed');
console.log('dry-run routing table:');
for (const [phrase, tool] of DRY_RUN) console.log(`  "${phrase}" -> ${tool}`);
