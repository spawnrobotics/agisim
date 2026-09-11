import {
    ROBOTS,
    DEFAULT_ROBOT_ID,
    resolveRobot,
    isDuckRobot,
} from './robots/index.js';

function envBool(key, fallback) {
    const v = import.meta.env[key];
    if (v === undefined || v === '') return fallback;
    return v === 'true' || v === '1';
}

function envNum(key, fallback) {
    const n = Number(import.meta.env[key]);
    return Number.isFinite(n) ? n : fallback;
}

function envInt(key, fallback) {
    const n = Number(import.meta.env[key]);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function envIntList(key) {
    const raw = import.meta.env[key];
    if (raw === undefined || raw === '') return null;
    const list = String(raw)
        .split(/[,\s]+/)
        .map((s) => Math.floor(Number(s)))
        .filter((n) => Number.isFinite(n) && n >= 1);
    return list.length ? list : null;
}

const MAX_CORTEX_PER_MODALITY = 9;

function clampCount(v, fallback = 1) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(MAX_CORTEX_PER_MODALITY, n);
}

// Flip these. Disabled modalities are not joined, not sent, and inbound packets are dropped.
const STREAMS = {
    visual: envBool('VITE_STREAM_VIDEO', false),
    auditory: envBool('VITE_STREAM_AUDIO', false),
    motor: envBool('VITE_STREAM_MOTOR', true),
};

const CONFIG = {
    robot: resolveRobot(import.meta.env.VITE_ROBOT || DEFAULT_ROBOT_ID),
    wsBase: import.meta.env.VITE_BRAIN_WS_BASE || 'ws://127.0.0.1:3000/ws',

    streams: STREAMS,

    frameSize: envInt('VITE_FRAME_SIZE', 32),
    motorFps: envInt('VITE_MOTOR_FPS', 30),
    videoFps: envInt('VITE_VIDEO_FPS', 10),

    policyHz: envInt('VITE_POLICY_HZ', 50),
    playbackRate: envNum('VITE_PLAYBACK_RATE', .25),
    maxStepsPerFrame: envInt('VITE_MAX_STEPS_PER_FRAME', 20),

    applyRx: envBool('VITE_APPLY_RX', false),
    policyToBrain: envBool('VITE_POLICY_TO_BRAIN', false),

    visualCount: STREAMS.visual ? clampCount(envInt('VITE_VISUAL_COUNT', 1)) : 0,
    auditoryCount: STREAMS.auditory ? clampCount(envInt('VITE_AUDITORY_COUNT', 1)) : 0,
    motorCount: STREAMS.motor ? clampCount(envInt('VITE_MOTOR_COUNT', 1)) : 0,

    frameSizes: STREAMS.visual ? envIntList('VITE_FRAME_SIZES') : null,
    actionSizes: STREAMS.motor ? envIntList('VITE_ACTION_SIZES') : null,
    obsSizes: STREAMS.motor ? envIntList('VITE_OBS_SIZES') : null,

    enableLearningVisual: STREAMS.visual && envBool('VITE_LEARNING_VISUAL', false),
    enableLearningAuditory: STREAMS.auditory && envBool('VITE_LEARNING_AUDITORY', false),
    enableLearningMotor: STREAMS.motor && envBool('VITE_LEARNING_MOTOR', true),

    enableStreamVideo: STREAMS.visual,
    enableStreamAudio: STREAMS.auditory,
    enableStreamMotor: STREAMS.motor,

    mode: import.meta.env.MODE,
    isDev: import.meta.env.DEV,
    isProd: import.meta.env.PROD,

    storage: {
        brainId: 'brainId',
    },

    maxCortexPerModality: MAX_CORTEX_PER_MODALITY,
};

export function isStreamEnabled(kind) {
    return CONFIG.streams?.[kind] === true;
}

export function getWsBase() {
    return String(CONFIG.wsBase).replace(/\/$/, '');
}

export function getWsUrl(brainId = null) {
    const base = getWsBase();
    let id = brainId;
    if (id == null) {
        try {
            id = localStorage.getItem(CONFIG.storage.brainId) || '';
        } catch {
            id = '';
        }
    }
    if (!id) return base;
    return `${base}?key=${encodeURIComponent(id)}`;
}

export function getJoinPayload({
    brainId,
    actionSize,
    actionSizes,
    obsSizes,
    motorCount,
    visualCount,
    auditoryCount,
    frameSize,
    frameSizes,
} = {}) {
    const visualOn = isStreamEnabled('visual');
    const auditoryOn = isStreamEnabled('auditory');
    const motorOn = isStreamEnabled('motor');

    const sizes = motorOn && Array.isArray(actionSizes) && actionSizes.length
        ? actionSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 1)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (motorOn ? CONFIG.actionSizes || null : null);

    const observations = motorOn && Array.isArray(obsSizes) && obsSizes.length
        ? obsSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 1)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (motorOn ? CONFIG.obsSizes || null : null);

    const frames = visualOn && Array.isArray(frameSizes) && frameSizes.length
        ? frameSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 8)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (visualOn ? CONFIG.frameSizes || null : null);

    const vCount = visualOn ? clampCount(visualCount ?? CONFIG.visualCount, 1) : 0;
    const aCount = auditoryOn ? clampCount(auditoryCount ?? CONFIG.auditoryCount, 1) : 0;
    const mCount = motorOn
        ? clampCount(motorCount ?? sizes?.length ?? CONFIG.motorCount, 1)
        : 0;

    const primaryAction = motorOn && actionSize != null && Number.isFinite(Number(actionSize))
        ? Math.max(1, Math.floor(Number(actionSize)))
        : (motorOn ? sizes?.[0] ?? undefined : undefined);

    const primaryFrame = Math.max(
        8,
        Math.floor(Number(frameSize ?? CONFIG.frameSize) || 32)
    );

    const payload = {
        type: 'join',
        brainId: brainId || null,
        visualCount: vCount,
        auditoryCount: aCount,
        motorCount: mCount,
        enableLearningVisual: CONFIG.enableLearningVisual,
        enableLearningAuditory: CONFIG.enableLearningAuditory,
        enableLearningMotor: CONFIG.enableLearningMotor,
    };

    if (visualOn) payload.frameSize = primaryFrame;
    if (primaryAction != null) payload.actionSize = primaryAction;
    if (sizes?.length) payload.actionSizes = sizes.slice(0, mCount);
    if (observations?.length) payload.obsSizes = observations.slice(0, mCount);
    if (frames?.length) payload.frameSizes = frames.slice(0, vCount);

    return payload;
}

export function getStoredBrainId() {
    try {
        return localStorage.getItem(CONFIG.storage.brainId) || window.brainId || null;
    } catch {
        return null;
    }
}

export function setStoredBrainId(id) {
    try {
        if (id) {
            localStorage.setItem(CONFIG.storage.brainId, id);
            window.brainId = id;
        }
    } catch (_) { }
}

export {
    ROBOTS,
    DEFAULT_ROBOT_ID,
    resolveRobot,
    isDuckRobot,
};

export default CONFIG;