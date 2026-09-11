// brainMotor.js

import CONFIG from './config.js';
import { getLastMotorOutcome } from './rewards/rewards.js';
import { createTouchOutcome } from './rewards/touch.js';
import {
    createMotorGroups,
    getLegGroups,
    getWaistGroup,
    getLocoGroup,
    getManipGroups,
    getGazeGroup,
    assertGroupsCoverNu,
} from './motorGroups.js';
import {
    packGroupObservation,
    packAllGroupObservations,
    readGlobalMotorState,
    getObsSizes,
    limbImuForGroup,
} from './motorObs.js';
import { outcomeForGroup } from './motorOutcomeGroups.js';
import { createBrainMotorRx, packHeader } from './brainMotorRx.js';

const WALK_RESET_VX = 0.22;

function actorLabel(applyRx) {
    if (CONFIG.policyToBrain) return 'onnx';
    return applyRx ? 'brain' : 'onnx';
}

function liveOutcome(policyAction, applyRx) {
    const base = getLastMotorOutcome() || {};
    const outcome = { ...base };
    if (!Array.isArray(outcome.cmd) || outcome.cmd.length < 3) {
        outcome.cmd = [WALK_RESET_VX, 0, 0];
    }
    if (policyAction) {
        outcome.policyAction = policyAction;
        outcome.actor = actorLabel(applyRx);
    }
    return outcome;
}

function walkingResetOutcome() {
    return {
        hold: 1,
        sway: 0,
        holdTicks: 0,
        fallen: false,
        onFloor: false,
        success: false,
        vErr: [0, 0, 0],
        vLocal: [0, 0, 0],
        cmd: [WALK_RESET_VX, 0, 0],
        headCmd: [0, 0, 0, 0],
        actor: 'reset',
        policyAction: null,
        source: 'plant-reset-walk',
        gene: 'forward',
    };
}

function logGroupImus(model, data, groups) {
    const rows = (groups || []).map((g) => {
        const imu = limbImuForGroup(model, data, g);
        return {
            header: g.header,
            id: g.id,
            role: g.role,
            acts: g.actionSize,
            imuBody: g.imuBody || null,
            imuSite: g.imuSite || null,
            mapped: !!(g.imuBody || g.imuSite),
            resolved: !imu.missing,
            bodyId: imu.bodyId,
            siteId: imu.siteId,
            upright: imu.upright,
            gx: imu.gx,
            gy: imu.gy,
            wz: imu.wz,
        };
    });
    console.log('[BrainMotor] group IMU', rows);
    const missingMap = rows.filter((r) => !r.mapped);
    const missingBody = rows.filter((r) => r.mapped && !r.resolved);
    if (missingMap.length) {
        console.warn('[BrainMotor] groups without IMU target', missingMap.map((r) => r.id));
    }
    if (missingBody.length) {
        console.warn('[BrainMotor] IMU body/site not in model', missingBody.map((r) => ({
            id: r.id,
            imuBody: r.imuBody,
            imuSite: r.imuSite,
        })));
    }
    return rows;
}

