import { missionConstraints } from '../context.js';

/*
 * Shared mutation logic for the persistent Level-2 mission constraints.
 *
 * Both processes need the exact same semantics: the coordinator applies a
 * constraint via the apply_mission/dropMission LLM tools, then mirrors it to the
 * worker over the partner protocol ({"type":"constraint",...}), and the worker
 * applies it here too. Keeping one implementation guarantees the two agents can
 * never drift on what a mission means.
 *
 * Every function returns a STRING observation (same contract as the LLM tools).
 */

/**
 * The single rule deciding whether a Level-3 routine (handoff / gather / light) is
 * "on": its running point total is NOT negative. A total of 0 — the default, and the
 * case of a mission with NO reward clause — counts as ON, because a no-reward mission
 * contributes nothing and must still be followed. Only an explicitly-stated penalty
 * (net < 0) turns the routine OFF (declines a fresh offer, stops a running one).
 */
export function armedByNet(net) {
    return net >= 0;
}

/**
 * Apply a mission-constraint config. Fields are all optional and additive:
 *   requiredStackSize (floor), maxStackSize (cap), forbiddenStackSizes (N or [N,…]),
 *   allowedDeliveryTiles [[x,y],…], allowedSpawnerTiles,
 *   avoidTiles [[x,y],…], maxParcelReward, maxBundleValue,
 *   deliveryMultipliers [[x,y,mult],…], oneShotBonus {x,y,points,perAgent?},
 *   penaltyTiles [[x,y,points],…], handoffNet/gatherNet/lightNet (signed, ADDED to
 *   the running per-type Level-3 routine total), description.
 * @param {object} config already-parsed JSON
 * @returns {string} observation
 */
export function applyMissionConfig(config) {
    const fieldsSet = [];
    if (config.requiredStackSize != null) {
        missionConstraints.requiredStackSize = Number(config.requiredStackSize);
        fieldsSet.push('requiredStackSize');
    }
    if (config.maxStackSize != null) {
        missionConstraints.maxStackSize = Number(config.maxStackSize);
        fieldsSet.push('maxStackSize');
    }
    if (config.forbiddenStackSizes != null) {
        // number | [numbers] — counts the agent must never deliver at ("deliver N =
        // penalty"). Accumulate (additive), so repeated bans stack.
        for (const n of [].concat(config.forbiddenStackSizes))
            missionConstraints.forbiddenStackSizes.add(Number(n));
        fieldsSet.push('forbiddenStackSizes');
    }
    if (config.allowedDeliveryTiles != null) {
        missionConstraints.allowedDeliveryTiles = new Set(
            config.allowedDeliveryTiles.map(([x, y]) => `${x}_${y}`)
        );
        fieldsSet.push('allowedDeliveryTiles');
    }
    if (config.allowedSpawnerTiles != null) {
        missionConstraints.allowedSpawnerTiles = new Set(
            config.allowedSpawnerTiles.map(([x, y]) => `${x}_${y}`)
        );
        fieldsSet.push('allowedSpawnerTiles');
    }
    if (Array.isArray(config.avoidTiles)) {
        for (const [x, y] of config.avoidTiles) missionConstraints.avoidTiles.add(`${x}_${y}`);
        fieldsSet.push('avoidTiles');
    }
    if (config.maxParcelReward != null) {
        missionConstraints.maxParcelReward = Number(config.maxParcelReward);
        fieldsSet.push('maxParcelReward');
    }
    if (config.maxBundleValue != null) {
        missionConstraints.maxBundleValue = Number(config.maxBundleValue);
        fieldsSet.push('maxBundleValue');
    }
    if (Array.isArray(config.deliveryMultipliers)) {
        // [[x,y,mult],…] -> Map "x_y" -> multiplier. Replaces any prior map so a
        // re-issued bonus mission supersedes the old tiles (not additive: a tile's
        // multiplier is whatever the latest mission says).
        missionConstraints.deliveryMultipliers = new Map(
            config.deliveryMultipliers.map(([x, y, m]) => [`${x}_${y}`, Number(m)])
        );
        fieldsSet.push('deliveryMultipliers');
    }
    if (config.oneShotBonus != null) {
        // { x, y, points, perAgent? } — a single go-there reward. Replaces any prior
        // bonus (only one pending at a time). The literal `points` is what the BDI
        // value functions weigh against parcel income (Strategy.bonusGoalValue).
        const b = config.oneShotBonus;
        missionConstraints.oneShotBonus = {
            x: Number(b.x), y: Number(b.y), points: Number(b.points),
            perAgent: b.perAgent === true,
        };
        fieldsSet.push('oneShotBonus');
    }
    if (Array.isArray(config.penaltyTiles)) {
        // [[x,y,points],…] — a point penalty for entering/delivering at a tile.
        // Accumulate (additive) so repeated penalty missions stack, mirroring
        // avoidTiles. Each key is ALSO hard-banned via avoidTiles so the existing
        // pathfinding exclusion does the avoidance with no new navigation code; the
        // magnitude is kept here for the worth-gate and conversational recall.
        for (const [x, y, points] of config.penaltyTiles) {
            const key = `${x}_${y}`;
            missionConstraints.penaltyTiles.set(key, Number(points));
            missionConstraints.avoidTiles.add(key);
        }
        fieldsSet.push('penaltyTiles');
    }
    // Level-3 routine net totals: ADD the offer's signed value to the running sum
    // (additive across same-type offers), so a later positive offer can outweigh an
    // earlier penalty and vice-versa. The tools read these via armedByNet to decide
    // arm / decline / stop. Absent ⇒ untouched (stays neutral).
    if (config.handoffNet != null) {
        missionConstraints.handoffNet += Number(config.handoffNet);
        fieldsSet.push('handoffNet');
    }
    if (config.gatherNet != null) {
        missionConstraints.gatherNet += Number(config.gatherNet);
        fieldsSet.push('gatherNet');
    }
    if (config.lightNet != null) {
        missionConstraints.lightNet += Number(config.lightNet);
        fieldsSet.push('lightNet');
    }

    // Tag the description with the field name(s) so the LLM can identify
    // which dropMission(field) to call later ("drop this mission").
    const baseDesc   = config.description || 'constraint applied';
    const taggedDesc = fieldsSet.length > 0 ? `${baseDesc} [${fieldsSet.join(',')}]` : baseDesc;
    missionConstraints.descriptions.push(taggedDesc);

    const active = missionConstraints.descriptions.join('; ');
    return `Mission applied. Active missions: ${active}`;
}

