// motorObs.js

import { MOTOR_OUTCOME_EXTRA, readStandHeights } from './rewards/rewards.js';
import { quatUpDot, clamp11 } from './rewards/helpers.js';
import { DEFAULT_GROUP_IMU } from './motorGroups.js';

export const GLOBAL_OBS = [
    'pelvis_z',
    'head_z',
    'upright',
    'gx',
    'gy',
    'gz',
    'vx',
    'vy',
    'vz',
    'wx',
    'wy',
    'wz',
    'fallen',
    'success',
];

export const GLOBAL_OBS_N = GLOBAL_OBS.length;
export const LOCAL_PLANES = 3;
export const LIMB_IMU_N = 4;
export const OUTCOME_OBS_N = MOTOR_OUTCOME_EXTRA + 1 + 3;

const IMU_BODY_FALLBACKS = {
    left_hip: ['left_hip_roll_link', 'left_hip_pitch_link', 'left_hip_yaw_link'],
    right_hip: ['right_hip_roll_link', 'right_hip_pitch_link', 'right_hip_yaw_link'],
    left_leg: ['left_knee_link', 'left_ankle_pitch_link', 'left_ankle_roll_link'],
    right_leg: ['right_knee_link', 'right_ankle_pitch_link', 'right_ankle_roll_link'],
    waist: ['torso_link', 'pelvis'],
    pelvis: ['pelvis', 'torso_link'],
    loco: ['torso_link', 'pelvis'],
    all: ['torso_link', 'pelvis'],
    other: ['torso_link', 'pelvis'],
    left_arm: ['left_wrist_yaw_link', 'left_elbow_link', 'left_shoulder_roll_link'],
    right_arm: ['right_wrist_yaw_link', 'right_elbow_link', 'right_shoulder_roll_link'],
    left_hand: ['left_wrist_yaw_link'],
    right_hand: ['right_wrist_yaw_link'],
    left_manip: ['left_wrist_yaw_link'],
    right_manip: ['right_wrist_yaw_link'],
    arms: ['torso_link'],
    head: ['head_link', 'torso_link'],
};

export function obsSizeForGroup(group) {
    const a = group?.actionSize | 0;
    return GLOBAL_OBS_N + LOCAL_PLANES * a + LIMB_IMU_N + OUTCOME_OBS_N;
}

export function getObsSizes(groups) {
    return (groups || []).map(obsSizeForGroup);
}

export function limbImuOffset(group) {
    const a = group?.actionSize | 0;
    return GLOBAL_OBS_N + LOCAL_PLANES * a;
}

function actuatorJoint(model, actIndex) {
    const trn = model.actuator_trnid;
    if (!trn) return -1;
    return trn[actIndex * 2] | 0;
}

function actuatorDof(model, actIndex) {
    const jnt = actuatorJoint(model, actIndex);
    const adr = model.jnt_dofadr;
    if (!adr || jnt < 0) return -1;
    return adr[jnt] | 0;
}

function actuatorQpos(model, actIndex) {
    const jnt = actuatorJoint(model, actIndex);
    const adr = model.jnt_qposadr;
    if (!adr || jnt < 0) return -1;
    return adr[jnt] | 0;
}

function headingVel(qw, qx, qy, qz, vx, vy) {
    const qwSafe = Number.isFinite(qw) ? qw : 1;
    const siny = 2 * (qwSafe * qz + qx * qy);
    const cosy = 1 - 2 * (qy * qy + qz * qz);
    const yaw = Math.atan2(siny, cosy);
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    return { vx: c * vx - s * vy, vy: s * vx + c * vy };
}

function gravityFromQuat(qw, qx, qy, qz) {
    const qwSafe = Number.isFinite(qw) ? qw : 1;
    return {
        gx: 2 * (qx * qz - qwSafe * qy),
        gy: 2 * (qy * qz + qwSafe * qx),
        gz: -(1 - 2 * (qx * qx + qy * qy)),
    };
}

function gravityBody(data) {
    return gravityFromQuat(
        Number(data.qpos[3]),
        Number(data.qpos[4]) || 0,
        Number(data.qpos[5]) || 0,
        Number(data.qpos[6]) || 0
    );
}

