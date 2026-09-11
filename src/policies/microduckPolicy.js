// policies/microduckPolicy.js
import * as ort from 'onnxruntime-web';
import {
    OBS_N,
    ACT_N,
    POLICY_HZ,
    ACTION_SCALE,
    DEFAULT_POSE,
    EXPECT_JOINTS,
    clip,
    findGyroAdr,
    findBody,
    projGFromXquat,
    readGyro,
    packPolicyObs,
    resolveActuatorMap,
    logPolicyContract,
    logObsTick,
} from './microduckPolicyObs.js';

export {
    OBS_N,
    ACT_N,
    POLICY_HZ,
    ACTION_SCALE,
    DEFAULT_POSE,
    EXPECT_JOINTS,
} from './microduckPolicyObs.js';

const DEFAULT_WALK = '/microduck/policies/alpha_walking.onnx';

const STILL_EPS = 0.12;
const MIN_WALK_VX = 0.22;
const STAND_Z = 0.125;
const DEFAULT_WALK_VX = 0.35;
const WALK_ACTION_SCALE = 1.0;
const WALK_VX_IN_MS = 250;

async function fetchOnnxBytes(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`[policy] ${url} HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 80));
    if (buf.byteLength < 256) {
        throw new Error(`[policy] ${url} is ${buf.byteLength} bytes — not ONNX. ${JSON.stringify(head)}`);
    }
    if (
        head.startsWith('<!') ||
        head.startsWith('<html') ||
        head.startsWith('<HTML') ||
        head.startsWith('version https://git-lfs')
    ) {
        throw new Error(`[policy] ${url} is not a binary ONNX: ${JSON.stringify(head.slice(0, 60))}`);
    }
    console.log('[microduckPolicy] file ok', url, buf.byteLength);
    return buf;
}

async function loadSession(url) {
    if (!url) return null;
    const session = await ort.InferenceSession.create(await fetchOnnxBytes(url), {
        executionProviders: ['wasm'],
    });
    console.log('[microduckPolicy] session', url, session.inputNames, session.outputNames);
    return session;
}

async function tryLoad(url, label) {
    if (!url) return null;
    try {
        return await loadSession(url);
    } catch (err) {
        console.warn(`[microduckPolicy] ${label} missing`, url, err);
        return null;
    }
}

function finite3(src, fallback = [0, 0, 0]) {
    const raw = Array.isArray(src) ? src : fallback;
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
    ];
}

function clamp01(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t;
}

function smootherstep(t) {
    const x = clamp01(t);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

export async function createMicroduckPolicy({
    model,
    data,
    walkUrl = DEFAULT_WALK,
    standUrl: _unusedStandUrl,
    actionScale = ACTION_SCALE,
    torsoBodyName = 'trunk_base',
    gyroSensorName = 'imu_ang_vel',
    defaultWalkVx = DEFAULT_WALK_VX,
    autoWalk = true,
} = {}) {
    let walk = null;
    let sessionsReady = false;
    let sessionsLoading = null;

    const nu = model.nu | 0;
    const nAct = Math.min(ACT_N, nu);

    const {
        qadr,
        dadr,
        actIdx,
        names,
        order,
    } = resolveActuatorMap(model, nAct);

    if (!order.ok) {
        console.warn('[microduckPolicy] actuator order remapped', order.mismatches);
    }

    const defaultPose = DEFAULT_POSE.slice(0, nAct);
    const lastAction = new Float32Array(nAct);
    const obs = new Float32Array(OBS_N);
    const cmd = {
        vel: [autoWalk ? MIN_WALK_VX : 0, 0, 0],
        head: [0, 0, 0, 0],
        body: [0, 0, 0, 0, 0, 0],
    };

    const torso = findBody(model, torsoBodyName);
    const gyroAdr = findGyroAdr(model, gyroSensorName);

    let enabled = true;
    let busy = false;
    let ticks = 0;
    const skill = 'walk';
    let userVel = false;
    let walkSince = performance.now();
    let lastOutcome = null;
    let loggedContract = false;
    let loggedWalkVx = false;

    function ctrlRange(act) {
        const a = act | 0;
        return [
            Number(model.actuator_ctrlrange[a * 2]),
            Number(model.actuator_ctrlrange[a * 2 + 1]),
        ];
    }

    function liveScale() {
        if (Number.isFinite(Number(actionScale))) return Number(actionScale);
        return WALK_ACTION_SCALE;
    }

    function writePoseToPlant(pose = defaultPose, action = null) {
        const scale = liveScale();
        for (let i = 0; i < nAct; i++) {
            const a = actIdx[i] | 0;
            const offset = action ? Number(action[i]) || 0 : 0;
            const target = Number(pose[i]) + scale * offset;
            data.qpos[qadr[i]] = Number(pose[i]) || 0;
            const [lo, hi] = ctrlRange(a);
            data.ctrl[a] = clip(target, lo, hi);
        }
    }

    function applyHome() {
        writePoseToPlant(defaultPose, null);
        lastAction.fill(0);
        if (Number.isFinite(data.qpos[2]) && data.qpos[2] < 0.08) {
            data.qpos[2] = STAND_Z;
        }
    }

    function velNorm() {
        return Math.hypot(cmd.vel[0], cmd.vel[1], cmd.vel[2]);
    }

    function targetWalkVx() {
        const vx = Number(defaultWalkVx);
        return Number.isFinite(vx) && vx !== 0 ? Math.max(MIN_WALK_VX, vx) : DEFAULT_WALK_VX;
    }

    function ensureWalkCmd() {
        if (userVel) return;
        if (velNorm() < STILL_EPS) {
            cmd.vel = [MIN_WALK_VX, 0, 0];
        }
    }

    function rampWalkCmd(now) {
        if (!autoWalk || userVel) return;
        const cruise = targetWalkVx();
        const u = smootherstep((now - (walkSince || now)) / WALK_VX_IN_MS);
        const vx = MIN_WALK_VX + u * (cruise - MIN_WALK_VX);
        cmd.vel = [vx, 0, 0];
        if (vx >= cruise * 0.95 && !loggedWalkVx) {
            loggedWalkVx = true;
            console.log('[microduckPolicy] walk cruise', { vx });
        }
    }

    applyHome();
    ensureWalkCmd();

    function liveGravity() {
        return projGFromXquat(data, torso);
    }

    function packObs() {
        const gyro = readGyro(model, data, gyroAdr, torso);
        const g = liveGravity();
        return packPolicyObs({
            obs,
            data,
            nAct,
            qadr,
            dadr,
            defaultPose,
            lastAction,
            gyro,
            g,
            skill,
            cmd,
        });
    }

    function applyAction(act) {
        const scale = liveScale();
        for (let i = 0; i < nAct; i++) {
            let a = Number(act[i]);
            if (!Number.isFinite(a)) a = 0;
            if (a > 1) a = 1;
            if (a < -1) a = -1;
            lastAction[i] = a;
            const actI = actIdx[i] | 0;
            const [lo, hi] = ctrlRange(actI);
            data.ctrl[actI] = clip(defaultPose[i] + scale * a, lo, hi);
        }
    }

    async function loadSessions({
        walkUrl: nextWalk = walkUrl,
        onProgress,
    } = {}) {
        if (sessionsReady) return { walk: !!walk, stand: false };
        if (sessionsLoading) return sessionsLoading;

        sessionsLoading = (async () => {
            onProgress?.('Loading walk policy…', 86);
            walk = await tryLoad(nextWalk, 'walk');
            sessionsReady = !!walk;
            console.log('[microduckPolicy] sessions', {
                walkUrl: nextWalk,
                hasWalk: !!walk,
                hasStand: false,
                mode: 'walk-only',
            });
            return { walk: !!walk, stand: false };
        })();

        try {
            return await sessionsLoading;
        } finally {
            sessionsLoading = null;
        }
    }

    async function infer(outcome) {
        if (outcome) lastOutcome = outcome;
        if (!enabled || busy) return lastAction;
        if (!walk) return lastAction;
        busy = true;
        try {
            if (!loggedContract) {
                loggedContract = true;
                packObs();
                logPolicyContract({
                    model,
                    data,
                    nAct,
                    torso,
                    torsoBodyName,
                    gyroAdr,
                    gyroSensorName,
                    walk,
                    obs,
                    defaultPose,
                    names,
                    actIdx,
                });
            }

            rampWalkCmd(performance.now());
            ensureWalkCmd();

            packObs();
            const results = await walk.run({
                [walk.inputNames[0]]: new ort.Tensor('float32', obs, [1, OBS_N]),
            });
            applyAction(results[walk.outputNames[0]].data);
            ticks++;
            if (ticks <= 5 || ticks % 50 === 0) {
                logObsTick({
                    skill,
                    overrideSkill: 'walk',
                    session: walk,
                    obs,
                    data,
                    torso,
                    lastAction,
                    cmd,
                    ticks,
                    gyroAdr,
                });
            }
        } finally {
            busy = false;
        }
        return lastAction;
    }

    console.log('[microduckPolicy] plant ready (walk-only, onnx deferred)', {
        nu,
        nAct,
        autoWalk,
        defaultWalkVx,
        minWalkVx: MIN_WALK_VX,
        stillEps: STILL_EPS,
        walkActionScale: WALK_ACTION_SCALE,
        qadr: Array.from(qadr),
        dadr: Array.from(dadr),
        actIdx: Array.from(actIdx),
        names,
        jointOrderOk: order.ok,
        torso,
        gyroAdr,
        walkUrl,
    });

    return {
        infer,
        packObs,
        applyHome,
        resetStand: applyHome,
        loadSessions,
        hasSessions: () => !!walk,
        setEnabled: (v) => { enabled = !!v; },
        isEnabled: () => enabled,
        setAutoWalk: (v) => {
            autoWalk = !!v;
            if (autoWalk && !userVel) {
                walkSince = performance.now();
                loggedWalkVx = false;
                cmd.vel = [MIN_WALK_VX, 0, 0];
            }
        },
        setDefaultWalkVx: (vx) => {
            defaultWalkVx = Number(vx) || DEFAULT_WALK_VX;
        },
        setVel: (vx = 0, vy = 0, wz = 0) => {
            cmd.vel = finite3([vx, vy, wz]);
            userVel = velNorm() > STILL_EPS;
            if (!userVel && autoWalk) {
                cmd.vel = [MIN_WALK_VX, 0, 0];
            }
        },
        setHead: (arr = []) => {
            cmd.head = [
                Number(arr[0]) || 0,
                Number(arr[1]) || 0,
                Number(arr[2]) || 0,
                Number(arr[3]) || 0,
            ];
        },
        setBody: (arr = []) => {
            cmd.body = [
                Number(arr[0]) || 0,
                Number(arr[1]) || 0,
                Number(arr[2]) || 0,
                Number(arr[3]) || 0,
                Number(arr[4]) || 0,
                Number(arr[5]) || 0,
            ];
        },
        setSkill: (name) => {
            if (name && String(name) !== 'walk') {
                console.warn('[microduckPolicy] walk-only: ignored skill', name);
            }
            return 'walk';
        },
        clearSkill: () => { },
        getSkill: () => 'walk',
        lastAction,
        defaultPose,
        qadr,
        dadr,
        actIdx,
        gyroAdr,
        torso,
    };
}

export default createMicroduckPolicy;