// rewards/rewards.js
import {
    REWARD_DEFAULTS,
    MOTOR_OUTCOME_EXTRA,
    STIM_NEAR_ZERO,
    ADV_MIN,
    ADV_MAX,
    ADV_GAIN,
} from './constants.js';

import {
    quatUpDot,
    heightTermFromZ,
    uprightTermFromDot,
    clamp11,
    clamp01,
    resolveBodyId,
    resolveSiteId,
    bodyZById,
    siteZById,
    bodyLocalZ,
    blendHeight,
    emptyOutcome,
    normalizeOutcome,
    listBodyNames,
} from './helpers.js';

export {
    REWARD_DEFAULTS,
    STANDUP_REWARD_DEFAULTS,
    MOTOR_OUTCOME_EXTRA,
} from './constants.js';

export {
    quatUpDot,
    heightTermFromZ,
    uprightTermFromDot,
    blendHeight,
    normalizeOutcome,
} from './helpers.js';

export { createRewardCurriculum } from './curriculum.js';
export { createTouchOutcome } from './touch.js';
export { GENE_ORDER, geneExpression } from './genes.js';

const HEAD_SITES = [
    'head',
    'head_site',
    'imu',
    'imu_in_torso',
    'imu_in_pelvis',
    'imu_link',
];

const HEAD_CANDIDATES = [
    'head_link',
    'head',
    'neck',
    'torso_link',
    'torso',
    'trunk',
    'base',
    'pelvis',
];

const TORSO_CANDIDATES = [
    'torso_link',
    'torso',
    'trunk',
    'base',
    'base_link',
    'pelvis',
    'pelvis_link',
    'root',
    'body',
    'imu_link',
];

const HEAD_LOCAL = { x: 0, y: 0, z: 0.12 };

let cacheKey = '';
let cachedHeadSiteId = -2;
let cachedHeadId = -2;
let cachedTorsoId = -2;
let loggedMissing = false;

/** @type {ReturnType<typeof emptyOutcome>} */
let lastOutcome = emptyOutcome();

function modelCacheKey(model) {
    return `${model?.nbody | 0}:${model?.nq | 0}:${model?.nu | 0}`;
}

function resetBodyCache() {
    cachedHeadSiteId = -2;
    cachedHeadId = -2;
    cachedTorsoId = -2;
    loggedMissing = false;
}

function resolveFirst(fn, names) {
    for (const name of names) {
        const id = fn(name);
        if (id >= 0) return { id, name };
    }
    return { id: -1, name: null };
}

function fallbackTorsoId(model) {
    const n = model?.nbody | 0;
    if (n > 1) return 1; 
    return -1;
}

function extraNamesFromOpts(opts) {
    const robot = opts?.robot || {};
    const extra = [];
    if (robot.torsoBody) extra.push(robot.torsoBody);
    if (robot.headBody) extra.push(robot.headBody);
    if (robot.headSite) extra.push(robot.headSite);
    if (Array.isArray(opts.torsoNames)) extra.push(...opts.torsoNames);
    if (Array.isArray(opts.headNames)) extra.push(...opts.headNames);
    if (Array.isArray(opts.headSites)) extra.push(...opts.headSites);
    return extra.map((s) => String(s || '').trim()).filter(Boolean);
}

export function readStandHeights(model, data, mujoco = null, opts = {}) {
    const key = modelCacheKey(model);
    if (key !== cacheKey) {
        cacheKey = key;
        resetBodyCache();
    }

    const pelvis = Number(data?.qpos?.[2]) || 0;
    const extras = extraNamesFromOpts(opts);

    if (cachedTorsoId < 0) {
        const names = [...extras, ...TORSO_CANDIDATES];
        const t = resolveFirst((n) => resolveBodyId(mujoco, model, n), names);
        cachedTorsoId = t.id >= 0 ? t.id : fallbackTorsoId(model);
        if (t.id < 0 && !loggedMissing) {
            loggedMissing = true;
            console.warn('[reward] no named torso; using body id', cachedTorsoId, {
                tried: names,
                bodies: listBodyNames(mujoco, model),
            });
        }
    }

    if (cachedHeadSiteId < 0) {
        const sites = [...extras, ...HEAD_SITES];
        const s = resolveFirst((n) => resolveSiteId(mujoco, model, n), sites);
        cachedHeadSiteId = s.id;
    }

    if (cachedHeadId < 0) {
        const names = [...extras, ...HEAD_CANDIDATES];
        const b = resolveFirst((n) => resolveBodyId(mujoco, model, n), names);
        cachedHeadId = b.id >= 0 ? b.id : cachedTorsoId;
    }

    const siteZ = siteZById(data, cachedHeadSiteId);
    const offset = opts.robot?.headLocal || HEAD_LOCAL;
    const rotated = bodyLocalZ(
        data,
        cachedTorsoId >= 0 ? cachedTorsoId : cachedHeadId,
        offset.x ?? 0,
        offset.y ?? 0,
        offset.z ?? 0
    );
    const torsoZ = bodyZById(data, cachedTorsoId);

    let head;
    let source;
    if (siteZ != null) {
        head = siteZ;
        source = 'site';
    } else if (rotated != null && (offset.z || 0) !== 0) {
        head = rotated;
        source = 'torso_offset';
    } else if (torsoZ != null) {
        head = torsoZ;
        source = 'torso';
    } else {
        head = pelvis;
        source = 'qpos_z';
    }

    return {
        pelvis,
        head,
        source,
        torsoId: cachedTorsoId,
        headId: cachedHeadId,
        headSiteId: cachedHeadSiteId,
    };
}

