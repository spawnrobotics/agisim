// main.js
import { loadRobotScene } from './loader.js';
import { createRenderer } from './renderer.js';
import { createUI } from './ui.js';
import { createJointControls } from './jointControls.js';
import { createBrainWS } from './brainWS.js';
import { createBrainPanel } from './brainPanel.js';
import { createDragControls } from './dragControls.js';
import { createRobotHeadCamera } from './robotCamera.js';
import { createMediaStreaming } from './mediaStreaming.js';
import { createStreamHud } from './streamHUD.js';
import { createSimLoop } from './loop/simLoop.js';
import { createMicroduckPolicy } from './policies/microduckPolicy.js';
import { createPolicyHandoff } from './policies/policyHandoff.js';
import { createMotorGroups } from './motorGroups.js';
import { getObsSizes } from './motorObs.js';
import CONFIG, {
    ROBOTS,
    isDuckRobot,
    getStoredBrainId,
    setStoredBrainId,
} from './config.js';
import {
    spawnStanding,
    resetStanding,
    logMotorLayout,
} from './loop/simSetup.js';
import { bindFollowKeys, bindActorKeys } from './inputBindings.js';
import { clearMotorOutcome } from './rewards/rewards.js';
import {
    resolveBootRobotId,
    setActiveRobot,
    markLoadSuccess,
    revertRobotLoad,
    switchRobot as requestSwitchRobot,
    ROBOT_PENDING_KEY,
    readLocal,
} from './robotSwitch.js';

let session = null;
let switching = false;
let appStarted = false;

function familyOf(r) {
    return String(r?.family || r?.id || '').toLowerCase();
}

function listAvailableRobots() {
    const raw = Array.isArray(ROBOTS)
        ? ROBOTS
        : (ROBOTS && typeof ROBOTS === 'object' ? Object.values(ROBOTS) : []);
    const unique = [];
    const seen = new Set();
    for (const r of raw) {
        if (!r?.id) continue;
        const fam = familyOf(r);
        if (seen.has(fam)) continue;
        seen.add(fam);
        unique.push(r);
    }
    return unique.slice(0, 2);
}

function clearStoredBrainId() {
    try {
        localStorage.removeItem('brainWsBase');
        localStorage.removeItem(CONFIG.storage?.brainId || 'brainId');
        window.brainId = null;
    } catch (_) { }
    try { setStoredBrainId(null); } catch (_) { }
}

function setBoot(msg, pct) {
    const root = document.getElementById('boot-loader') || restoreBoot();
    root.classList.remove('hidden');
    root.setAttribute('aria-busy', 'true');
    const status = document.getElementById('boot-status');
    const bar = document.getElementById('boot-bar');
    if (status && msg) status.textContent = msg;
    if (bar && Number.isFinite(pct)) {
        bar.style.width = `${Math.max(4, Math.min(100, pct))}%`;
    }
}

function restoreBoot() {
    let root = document.getElementById('boot-loader');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'boot-loader';
    root.className = 'boot-loader';
    root.setAttribute('aria-busy', 'true');
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = `
      <div class="boot-card">
        <div class="boot-spinner" aria-hidden="true"></div>
        <div class="boot-title">AGI SIM</div>
        <div class="boot-status" id="boot-status">Loading model…</div>
        <div class="boot-track" aria-hidden="true">
          <div class="boot-bar" id="boot-bar"></div>
        </div>
      </div>`;
    document.body.prepend(root);
    return root;
}

function hideBoot() {
    const root = document.getElementById('boot-loader');
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-busy', 'false');
}

function stripPanels() {
    for (const id of ['brain-panel', 'control-panel', 'joint-controls', 'stream-hud']) {
        document.getElementById(id)?.remove();
    }
}

function resetBrainConnection(brainWS) {
    clearStoredBrainId();
    if (!brainWS) return;
    try {
        brainWS.resetConnection?.({ clearBrainId: true });
        return;
    } catch (_) { }
    try { brainWS.disconnect?.(); } catch (_) { }
}

