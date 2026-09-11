// motorGroups.js

/** 1 = all, 2 = loco / arms, 3 = loco / L arm / R arm, 5+ = legs / waist / arms */
export const MOTOR_GROUP_MODE = 3;

export const DEFAULT_GROUP_IMU = {
    left_leg: { body: 'left_ankle_roll_link', site: null },
    right_leg: { body: 'right_ankle_roll_link', site: null },
    waist: { body: 'pelvis', site: 'imu_in_pelvis' },
    pelvis: { body: 'pelvis', site: 'imu_in_pelvis' },
    loco: { body: 'pelvis', site: 'imu_in_pelvis' },
    all: { body: 'pelvis', site: 'imu_in_pelvis' },
    other: { body: 'pelvis', site: 'imu_in_pelvis' },
    left_arm: { body: 'left_wrist_yaw_link', site: null },
    right_arm: { body: 'right_wrist_yaw_link', site: null },
    left_hand: { body: 'left_wrist_yaw_link', site: null },
    right_hand: { body: 'right_wrist_yaw_link', site: null },
    left_manip: { body: 'left_wrist_yaw_link', site: null },
    right_manip: { body: 'right_wrist_yaw_link', site: null },
    arms: { body: 'torso_link', site: 'imu_in_torso' },
    head: { body: 'torso_link', site: 'head' },
};

function imuForId(id) {
    return DEFAULT_GROUP_IMU[id] || DEFAULT_GROUP_IMU.other;
}

function logGroupImu(groups) {
    const rows = (groups || []).map((g) => ({
        header: g.header,
        id: g.id,
        role: g.role,
        acts: g.actionSize,
        imuBody: g.imuBody || null,
        imuSite: g.imuSite || null,
        mapped: !!(g.imuBody || g.imuSite),
    }));
    const missing = rows.filter((r) => !r.mapped);
    console.log('[MotorGroups] IMU map', rows);
    if (missing.length) {
        console.warn('[MotorGroups] groups without IMU target', missing.map((r) => r.id));
    }
    return rows;
}

const GROUP_DEFS = [
    {
        id: 'left_leg',
        match: [
            /^left_hip/i,
            /(^|_)l_hip/i,
            /left_.*hip/i,
            /^left_(knee|ankle)/i,
            /(^|_)l_(knee|ankle)/i,
            /left_.*(knee|ankle)/i,
        ],
    },
    {
        id: 'right_leg',
        match: [
            /^right_hip/i,
            /(^|_)r_hip/i,
            /right_.*hip/i,
            /^right_(knee|ankle)/i,
            /(^|_)r_(knee|ankle)/i,
            /right_.*(knee|ankle)/i,
        ],
    },
    {
        id: 'waist',
        match: [
            /^(waist|torso_joint|pelvis_joint)/i,
        ],
    },
    {
        id: 'left_hand',
        match: [/left_.*(hand|finger|thumb|palm|gripper)/i],
    },
    {
        id: 'right_hand',
        match: [/right_.*(hand|finger|thumb|palm|gripper)/i],
    },
    {
        id: 'left_arm',
        match: [/^left_(shoulder|elbow|wrist)/i, /left_.*(shoulder|elbow|wrist)/i],
    },
    {
        id: 'right_arm',
        match: [/^right_(shoulder|elbow|wrist)/i, /right_.*(shoulder|elbow|wrist)/i],
    },
];

const HAND_IDS = new Set(['left_hand', 'right_hand']);
const ARM_IDS = new Set(['left_arm', 'right_arm']);
const MANIP_IDS = new Set([
    ...HAND_IDS,
    ...ARM_IDS,
    'left_manip',
    'right_manip',
    'arms',
]);
const LEG_IDS = new Set(['left_leg', 'right_leg', 'loco']);
const WAIST_IDS = new Set(['waist', 'loco', 'pelvis']);

const LOCO_MERGE_IDS = new Set([
    'left_leg', 'right_leg', 'waist', 'pelvis', 'other',
]);
const LEFT_ARM_MERGE_IDS = new Set(['left_arm', 'left_hand', 'left_manip']);
const RIGHT_ARM_MERGE_IDS = new Set(['right_arm', 'right_hand', 'right_manip']);
const ARMS_MERGE_IDS = new Set([
    ...LEFT_ARM_MERGE_IDS,
    ...RIGHT_ARM_MERGE_IDS,
    'arms',
]);