export function getLastMotorOutcome() {
    return { ...lastOutcome };
}

export function setLastMotorOutcome(outcome) {
    lastOutcome = normalizeOutcome(outcome);
    return getLastMotorOutcome();
}

export function clearMotorOutcome() {
    lastOutcome = emptyOutcome();
}

export function extractReward(model, data, opts = {}) {
    const standCfg = opts.robot?.stand && typeof opts.robot.stand === 'object'
        ? opts.robot.stand
        : {};
    const cfg = { ...REWARD_DEFAULTS, ...standCfg, ...opts };

    const { pelvis, head } = readStandHeights(model, data, opts.mujoco, opts);
    const z = blendHeight(pelvis, head, cfg);

    const qw = Number(data.qpos[3]);
    const qx = Number(data.qpos[4]) || 0;
    const qy = Number(data.qpos[5]) || 0;
    const qz = Number(data.qpos[6]) || 0;
    const qwSafe = Number.isFinite(qw) ? qw : 1;

    const upright = quatUpDot(qwSafe, qx, qy, qz);
    const pelvisTerm = heightTermFromZ(
        pelvis,
        cfg.pelvisFloor ?? 0.05,
        cfg.pelvisFall ?? cfg.heightFall,
        cfg.pelvisStand ?? 0.79
    );
    const headTerm = heightTermFromZ(
        head,
        cfg.headFloor ?? 0.12,
        cfg.headFall ?? 0.35,
        cfg.headStand ?? 1.22
    );
    const wp = cfg.wPelvisH ?? 0.5;
    const wh = cfg.wHeadH ?? 0.5;
    const heightTerm = clamp01((wp * pelvisTerm + wh * headTerm) / Math.max(1e-6, wp + wh));
    const uprightTerm = uprightTermFromDot(upright, cfg);

    const prevH =
        opts.prevHeight != null && Number.isFinite(Number(opts.prevHeight))
            ? Number(opts.prevHeight)
            : z;
    const prevPelvis =
        opts.prevPelvis != null && Number.isFinite(Number(opts.prevPelvis))
            ? Number(opts.prevPelvis)
            : pelvis;
    const prevHead =
        opts.prevHead != null && Number.isFinite(Number(opts.prevHead))
            ? Number(opts.prevHead)
            : head;

    const dz = z - prevH;
    const dzPelvis = pelvis - prevPelvis;
    const dzHead = head - prevHead;
    const dzUp = Math.max(dz, dzHead, dzPelvis);

    const progressScale = Math.max(1e-4, Number(cfg.progressScale) || 0.04);
    const progressTerm = clamp01(dzUp / progressScale);

    const velPen = rmsArrayLocal(data.qvel, model.nv | 0);
    const ctrlPen = rmsArrayLocal(data.ctrl, model.nu | 0);

    const fallen =
        pelvis < (cfg.pelvisFall ?? cfg.heightFall) ||
        head < (cfg.headFall ?? 0.35) ||
        upright < 0.15;

    const successHeight =
        cfg.successHeight ??
        (cfg.heightStand != null ? cfg.heightStand * 0.93 : undefined) ??
        ((cfg.pelvisStand ?? 0.79) * 0.5 + (cfg.headStand ?? 1.22) * 0.5) * 0.93;

    const success =
        z >= successHeight &&
        pelvis >= (cfg.successPelvis ?? cfg.pelvisStand ?? 0.70) &&
        head >= (cfg.successHead ?? cfg.headStand ?? 1.10) &&
        upright >= (cfg.successUpright ?? 0.75);

    let reward =
        (cfg.wHeight ?? 0.5) * heightTerm +
        (cfg.wUpright ?? 0.4) * uprightTerm +
        (cfg.wProgress ?? 0.3) * progressTerm -
        (cfg.wVel ?? 0.04) * Math.min(1, velPen) -
        (cfg.wCtrl ?? 0.03) * Math.min(1, ctrlPen);

    if (success) reward += cfg.wSuccess ?? 0;

    if (fallen) {
        const pFloor = cfg.pelvisFloor ?? 0.05;
        const pFall = cfg.pelvisFall ?? cfg.heightFall ?? 0.22;
        const hFloor = cfg.headFloor ?? 0.12;
        const hFall = cfg.headFall ?? 0.35;

        const pelvisDown = clamp01((pFall - pelvis) / Math.max(1e-3, pFall - pFloor));
        const headDown = clamp01((hFall - head) / Math.max(1e-3, hFall - hFloor));
        const tiltDown = clamp01((0.15 - upright) / 0.15);
        const down = clamp01(0.45 * pelvisDown + 0.35 * headDown + 0.20 * tiltDown);
        const lift = clamp01(progressTerm);
        const mix = (cfg.fallMix ?? 0.85) * down * (1 - 0.75 * lift);
        const floor = cfg.fallenFloor ?? -1;
        reward = reward * (1 - mix) + floor * mix;
    }

    reward = clamp11(reward);

    const outcome = normalizeOutcome({
        reward,
        height: +z.toFixed(4),
        pelvisHeight: +pelvis.toFixed(4),
        headHeight: +head.toFixed(4),
        upright: +upright.toFixed(4),
        heightTerm: +heightTerm.toFixed(4),
        uprightTerm: +uprightTerm.toFixed(4),
        progressTerm: +progressTerm.toFixed(4),
        success,
        fallen,
        posSum: Math.max(0, reward),
        negSum: Math.max(0, -reward),
        valence: reward,
        source: 'stand',
        ts: Date.now(),
    });

    if (opts.cache !== false) setLastMotorOutcome(outcome);
    return outcome;
}