async function disposeSession(s) {
    if (!s) return;
    try { s.loop?.stop?.(); } catch (_) { }
    try { s.handoff?.stop?.(); } catch (_) { }
    try { s.unbindKeys?.(); } catch (_) { }
    try { s.drag?.dispose?.(); } catch (_) { }
    try { s.media?.dispose?.(); } catch (_) { }
    try { s.hud?.dispose?.(); } catch (_) { }
    try { s.headCam?.dispose?.(); } catch (_) { }
    try { s.renderer?.dispose?.(); } catch (_) { }
    try { s.controls?.dispose?.(); } catch (_) { }
    resetBrainConnection(s.brainWS);
    try { clearMotorOutcome(); } catch (_) { }
    try { s.data?.delete?.(); } catch (_) { }
    try { s.model?.delete?.(); } catch (_) { }
    stripPanels();
}

async function switchRobot(id) {
    return requestSwitchRobot(id, {
        session,
        switching,
        setSwitching: (v) => { switching = v; },
        setSession: (s) => { session = s; },
        setBoot,
        disposeSession,
        clearStoredBrainId,
    });
}

async function boot() {
    stripPanels();
    clearStoredBrainId();

    const requestedId = resolveBootRobotId();
    const robot = setActiveRobot(requestedId, { persist: false });
    const duck = typeof isDuckRobot === 'function'
        ? isDuckRobot(robot)
        : familyOf(robot).includes('duck');

    setBoot(`Loading ${robot.name || robot.id}…`, 4);

    let loaded;
    try {
        loaded = await loadRobotScene(robot, { onProgress: setBoot });
    } catch (err) {
        const reverted = await revertRobotLoad(robot.id, err, { setBoot });
        if (reverted) return;
        throw err;
    }

    markLoadSuccess(robot.id);
    const { mujoco, model, data } = loaded;

    setBoot('Spawning robot…', 80);
    spawnStanding(mujoco, model, data, robot);

    const motorGroups = createMotorGroups(model);
    const actionSizes = motorGroups.map((g) => g.actionSize);
    const obsSizes = getObsSizes(motorGroups);
    logMotorLayout(robot, model, motorGroups);

    const policyOwnsCtrl = duck && !CONFIG.policyToBrain;
    const p = robot.policy || {};

    const loopRef = { current: null };
    const jointsRef = { current: null };
    const brainWSRef = { current: null };

    let duckPolicy = null;
    if (duck) {
        setBoot('Preparing plant…', 84);
        duckPolicy = await createMicroduckPolicy({
            model,
            data,
            walkUrl: p.walk,
            standUrl: p.stand,
            sitstandUrl: p.sitstand,
            groundPickUrl: p.groundPick,
            kickLeftUrl: p.kickLeft,
            kickRightUrl: p.kickRight,
            rollerUrl: p.roller,
            rollerCrouchUrl: p.rollerCrouch,
            rouladeUrl: p.roulade,
            actionScale: p.actionScale ?? 1.0,
            torsoBodyName: robot.torsoBody || 'trunk_base',
            floorPelvis: p.floorPelvis ?? 0.07,
            floorUpright: p.floorUpright ?? 0.45,
            standPelvis: p.standPelvis ?? 0.10,
            standUpright: p.standUpright ?? 0.70,
        });
        resetStanding(mujoco, model, data, { robot, duckPolicy, startCmd: [0, 0, 0] });
    }

    setBoot('Building renderer…', 90);
    const {
        camera,
        renderer,
        controls,
        bodyGroups,
        configureHeadCamera,
        update,
        render,
        setFollow,
        resetCamera,
        scene,
    } = createRenderer(model, data, mujoco, robot);

    const headCam = createRobotHeadCamera({
        scene,
        bodyGroups,
        model,
        frameSize: CONFIG.frameSize,
        configureHeadCamera,
        headBody: robot?.headBody,
    });
    configureHeadCamera?.(headCam?.cam);

    const drag = createDragControls({
        renderer,
        camera,
        controls,
        bodyGroups,
        model,
        data,
        mujoco,
        stiffness: robot?.drag?.stiffness ?? 400,
        damping: robot?.drag?.damping ?? 25,
        maxForce: robot?.drag?.maxForce ?? 300,
    });

    const joints = createJointControls({ mujoco, model, data });
    jointsRef.current = joints;

    const brainPanelRef = {
        setStatus: () => { },
        setReward: () => { },
        setImu: () => { },
    };
    const handoffRef = { current: null };
    let media = null;
    let hud = null;

    setBoot('Connecting systems…', 94);

    async function holdStandFrames(frames = 12) {
        const ws = brainWSRef.current;
        ws?.setApplyRx?.(false);
        ws?.setTxEnabled?.(false);
        ws?.stopAllPlayback?.();
        if (duckPolicy?.infer && duckPolicy.hasSessions?.()) {
            for (let i = 0; i < frames; i++) {
                try { await duckPolicy.infer(); } catch (err) {
                    console.warn('[main] stand hold infer failed', err);
                    break;
                }
                jointsRef.current?.syncFromData?.();
                ws?.captureWalkCtrl?.();
                ws?.applyWalkCtrl?.();
            }
        } else {
            ws?.captureWalkCtrl?.();
            ws?.applyWalkCtrl?.();
        }
    }

    async function applyStandPolicy() {
        const ws = brainWSRef.current;
        ws?.setApplyRx?.(false);
        ws?.setTxEnabled?.(false);
        ws?.stopAllPlayback?.();

        const snap = resetStanding(mujoco, model, data, {
            robot,
            duckPolicy,
            joints: jointsRef.current,
            loop: loopRef.current,
            startCmd: [0, 0, 0],
        });

        if (duck && duckPolicy?.hasSessions?.()) await holdStandFrames(16);

        jointsRef.current?.syncFromData?.();
        loopRef.current?.resetStandingPlant?.();
        ws?.captureWalkCtrl?.();
        ws?.applyWalkCtrl?.();
        return snap;
    }

    const brainWS = createBrainWS({
        model,
        data,
        motorGroups,
        actionSizes,
        obsSizes,
        visualCount: CONFIG.visualCount ?? 1,
        auditoryCount: CONFIG.auditoryCount ?? 1,
        applyRx: CONFIG.applyRx,
        onCtrlChanged: () => joints.syncFromData(),
        onStatus: (msg, color) => brainPanelRef.setStatus(msg, color),
        onReady: (msg) => {
            brainWS.setApplyRx?.(false);
            brainWS.stopAllPlayback?.();
            brainWS.setTxEnabled?.(false);
            console.log('[main] ws ready', {
                robot: robot.id,
                brainId: getStoredBrainId(),
                applyRx: brainWS.isApplyRx?.(),
                policyToBrain: CONFIG.policyToBrain,
                motors: motorGroups.map((g) => `${g.header}:${g.id}:${g.actionSize}`),
                serverMotors: msg?.motorCount,
            });
            void applyStandPolicy().then(() => {
                brainWS.releaseResetHold?.();
                brainWS.startLoop?.();
                media?.syncStreaming();
            });
        },
        onVideoBuffer: (buf) => {
            hud?.showBrainOverlay(true);
            media?.handleVideoBuffer(buf);
        },
        onAudioBuffer: (samples) => media?.playAudioImmediately(samples),
    });
    brainWSRef.current = brainWS;

    const handoff = createPolicyHandoff({
        duckPolicy,
        brainWS,
        warmupMs: 12000,
        minUpright: 0.65,
        holdOkMs: 2000,
        autoTakeover: false,
        onPhase: (phase) =>
            brainPanelRef.setStatus?.(`actor: ${phase}`, phase === 'brain' ? '#88ff88' : '#ffcc66'),
    });
    handoffRef.current = handoff;

    media = createMediaStreaming({
        getHeadCam: () => headCam,
        isWsOpen: () => brainWS.isWsOpen(),
        sendBinary: (buf) => brainWS.sendWsBinary(buf),
        onStatus: (msg, color) => brainPanelRef.setStatus(msg, color),
        videoFps: CONFIG.videoFps || 10,
        frameSize: CONFIG.frameSize,
        videoHeader: 'VIS1',
        audioHeader: 'AUD1',
    });

    hud = createStreamHud({
        media,
        getPreviewCanvas: () => headCam?.previewCanvas,
    });

    await media.setVideoEnabled(true);
    hud.paintVideo?.(media.isVideoEnabled());
    hud.paintAudio?.(media.isAudioEnabled());

    if (duck) {
        setBoot('Standing up…', 97);
        await applyStandPolicy();
    }

    const ui = createUI({
        mujoco,
        model,
        data,
        robots: listAvailableRobots(),
        activeRobotId: robot.id,
        onSelectRobot: (id) => switchRobot(id),
        onCtrlChanged: () => joints.syncFromData(),
        onResume: () => { void applyStandPolicy(); },
        onReset: () => applyStandPolicy().then(async () => {
            handoff.forceDemo?.();
            brainWS.setApplyRx?.(false);
            brainWS.setTxEnabled?.(false);
            brainWS.stopAllPlayback?.();
            brainWS.resetMotorSeed?.();
            brainWS.applyWalkCtrl?.();
            brainWS.sendResetPlant?.();
            await holdStandFrames(8);
            brainWS.releaseResetHold?.();
        }),
    });

    const brainPanel = createBrainPanel(brainWS);
    brainPanelRef.setStatus = brainPanel.setStatus;
    brainPanelRef.setReward = brainPanel.setReward;
    brainPanelRef.setImu = brainPanel.setImu;

    const unbindFollow = bindFollowKeys(setFollow, resetCamera);

    const loop = createSimLoop({
        mujoco,
        model,
        data,
        ui,
        drag,
        update,
        render,
        headCam,
        hud,
        brainWS,
        brainPanelRef,
        robot,
        motorGroups,
        duckPolicy,
        handoff,
        onCtrlChanged: () => joints.syncFromData(),
        rewardOpts: {
            cmd: Array.isArray(robot.cmd) ? robot.cmd.slice() : [0, 0, 0],
            headCmd: robot?.headCmd || [0, 0, 0, 0],
            dt: 1 / (p.hz || CONFIG.policyHz || CONFIG.motorFps || 50),
        },
        curriculumOpts: {
            task: robot?.task || (policyOwnsCtrl ? 'walk' : 'stand'),
        },
    });
    loopRef.current = loop;

    const unbindActor = bindActorKeys(duckPolicy, loop, handoff);

    handoff.start();
    loop.start();
    brainWS.connect();

    session = {
        robot,
        mujoco,
        model,
        data,
        renderer,
        controls,
        drag,
        headCam,
        media,
        hud,
        brainWS,
        handoff,
        loop,
        duckPolicy,
        unbindKeys() {
            try { unbindFollow?.(); } catch (_) { }
            try { unbindActor?.(); } catch (_) { }
        },
    };

    setBoot('Ready', 100);
    hideBoot();
    switching = false;

    console.log('[main] ready', {
        robot: robot.id,
        duck,
        nq: model.nq,
        nu: model.nu,
        nbody: model.nbody,
        motors: motorGroups.map((g) => `${g.header}:${g.id}:${g.actionSize}`),
    });

    if (duck && duckPolicy?.loadSessions) {
        void duckPolicy.loadSessions({
            walkUrl: p.walk,
            standUrl: p.stand,
            onProgress: (msg, pct) => console.log('[main] policy', msg, pct),
        }).then(async (loaded) => {
            if (loaded?.walk || loaded?.stand) {
                await applyStandPolicy();
                brainWS.releaseResetHold?.();
            }
        }).catch((err) => {
            console.warn('[main] onnx skipped', err);
        });
    }
}

