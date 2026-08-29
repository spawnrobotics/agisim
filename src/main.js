// main.js
import { loadConfiguredRobot } from './loader.js';
import { createRenderer } from './renderer.js';
import { createUI } from './ui.js';
import { createJointControls } from './jointControls.js';
import { createBrainWS } from './brainWS.js';
import { createBrainPanel } from './brainPanel.js';
import { createDragControls } from './dragControls.js';
import { createRobotHeadCamera } from './robotCamera.js';
import { createMediaStreaming } from './mediaStreaming.js';
import { createStreamHud } from './streamHUD.js';
import { createSimLoop } from './simLoop.js';
import { createMotorGroups } from './motorGroups.js';
import CONFIG from './config.js';

if (window.__mujocoAppStarted) {
    console.warn('[main] App already started — skipping second instance');
} else {
    window.__mujocoAppStarted = true;
    main().catch((err) => {
        window.__mujocoAppStarted = false;
        console.error(err);
        document.body.innerHTML = `<pre style="color:#ff5555;padding:24px;font-family:monospace">${err.stack || err}</pre>`;
    });
}

function spawnStanding(mujoco, model, data, robot = CONFIG.robot) {
    const s = robot?.spawn || {};
    const quat = Array.isArray(s.quat) && s.quat.length === 4 ? s.quat : [1, 0, 0, 0];

    data.qpos[0] = Number.isFinite(s.x) ? s.x : 0;
    data.qpos[1] = Number.isFinite(s.y) ? s.y : 0;
    data.qpos[2] = Number.isFinite(s.z) ? s.z : 0.92;
    data.qpos[3] = quat[0];
    data.qpos[4] = quat[1];
    data.qpos[5] = quat[2];
    data.qpos[6] = quat[3];

    for (let i = 0; i < data.qvel.length; i++) {
        data.qvel[i] = 0;
    }

    mujoco.mj_forward(model, data);
}

function bindFollowKeys(setFollow, resetCamera) {
    let following = true;
    setFollow(following);

    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key === 'f' || e.key === 'F') {
            following = !following;
            setFollow(following);
        }
        if (e.key === 'r' || e.key === 'R') {
            resetCamera();
        }
    });
}

async function main() {
    document.getElementById('brain-panel')?.remove();
    document.getElementById('control-panel')?.remove();
    document.getElementById('joint-controls')?.remove();
    document.getElementById('stream-hud')?.remove();

    try {
        localStorage.removeItem('brainWsBase');
    } catch (_) { }

    const { mujoco, model, data, robot } = await loadConfiguredRobot();
    spawnStanding(mujoco, model, data, robot);

    const motorGroups = createMotorGroups(model);
    const actionSizes = motorGroups.map((g) => g.actionSize);
    console.log(
        `[${robot?.id || 'robot'}] motor groups`,
        motorGroups.map((g) => `${g.header} ${g.id} n=${g.actionSize} [${g.indices.join(',')}]`)
    );

    const {
        scene,
        camera,
        renderer,
        controls,
        bodyGroups,
        configureHeadCamera,
        update,
        render,
        setFollow,
        resetCamera,
    } = createRenderer(model, data, mujoco);

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

    const brainPanelRef = {
        setStatus: () => { },
        setReward: () => { },
    };

    let media = null;
    let hud = null;

    const brainWS = createBrainWS({
        model,
        data,
        motorGroups,
        actionSizes,
        visualCount: CONFIG.visualCount ?? 1,
        auditoryCount: CONFIG.auditoryCount ?? 1,
        onCtrlChanged: () => joints.syncFromData(),
        onStatus: (msg, color) => brainPanelRef.setStatus(msg, color),
        onReady: (msg) => {
            if (msg?.motorCount != null && msg.motorCount !== motorGroups.length) {
                console.warn('[main] motorCount mismatch', {
                    robot: robot?.id,
                    server: msg.motorCount,
                    local: motorGroups.length,
                });
            }
            if (Array.isArray(msg?.actionSizes)) {
                const same =
                    msg.actionSizes.length === actionSizes.length &&
                    msg.actionSizes.every((n, i) => Number(n) === actionSizes[i]);
                if (!same) {
                    console.warn('[main] actionSizes mismatch', {
                        robot: robot?.id,
                        server: msg.actionSizes,
                        local: actionSizes,
                    });
                }
            }
            media?.syncStreaming();
        },
        onVideoBuffer: (buf) => {
            hud?.showBrainOverlay(true);
            media?.handleVideoBuffer(buf);
        },
        onAudioBuffer: (samples) => media?.playAudioImmediately(samples),
    });

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

    const ui = createUI({
        mujoco,
        model,
        data,
        onCtrlChanged: () => joints.syncFromData(),
        onResume: () => {
            brainWS.sendZeroActionSequence();
        },
    });

    const brainPanel = createBrainPanel(brainWS);
    brainPanelRef.setStatus = brainPanel.setStatus;
    brainPanelRef.setReward = brainPanel.setReward;

    bindFollowKeys(setFollow, resetCamera);

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
    });
    loop.start();

    brainWS.connect();

    window.addEventListener('beforeunload', () => {
        loop.stop();
        drag.dispose();
        media?.dispose();
        hud?.dispose();
        headCam?.dispose();
        brainWS.disconnect();
        data.delete();
        model.delete();
    });
}