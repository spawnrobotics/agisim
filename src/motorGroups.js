// motorGroups.js

const GROUP_DEFS = [
    { id: 'left_arm', match: [/left_.*(shoulder|elbow)/i] },
    { id: 'right_arm', match: [/right_.*(shoulder|elbow)/i] },
    { id: 'left_hand', match: [/left_.*(wrist|hand|finger)/i] },
    { id: 'right_hand', match: [/right_.*(wrist|hand|finger)/i] },
    { id: 'left_leg', match: [/left_.*(hip|knee|ankle)/i] },
    { id: 'right_leg', match: [/right_.*(hip|knee|ankle)/i] },
    { id: 'head', match: [/(^|_)(neck|head|beak|jaw|mouth)(_|$)/i] },
    { id: 'torso', match: [/(waist|torso|pelvis|trunk)/i] },
];

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
    for (let i = 0; i < n; i++) {
        out.push({ index: i, name: actuatorName(model, i) });
    }
    return out;
}

function matchesGroup(name, def) {
    const s = String(name || '');
    return def.match.some((re) => re.test(s));
}

export function createMotorGroups(model) {
    if (!model || !(model.nu > 0)) return [];

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
        groups.push({
            id: def.id,
            name: def.id,
            indices,
            names,
            actionSize: indices.length,
        });
    }

    const restIdx = [];
    const restNames = [];
    for (let i = 0; i < n; i++) {
        if (assigned.has(i)) continue;
        restIdx.push(i);
        restNames.push(actuatorName(model, i));
    }
    if (restIdx.length) {
        groups.push({
            id: 'other',
            name: 'other',
            indices: restIdx,
            names: restNames,
            actionSize: restIdx.length,
        });
    }

    // Compact headers after dropping empty groups: MOT1…MOTN
    for (let g = 0; g < groups.length; g++) {
        groups[g].index = g + 1;
        groups[g].header = `MOT${g + 1}`;
    }

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

export default createMotorGroups;