// config.js - Mujoco Brain / WebSocket config
const ROBOTS = {
    g1: {
        id: 'g1',
        name: 'Unitree G1',
        basePath: '/unitree_g1',
        scene: 'scene.xml',
        spawn: {
            x: 0,
            y: 0,
            z: 0.92,
            quat: [1, 0, 0, 0], // wxyz
        },
        torsoBody: 'torso_link',
        headBody: 'head_link',
        headSite: 'imu_in_torso',
        chestAxis: 'x',
        headLocal: { x: 0.0039635, y: 0, z: 0.38 },
        headCam: {
            position: [0.06, 0.4, 0],
            rotation: [-0.18, -Math.PI / 2, 0],
            debug: false,
        },
        drag: { stiffness: 400, damping: 25, maxForce: 300 },
        stand: {
            pelvisFloor: 0.05,
            pelvisFall: 0.22,
            pelvisStand: 0.79,
            headFloor: 0.12,
            headFall: 0.35,
            headStand: 1.22,
            successPelvis: 0.70,
            successHead: 1.10,
            successUpright: 0.75,
        },
    },
    microduck: {
        id: 'microduck',
        name: 'MicroDuck',
        basePath: '/microduck/robot/microduck',
        scene: 'scene.xml',
        spawn: {
            x: 0,
            y: 0,
            z: 0.12,
            quat: [1, 0, 0, 0],
        },
        torsoBody: 'trunk_base',
        headBody: 'jaw_soft',
        headCam: {
            position: [.02, -0.08, 0],
            rotation: [Math.PI / 2, Math.PI, Math.PI / 2],
            debug: false,
        },
        headSite: 'head_camera',
        waistYawJoint: 'head_yaw',
        chestAxis: 'x',
        headLocal: { x: 0, y: 0, z: 0.08 },
        drag: { stiffness: 40, damping: 8, maxForce: 15 },
        stand: {
            pelvisFloor: 0.02,
            pelvisFall: 0.06,
            pelvisStand: 0.12,
            headFloor: 0.04,
            headFall: 0.08,
            headStand: 0.20,
            successPelvis: 0.10,
            successHead: 0.16,
            successUpright: 0.75,
            sideUpright: 0.45,
            fallUpright: 0.25,
        },
        geneOpts: {
            limits: { wUpright: 0.5, wSide: 0.9 },
            roll: { pelvisLo: 0.03, pelvisHi: 0.10 },
            quad: {
                pelvisLo: 0.04,
                pelvisHi: 0.10,
                headLo: 0.06,
                headHi: 0.16,
            },
            crawl: { pelvisLo: 0.04, pelvisHi: 0.10, forwardScale: 0.015 },
        },
    },
};

function resolveRobot(raw) {
    const key = String(raw || 'g1').trim().toLowerCase();
    return ROBOTS[key] || ROBOTS.g1;
}

function envBool(key, fallback) {
    const v = import.meta.env[key];
    if (v === undefined || v === '') return fallback;
    return v === 'true' || v === '1';
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
    robot: resolveRobot(import.meta.env.VITE_ROBOT),
    wsBase: import.meta.env.VITE_BRAIN_WS_BASE || 'ws://127.0.0.1:3000/ws',

    frameSize: envInt('VITE_FRAME_SIZE', 32),
    motorFps: envInt('VITE_MOTOR_FPS', 30),
    videoFps: envInt('VITE_VIDEO_FPS', 10),

    visualCount: clampCount(envInt('VITE_VISUAL_COUNT', 1)),
    auditoryCount: clampCount(envInt('VITE_AUDITORY_COUNT', 1)),
    motorCount: clampCount(envInt('VITE_MOTOR_COUNT', 1)),

    /** Optional explicit per-instance sizes from env (comma-separated). */
    frameSizes: envIntList('VITE_FRAME_SIZES'),
    actionSizes: envIntList('VITE_ACTION_SIZES'),

    enableLearningVisual: envBool('VITE_LEARNING_VISUAL', true),
    enableLearningAuditory: envBool('VITE_LEARNING_AUDITORY', true),
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

/**
 * @param {object} [opts]
 * @param {string|null} [opts.brainId]
 * @param {number} [opts.actionSize]       primary motor (MOT1) width
 * @param {number[]} [opts.actionSizes]    per-motor-cortex widths (joint groups)
 * @param {number} [opts.motorCount]
 * @param {number} [opts.visualCount]
 * @param {number} [opts.auditoryCount]
 * @param {number} [opts.frameSize]
 * @param {number[]} [opts.frameSizes]
 */
export function getJoinPayload({
    brainId,
    actionSize,
    actionSizes,
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
export { ROBOTS, resolveRobot };
export default CONFIG;