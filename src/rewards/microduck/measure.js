// rewards/duck/measure.js

import {
    quatUpDot,
    clamp01,
    rmsArray,
    resolveBodyId,
    resolveNamedId,
    mjId2Name,
    bodyZById,
    siteZById,
} from '../helpers.js';
import { DUCK_REWARD_DEFAULTS, HEAD_JOINTS } from './defaults.js';

export const state = {
    key: '',
    cache: null,
    prevCtrl: null,
    contact: [0, 0],
    airTime: [0, 0],
    headEma: [0, 0, 0, 0],
    holdTicks: 0,
    lastPelvis: null,
    lastHead: null,
    lastUpright: null,
};

export function gauss2(err2, sig2) {
    return Math.exp(-Math.max(0, err2) / Math.max(1e-8, sig2));
}

function modelKey(model) {
    return `${model?.nbody | 0}:${model?.nq | 0}:${model?.nu | 0}`;
}

function jointFamily(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('hip_yaw')) return 'hip_yaw';
    if (n.includes('hip_roll')) return 'hip_roll';
    if (n.includes('hip_pitch')) return 'hip_pitch';
    if (n.includes('knee')) return 'knee';
    return 'ankle';
}

function isPassive(name) {
    const n = String(name || '').toLowerCase();
    return n.startsWith('passive_') || n.includes('backlash');
}

function isHeadJoint(name) {
    const n = String(name || '').toLowerCase();
    return n.includes('neck') || n.includes('head');
}

