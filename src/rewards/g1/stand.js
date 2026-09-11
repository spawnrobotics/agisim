// rewards/g1/stand.js

import {
    quatUpDot,
    resolveBodyId,
    resolveNamedId,
    bodyZById,
    siteZById,
    bodyLocalZ,
} from '../helpers.js';
import { HEAD_LOCAL, G1_WALK_DEFAULTS } from './defaults.js';

export { HEAD_LOCAL, G1_WALK_DEFAULTS };
export const state = { cache: null, key: '' };

function modelKey(model) {
    return `${model?.nbody | 0}:${model?.nq | 0}`;
}

export function rotateWorldToBody(qw, qx, qy, qz, vx, vy, vz) {
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;
    return [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
}

export function readCmd3(opts) {
    const raw = opts?.cmd || opts?.robot?.cmd || [0, 0, 0];
    return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0];
}

export function readHeadCmd(opts) {
    const raw = opts?.headCmd || opts?.robot?.headCmd || [0, 0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
        Number(raw[3]) || 0,
    ];
}

export function ensureCache(model, opts = {}) {
    const key = modelKey(model);
    if (state.key === key && state.cache) return state.cache;
    const robot = opts.robot || {};
    const mj = opts.mujoco || null;
    state.key = key;
    state.cache = {
        torsoId: resolveBodyId(mj, model, robot.torsoBody || G1_WALK_DEFAULTS.torsoBody),
        headSiteId: resolveNamedId(mj, model, 'mjOBJ_SITE', robot.headSite || G1_WALK_DEFAULTS.headSite),
        headBodyId: resolveBodyId(mj, model, robot.headBody || G1_WALK_DEFAULTS.headBody),
    };
    return state.cache;
}

export function mergeG1Cfg(opts = {}, extra = {}) {
    return { ...G1_WALK_DEFAULTS, ...opts, ...extra };
}

export function resetG1RewardState() {
    state.cache = null;
    state.key = '';
}

export function readBodyVel(data, qw, qx, qy, qz) {
    return rotateWorldToBody(
        qw, qx, qy, qz,
        Number(data.qvel[0]) || 0,
        Number(data.qvel[1]) || 0,
        Number(data.qvel[2]) || 0
    );
}

export function extractG1StandReward(model, data, opts = {}) {
    const cache = ensureCache(model, opts);
    const cmd = readCmd3(opts);
    const headCmd = readHeadCmd(opts);
    const pelvis = Number(data?.qpos?.[2]) || 0;
    const off = opts.robot?.headLocal || HEAD_LOCAL;
    const head =
        siteZById(data, cache.headSiteId) ??
        bodyLocalZ(data, cache.torsoId, off.x || 0, off.y || 0, off.z || 0) ??
        bodyZById(data, cache.headBodyId) ??
        bodyZById(data, cache.torsoId) ??
        pelvis;

    const qw = Number.isFinite(Number(data.qpos[3])) ? Number(data.qpos[3]) : 1;
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;
    const upright = quatUpDot(qw, qx, qy, qz);
    const vLocal = readBodyVel(data, qw, qx, qy, qz);
    const wz = Number(data.qvel[5]) || 0;

    return {
        height: pelvis * 0.5 + head * 0.5,
        pelvisHeight: pelvis,
        headHeight: head,
        upright,
        vLocal,
        vErr: [cmd[0] - vLocal[0], cmd[1] - vLocal[1], cmd[2] - wz],
        fallen: upright < 0.15,
        onFloor: upright < 0.15 && pelvis < 0.12,
        success: false,
        hold: 0,
        sway: 0,
        holdTicks: 0,
        gene: null,
        source: 'g1-plant',
        ts: Date.now(),
        cmd,
        headCmd,
    };
}

export function isUprightStable() {
    return false;
}

export default extractG1StandReward;