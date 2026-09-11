// rewards/rewards.js
import CONFIG from '../config.js';
import { STIM_NEAR_ZERO } from './constants.js';
import {
    resolveBodyId,
    resolveSiteId,
    bodyZById,
    siteZById,
    bodyLocalZ,
    emptyOutcome,
    normalizeOutcome,
    listBodyNames,
} from './helpers.js';
import {
    extractDuckReward,
    resetDuckRewardState,
} from './microduck/index.js';
import {
    extractG1Reward,
    resetG1RewardState,
} from './g1/index.js';

export {
    REWARD_DEFAULTS,
    STANDUP_REWARD_DEFAULTS,
    MOTOR_OUTCOME_EXTRA,
} from './constants.js';

export { createRewardCurriculum } from './curriculum.js';
export { createTouchOutcome } from './touch.js';
export {
    extractDuckReward,
    extractDuckStandReward,
    extractDuckWalkReward,
    resetDuckRewardState,
} from './microduck/index.js';
export {
    extractG1Reward,
    extractG1StandReward,
    extractG1WalkReward,
    resetG1RewardState,
} from './g1/index.js';

const HEAD_SITES = [
    'head', 'head_site', 'head_camera', 'imu',
    'imu_in_torso', 'imu_in_pelvis', 'imu_link',
];
const HEAD_BODIES = [
    'head_link', 'head', 'jaw_soft', 'neck',
    'torso_link', 'torso', 'trunk_base', 'trunk', 'base', 'pelvis',
];
const TORSO_BODIES = [
    'torso_link', 'torso', 'trunk_base', 'trunk',
    'base', 'base_link', 'pelvis', 'pelvis_link', 'root', 'body', 'imu_link',
];

let cacheKey = '';
let cachedHeadSiteId = -2;
let cachedHeadId = -2;
let cachedTorsoId = -2;
let loggedMissing = false;
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

function readCmd3(o) {
    const raw = Array.isArray(o?.cmd) ? o.cmd : [0, 0, 0];
    return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0];
}

function readHeadCmd(o) {
    const raw = Array.isArray(o?.headCmd) ? o.headCmd : [0, 0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
        Number(raw[3]) || 0,
    ];
}

function isDuck(robot) {
    const id = String(robot?.id || robot?.name || robot?.family || '').toLowerCase();
    const src = String(lastOutcome?.source || '').toLowerCase();
    return id.includes('duck') || src.includes('duck');
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
        const names = [...extras, ...TORSO_BODIES];
        const t = resolveFirst((n) => resolveBodyId(mujoco, model, n), names);
        cachedTorsoId = t.id >= 0 ? t.id : (model?.nbody > 1 ? 1 : -1);
        if (t.id < 0 && !loggedMissing) {
            loggedMissing = true;
            console.warn('[plant] no named torso; using body id', cachedTorsoId, {
                tried: names,
                bodies: listBodyNames(mujoco, model),
            });
        }
    }

    if (cachedHeadSiteId < 0) {
        cachedHeadSiteId = resolveFirst(
            (n) => resolveSiteId(mujoco, model, n),
            [...extras, ...HEAD_SITES]
        ).id;
    }

    if (cachedHeadId < 0) {
        const b = resolveFirst(
            (n) => resolveBodyId(mujoco, model, n),
            [...extras, ...HEAD_BODIES]
        );
        cachedHeadId = b.id >= 0 ? b.id : cachedTorsoId;
    }

    const siteZ = siteZById(data, cachedHeadSiteId);
    const offset = opts.robot?.headLocal
        || (isDuck(opts.robot) ? { x: 0, y: 0, z: 0.08 } : { x: 0.0039635, y: 0, z: 0.38 });
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
    const src = outcome && typeof outcome === 'object' ? outcome : {};
    lastOutcome = normalizeOutcome(src);
    lastOutcome.cmd = readCmd3(src);
    lastOutcome.headCmd = readHeadCmd(src);
    lastOutcome.imu = src.imu || lastOutcome.imu || null;
    lastOutcome.imuBySlot = src.imuBySlot || lastOutcome.imuBySlot || null;
    return getLastMotorOutcome();
}

export function clearMotorOutcome() {
    lastOutcome = emptyOutcome();
    resetDuckRewardState();
    resetG1RewardState();
}

export function extractReward(model, data, opts = {}) {
    const robot = opts.robot || CONFIG.robot || {};
    const outcome = isDuck(robot)
        ? extractDuckReward(model, data, { ...opts, robot })
        : extractG1Reward(model, data, { ...opts, robot });
    if (opts.cache !== false) setLastMotorOutcome(outcome);
    return outcome;
}

export function resolveAdvantageFromOutcome() {
    return 0;
}

export function outcomeToStimAmount() {
    return 0;
}

export function outcomeToJsonMessage(outcome = null, source = 'mujoco') {
    const o = outcome || lastOutcome;
    return {
        type: 'motor_plant',
        source,
        upright: o.upright,
        gx: o.gx,
        gy: o.gy,
        wz: o.wz,
        pelvisHeight: o.pelvisHeight,
        headHeight: o.headHeight,
        fallen: !!o.fallen,
        onFloor: !!o.onFloor,
        imu: o.imu || null,
        imuBySlot: o.imuBySlot || null,
        cmd: readCmd3(o),
        headCmd: readHeadCmd(o),
        ts: o.ts || Date.now(),
    };
}

export function outcomeToStimPayload() {
    return null;
}