function namesMatch(got, want) {
    const g = String(got || '').toLowerCase();
    const w = String(want || '').toLowerCase();
    if (!g || !w) return false;
    if (g === w || g.includes(w)) return true;
    return w.split('_').every((p) => p && g.includes(p));
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

export function tiltDegFromQuat(qx, qy) {
    const tilt2 = 2 * (qx * qx + qy * qy);
    const c = Math.max(-1, Math.min(1, 1 - tilt2));
    return (Math.acos(c) * 180) / Math.PI;
}

export function swayTerm(w, vLocal, cfg) {
    const wx = Number(w?.[0]) || 0;
    const wy = Number(w?.[1]) || 0;
    const vz = Number(vLocal?.[2]) || 0;
    const sx = cfg.swayWx ?? DUCK_REWARD_DEFAULTS.swayWx;
    const sy = cfg.swayWy ?? DUCK_REWARD_DEFAULTS.swayWy;
    const sz = cfg.swayVz ?? DUCK_REWARD_DEFAULTS.swayVz;
    return clamp01(
        (wx * wx) / (sx * sx) +
        (wy * wy) / (sy * sy) +
        Math.max(0, -vz) / Math.max(1e-3, sz)
    );
}

export function softSway(sway, cfg) {
    const dz = Math.max(0, Number(cfg.swayDeadzone) || 0);
    if (dz <= 0) return clamp01(sway);
    return clamp01((Math.max(0, sway) - dz) / Math.max(1e-3, 1 - dz));
}

function listServoJoints(mujoco, model) {
    const nj = model?.njnt | 0;
    const out = [];
    for (let j = 0; j < nj; j++) {
        const typ = model.jnt_type?.[j] | 0;
        if (typ !== 2 && typ !== 3) continue;
        const name = String(mjId2Name(mujoco, model, 'mjOBJ_JOINT', j) || '');
        if (isPassive(name)) continue;
        const qadr = model.jnt_qposadr?.[j];
        const vadr = model.jnt_dofadr?.[j];
        if (qadr == null || qadr < 0) continue;
        out.push({
            j,
            name,
            qadr: qadr | 0,
            vadr: vadr == null ? -1 : vadr | 0,
            qpos0: Number(model.qpos0?.[qadr]) || 0,
            family: jointFamily(name),
            head: isHeadJoint(name),
        });
    }
    return out;
}

function applyStandHomes(joints, robot) {
    const names = robot?.policy?.joints || robot?.joints || DUCK_REWARD_DEFAULTS.standJoints;
    const pose = robot?.policy?.pose || robot?.pose || DUCK_REWARD_DEFAULTS.standPose;
    const n = Math.min(names.length, pose.length);
    for (let i = 0; i < n; i++) {
        const want = names[i];
        const hit = joints.find((j) => namesMatch(j.name, want));
        if (hit) hit.home = Number(pose[i]) || 0;
    }
    for (const j of joints) {
        if (j.home == null) j.home = j.qpos0;
    }
    return joints;
}

function resolveFeet(mujoco, model, names) {
    const found = [];
    const seen = new Set();
    for (const name of names) {
        const id = resolveBodyId(mujoco, model, name);
        if (id >= 0 && !seen.has(id)) {
            seen.add(id);
            found.push({ id, name });
        }
        if (found.length >= 2) break;
    }
    if (found.length >= 2) return found;

    const nb = model?.nbody | 0;
    for (let i = 1; i < nb && found.length < 2; i++) {
        const n = String(mjId2Name(mujoco, model, 'mjOBJ_BODY', i) || '').toLowerCase();
        if (!n.includes('ankle') && !n.includes('foot')) continue;
        if (seen.has(i)) continue;
        seen.add(i);
        found.push({ id: i, name: n });
    }
    return found;
}

function buildCache(mujoco, model, robot) {
    const joints = applyStandHomes(listServoJoints(mujoco, model), robot);
    const head = [];
    for (const pat of HEAD_JOINTS) {
        const hit = joints.find((j) => j.name.toLowerCase().includes(pat));
        if (hit) head.push(hit);
    }
    const torsoName = robot?.torsoBody || DUCK_REWARD_DEFAULTS.torsoBody;
    return {
        joints,
        legs: joints.filter((j) => !j.head),
        head,
        feet: resolveFeet(mujoco, model, robot?.footBodies || DUCK_REWARD_DEFAULTS.footBodies),
        torsoId: resolveBodyId(mujoco, model, torsoName),
        headSiteId: robot?.headSite
            ? resolveNamedId(mujoco, model, 'mjOBJ_SITE', robot.headSite)
            : -1,
        headBodyId: robot?.headBody
            ? resolveBodyId(mujoco, model, robot.headBody)
            : -1,
    };
}

export function ensureCache(model, opts) {
    const key = modelKey(model);
    if (state.key !== key || !state.cache) {
        state.key = key;
        state.cache = buildCache(opts.mujoco || null, model, opts.robot || {});
        state.prevCtrl = null;
        state.contact = [0, 0];
        state.airTime = [0, 0];
        state.headEma = [0, 0, 0, 0];
        state.holdTicks = 0;
        state.lastPelvis = null;
        state.lastHead = null;
        state.lastUpright = null;
    }
    return state.cache;
}

export function mergeDuckCfg(opts = {}, extra = {}) {
    const stand = opts.robot?.stand && typeof opts.robot.stand === 'object'
        ? opts.robot.stand
        : {};
    const policy = opts.robot?.policy && typeof opts.robot.policy === 'object'
        ? opts.robot.policy
        : {};
    const reward = opts.robot?.reward && typeof opts.robot.reward === 'object'
        ? opts.robot.reward
        : {};
    return {
        ...DUCK_REWARD_DEFAULTS,
        ...stand,
        ...reward,
        ...opts,
        ...extra,
        pelvisFloor: policy.floorPelvis ?? stand.pelvisFloor ?? DUCK_REWARD_DEFAULTS.pelvisFloor,
        floorUpright: policy.floorUpright ?? stand.sideUpright ?? DUCK_REWARD_DEFAULTS.floorUpright,
    };
}

export function readCmd3(cfg) {
    const raw = Array.isArray(cfg?.cmd) ? cfg.cmd : [0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
    ];
}

export function readHeadCmd(cfg) {
    const raw = Array.isArray(cfg?.headCmd) ? cfg.headCmd : [0, 0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
        Number(raw[3]) || 0,
    ];
}

export function footContact(data, foot, zCut) {
    const z = bodyZById(data, foot.id);
    if (z == null) return 0;
    return z <= zCut ? 1 : 0;
}

export function footSpeedXY(data, foot) {
    if (!data?.cvel || foot.id < 0) return 0;
    const o = foot.id * 6;
    const vx = Number(data.cvel[o + 3]) || 0;
    const vy = Number(data.cvel[o + 4]) || 0;
    return Math.hypot(vx, vy);
}

export function resetDuckRewardState() {
    state.prevCtrl = null;
    state.contact = [0, 0];
    state.airTime = [0, 0];
    state.headEma = [0, 0, 0, 0];
    state.holdTicks = 0;
    state.lastPelvis = null;
    state.lastHead = null;
    state.lastUpright = null;
}

export function publishReward(score, onFloor, cfg) {
    if (onFloor) {
        const floor = Number(cfg.floorReward ?? cfg.floorRewardCap ?? -1);
        return Math.max(-1, Math.min(0, floor));
    }
    return Math.max(0, Math.min(1, Number(score) || 0));
}

export function measureDuck(model, data, opts, cfg) {
    const cache = ensureCache(model, opts);
    const dt = Number(cfg.dt) > 0 ? Number(cfg.dt) : DUCK_REWARD_DEFAULTS.dt;

    const qw = Number.isFinite(Number(data.qpos[3])) ? Number(data.qpos[3]) : 1;
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;

    const vW = [
        Number(data.qvel[0]) || 0,
        Number(data.qvel[1]) || 0,
        Number(data.qvel[2]) || 0,
    ];
    const w = [
        Number(data.qvel[3]) || 0,
        Number(data.qvel[4]) || 0,
        Number(data.qvel[5]) || 0,
    ];
    const vLocal = rotateWorldToBody(qw, qx, qy, qz, vW[0], vW[1], vW[2]);
    const sway = swayTerm(w, vLocal, cfg);
    const swayPen = softSway(sway, cfg);

    const [vxCmd, vyCmd, wzCmd] = readCmd3(cfg);
    const wantMove = Math.hypot(vxCmd, vyCmd, wzCmd) > (cfg.cmdEps ?? DUCK_REWARD_DEFAULTS.cmdEps);

    const trackLin = gauss2(
        (vLocal[0] - vxCmd) ** 2 + (vLocal[1] - vyCmd) ** 2,
        cfg.sigLin2
    );
    const trackAng = gauss2((w[2] - wzCmd) ** 2, cfg.sigAng2);

    const rollDeg = Math.abs(2 * qx) * (180 / Math.PI);
    const pitchDeg = Math.abs(2 * qy) * (180 / Math.PI);
    const pitchAllow = wantMove
        ? (cfg.pitchAllowWalkDeg ?? DUCK_REWARD_DEFAULTS.pitchAllowWalkDeg)
        : (cfg.pitchAllowStandDeg ?? DUCK_REWARD_DEFAULTS.pitchAllowStandDeg);
    const pitchExcessDeg = Math.max(0, pitchDeg - pitchAllow);
    const tilt2 = 2 * (qx * qx + qy * qy);
    const uprightGauss = gauss2(
        (2 * qx * qx) + 0.25 * (pitchExcessDeg > 0 ? 2 * qy * qy : 0),
        cfg.sigUp2
    );
    const upright = quatUpDot(qw, qx, qy, qz);
    const tiltDeg = tiltDegFromQuat(qx, qy);
    const leanRoll = clamp01(rollDeg / Math.max(cfg.leanRollDenomMin ?? 8, cfg.tiltFallenRollDeg ?? 38));
    const leanPitch = clamp01(pitchExcessDeg / (cfg.leanPitchDenom ?? 25));
    const lean = clamp01(
        (cfg.leanRollMix ?? 0.75) * leanRoll +
        (cfg.leanPitchMix ?? 0.25) * leanPitch
    );

    const pelvis = Number(data.qpos[2]) || 0;
    const headZ =
        siteZById(data, cache.headSiteId) ??
        bodyZById(data, cache.headBodyId) ??
        bodyZById(data, cache.torsoId) ??
        pelvis;

    const pelvisStand = cfg.pelvisStand ?? DUCK_REWARD_DEFAULTS.pelvisStand;
    const atStand =
        pelvis >= pelvisStand * (cfg.atStandPelvisFrac ?? 0.85) &&
        upright >= (cfg.successUpright ?? 0.78) * (cfg.atStandUprightFrac ?? 0.88) &&
        rollDeg < (cfg.tiltFallenRollDeg ?? 38) * (cfg.atStandRollFrac ?? 0.70) &&
        pitchDeg < pitchAllow + (cfg.atStandPitchSlackDeg ?? 12);

    const stds = wantMove ? cfg.stdWalk : cfg.stdStand;
    let poseAcc = 0;
    let poseN = 0;
    for (const j of cache.legs) {
        const e = (Number(data.qpos[j.qadr]) || 0) - (j.home ?? j.qpos0);
        const s = Math.max(1e-3, stds[j.family] ?? 0.2);
        poseAcc += Math.exp(-((e / s) ** 2));
        poseN++;
    }
    const pose = poseN ? poseAcc / poseN : 0;

    const headCmd = readHeadCmd(cfg);
    let headAcc = 0;
    const headErr = [0, 0, 0, 0];
    const nHead = Math.min(4, cache.head.length);
    for (let i = 0; i < nHead; i++) {
        const j = cache.head[i];
        const home = j.home ?? j.qpos0;
        const target = home + (Number(headCmd[i]) || 0);
        const e = (Number(data.qpos[j.qadr]) || 0) - target;
        headErr[i] = e;
        headAcc += Math.exp(-((e / cfg.headStd) ** 2));
    }
    const headPose = nHead ? headAcc / nHead : 0;

    const aEma = 1 - Math.exp(-dt / Math.max(1e-3, cfg.headBiasTau));
    for (let i = 0; i < 4; i++) {
        state.headEma[i] += aEma * (headErr[i] - state.headEma[i]);
    }
    const headBias = nHead
        ? -(Math.abs(state.headEma[0]) + Math.abs(state.headEma[1]) +
            Math.abs(state.headEma[2]) + Math.abs(state.headEma[3])) / nHead
        : 0;

    let air = 0;
    let slip = 0;
    let clear = 0;
    let swing = 0;
    const contact = [0, 0];
    for (let i = 0; i < cache.feet.length; i++) {
        const foot = cache.feet[i];
        const c = footContact(data, foot, cfg.contactZ);
        contact[i] = c;
        if (c) {
            const landed = state.contact[i] === 0;
            if (wantMove && landed && state.airTime[i] >= cfg.airMin && state.airTime[i] <= cfg.airMax) {
                air += 1;
            }
            state.airTime[i] = 0;
            slip += footSpeedXY(data, foot) ** 2;
        } else {
            state.airTime[i] += dt;
            if (wantMove) {
                const z = bodyZById(data, foot.id) ?? cfg.swingZ;
                const e2 = (z - cfg.swingZ) ** 2;
                clear += e2;
                swing += e2;
            }
        }
    }
    state.contact = contact;
    const planted = (contact[0] || 0) + (contact[1] || 0);

    const nu = model.nu | 0;
    let dA2 = 0;
    if (state.prevCtrl && state.prevCtrl.length === nu) {
        for (let i = 0; i < nu; i++) {
            const d = (Number(data.ctrl[i]) || 0) - state.prevCtrl[i];
            dA2 += d * d;
        }
    }
    if (!state.prevCtrl || state.prevCtrl.length !== nu) state.prevCtrl = new Float32Array(nu);
    for (let i = 0; i < nu; i++) state.prevCtrl[i] = Number(data.ctrl[i]) || 0;

    const bodyAng = w[0] ** 2 + w[1] ** 2 + w[2] ** 2;
    const velPen = rmsArray(data.qvel, model.nv | 0);
    const ctrlPen = rmsArray(data.ctrl, nu);

    const prevPelvis = Number.isFinite(Number(opts.prevPelvis))
        ? Number(opts.prevPelvis)
        : (state.lastPelvis ?? pelvis);
    const prevHead = Number.isFinite(Number(opts.prevHead))
        ? Number(opts.prevHead)
        : (state.lastHead ?? headZ);
    const prevUpright = Number.isFinite(Number(opts.prevUpright))
        ? Number(opts.prevUpright)
        : (state.lastUpright ?? upright);

    const dzPelvis = pelvis - prevPelvis;
    const dzUp = Math.max(pelvis - prevPelvis, headZ - prevHead);
    const tiltDrop = clamp01((prevUpright - upright) / Math.max(1e-4, cfg.tiltDropScale || 0.12));
    const heightGate = clamp01(pelvis / Math.max(1e-3, pelvisStand));

    const pelvisFall = cfg.pelvisFall ?? DUCK_REWARD_DEFAULTS.pelvisFall;
    const pelvisFloor = cfg.pelvisFloor ?? DUCK_REWARD_DEFAULTS.pelvisFloor;
    const headFall = cfg.headFall ?? DUCK_REWARD_DEFAULTS.headFall;
    const fallUpright = cfg.fallUpright ?? DUCK_REWARD_DEFAULTS.fallUpright;
    const floorUpright = cfg.floorUpright ?? DUCK_REWARD_DEFAULTS.floorUpright;

    const collapsing =
        !atStand &&
        dzPelvis < -(cfg.collapseDz ?? DUCK_REWARD_DEFAULTS.collapseDz) &&
        upright < (cfg.collapseUpright ?? DUCK_REWARD_DEFAULTS.collapseUpright);

    const fallen =
        pelvis < pelvisFall ||
        rollDeg >= (cfg.tiltFallenRollDeg ?? 38) ||
        pitchDeg >= (cfg.tiltFallenPitchDeg ?? 70) ||
        upright < fallUpright ||
        collapsing;

    const onFloor =
        pelvis < pelvisFloor ||
        headZ < headFall ||
        (fallen && pelvis < pelvisStand * (cfg.floorPelvisStandFrac ?? 0.55)) ||
        (upright < floorUpright && pelvis < pelvisStand * (cfg.floorUprightPelvisFrac ?? 0.70));

    const belowStand =
        pelvis < pelvisStand * (cfg.belowStandPelvisFrac ?? 0.85) ||
        upright < (cfg.successUpright ?? 0.78) * (cfg.belowStandUprightFrac ?? 0.88);

    const hold = clamp01(
        uprightGauss *
        clamp01(pelvis / Math.max(1e-3, pelvisStand)) *
        ((cfg.swayHoldMix ?? 0.35) + (cfg.holdSwayMix ?? 0.65) * (1 - swayPen))
    );

    const plantedGate = planted > 0 ? 1 : (cfg.plantedAirScale ?? 0.55);
    const balanceTerm = clamp01(
        uprightGauss * hold * plantedGate * (1 - (cfg.balanceSwayMix ?? 0.45) * swayPen)
    );
    const riseTerm = belowStand
        ? clamp01(Math.max(0, dzUp) / Math.max(1e-4, cfg.riseScale || 0.02))
        : 0;
    const dropTerm = (!onFloor && belowStand && dzPelvis < 0)
        ? clamp01((-dzPelvis) / Math.max(1e-4, cfg.dropScale || 0.015))
        : 0;

    const stable = atStand && sway < (cfg.swayStable ?? 0.35) && !onFloor;
    if (stable) state.holdTicks = (state.holdTicks || 0) + 1;
    else if (atStand) state.holdTicks = Math.max(0, (state.holdTicks || 0) - 1);
    else state.holdTicks = 0;

    const forwardMag = Math.max(0, vLocal[0]);
    const forwardAlign = wantMove
        ? clamp01(forwardMag / Math.max(cfg.forwardCmdFloor ?? 0.05, Math.abs(vxCmd)))
        : 0;
    const lateralPen = clamp01(Math.abs(vLocal[1]) / (cfg.lateralDenom ?? 0.25));
    const postureGate = clamp01(
        (upright - (cfg.postureUprightLo ?? 0.45)) / (cfg.postureUprightSpan ?? 0.40)
    );

    const success =
        !onFloor &&
        atStand &&
        pelvis >= (cfg.successPelvis ?? 0.10) &&
        headZ >= (cfg.successHead ?? 0.16) &&
        upright >= (cfg.successUpright ?? 0.78);

    state.lastPelvis = pelvis;
    state.lastHead = headZ;
    state.lastUpright = upright;

    return {
        cache,
        dt,
        qw, qx, qy, qz,
        vLocal,
        w,
        sway,
        swayPen,
        lean,
        leanRoll,
        leanPitch,
        rollDeg,
        pitchDeg,
        pitchAllow,
        pitchExcessDeg,
        vxCmd, vyCmd, wzCmd,
        wantMove,
        trackLin,
        trackAng,
        uprightGauss,
        upright,
        tiltDeg,
        tilt2,
        pelvis,
        headZ,
        pelvisStand,
        atStand,
        pose,
        headCmd,
        headPose,
        headBias,
        air,
        slip,
        clear,
        swing,
        contact,
        planted,
        dA2,
        bodyAng,
        velPen,
        ctrlPen,
        dzPelvis,
        tiltDrop,
        heightGate,
        fallen,
        onFloor,
        belowStand,
        hold,
        balanceTerm,
        riseTerm,
        dropTerm,
        stable,
        forwardAlign,
        lateralPen,
        postureGate,
        success,
        nu,
    };
}