function readCString(names, start) {
    if (names == null || start == null || start < 0) return '';
    if (typeof names === 'string') {
        const end = names.indexOf('\0', start);
        return names.slice(start, end < 0 ? undefined : end);
    }
    const bytes = names.subarray ? names : new Uint8Array(names.buffer || names);
    let s = start | 0;
    if (s < 0 || s >= bytes.length) return '';
    let e = s;
    while (e < bytes.length && bytes[e] !== 0) e++;
    return new TextDecoder().decode(bytes.subarray(s, e));
}

export function actuatorName(model, i) {
    try {
        const adr = model.name_actuatoradr || model.actuator_nameadr;
        if (adr && model.names != null) {
            const start = adr[i] ?? adr.get?.(i);
            const name = readCString(model.names, start);
            if (name) return name;
        }
    } catch (_) { /* ignore */ }
    return `act_${i}`;
}

export function listActuators(model) {
    const out = [];
    const n = model?.nu | 0;
    for (let i = 0; i < n; i++) out.push({ index: i, name: actuatorName(model, i) });
    return out;
}

function matchesGroup(name, def) {
    return def.match.some((re) => re.test(String(name || '')));
}

function roleFor(id) {
    if (id === 'all' || id === 'loco') return 'loco';
    if (HAND_IDS.has(id)) return 'hand';
    if (id === 'arms' || ARM_IDS.has(id) || id === 'left_manip' || id === 'right_manip') {
        return 'manip';
    }
    if (LEG_IDS.has(id)) return 'leg';
    if (WAIST_IDS.has(id)) return 'waist';
    if (id === 'head') return 'gaze';
    return 'other';
}

function finalizeGroup(def, indices, names, index = 1) {
    const imu = imuForId(def.id);
    return {
        id: def.id,
        name: def.id,
        indices,
        names,
        actionSize: indices.length,
        role: roleFor(def.id),
        index,
        header: `MOT${index}`,
        imuBody: imu.body || null,
        imuSite: imu.site || null,
    };
}

function reindex(groups) {
    for (let g = 0; g < groups.length; g++) {
        groups[g].index = g + 1;
        groups[g].header = `MOT${g + 1}`;
    }
    return groups;
}

function mergeGroups(parts, id) {
    const indices = [];
    const names = [];
    const seen = new Set();
    for (const g of parts) {
        for (let i = 0; i < g.indices.length; i++) {
            const idx = g.indices[i];
            if (seen.has(idx)) continue;
            seen.add(idx);
            indices.push(idx);
            names.push(g.names[i]);
        }
    }
    if (!indices.length) return null;
    return finalizeGroup({ id }, indices, names, 1);
}

function createSingleGroup(model) {
    const n = model.nu | 0;
    const indices = [];
    const names = [];
    for (let i = 0; i < n; i++) {
        indices.push(i);
        names.push(actuatorName(model, i));
    }
    return [finalizeGroup({ id: 'all' }, indices, names, 1)];
}

function createFineGroups(model) {
    const n = model.nu | 0;
    const assigned = new Set();
    const groups = [];

    for (const def of GROUP_DEFS) {
        const indices = [];
        const names = [];
        for (let i = 0; i < n; i++) {
            if (assigned.has(i)) continue;
            const name = actuatorName(model, i);
            if (!matchesGroup(name, def)) continue;
            indices.push(i);
            names.push(name);
            assigned.add(i);
        }
        if (!indices.length) continue;
        groups.push(finalizeGroup(def, indices, names, groups.length + 1));
    }

    const restIdx = [];
    const restNames = [];
    for (let i = 0; i < n; i++) {
        if (assigned.has(i)) continue;
        restIdx.push(i);
        restNames.push(actuatorName(model, i));
    }
    if (restIdx.length) {
        groups.push(finalizeGroup({ id: 'other' }, restIdx, restNames, groups.length + 1));
    }

    return reindex(groups);
}

function foldHandsIntoArms(groups) {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const used = new Set();
    const out = [];

    for (const g of groups) {
        if (used.has(g.id)) continue;
        if (g.id === 'left_hand') {
            const merged = mergeGroups([byId.get('left_arm'), g].filter(Boolean), 'left_arm');
            if (merged) {
                out.push(merged);
                used.add('left_arm');
                used.add('left_hand');
            }
            continue;
        }
        if (g.id === 'right_hand') {
            const merged = mergeGroups([byId.get('right_arm'), g].filter(Boolean), 'right_arm');
            if (merged) {
                out.push(merged);
                used.add('right_arm');
                used.add('right_hand');
            }
            continue;
        }
        if ((g.id === 'left_arm' && byId.has('left_hand')) ||
            (g.id === 'right_arm' && byId.has('right_hand'))) {
            continue;
        }
        used.add(g.id);
        out.push(g);
    }

    return reindex(out);
}