function rmsArrayLocal(arr, n) {
    let s = 0;
    const m = Math.max(1, n | 0);
    for (let i = 0; i < m; i++) {
        const v = Number(arr[i]) || 0;
        s += v * v;
    }
    return Math.sqrt(s / m);
}

function outcomeSignal(o) {
    if (Number.isFinite(Number(o.reward))) return clamp11(o.reward);
    if (Number.isFinite(Number(o.valence))) return clamp11(o.valence);
    const p = Math.max(0, Number(o.posSum) || 0);
    const n = Math.max(0, Number(o.negSum) || 0);
    const t = p + n;
    return t > 1e-6 ? clamp11((p - n) / t) : 0;
}

export function resolveAdvantageFromOutcome(outcome = lastOutcome) {
    const s = outcomeSignal(outcome || lastOutcome);
    return Math.max(ADV_MIN, Math.min(ADV_MAX, 1 + ADV_GAIN * s));
}

export function outcomeToStimAmount(outcome = null, minAbs = STIM_NEAR_ZERO) {
    const o = outcome || lastOutcome;
    let amount = +clamp11(o.reward ?? o.valence ?? 0).toFixed(4);

    if (Math.abs(amount) < minAbs) return 0;
    return amount;
}

export function packJointsWithOutcome(joints, outcome = null) {
    const o = outcome || lastOutcome;
    const n = joints?.length || 0;
    const out = new Float32Array(n + MOTOR_OUTCOME_EXTRA);
    for (let i = 0; i < n; i++) {
        const v = Number(joints[i]);
        out[i] = Number.isFinite(v) ? v : 0;
    }
    out[n] = Number.isFinite(Number(o.reward)) ? Number(o.reward) : 0;
    out[n + 1] = Math.max(0, Number(o.posSum) || 0);
    out[n + 2] = Math.max(0, Number(o.negSum) || 0);
    return out;
}

export function outcomeToJsonMessage(outcome = null, source = 'mujoco') {
    const o = outcome || lastOutcome;
    return {
        type: 'motor_outcome',
        source,
        ...o,
        advantage: +resolveAdvantageFromOutcome(o).toFixed(4),
        stimAmount: outcomeToStimAmount(o, 0),
        ts: o.ts || Date.now(),
    };
}

export function outcomeToStimPayload(outcome = null, opts = {}) {
    const o = outcome || lastOutcome;
    const minAbs = opts.minAbs != null ? Number(opts.minAbs) : STIM_NEAR_ZERO;
    const amount = outcomeToStimAmount(o, minAbs);
    if (amount === 0) return null;
    return {
        amount,
        height: o.height,
        pelvisHeight: o.pelvisHeight,
        headHeight: o.headHeight,
        upright: o.upright,
        heightTerm: o.heightTerm,
        uprightTerm: o.uprightTerm,
        progressTerm: o.progressTerm,
        success: !!o.success,
        fallen: !!o.fallen,
        posSum: o.posSum,
        negSum: o.negSum,
        gene: o.gene || null,
        expression: o.expression,
        source: opts.source || o.source || 'mujoco',
    };
}