function gravityFromXmat(xmat, base) {
    if (!xmat) return null;
    const m00 = Number(xmat[base + 0]);
    const m10 = Number(xmat[base + 3]);
    const m20 = Number(xmat[base + 6]);
    const m01 = Number(xmat[base + 1]);
    const m11 = Number(xmat[base + 4]);
    const m21 = Number(xmat[base + 7]);
    if (![m00, m10, m20, m01, m11, m21].every(Number.isFinite)) return null;
    return {
        gx: -Number(xmat[base + 2]),
        gy: -Number(xmat[base + 5]),
        gz: -Number(xmat[base + 8]),
    };
}

function bodyWorldUp(data, bodyId) {
    if (bodyId == null || bodyId < 0 || !data?.xmat) return null;
    const z = Number(data.xmat[bodyId * 9 + 8]);
    return Number.isFinite(z) ? Math.max(-1, Math.min(1, z)) : null;
}

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

function findNamedId(model, count, adrField, want) {
    const target = String(want || '');
    if (!target || !model || !(count > 0)) return -1;
    const adr = model[adrField];
    if (!adr || model.names == null) return -1;
    for (let i = 0; i < count; i++) {
        const start = adr[i] ?? adr.get?.(i);
        if (readCString(model.names, start) === target) return i;
    }
    return -1;
}

function findBodyId(model, name) {
    return findNamedId(model, model?.nbody | 0, 'name_bodyadr', name);
}

function findSiteId(model, name) {
    return findNamedId(model, model?.nsite | 0, 'name_siteadr', name);
}

function resolveGroupImuTarget(model, group) {
    const id = String(group?.id || '');
    const hint = group?.imuBody || group?.imuSite
        ? { body: group.imuBody || null, site: group.imuSite || null }
        : (DEFAULT_GROUP_IMU[id] || null);

    let siteId = hint?.site ? findSiteId(model, hint.site) : -1;
    let bodyId = hint?.body ? findBodyId(model, hint.body) : -1;

    if (bodyId < 0) {
        for (const name of IMU_BODY_FALLBACKS[id] || []) {
            bodyId = findBodyId(model, name);
            if (bodyId >= 0) break;
        }
    }
    if (bodyId < 0 && siteId >= 0 && model.site_bodyid) {
        bodyId = model.site_bodyid[siteId] | 0;
    }

    return {
        slot: group?.id || group?.header || 'mot',
        bodyId: bodyId >= 0 ? bodyId : -1,
        siteId,
        bodyName: hint?.body || null,
        siteName: hint?.site || null,
        resolved: bodyId >= 0 || siteId >= 0,
    };
}

export function limbImuForGroup(model, data, group) {
    const target = resolveGroupImuTarget(model, group);
    if (!target.resolved) {
        return {
            upright: 0, gx: 0, gy: 0, wz: 0,
            slot: target.slot,
            missing: true,
        };
    }
    const bodyId = target.bodyId | 0;
    const siteId = target.siteId | 0;

    let upright = bodyWorldUp(data, bodyId);
    let g = null;

    if (siteId >= 0 && data?.site_xmat) {
        const base = siteId * 9;
        const z = Number(data.site_xmat[base + 8]);
        if (Number.isFinite(z)) upright = Math.max(-1, Math.min(1, z));
        g = gravityFromXmat(data.site_xmat, base);
    }

    if (!g && data?.xquat && bodyId >= 0) {
        const q = bodyId * 4;
        g = gravityFromQuat(
            Number(data.xquat[q]),
            Number(data.xquat[q + 1]) || 0,
            Number(data.xquat[q + 2]) || 0,
            Number(data.xquat[q + 3]) || 0
        );
    }
    if (!g) g = gravityFromXmat(data?.xmat, bodyId * 9) || { gx: 0, gy: 0, gz: -1 };

    let wz = 0;
    if (data?.cvel && bodyId >= 0) {
        const o = bodyId * 6;
        const m = bodyId * 9;
        const wx = Number(data.cvel[o + 0]) || 0;
        const wy = Number(data.cvel[o + 1]) || 0;
        const wzW = Number(data.cvel[o + 2]) || 0;
        const ux = Number(data.xmat?.[m + 2]) || 0;
        const uy = Number(data.xmat?.[m + 5]) || 0;
        const uz = Number(data.xmat?.[m + 8]) || 1;
        wz = wx * ux + wy * uy + wzW * uz;
    }

    return {
        upright: Math.max(-1, Math.min(1, upright ?? 1)),
        gx: Number(g.gx) || 0,
        gy: Number(g.gy) || 0,
        wz,
        slot: target.slot,
        kind: 'limb',
        bodyId,
        siteId,
        bodyName: target.bodyName,
        siteName: target.siteName,
    };
}

