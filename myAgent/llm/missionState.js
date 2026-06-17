import { missionConstraints } from '../context.js';

/**
 * @typedef { {requiredStackSize: number|null, maxStackSize: number|null, forbiddenStackSizes: Set<number>, allowedDeliveryTiles: Set<string>|null, allowedSpawnerTiles: Set<string>|null, avoidTiles: Set<string>, maxParcelReward: number|null, maxBundleValue: number|null, minBundleValue: number|null, exactBundleValue: number|null, deliveryMultipliers: Map<string,number>|null, oneShotBonus: {x:number,y:number,points:number,perAgent:boolean}|null, penaltyTiles: Map<string,number>, handoffNet: number, gatherNet: number, lightNet: number, multiplierNet: number, descriptions: Array<string>} } MissionConstraints
 */

/**
 * Check if a Level-3 routine should be armed (net total is non-negative)
 * @param {number} net - Running net point total for the routine
 * @returns {boolean} True if the routine is armed (net >= 0 means no net penalty)
 */
export function armedByNet(net) {
    return net >= 0;
}

/**
 * Apply mission constraint configuration from LLM tools
 * @param {Object} config - Mission configuration object (already-parsed JSON)
 * @returns {string} Observation string confirming which fields were set
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
    if (config.minBundleValue != null) {
        missionConstraints.minBundleValue = Number(config.minBundleValue);
        fieldsSet.push('minBundleValue');
    }
    if (config.exactBundleValue != null) {
        missionConstraints.exactBundleValue = Number(config.exactBundleValue);
        fieldsSet.push('exactBundleValue');
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
    if (config.multiplierNet != null) {
        missionConstraints.multiplierNet += Number(config.multiplierNet);
        fieldsSet.push('multiplierNet');
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
    maxparcelreward:      ['Parcel reward ceiling',        'maxParcelReward',      () => { missionConstraints.maxParcelReward = null; }],
    maxbundlevalue:       ['Bundle value ceiling',         'maxBundleValue',       () => { missionConstraints.maxBundleValue = null; }],
    minbundlevalue:       ['Bundle value floor',           'minBundleValue',       () => { missionConstraints.minBundleValue = null; }],
    exactbundlevalue:     ['Bundle value equality',        'exactBundleValue',     () => { missionConstraints.exactBundleValue = null; }],
    deliverymultipliers:  ['Delivery multiplier bonus',    'deliveryMultipliers',  () => { missionConstraints.deliveryMultipliers = null; }],
    oneshotbonus:         ['One-shot bonus goal',        'oneShotBonus',         () => { missionConstraints.oneShotBonus = null; }],
    // Dropping the penalty also lifts the hard ban it added: remove exactly the
    // penaltyTiles keys from avoidTiles (leaving any tiles a separate avoidTiles
    // mission contributed), then clear the magnitudes.
    penaltytiles:         ['Tile penalty constraint',    'penaltyTiles',         () => {
        for (const key of missionConstraints.penaltyTiles.keys()) missionConstraints.avoidTiles.delete(key);
        missionConstraints.penaltyTiles.clear();
    }],
    handoffnet:           ['Handoff point total',            'handoffNet',      () => { missionConstraints.handoffNet    = 0; }],
    gathernet:            ['Gather point total',             'gatherNet',       () => { missionConstraints.gatherNet     = 0; }],
    lightnet:             ['Light-mission point total',      'lightNet',        () => { missionConstraints.lightNet      = 0; }],
    multipliernet:        ['Multiplier mission net total',   'multiplierNet',   () => { missionConstraints.multiplierNet = 0; }],
};

/**
 * Remove one constraint by fuzzy field name
 * @param {string} field - Field name to remove (e.g. "requiredStackSize", "avoid tiles")
 * @returns {{ok: boolean, label?: string, observation: string}} Result with success flag and message
 */
export function dropMissionField(field) {
    const raw = String(field ?? '').trim();
    const key = raw.toLowerCase().replace(/[\s_-]/g, '');
    const entry = Object.entries(FIELD_MAP).find(([k]) => k === key || k.startsWith(key) || key.startsWith(k));
    if (!entry) {
        return {
            ok: false,
            observation: `Error: unknown field '${raw}'. Pass one of: requiredStackSize, maxStackSize, forbiddenStackSizes, allowedDeliveryTiles, allowedSpawnerTiles, avoidTiles, maxParcelReward, maxBundleValue, minBundleValue, exactBundleValue, deliveryMultipliers, oneShotBonus, penaltyTiles, handoffNet, gatherNet, lightNet, multiplierNet.`,
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
 * Clear all constraints, restoring default agent behavior
 * @returns {string} Observation confirming all missions cleared
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
    missionConstraints.minBundleValue       = null;
    missionConstraints.exactBundleValue     = null;
    missionConstraints.deliveryMultipliers  = null;
    missionConstraints.oneShotBonus         = null;
    missionConstraints.penaltyTiles.clear();
    missionConstraints.handoffNet           = 0;
    missionConstraints.gatherNet            = 0;
    missionConstraints.lightNet             = 0;
    missionConstraints.descriptions         = [];
    return 'All mission constraints cleared — agent restored to default behavior.';
}
