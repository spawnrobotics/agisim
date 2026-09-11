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

const CONFIG = {
    robot: resolveRobot(import.meta.env.VITE_ROBOT || DEFAULT_ROBOT_ID),
    wsBase: import.meta.env.VITE_BRAIN_WS_BASE || 'ws://127.0.0.1:3000/ws',

    frameSize: envInt('VITE_FRAME_SIZE', 32),
    motorFps: envInt('VITE_MOTOR_FPS', 30),
    videoFps: envInt('VITE_VIDEO_FPS', 10),

    policyHz: envInt('VITE_POLICY_HZ', 50),
    playbackRate: envNum('VITE_PLAYBACK_RATE', .25),
    maxStepsPerFrame: envInt('VITE_MAX_STEPS_PER_FRAME', 20),

    /** Brain motor packets write data.ctrl. */
    applyRx: envBool('VITE_APPLY_RX', false),
    /** ONNX joint targets are forwarded to the brain; do not leave them on data.ctrl. */
    policyToBrain: envBool('VITE_POLICY_TO_BRAIN', false),

    visualCount: clampCount(envInt('VITE_VISUAL_COUNT', 1)),
    auditoryCount: clampCount(envInt('VITE_AUDITORY_COUNT', 1)),
    motorCount: clampCount(envInt('VITE_MOTOR_COUNT', 1)),

    frameSizes: envIntList('VITE_FRAME_SIZES'),
    actionSizes: envIntList('VITE_ACTION_SIZES'),
    obsSizes: envIntList('VITE_OBS_SIZES'),

    enableLearningVisual: envBool('VITE_LEARNING_VISUAL', false),
    enableLearningAuditory: envBool('VITE_LEARNING_AUDITORY', false),
    enableLearningMotor: envBool('VITE_LEARNING_MOTOR', true),

    mode: import.meta.env.MODE,
    isDev: import.meta.env.DEV,
    isProd: import.meta.env.PROD,

    storage: {
        brainId: 'brainId',
    },

    maxCortexPerModality: MAX_CORTEX_PER_MODALITY,
};

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
    const sizes = Array.isArray(actionSizes) && actionSizes.length
        ? actionSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 1)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (CONFIG.actionSizes || null);

    const observations = Array.isArray(obsSizes) && obsSizes.length
        ? obsSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 1)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (CONFIG.obsSizes || null);

    const frames = Array.isArray(frameSizes) && frameSizes.length
        ? frameSizes
            .map((n) => Math.floor(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 8)
            .slice(0, MAX_CORTEX_PER_MODALITY)
        : (CONFIG.frameSizes || null);

    const vCount = clampCount(visualCount ?? CONFIG.visualCount, 1);
    const aCount = clampCount(auditoryCount ?? CONFIG.auditoryCount, 1);
    const mCount = clampCount(
        motorCount ?? sizes?.length ?? CONFIG.motorCount,
        1
    );

    const primaryAction =
        actionSize != null && Number.isFinite(Number(actionSize))
            ? Math.max(1, Math.floor(Number(actionSize)))
            : (sizes?.[0] ?? undefined);

    const primaryFrame = Math.max(
        8,
        Math.floor(Number(frameSize ?? CONFIG.frameSize) || 32)
    );

    const payload = {
        type: 'join',
        brainId: brainId || null,
        frameSize: primaryFrame,
        visualCount: vCount,
        auditoryCount: aCount,
        motorCount: mCount,
        enableLearningVisual: CONFIG.enableLearningVisual,
        enableLearningAuditory: CONFIG.enableLearningAuditory,
        enableLearningMotor: CONFIG.enableLearningMotor,
    };

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