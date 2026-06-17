import { missionConstraints } from '../context.js';

/**
 * @typedef { {requiredStackSize: number|null, maxStackSize: number|null, forbiddenStackSizes: Set<number>, allowedDeliveryTiles: Set<string>|null, allowedSpawnerTiles: Set<string>|null, avoidTiles: Set<string>, maxParcelReward: number|null, maxBundleValue: number|null, minBundleValue: number|null, exactBundleValue: number|null, deliveryMultipliers: Map<string,number>|null, oneShotBonus: {x:number,y:number,points:number,perAgent:boolean}|null, penaltyTiles: Map<string,number>, handoffNet: number, gatherNet: number, lightNet: number, multiplierNet: number, descriptions: Array<string>} } MissionConstraints
 */

/**
 * Whether a Level-3 routine should be armed (net total non-negative)
 * @param {number} net - Running net point total
 * @returns {boolean} True if armed (net >= 0, no net penalty)
 */
export function armedByNet(net) {
    return net >= 0;
}

/**
 * Apply mission constraint configuration from LLM tools
 * @param {Object} config - Already-parsed mission config
 * @returns {string} Observation confirming which fields were set
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
        // Counts the agent must never deliver at ("deliver N = penalty"); additive.
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
        // [[x,y,mult],…] -> Map "x_y" -> multiplier. Replaces any prior map (not
        // additive): a tile's multiplier is whatever the latest mission says.
        missionConstraints.deliveryMultipliers = new Map(
            config.deliveryMultipliers.map(([x, y, m]) => [`${x}_${y}`, Number(m)])
        );
        fieldsSet.push('deliveryMultipliers');
    }
    if (config.oneShotBonus != null) {
        // { x, y, points, perAgent? } — a single go-there reward; replaces any prior
        // one. `points` is what the BDI value functions weigh against parcel income.
        const b = config.oneShotBonus;
        missionConstraints.oneShotBonus = {
            x: Number(b.x), y: Number(b.y), points: Number(b.points),
            perAgent: b.perAgent === true,
        };
        fieldsSet.push('oneShotBonus');
    }
    if (Array.isArray(config.penaltyTiles)) {
        // [[x,y,points],…] — a point penalty for entering/delivering at a tile; additive.
        // Each key is ALSO hard-banned via avoidTiles (reusing the pathfinding exclusion);
        // the magnitude is kept here for the worth-gate and recall.
        for (const [x, y, points] of config.penaltyTiles) {
            const key = `${x}_${y}`;
            missionConstraints.penaltyTiles.set(key, Number(points));
            missionConstraints.avoidTiles.add(key);
        }
        fieldsSet.push('penaltyTiles');
    }
    // Level-3 net totals: ADD the offer's signed value to the running sum, so a later
    // offer can outweigh an earlier one. Tools read these via armedByNet to arm/decline/
    // stop. Absent ⇒ untouched.
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

    // Tag the description with field name(s) so the LLM knows which dropMission(field)
    // to call later.
    const baseDesc   = config.description || 'constraint applied';
    const taggedDesc = fieldsSet.length > 0 ? `${baseDesc} [${fieldsSet.join(',')}]` : baseDesc;
    missionConstraints.descriptions.push(taggedDesc);

    const active = missionConstraints.descriptions.join('; ');
    return `Mission applied. Active missions: ${active}`;
}

// normalized key -> [label, camelCaseName, clearFn]
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
    // Dropping the penalty also lifts the ban it added: remove only the penaltyTiles
    // keys from avoidTiles (keeping any from a separate avoidTiles mission), then clear.
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
 * @param {string} field - Field to remove (e.g. "requiredStackSize", "avoid tiles")
 * @returns {{ok: boolean, label?: string, observation: string}} Success flag + message
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
    // Remove descriptions tagged with this field.
    missionConstraints.descriptions = missionConstraints.descriptions.filter(
        d => !d.includes(camel)
    );
    return { ok: true, label, observation: `${label} cleared.` };
}

/**
 * Clear all constraints, restoring default behavior
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
