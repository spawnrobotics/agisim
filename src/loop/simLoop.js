// simLoop.js

import { readStandHeights } from '../rewards/rewards.js';
import { createRewardCurriculum } from '../rewards/curriculum.js';
import { REWARD_DEFAULTS } from '../rewards/constants.js';
import CONFIG from '../config.js';
import { createPhysicsClock, readSimCfg, policyCfg } from './simPhysics.js';
import {
    readGlobalMotorState,
    limbImuForGroup,
} from '../motorObs.js';

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function readCmd3(src, fallback = [0, 0, 0]) {
    const raw = Array.isArray(src) && src.length >= 3 ? src : fallback;
    return [Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0];
}

function readHeadCmd(src) {
    const raw = Array.isArray(src) ? src : [0, 0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
        Number(raw[3]) || 0,
    ];
}

function defaultWalkCmd(robot, rewardOpts) {
    const fallbackVx = num(
        rewardOpts?.standWalkVx ??
        robot?.stand?.standWalkVx ??
        robot?.cmd?.[0] ??
        REWARD_DEFAULTS.standWalkVx,
        0
    );
    return readCmd3(rewardOpts?.cmd || robot?.cmd, [fallbackVx, 0, 0]);
}

export function createSimLoop({
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
    rewardOpts = {},
    curriculumOpts = {},
    robot = CONFIG.robot,
    motorGroups = null,
    duckPolicy = null,
    handoff = null,
    onCtrlChanged = () => { },
}) {
    let rafId = 0;
    let lastPlantAt = 0;
    let running = false;
    let lastFrameAt = 0;
    let policyBusy = false;
    let lastInferAt = 0;
    let lateInferLogged = 0;
    let pendingAct = false;
    let lastImuLogAt = 0;

    const groups = motorGroups
        || brainWS?.getMotorGroups?.()
        || brainWS?.getGroups?.()
        || brainWS?.groups
        || [];

    const {
        inferHz,
        playbackRate,
        maxSteps,
        rewardEveryN,
        rewardMinDtMs,
    } = readSimCfg(robot);

    void policyCfg(robot);

    const clock = createPhysicsClock({
        mujoco,
        model,
        data,
        inferHz,
        playbackRate,
        maxSteps,
        onStep: (now) => maybePlant(now),
    });

    const { physDt, inferDt, inferMs } = clock;
    const dt = num(rewardOpts.dt, inferDt);
    const task = curriculumOpts.task || robot?.task || 'stand';
    const walkCmd = defaultWalkCmd(robot, rewardOpts);
    const headCmd = readHeadCmd(rewardOpts.headCmd || robot?.headCmd);

    if (duckPolicy) {
        duckPolicy.applyHome?.();
        if (Number.isFinite(Number(robot?.spawn?.z))) data.qpos[2] = Number(robot.spawn.z);
        mujoco.mj_forward(model, data);
        duckPolicy.setVel?.(walkCmd[0], walkCmd[1], walkCmd[2]);
        duckPolicy.setHead?.(headCmd);
    }

    const curriculum = createRewardCurriculum({
        enabled: curriculumOpts.enabled !== false,
        robot,
        task,
        cmd: walkCmd,
        ema: curriculumOpts.ema,
        logEvery: curriculumOpts.logEvery,
    });

    const init = readStandHeights(model, data, mujoco, { robot });
    let prevHeight = init.pelvis * 0.5 + init.head * 0.5;
    let prevPelvis = init.pelvis;
    let prevHead = init.head;
    let lastPublished = null;

    function readImuPlant(raw = {}) {
        const globalState = readGlobalMotorState(model, data, raw, {
            mujoco,
            robot,
            ...rewardOpts,
        });
        const limbs = {};
        for (const g of groups) {
            const imu = limbImuForGroup(model, data, g);
            const slot = g.id || g.header;
            limbs[slot] = {
                upright: imu.upright,
                gx: imu.gx,
                gy: imu.gy,
                wz: imu.wz,
                slot,
                header: g.header,
                kind: 'limb',
                missing: !!imu.missing,
                bodyId: imu.bodyId,
                siteId: imu.siteId,
            };
        }
        return {
            pelvis_z: globalState.pelvis_z,
            head_z: globalState.head_z,
            upright: globalState.upright,
            gx: globalState.gx,
            gy: globalState.gy,
            gz: globalState.gz,
            vx: globalState.vx,
            vy: globalState.vy,
            vz: globalState.vz,
            wx: globalState.wx,
            wy: globalState.wy,
            wz: globalState.wz,
            fallen: !!globalState.fallen,
            onFloor: !!globalState.onFloor,
            height: globalState.pelvis_z * 0.5 + globalState.head_z * 0.5,
            pelvisHeight: globalState.pelvis_z,
            headHeight: globalState.head_z,
            imu: {
                upright: globalState.upright,
                gx: globalState.gx,
                gy: globalState.gy,
                wz: globalState.wz,
                kind: 'pelvis',
                slot: 'pelvis',
            },
            imuBySlot: limbs,
            cmd: readCmd3(raw.cmd || walkCmd),
            headCmd: readHeadCmd(raw.headCmd || headCmd),
            source: 'sim-imu',
            ts: Date.now(),
        };
    }

    function publishOutcome(raw) {
        const outcome = readImuPlant(raw || {});
        lastPublished = outcome;

        if (duckPolicy?.lastAction) {
            outcome.policyAction = Array.from(duckPolicy.lastAction);
            outcome.actor = CONFIG.applyRx
                ? (CONFIG.policyToBrain ? 'onnx+brain' : 'brain')
                : 'onnx';
            brainWS?.notePolicyAction?.(duckPolicy.lastAction);
        }

        if (typeof brainWS?.pushMotorOutcome === 'function') {
            brainWS.pushMotorOutcome(outcome);
        } else {
            brainWS?.updateMotorOutcome?.(outcome);
            brainWS?.sendOutcome?.(outcome);
        }

        brainPanelRef?.setReward?.(outcome);
        brainPanelRef?.setImu?.(outcome.imu, outcome.imuBySlot);
        return outcome;
    }

    function maybePlant(now) {
        if (clock.stepCount % rewardEveryN !== 0) return;
        if (now - lastPlantAt < rewardMinDtMs) return;

        const raw = curriculum.tick?.(model, data, {
            ...rewardOpts,
            robot,
            mujoco,
            dt,
            task,
            cmd: walkCmd,
            headCmd,
            prevHeight,
            prevPelvis,
            prevHead,
            cache: false,
        }) || {};

        const outcome = publishOutcome(raw);
        if (outcome) {
            prevHeight = outcome.height;
            prevPelvis = outcome.pelvisHeight;
            prevHead = outcome.headHeight;
            handoff?.tick?.(outcome);
        }

        if (now - lastImuLogAt >= 1000) {
            lastImuLogAt = now;
        }

        lastPlantAt = now;
    }

    function policyOwnsPlant() {
        if (!CONFIG.applyRx) return true;
        return !!CONFIG.policyToBrain;
    }

    function policyShouldRun() {
        if (!duckPolicy) return false;
        if (policyOwnsPlant()) return duckPolicy.isEnabled?.() !== false;
        if (handoff) return handoff.isPolicyActor();
        return duckPolicy.isEnabled?.() !== false;
    }

    function commitPolicyAction() {
        if (!pendingAct) return;
        pendingAct = false;
        brainWS?.notePolicyAction?.(duckPolicy?.lastAction);
        onCtrlChanged();
        clock.markActionApplied();
    }

    async function kickInfer(now) {
        if (!policyShouldRun() || policyBusy) return;
        policyBusy = true;
        lastInferAt = now;
        try {
            const t0 = performance.now();
            await duckPolicy.infer(lastPublished);
            if (performance.now() - t0 > inferMs && now - lateInferLogged > 1000) {
                lateInferLogged = now;
                console.warn('[simLoop] infer late');
            }
            brainWS?.notePolicyAction?.(duckPolicy?.lastAction);
            pendingAct = true;
        } catch (err) {
            console.warn('[simLoop] policy infer failed', err);
        } finally {
            policyBusy = false;
        }
    }

    function tick(now) {
        rafId = requestAnimationFrame(tick);
        const t = now || performance.now();
        const frameDt = lastFrameAt ? Math.min(0.05, (t - lastFrameAt) / 1000) : physDt;
        lastFrameAt = t;

        drag?.update();
        if (ui.shouldStep()) {
            if (policyShouldRun()) {
                if (clock.controlDue && pendingAct) commitPolicyAction();
                if (clock.controlDue && !policyBusy) void kickInfer(t);
            }
            clock.stepFromFrame(frameDt, t);
        }

        update();
        headCam?.renderFrame();
        hud?.blitPreview();
        render();
    }

    function start() {
        if (running) return;
        running = true;
        lastFrameAt = 0;
        lastInferAt = 0;
        policyBusy = false;
        pendingAct = false;
        clock.reset();
        tick();
    }

    function stop() {
        running = false;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    }

    function resetRewardBaseline(z) {
        curriculum.reset?.();
        const h = readStandHeights(model, data, mujoco, { robot });
        prevPelvis = h.pelvis;
        prevHead = h.head;
        prevHeight = z != null && Number.isFinite(Number(z))
            ? Number(z)
            : h.pelvis * 0.5 + h.head * 0.5;
    }

    function resetStandingPlant() {
        policyBusy = false;
        lastInferAt = 0;
        lastFrameAt = 0;
        pendingAct = false;
        clock.reset();
        resetRewardBaseline(data.qpos[2]);
    }

    return {
        start,
        stop,
        resetRewardBaseline,
        resetStandingPlant,
        getCurriculum: () => curriculum,
        getGene: () => curriculum.getGene?.(),
        setGene: (g) => curriculum.setGene?.(g),
        getTask: () => curriculum.getTask?.() ?? curriculum.getGene?.(),
        setTask: (t) => curriculum.setTask?.(t) ?? curriculum.setGene?.(t),
        getMotorGroups: () => groups,
        getCmd: () => walkCmd.slice(),
        setCmd: (vx, vy, wz) => {
            walkCmd[0] = Number(vx) || 0;
            walkCmd[1] = Number(vy) || 0;
            walkCmd[2] = Number(wz) || 0;
            duckPolicy?.setVel?.(walkCmd[0], walkCmd[1], walkCmd[2]);
        },
        getTiming: () => clock.snapshot(),
        getPhysics: () => clock,
        getLastImu: () => lastPublished?.imu || null,
        getLastLimbImu: () => lastPublished?.imuBySlot || null,
        publishOutcome,
        duckPolicy,
        handoff,
    };
}

export default createSimLoop;