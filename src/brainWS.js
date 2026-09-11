import {
    getWsUrl,
    getJoinPayload,
    getStoredBrainId,
    setStoredBrainId,
    isStreamEnabled,
} from './config.js';
import CONFIG from './config.js';
import { createBrainMotor } from './brainMotor.js';
import { createMotorGroups } from './motorGroups.js';
import { getObsSizes } from './motorObs.js';
import {
    setLastMotorOutcome,
    outcomeToJsonMessage,
    outcomeToStimPayload,
    resolveAdvantageFromOutcome,
    clearMotorOutcome,
} from './rewards/rewards.js';
import { sendCortexStim } from './stimSend.js';

let activeWS = null;
let connectInFlight = false;

function forceCloseSocket(ws) {
    if (!ws) return;
    try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
        ) {
            ws.close(1000, 'replaced');
        }
    } catch (_) { }
}

function readHeader(uint8) {
    if (!uint8 || uint8.length < 4) return '';
    return String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);
}

function isVisualHeader(header) {
    return header === 'VIDO' || header === 'VIDE' || /^VIS[1-9]$/.test(header);
}

function isAudioHeader(header) {
    return header === 'AUDO' || header === 'AUIO' || /^AUD[1-9]$/.test(header);
}

function isMotorHeader(header) {
    return header === 'MOTO' || header === 'MOTR' || /^MOT[1-9]$/.test(header);
}

function headerKind(header) {
    if (isVisualHeader(header)) return 'visual';
    if (isAudioHeader(header)) return 'auditory';
    if (isMotorHeader(header)) return 'motor';
    return null;
}

function sameIntList(a, b) {
    return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((n, i) => Number(n) === Number(b[i]))
    );
}

function enrichOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') return outcome;
    const next = { ...outcome };
    if (!Number.isFinite(Number(next.advantage))) {
        next.advantage = resolveAdvantageFromOutcome(next);
    }
    next.hold = Math.max(0, Math.min(1, Number(next.hold) || 0));
    next.sway = Math.max(0, Math.min(1, Number(next.sway) || 0));
    next.holdTicks = Math.max(0, Math.floor(Number(next.holdTicks) || 0));
    next.fallen = !!next.fallen;
    next.onFloor = !!(next.onFloor || next.fallen);
    next.success = !!next.success;
    return next;
}

function standingResetOutcome() {
    return enrichOutcome({
        reward: 0,
        valence: 0,
        posSum: 0,
        negSum: 0,
        advantage: 1,
        hold: 1,
        sway: 0,
        holdTicks: 0,
        fallen: false,
        onFloor: false,
        success: false,
        vErr: [0, 0, 0],
        vLocal: [0, 0, 0],
        cmd: [0, 0, 0],
        headCmd: [0, 0, 0, 0],
        actor: 'reset',
        policyAction: null,
        source: 'plant-reset',
    });
}