export function readGlobalMotorState(model, data, outcome, opts = {}) {
    const heights = readStandHeights(model, data, opts.mujoco, opts);
    const qw = Number(data.qpos[3]);
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;
    const fromQuat = quatUpDot(Number.isFinite(qw) ? qw : 1, qx, qy, qz);
    const fromBody = bodyWorldUp(data, heights.torsoId);
    const upright = fromBody != null ? fromBody : fromQuat;
    const g = gravityBody(data);

    const wx = Number(data.qvel[3]) || 0;
    const wy = Number(data.qvel[4]) || 0;
    const wz = Number(data.qvel[5]) || 0;
    const vxW = Number(data.qvel[0]) || 0;
    const vyW = Number(data.qvel[1]) || 0;
    const vz = Number(data.qvel[2]) || 0;
    const h = headingVel(qw, qx, qy, qz, vxW, vyW);

    return {
        pelvis_z: heights.pelvis,
        head_z: heights.head,
        upright,
        gx: g.gx,
        gy: g.gy,
        gz: g.gz,
        vx: h.vx,
        vy: h.vy,
        vz,
        wx,
        wy,
        wz,
        fallen: outcome?.fallen || outcome?.onFloor ? 1 : 0,
        success: 0,
        onFloor: !!outcome?.onFloor,
    };
}

export function packGroupObservation(model, data, group, outcome, globalState) {
    const nAct = group?.actionSize | 0;
    const out = new Float32Array(obsSizeForGroup(group));
    const g = globalState;
    const home = group?.home || group?.defaultPose || null;
    const idx = group.indices || [];

    let k = 0;
    out[k++] = g.pelvis_z;
    out[k++] = g.head_z;
    out[k++] = g.upright;
    out[k++] = g.gx;
    out[k++] = g.gy;
    out[k++] = g.gz;
    out[k++] = g.vx;
    out[k++] = g.vy;
    out[k++] = g.vz;
    out[k++] = g.wx;
    out[k++] = g.wy;
    out[k++] = g.wz;
    out[k++] = g.fallen;
    out[k++] = g.success;

    for (let i = 0; i < nAct; i++) {
        const qadr = actuatorQpos(model, idx[i] | 0);
        const q = qadr >= 0 ? Number(data.qpos[qadr]) || 0 : 0;
        const h0 = home && Number.isFinite(Number(home[i])) ? Number(home[i]) : 0;
        out[k++] = q - h0;
    }
    for (let i = 0; i < nAct; i++) {
        const dof = actuatorDof(model, idx[i] | 0);
        out[k++] = dof >= 0 ? Number(data.qvel[dof]) || 0 : 0;
    }
    for (let i = 0; i < nAct; i++) {
        out[k++] = Number(data.ctrl[idx[i] | 0]) || 0;
    }

    const limb = limbImuForGroup(model, data, group);
    out[k++] = limb.upright;
    out[k++] = limb.gx;
    out[k++] = limb.gy;
    out[k++] = limb.wz;

    // Reserved outcome trailer. Cortex does not train on these.
    out[k++] = 0;
    out[k++] = 0;
    out[k++] = 0;
    out[k++] = 0;
    out[k++] = 0;
    out[k++] = 0;
    out[k++] = clamp11(g.wz);
    return out;
}

export function packAllGroupObservations(model, data, groups, outcome, opts = {}) {
    const globalState = readGlobalMotorState(model, data, outcome, opts);
    return (groups || []).map((g) => ({
        header: g.header,
        id: g.id,
        actionSize: g.actionSize,
        obs: packGroupObservation(model, data, g, outcome, globalState),
        limbImu: limbImuForGroup(model, data, g),
    }));
}

export { DEFAULT_GROUP_IMU };