function createThreeGroups(fine) {
    const loco = mergeGroups(fine.filter((g) => LOCO_MERGE_IDS.has(g.id)), 'loco');
    const left = mergeGroups(fine.filter((g) => LEFT_ARM_MERGE_IDS.has(g.id)), 'left_arm');
    const right = mergeGroups(fine.filter((g) => RIGHT_ARM_MERGE_IDS.has(g.id)), 'right_arm');
    return reindex([loco, left, right].filter(Boolean));
}

function createTwoGroups(fine) {
    const loco = mergeGroups(fine.filter((g) => LOCO_MERGE_IDS.has(g.id)), 'loco');
    const arms = mergeGroups(fine.filter((g) => ARMS_MERGE_IDS.has(g.id)), 'arms');
    return reindex([loco, arms].filter(Boolean));
}

export function createMotorGroups(model, mode = MOTOR_GROUP_MODE) {
    if (!model || !(model.nu > 0)) return [];
    const n = Number(mode) || MOTOR_GROUP_MODE;
    let groups;
    if (n <= 1) groups = createSingleGroup(model);
    else {
        const fine = createFineGroups(model);
        if (n === 2) groups = createTwoGroups(fine);
        else if (n === 3) groups = createThreeGroups(fine);
        else groups = foldHandsIntoArms(fine);
    }
    logGroupImu(groups);
    return groups;
}

export function getActionSizes(groups) {
    return (groups || []).map((g) => g.actionSize);
}

export function findGroupByHeader(groups, header) {
    const h = String(header || '').toUpperCase();
    if (h === 'MOTO' || h === 'MOTR') return groups?.[0] || null;
    return (groups || []).find((g) => g.header === h) || null;
}

export function findGroupById(groups, id) {
    return (groups || []).find((g) => g.id === id) || null;
}

export function findGroupByRole(groups, role) {
    return (groups || []).find((g) => g.role === role) || null;
}

export function getLegGroups(groups) {
    return (groups || []).filter((g) =>
        g.role === 'leg' ||
        g.id === 'left_leg' ||
        g.id === 'right_leg'
    );
}

export function getLeftLegGroup(groups) {
    return findGroupById(groups, 'left_leg') || null;
}

export function getRightLegGroup(groups) {
    return findGroupById(groups, 'right_leg') || null;
}

export function getWaistGroup(groups) {
    return (
        findGroupById(groups, 'waist') ||
        findGroupById(groups, 'loco') ||
        findGroupByRole(groups, 'waist') ||
        findGroupByRole(groups, 'loco') ||
        groups?.[0] ||
        null
    );
}

export function getLocoGroup(groups) {
    return findGroupById(groups, 'loco') || findGroupByRole(groups, 'loco') || getWaistGroup(groups);
}

export function getArmGroups(groups) {
    return (groups || []).filter((g) => ARM_IDS.has(g.id) || g.id === 'arms' || g.role === 'manip');
}

export function getHandGroups(groups) {
    return (groups || []).filter((g) => HAND_IDS.has(g.id) || g.role === 'hand');
}

export function getManipGroups(groups) {
    return (groups || []).filter((g) => g.role === 'manip' || g.role === 'hand' || MANIP_IDS.has(g.id));
}

export function getGazeGroup(groups) {
    return findGroupById(groups, 'head') || findGroupByRole(groups, 'gaze') || null;
}

export function assertGroupsCoverNu(groups, nu) {
    const n = nu | 0;
    const seen = new Set();
    for (const g of groups || []) {
        for (const i of g.indices || []) {
            if (seen.has(i)) return { ok: false, reason: `dup index ${i}` };
            seen.add(i);
        }
    }
    if (seen.size !== n) return { ok: false, reason: `covered ${seen.size}/${n}` };
    return { ok: true };
}

export { GROUP_DEFS, HAND_IDS, ARM_IDS, MANIP_IDS, LEG_IDS, WAIST_IDS };
export const SINGLE_GROUP = MOTOR_GROUP_MODE <= 1;
export default createMotorGroups;