if (window.__mujocoAppStarted) {
    console.warn('[main] App already started — skipping second instance');
} else {
    window.__mujocoAppStarted = true;
    appStarted = true;
    boot().catch(async (err) => {
        const failedId = CONFIG.robot?.id || readLocal(ROBOT_PENDING_KEY);
        const reverted = await revertRobotLoad(failedId, err, { setBoot });
        window.__mujocoAppStarted = false;
        appStarted = false;
        switching = false;
        if (reverted) return;
        console.error(err);
        document.body.innerHTML = `<pre style="color:#ff5555;padding:24px;font-family:monospace">${err.stack || err}</pre>`;
    });
}

window.addEventListener('beforeunload', () => {
    if (!appStarted && !session) return;
    const s = session;
    session = null;
    try { s?.loop?.stop?.(); } catch (_) { }
    try { s?.drag?.dispose?.(); } catch (_) { }
    try { s?.media?.dispose?.(); } catch (_) { }
    try { s?.hud?.dispose?.(); } catch (_) { }
    try { s?.headCam?.dispose?.(); } catch (_) { }
    try { s?.brainWS?.disconnect?.(); } catch (_) { }
    try { s?.data?.delete?.(); } catch (_) { }
    try { s?.model?.delete?.(); } catch (_) { }
});