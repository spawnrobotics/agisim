// motorObs.js
import {
    MOTOR_OUTCOME_EXTRA,
    resolveAdvantageFromOutcome,
    readStandHeights,
} from './rewards/rewards.js';
import { quatUpDot, clamp11 } from './rewards/helpers.js';

/** Shared prefix every cortex sees. Keep order frozen. */
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
export const LOCAL_PLANES = 3; // qpos-like, qvel-like, last ctrl
export const OUTCOME_OBS_N = MOTOR_OUTCOME_EXTRA + 1; // + advantage

export function obsSizeForGroup(group) {
    const a = group?.actionSize | 0;
    return GLOBAL_OBS_N + LOCAL_PLANES * a + OUTCOME_OBS_N;
}

export function getObsSizes(groups) {
    return (groups || []).map(obsSizeForGroup);
}

function actuatorDof(model, actIndex) {
    const trn = model.actuator_trnid;
    if (!trn) return -1;
    const jnt = trn[actIndex * 2] | 0;
    const adr = model.jnt_dofadr;
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

function gravityBody(data) {
    const qw = Number(data.qpos[3]);
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;
    const qwSafe = Number.isFinite(qw) ? qw : 1;
    // rotate world +Z gravity into body: R^T * [0,0,-1]
    const gx = 2 * (qx * qz - qwSafe * qy);
    const gy = 2 * (qy * qz + qwSafe * qx);
    const gz = 1 - 2 * (qx * qx + qy * qy);
    return { gx, gy, gz: -gz };
}

export function readGlobalMotorState(model, data, outcome, opts = {}) {
    const heights = readStandHeights(model, data, opts.mujoco, opts);
    const qw = Number(data.qpos[3]);
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;
    const upright = quatUpDot(Number.isFinite(qw) ? qw : 1, qx, qy, qz);
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
        fallen: outcome?.fallen ? 1 : 0,
        success: outcome?.success ? 1 : 0,
    };
}

export function packGroupObservation(model, data, group, outcome, globalState) {
    const nAct = group?.actionSize | 0;
    const out = new Float32Array(obsSizeForGroup(group));
    const g = globalState;

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

    const idx = group.indices || [];
    for (let i = 0; i < nAct; i++) {
        const a = idx[i] | 0;
        out[k++] = Number(data.ctrl[a]) || 0;
    }
    for (let i = 0; i < nAct; i++) {
        const dof = actuatorDof(model, idx[i] | 0);
        out[k++] = dof >= 0 ? Number(data.qvel[dof]) || 0 : 0;
    }
    for (let i = 0; i < nAct; i++) {
        const a = idx[i] | 0;
        out[k++] = Number(data.ctrl[a]) || 0;
    }

    const o = outcome || {};
    out[k++] = Number.isFinite(Number(o.reward)) ? Number(o.reward) : 0;
    out[k++] = Math.max(0, Number(o.posSum) || 0);
    out[k++] = Math.max(0, Number(o.negSum) || 0);
    out[k++] = resolveAdvantageFromOutcome(o);
    return out;
}

export function packAllGroupObservations(model, data, groups, outcome, opts = {}) {
    const globalState = readGlobalMotorState(model, data, outcome, opts);
    return (groups || []).map((g) => ({
        header: g.header,
        id: g.id,
        actionSize: g.actionSize,
        obs: packGroupObservation(model, data, g, outcome, globalState),
    }));
}