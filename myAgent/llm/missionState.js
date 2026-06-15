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
 * Apply a mission-constraint config. Fields are all optional and additive:
 *   requiredStackSize (floor), maxStackSize (cap), allowedDeliveryTiles [[x,y],…], allowedSpawnerTiles,
 *   avoidTiles [[x,y],…], maxParcelReward, maxBundleValue,
 *   deliveryMultipliers [[x,y,mult],…], description.
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
    alloweddeliverytiles: ['Delivery tile constraint',  'allowedDeliveryTiles', () => { missionConstraints.allowedDeliveryTiles = null; }],
    allowedspawnertiles:  ['Spawner zone constraint',   'allowedSpawnerTiles',  () => { missionConstraints.allowedSpawnerTiles = null; }],
    avoidtiles:           ['Tile avoidance constraint', 'avoidTiles',           () => { missionConstraints.avoidTiles.clear(); }],
    maxparcelreward:      ['Parcel reward ceiling',     'maxParcelReward',      () => { missionConstraints.maxParcelReward = null; }],
    maxbundlevalue:       ['Bundle value ceiling',      'maxBundleValue',       () => { missionConstraints.maxBundleValue = null; }],
    deliverymultipliers:  ['Delivery multiplier bonus',  'deliveryMultipliers',  () => { missionConstraints.deliveryMultipliers = null; }],
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
            observation: `Error: unknown field '${raw}'. Pass one of: requiredStackSize, maxStackSize, allowedDeliveryTiles, allowedSpawnerTiles, avoidTiles, maxParcelReward, maxBundleValue.`,
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
    missionConstraints.allowedDeliveryTiles = null;
    missionConstraints.allowedSpawnerTiles  = null;
    missionConstraints.avoidTiles.clear();
    missionConstraints.maxParcelReward      = null;
    missionConstraints.maxBundleValue       = null;
    missionConstraints.deliveryMultipliers  = null;
    missionConstraints.descriptions         = [];
    return 'All mission constraints cleared — agent restored to default behavior.';
}
