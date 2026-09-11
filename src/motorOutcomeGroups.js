// motorOutcomeGroups.js
// Outcome is metadata only: which group this packet belongs to.
// No reward / advantage / pos-neg / hold-scale plant.
// Per-group signal is the limb IMU slice in motorObs.js.

export function isLegGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return role === 'leg' || id === 'left_leg' || id === 'right_leg';
}

export function isWaistGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return role === 'waist' || id === 'waist' || id === 'pelvis';
}

export function isLocoGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return (
        role === 'loco' ||
        isLegGroup(group) ||
        isWaistGroup(group) ||
        id === 'loco' ||
        id === 'all'
    );
}

export function isArmGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return (
        role === 'manip' ||
        id === 'left_arm' ||
        id === 'right_arm' ||
        id === 'left_manip' ||
        id === 'right_manip' ||
        id === 'arms'
    );
}

export function isHandGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return role === 'hand' || id === 'left_hand' || id === 'right_hand';
}

export function isGazeGroup(group) {
    const id = String(group?.id || '');
    const role = group?.role;
    return role === 'gaze' || id === 'head';
}

/**
 * Stamp slot / header / IMU body onto the shared outcome.
 * Does not change reward fields — those are unused by motor cortex.
 */
export function outcomeForGroup(group, outcome = null) {
    const o = outcome && typeof outcome === 'object' ? outcome : {};
    if (!group) return o;
    return {
        ...o,
        slot: group.id || group.name || o.slot || null,
        groupId: group.id || o.groupId || null,
        header: group.header || o.header || null,
        role: group.role || o.role || null,
        imuBody: group.imuBody || null,
        imuSite: group.imuSite || null,
        kind: 'limb',
    };
}

export default outcomeForGroup;