// [normalized key] -> [label, camelCaseName, clearFn]
const FIELD_MAP = {
    requiredstacksize:    ['Stack size floor',          'requiredStackSize',    () => { missionConstraints.requiredStackSize = null; }],
    maxstacksize:         ['Stack size cap',            'maxStackSize',         () => { missionConstraints.maxStackSize = null; }],
    forbiddenstacksizes:  ['Forbidden delivery count',  'forbiddenStackSizes',  () => { missionConstraints.forbiddenStackSizes.clear(); }],
    alloweddeliverytiles: ['Delivery tile constraint',  'allowedDeliveryTiles', () => { missionConstraints.allowedDeliveryTiles = null; }],
    allowedspawnertiles:  ['Spawner zone constraint',   'allowedSpawnerTiles',  () => { missionConstraints.allowedSpawnerTiles = null; }],
    avoidtiles:           ['Tile avoidance constraint', 'avoidTiles',           () => { missionConstraints.avoidTiles.clear(); }],
    maxparcelreward:      ['Parcel reward ceiling',     'maxParcelReward',      () => { missionConstraints.maxParcelReward = null; }],
    maxbundlevalue:       ['Bundle value ceiling',      'maxBundleValue',       () => { missionConstraints.maxBundleValue = null; }],
    deliverymultipliers:  ['Delivery multiplier bonus',  'deliveryMultipliers',  () => { missionConstraints.deliveryMultipliers = null; }],
    oneshotbonus:         ['One-shot bonus goal',        'oneShotBonus',         () => { missionConstraints.oneShotBonus = null; }],
    // Dropping the penalty also lifts the hard ban it added: remove exactly the
    // penaltyTiles keys from avoidTiles (leaving any tiles a separate avoidTiles
    // mission contributed), then clear the magnitudes.
    penaltytiles:         ['Tile penalty constraint',    'penaltyTiles',         () => {
        for (const key of missionConstraints.penaltyTiles.keys()) missionConstraints.avoidTiles.delete(key);
        missionConstraints.penaltyTiles.clear();
    }],
    handoffnet:           ['Handoff point total',       'handoffNet',           () => { missionConstraints.handoffNet = 0; }],
    gathernet:            ['Gather point total',        'gatherNet',            () => { missionConstraints.gatherNet  = 0; }],
    lightnet:             ['Light-mission point total', 'lightNet',             () => { missionConstraints.lightNet   = 0; }],
};

/**
 * Remove ONE constraint by (fuzzy) field name.
 * @param {string} field e.g. "requiredStackSize", "avoid tiles"
 * @returns {{ok: boolean, label?: string, observation: string}}
 */
export function dropMissionField(field) {
    const raw = String(field ?? '').trim();
    const key = raw.toLowerCase().replace(/[\s_-]/g, '');
    const entry = Object.entries(FIELD_MAP).find(([k]) => k === key || k.startsWith(key) || key.startsWith(k));
    if (!entry) {
        return {
            ok: false,
            observation: `Error: unknown field '${raw}'. Pass one of: requiredStackSize, maxStackSize, forbiddenStackSizes, allowedDeliveryTiles, allowedSpawnerTiles, avoidTiles, maxParcelReward, maxBundleValue, deliveryMultipliers, oneShotBonus, penaltyTiles, handoffNet, gatherNet, lightNet.`,
        };
    }
    const [, [label, camel, clear]] = entry;
    clear();
    // Remove descriptions that were tagged with this field.
    missionConstraints.descriptions = missionConstraints.descriptions.filter(
        d => !d.includes(camel)
    );
    return { ok: true, label, observation: `${label} cleared.` };
}

/**
 * Clear ALL constraints — agent restored to default behavior.
 * @returns {string} observation
 */
export function dropAllMissions() {
    missionConstraints.requiredStackSize    = null;
    missionConstraints.maxStackSize         = null;
    missionConstraints.forbiddenStackSizes.clear();
    missionConstraints.allowedDeliveryTiles = null;
    missionConstraints.allowedSpawnerTiles  = null;
    missionConstraints.avoidTiles.clear();
    missionConstraints.maxParcelReward      = null;
    missionConstraints.maxBundleValue       = null;
    missionConstraints.deliveryMultipliers  = null;
    missionConstraints.oneShotBonus         = null;
    missionConstraints.penaltyTiles.clear();
    missionConstraints.handoffNet           = 0;
    missionConstraints.gatherNet            = 0;
    missionConstraints.lightNet             = 0;
    missionConstraints.descriptions         = [];
    return 'All mission constraints cleared — agent restored to default behavior.';
}