export function createBrainMotor({
    model,
    data,
    isReady = () => false,
    sendBinary = () => { },
    onCtrlChanged = () => { },
    groups: groupsOverride = null,
    enableTouch = false,
    extractOpts = {},
    applyRx: applyRxInit = CONFIG.applyRx,
}) {
    const groups = (groupsOverride?.length
        ? groupsOverride
        : createMotorGroups(model)
    ).filter((g) => g?.indices?.length);

    const fullActionSize = model.nu | 0;
    const actionSizes = groups.map((g) => g.actionSize);
    const obsSizes = getObsSizes(groups);
    const motorCount = groups.length;

    const locoGroup = getLocoGroup(groups);
    const waistGroup = getWaistGroup(groups) || locoGroup;
    const legGroups = getLegGroups(groups);
    const manipGroups = getManipGroups(groups);
    const gazeGroup = getGazeGroup(groups);

    const cover = assertGroupsCoverNu(groups, fullActionSize);
    if (!cover.ok) {
        console.warn('[BrainMotor] actuator cover', cover.reason, {
            nu: fullActionSize,
            groups: groups.map((g) => `${g.header}:${g.id}:${g.actionSize}`),
        });
    }

    logGroupImus(model, data, groups);

    const MOTOR_INTERVAL_MS = 1000 / (CONFIG.motorFps || 20);
    const MOTOR_LOG = false;
    const MOTOR_LOG_EVERY_MS = 1000;

    const touch = createTouchOutcome({ enabled: enableTouch });

    let lastMotorSend = 0;
    let motorTimer = null;
    let txCount = 0;
    let lastTxLogAt = 0;
    let txEnabled = true;
    let policyAction = null;
    let holdResetTx = false;
    let lastWalkCtrl = null;

    function motorLog(...args) {
        if (MOTOR_LOG) console.log('[BrainMotor]', ...args);
    }
    function motorWarn(...args) {
        console.warn('[BrainMotor]', ...args);
    }

    const rx = createBrainMotorRx({
        model,
        data,
        groups,
        onCtrlChanged,
        applyRx: applyRxInit,
        intervalMs: MOTOR_INTERVAL_MS,
        log: motorLog,
        warn: motorWarn,
    });

    function snapshotCtrl() {
        if (!data?.ctrl) return null;
        return Array.from(data.ctrl, (x) => Number(x) || 0);
    }

    function writeCtrl(src) {
        if (!data?.ctrl || !src?.length) return false;
        const n = Math.min(data.ctrl.length, src.length);
        for (let i = 0; i < n; i++) data.ctrl[i] = Number(src[i]) || 0;
        onCtrlChanged();
        return true;
    }

    function captureWalkCtrl() {
        const snap = snapshotCtrl();
        if (snap?.length) lastWalkCtrl = snap;
        return lastWalkCtrl;
    }

    function applyWalkCtrl() {
        if (lastWalkCtrl?.length) return writeCtrl(lastWalkCtrl);
        return false;
    }

    function packGroupTx(group, globalState, outcome) {
        return packGroupObservation(model, data, group, outcome, globalState);
    }

    function sendObsOnly(outcome, globalState) {
        if (!groups.length) {
            const packed = packGroupObservation(
                model,
                data,
                {
                    header: 'MOTO',
                    id: 'all',
                    indices: Array.from({ length: fullActionSize }, (_, i) => i),
                    actionSize: fullActionSize,
                    imuBody: 'pelvis',
                    imuSite: 'imu_in_pelvis',
                },
                outcome,
                globalState
            );
            sendBinary(packHeader('MOTO', packed));
            return;
        }
        for (const group of groups) {
            sendBinary(packHeader(group.header, packGroupTx(group, globalState, outcome)));
        }
    }

    function sendMotorFrame() {
        if (!txEnabled || holdResetTx || !isReady()) return;
        const now = performance.now();
        if (now - lastMotorSend < MOTOR_INTERVAL_MS) return;
        lastMotorSend = now;

        const outcome = liveOutcome(policyAction, rx.isApplyRx());
        const globalState = readGlobalMotorState(model, data, outcome, extractOpts);
        sendObsOnly(outcome, globalState);

        txCount++;
        if (now - lastTxLogAt >= MOTOR_LOG_EVERY_MS) {
            const snap = touch.getTouchSnapshot();
            motorLog('TX MOT*', {
                packetsThisSec: txCount,
                applyRx: rx.isApplyRx(),
                actor: actorLabel(rx.isApplyRx()),
                groups: groups.map((g) => `${g.header}:${g.id}`),
                global: {
                    onFloor: !!outcome?.onFloor,
                    fallen: !!outcome?.fallen,
                    upright: globalState.upright,
                    pelvis_z: globalState.pelvis_z,
                    cmd: outcome?.cmd,
                },
                touch: snap.enabled ? snap.groups : 'off',
            });
            lastTxLogAt = now;
            txCount = 0;
        }
    }

    function resetPlantMemory() {
        policyAction = null;
        holdResetTx = true;
        rx.setApplyRx(false);
        rx.stopAllPlayback();
        rx.resetCounters();
        lastMotorSend = 0;
        txCount = 0;
        lastTxLogAt = 0;
        touch.clearAllTouchOutcomes?.();
        applyWalkCtrl();
    }

    function sendResetPlant() {
        resetPlantMemory();
        applyWalkCtrl();
        onCtrlChanged();

        const outcome = walkingResetOutcome();
        const globalState = readGlobalMotorState(model, data, outcome, extractOpts);
        globalState.fallen = false;
        globalState.success = false;

        if (!isReady()) {
            motorLog('reset plant local only (ws not ready)');
            return false;
        }

        sendObsOnly(outcome, globalState);
        motorLog('TX reset plant walk', {
            groups: groups.map((g) => `${g.header}:${g.id}:${g.actionSize}`),
            fallen: false,
            onFloor: false,
            cmd: outcome.cmd,
            wroteCtrl: !!lastWalkCtrl,
            holdResetTx,
        });
        return true;
    }

    function releaseResetHold() {
        holdResetTx = false;
        captureWalkCtrl();
    }

    function startLoop() {
        if (motorTimer) return;
        motorTimer = setInterval(sendMotorFrame, MOTOR_INTERVAL_MS);
    }

    function stopLoop() {
        if (motorTimer) {
            clearInterval(motorTimer);
            motorTimer = null;
        }
        rx.stopAllPlayback();
        rx.bumpSeqIds();
    }

    function resetCounters() {
        txCount = 0;
        lastTxLogAt = 0;
        lastMotorSend = 0;
        rx.resetCounters();
    }

    return {
        actionSize: groups[0]?.actionSize ?? fullActionSize,
        actionSizes,
        obsSizes,
        motorCount,
        groups,
        locoGroup,
        legGroups,
        waistGroup,
        manipGroups,
        gazeGroup,
        getGroups: () => groups,
        getLocoGroup: () => locoGroup,
        getObsSizes: () => obsSizes.slice(),
        packAll: (outcome) =>
            packAllGroupObservations(
                model,
                data,
                groups,
                outcome || liveOutcome(policyAction, rx.isApplyRx()),
                extractOpts
            ),
        startLoop,
        stopLoop,
        sendMotorFrame,
        sendZeroActionSequence: sendResetPlant,
        sendResetPlant,
        resetPlantMemory,
        captureStandCtrl: captureWalkCtrl,
        applyStandCtrl: applyWalkCtrl,
        captureWalkCtrl,
        applyWalkCtrl,
        releaseResetHold,
        isResetHolding: () => holdResetTx,
        handleRx: rx.handleRx,
        resetCounters,
        applyGroupAction: rx.applyGroupAction,
        applyAction: rx.applyAction,
        outcomeForGroup: (group, outcome) => outcomeForGroup(group, outcome),
        isPlaying: rx.isPlaying,
        getPlayProgress: rx.getPlayProgress,
        setApplyRx: rx.setApplyRx,
        isApplyRx: rx.isApplyRx,
        setTxEnabled: (v) => { txEnabled = !!v; },
        isTxEnabled: () => txEnabled && !holdResetTx,
        notePolicyAction: (act) => {
            policyAction = act
                ? Array.from(act, (x) => Number(x) || 0)
                : null;
            if (policyAction) lastWalkCtrl = policyAction.slice();
        },
        stopAllPlayback: rx.stopAllPlayback,
        enableTouch: (on) => touch.enableTouch(on),
        isTouchEnabled: () => touch.isTouchEnabled(),
        setGroupTouchOutcome: (header, outcome) =>
            touch.setGroupTouchOutcome(header, outcome),
        clearGroupTouchOutcome: (header) => touch.clearGroupTouchOutcome(header),
        clearAllTouchOutcomes: () => touch.clearAllTouchOutcomes(),
        getTouchSnapshot: () => touch.getTouchSnapshot(),
        logGroupImus: () => logGroupImus(model, data, groups),
    };
}

export default createBrainMotor;