export function createBrainWS({
    model,
    data,
    motorGroups: groupsIn = null,
    actionSizes: sizesIn = null,
    obsSizes: obsIn = null,
    visualCount: visualCountIn,
    auditoryCount: auditoryCountIn,
    onCtrlChanged = () => { },
    onStatus = () => { },
    onReady = () => { },
    onVideoBuffer = () => { },
    onAudioBuffer = () => { },
    applyRx: applyRxInit = CONFIG.applyRx,
} = {}) {
    let ws = null;
    let joined = false;
    let reconnectTimer = null;
    let intentionalClose = false;

    const motorOn = isStreamEnabled('motor');
    const visualOn = isStreamEnabled('visual');
    const auditoryOn = isStreamEnabled('auditory');

    const motorGroups = motorOn && Array.isArray(groupsIn) && groupsIn.length
        ? groupsIn
        : (motorOn && typeof createMotorGroups === 'function' ? createMotorGroups(model) : []);

    const actionSizes = motorOn && Array.isArray(sizesIn) && sizesIn.length
        ? sizesIn.slice()
        : (motorOn
            ? (motorGroups.length ? motorGroups.map((g) => g.actionSize) : [model.nu])
            : []);

    const obsSizes = motorOn && Array.isArray(obsIn) && obsIn.length
        ? obsIn.slice()
        : (motorOn ? getObsSizes(motorGroups) : []);

    const motorCount = motorOn ? actionSizes.length : 0;
    const visualCount = visualOn ? (visualCountIn ?? CONFIG.visualCount ?? 1) : 0;
    const auditoryCount = auditoryOn ? (auditoryCountIn ?? CONFIG.auditoryCount ?? 1) : 0;
    const primaryActionSize = actionSizes[0] ?? model.nu;

    function setStatus(msg, color) {
        onStatus(msg, color);
    }

    function isWsOpen() {
        return ws?.readyState === WebSocket.OPEN;
    }

    function isReady() {
        return isWsOpen() && joined;
    }

    function sendWsJson(obj) {
        if (!isWsOpen()) return;
        if (obj?.type === 'motor_outcome' && !motorOn) return;
        if (obj?.type === 'motor-reset' && !motorOn) return;
        ws.send(JSON.stringify(obj));
    }

    function sendWsBinary(buffer) {
        if (!isWsOpen() || buffer == null) return;
        const u8 = buffer instanceof Uint8Array
            ? buffer
            : new Uint8Array(buffer);
        const kind = headerKind(readHeader(u8));
        if (kind && !isStreamEnabled(kind)) return;
        ws.send(buffer);
    }

    const motor = createBrainMotor({
        model,
        data,
        groups: motorGroups,
        isReady,
        sendBinary: sendWsBinary,
        onCtrlChanged,
        applyRx: applyRxInit,
    });

    function pushMotorOutcome(outcome, opts = {}) {
        if (!motorOn || !outcome || typeof outcome !== 'object') return false;

        const live = enrichOutcome(outcome);
        setLastMotorOutcome(live);

        if (!isReady()) return false;

        const {
            json = true,
            stim = true,
            stimHeader = 'STND',
            stimMinAbs = live.fallen
                ? 0.05
                : (live.hold > 0.75 ? 0.0 : 0.02),
        } = opts;

        if (json) sendWsJson(outcomeToJsonMessage(live));

        if (stim) {
            const payload = outcomeToStimPayload(live, {
                minAbs: stimMinAbs,
                source: live.source || 'mujoco_g1',
            });
            if (payload) sendCortexStim(sendWsBinary, stimHeader, payload);
        }

        return true;
    }

    function sendOutcome(outcome) {
        return pushMotorOutcome(outcome, { json: true, stim: true });
    }

    function resetMotorSeed() {
        try { clearMotorOutcome?.(); } catch (_) { }
        motor.notePolicyAction?.(null);
        motor.stopAllPlayback?.();
        motor.setApplyRx?.(false);
        motor.setTxEnabled?.(false);
        motor.resetPlantMemory?.();
        motor.resetCounters?.();
        motor.applyStandCtrl?.();
        setLastMotorOutcome(standingResetOutcome());
    }

    function sendResetPlant() {
        resetMotorSeed();
        motor.applyStandCtrl?.();

        const sent =
            motor.sendResetPlant?.() ??
            motor.sendZeroActionSequence?.() ??
            false;

        const live = standingResetOutcome();
        setLastMotorOutcome(live);

        if (isReady() && motorOn) {
            sendWsJson({
                type: 'motor-reset',
                reason: 'plant-reset',
                actionSize: primaryActionSize,
                actionSizes,
                obsSizes,
                motorCount,
                fallen: false,
                success: false,
                hold: 1,
                sway: 0,
                reward: 0,
                advantage: 1,
                vErr: [0, 0, 0],
                cmd: [0, 0, 0],
                headCmd: [0, 0, 0, 0],
            });
            pushMotorOutcome(live, {
                json: true,
                stim: true,
                stimMinAbs: 0,
            });
        }

        onCtrlChanged();
        return sent;
    }

    function releaseResetHold() {
        motor.releaseResetHold?.();
        motor.applyStandCtrl?.();
        if (motorOn) {
            motor.setTxEnabled?.(true);
            motor.setApplyRx?.(CONFIG.applyRx);
            if (isReady()) motor.startLoop();
        }
    }

    function handleVideoPacket(uint8) {
        if (!visualOn) return;

        if (uint8.length >= 8 && uint8[4] !== 2) {
            if (isVisualHeader(readHeader(uint8)) && uint8[4] !== 2) {
                const payload = uint8.slice(4);
                const frameSize = CONFIG.frameSize || 32;
                const bytesPerFrame = frameSize * frameSize * 4;
                if (payload.length >= bytesPerFrame) {
                    onVideoBuffer({
                        data: payload,
                        frameCount: Math.floor(payload.length / bytesPerFrame) || 1,
                        width: frameSize,
                        height: frameSize,
                    });
                }
                return;
            }
            console.warn('[BrainWS] visual unknown subtype', uint8[4]);
            return;
        }

        const payload = uint8.length >= 8 ? uint8.slice(8) : uint8.slice(4);
        const frameSize = CONFIG.frameSize || 32;
        const bytesPerFrame = frameSize * frameSize * 4;
        const frameCount = Math.floor(payload.length / bytesPerFrame) || 0;
        if (frameCount < 1) {
            console.warn('[BrainWS] visual size mismatch', {
                payload: payload.length,
                bytesPerFrame,
            });
            return;
        }
        onVideoBuffer({
            data: payload,
            frameCount,
            width: frameSize,
            height: frameSize,
        });
    }

    function handleAudioPacket(uint8) {
        if (!auditoryOn) return;
        const payload = uint8.slice(4);
        if (payload.byteLength < 4 || payload.byteLength % 4 !== 0) return;
        const float32Array = new Float32Array(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength / 4
        );
        onAudioBuffer(float32Array);
    }

    function handleMessage(event) {
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'ready') {
                    joined = true;
                    connectInFlight = false;
                    if (msg.brainId) setStoredBrainId(msg.brainId);

                    if (
                        motorOn &&
                        msg.actionSize != null &&
                        Number(msg.actionSize) !== primaryActionSize
                    ) {
                        console.warn('[BrainWS] actionSize mismatch', {
                            server: msg.actionSize,
                            local: primaryActionSize,
                        });
                    }

                    if (
                        motorOn &&
                        msg.motorCount != null &&
                        Number(msg.motorCount) !== motorCount
                    ) {
                        console.warn('[BrainWS] motorCount mismatch', {
                            server: msg.motorCount,
                            local: motorCount,
                        });
                    }

                    if (motorOn && Array.isArray(msg.actionSizes) && !sameIntList(msg.actionSizes, actionSizes)) {
                        console.warn('[BrainWS] actionSizes mismatch', {
                            server: msg.actionSizes,
                            local: actionSizes,
                        });
                    }

                    if (motorOn && Array.isArray(msg.obsSizes) && !sameIntList(msg.obsSizes, obsSizes)) {
                        console.warn('[BrainWS] obsSizes mismatch', {
                            server: msg.obsSizes,
                            local: obsSizes,
                        });
                    }

                    setStatus(
                        msg.isPersistent ? 'Connected' : 'Connected & Ready',
                        '#60a5fa'
                    );
                    motor.setApplyRx(false);
                    motor.setTxEnabled(false);
                    motor.stopAllPlayback?.();
                    motor.applyStandCtrl?.();
                    if (motorOn) motor.startLoop();
                    onReady({
                        ...msg,
                        motorCount,
                        visualCount,
                        auditoryCount,
                        actionSizes,
                        obsSizes,
                        applyRx: motor.isApplyRx(),
                        policyToBrain: CONFIG.policyToBrain,
                        streams: {
                            visual: visualOn,
                            auditory: auditoryOn,
                            motor: motorOn,
                        },
                        headers: msg.headers || {
                            visual: visualOn
                                ? Array.from({ length: visualCount }, (_, i) => `VIS${i + 1}`)
                                : [],
                            auditory: auditoryOn
                                ? Array.from({ length: auditoryCount }, (_, i) => `AUD${i + 1}`)
                                : [],
                            motor: motorOn
                                ? (motorGroups.length ? motorGroups.map((g) => g.header) : ['MOT1'])
                                : [],
                        },
                    });
                } else if (msg.type === 'error') {
                    connectInFlight = false;
                    setStatus(msg.message || msg.error || 'Error', '#e24a4a');
                }
            } catch (_) { }
            return;
        }

        if (event.data instanceof ArrayBuffer) {
            const uint8 = new Uint8Array(event.data);
            if (uint8.length < 4) return;
            const header = readHeader(uint8);

            if (isVisualHeader(header)) {
                handleVideoPacket(uint8);
                return;
            }
            if (isAudioHeader(header)) {
                handleAudioPacket(uint8);
                return;
            }
            if (isMotorHeader(header)) {
                if (!motorOn) return;
                if (!motor.isResetHolding?.()) motor.handleRx(uint8);
            }
        }
    }

    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN && joined) {
            setStatus('Already connected', '#60a5fa');
            return;
        }
        if (
            connectInFlight ||
            (ws && ws.readyState === WebSocket.CONNECTING)
        ) {
            setStatus('Connect already in progress…', '#ffaa00');
            return;
        }

        intentionalClose = false;
        connectInFlight = true;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        motor.stopLoop();
        forceCloseSocket(activeWS);
        forceCloseSocket(ws);
        activeWS = null;
        ws = null;
        joined = false;
        motor.resetCounters();

        const wsUrl = getWsUrl(getStoredBrainId());
        setStatus(`Connecting to ${wsUrl}…`, '#ffaa00');

        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            connectInFlight = false;
            setStatus(`Invalid URL: ${err.message}`, '#e24a4a');
            return;
        }

        activeWS = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            setStatus('Connected to server — joining…', '#60a5fa');
            sendWsJson(
                getJoinPayload({
                    brainId: getStoredBrainId(),
                    actionSize: motorOn ? primaryActionSize : undefined,
                    actionSizes: motorOn ? actionSizes : undefined,
                    obsSizes: motorOn ? obsSizes : undefined,
                    motorCount,
                    visualCount,
                    auditoryCount,
                    frameSize: visualOn ? CONFIG.frameSize : undefined,
                })
            );
        };
        ws.onmessage = handleMessage;
        ws.onclose = (ev) => {
            if (ws !== activeWS && ws !== ev.target) return;
            joined = false;
            connectInFlight = false;
            motor.stopLoop();
            if (activeWS === ws) activeWS = null;
            setStatus(
                `Disconnected${ev.code ? ` code=${ev.code}` : ''}`,
                '#e24a4a'
            );
            if (!intentionalClose) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    connect();
                }, 2000);
            }
        };
        ws.onerror = () => {
            setStatus('WebSocket error (see console / close code)', '#e24a4a');
        };
    }

    function disconnect() {
        intentionalClose = true;
        connectInFlight = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        motor.stopLoop();
        joined = false;
        forceCloseSocket(ws);
        if (activeWS === ws) activeWS = null;
        ws = null;
        setStatus('Disconnected', '#aaa');
    }

    function resetConnection({ clearBrainId = false } = {}) {
        disconnect();
        resetMotorSeed();
        if (clearBrainId) {
            try {
                localStorage.removeItem(CONFIG.storage?.brainId || 'brainId');
                window.brainId = null;
            } catch (_) { }
        }
    }

    return {
        connect,
        disconnect,
        resetConnection,
        isWsOpen,
        isReady,
        sendWsJson,
        sendWsBinary,
        sendZeroActionSequence: () => motorOn && motor.sendZeroActionSequence(),
        sendResetPlant,
        resetMotorSeed,
        captureStandCtrl: () => motor.captureStandCtrl?.(),
        applyStandCtrl: () => motor.applyStandCtrl?.(),
        releaseResetHold,
        isResetHolding: () => !!motor.isResetHolding?.(),
        sendOutcome,
        pushMotorOutcome,
        getBrainId: getStoredBrainId,
        getActionSize: () => primaryActionSize,
        getActionSizes: () => actionSizes.slice(),
        getObsSizes: () => obsSizes.slice(),
        getMotorCount: () => motorCount,
        getMotorGroups: () => motorGroups,
        updateMotorOutcome: setLastMotorOutcome,
        setApplyRx: (v) => motor.setApplyRx(v),
        isApplyRx: () => motor.isApplyRx(),
        setTxEnabled: (v) => motor.setTxEnabled(motorOn && v),
        isTxEnabled: () => motor.isTxEnabled(),
        startLoop: () => { if (motorOn) motor.startLoop(); },
        stopLoop: () => motor.stopLoop(),
        startMotorLoop: () => { if (motorOn) motor.startLoop(); },
        handleRx: (u8) => {
            if (!motorOn) return;
            if (!motor.isResetHolding?.()) motor.handleRx(u8);
        },
        notePolicyAction: (act) => motor.notePolicyAction(act),
        stopAllPlayback: () => motor.stopAllPlayback(),
        syncActorFromHandoff: () => {
            if (!motorOn || motor.isResetHolding?.()) {
                motor.setApplyRx(false);
                motor.setTxEnabled(false);
                return;
            }
            motor.setApplyRx(CONFIG.applyRx);
            motor.setTxEnabled(true);
            if (isReady()) motor.startLoop();
        },
    };
}

export default createBrainWS;