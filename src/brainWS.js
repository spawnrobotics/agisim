// brainWS.js
import {
    getWsUrl,
    getJoinPayload,
    getStoredBrainId,
    setStoredBrainId,
} from './config.js';
import CONFIG from './config.js';
import { createBrainMotor } from './brainMotor.js';
import { createMotorGroups } from './motorGroups.js';
import {
    setLastMotorOutcome,
    outcomeToJsonMessage,
    outcomeToStimPayload,
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

export function createBrainWS({
    model,
    data,
    onCtrlChanged = () => { },
    onStatus = () => { },
    onReady = () => { },
    onVideoBuffer = () => { },
    onAudioBuffer = () => { },
}) {
    let ws = null;
    let joined = false;
    let reconnectTimer = null;
    let intentionalClose = false;

    const motorGroups = typeof createMotorGroups === 'function'
        ? createMotorGroups(model)
        : [];

    const actionSizes = motorGroups.length
        ? motorGroups.map((g) => g.actionSize)
        : [model.nu];

    const motorCount = actionSizes.length;
    const visualCount = CONFIG.visualCount || 1;
    const auditoryCount = CONFIG.auditoryCount || 1;
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
        if (isWsOpen()) ws.send(JSON.stringify(obj));
    }

    function sendWsBinary(buffer) {
        if (isWsOpen()) ws.send(buffer);
    }

    const motor = createBrainMotor({
        model,
        data,
        groups: motorGroups,
        isReady,
        sendBinary: sendWsBinary,
        onCtrlChanged,
    });

    function pushMotorOutcome(outcome, opts = {}) {
        if (!outcome || typeof outcome !== 'object') return false;

        setLastMotorOutcome(outcome);

        if (!isReady()) return false;

        const {
            json = true,
            stim = true,
            stimHeader = 'STND',
            stimMinAbs = 0.05,
        } = opts;

        if (json) {
            sendWsJson(outcomeToJsonMessage());
        }

        if (stim) {
            const payload = outcomeToStimPayload(outcome, {
                minAbs: stimMinAbs,
                source: 'mujoco_g1',
            });
            if (payload) {
                sendCortexStim(sendWsBinary, stimHeader, payload);
            }
        }

        return true;
    }

    function sendOutcome(outcome) {
        return pushMotorOutcome(outcome, { json: true, stim: true });
    }

    function handleVideoPacket(uint8) {
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
                        msg.actionSize != null &&
                        Number(msg.actionSize) !== primaryActionSize
                    ) {
                        console.warn('[BrainWS] actionSize mismatch', {
                            server: msg.actionSize,
                            local: primaryActionSize,
                        });
                    }

                    if (
                        msg.motorCount != null &&
                        Number(msg.motorCount) !== motorCount
                    ) {
                        console.warn('[BrainWS] motorCount mismatch', {
                            server: msg.motorCount,
                            local: motorCount,
                        });
                    }

                    if (Array.isArray(msg.actionSizes)) {
                        const same =
                            msg.actionSizes.length === actionSizes.length &&
                            msg.actionSizes.every((n, i) => Number(n) === actionSizes[i]);
                        if (!same) {
                            console.warn('[BrainWS] actionSizes mismatch', {
                                server: msg.actionSizes,
                                local: actionSizes,
                            });
                        }
                    }

                    setStatus(
                        msg.isPersistent ? 'Connected' : 'Connected & Ready',
                        '#60a5fa'
                    );
                    motor.startLoop();
                    onReady({
                        ...msg,
                        motorCount,
                        visualCount,
                        auditoryCount,
                        actionSizes,
                        headers: msg.headers || {
                            visual: Array.from({ length: visualCount }, (_, i) => `VIS${i + 1}`),
                            auditory: Array.from({ length: auditoryCount }, (_, i) => `AUD${i + 1}`),
                            motor: motorGroups.length
                                ? motorGroups.map((g) => g.header)
                                : ['MOT1'],
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
                motor.handleRx(uint8);
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
                    actionSize: primaryActionSize,
                    actionSizes,
                    motorCount,
                    visualCount,
                    auditoryCount,
                    frameSize: CONFIG.frameSize,
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

    return {
        connect,
        disconnect,
        isWsOpen,
        isReady,
        sendWsJson,
        sendWsBinary,
        sendZeroActionSequence: () => motor.sendZeroActionSequence(),
        sendOutcome,
        pushMotorOutcome,
        getBrainId: getStoredBrainId,
        getActionSize: () => primaryActionSize,
        getActionSizes: () => actionSizes.slice(),
        getMotorCount: () => motorCount,
        getMotorGroups: () => motorGroups,
        updateMotorOutcome: setLastMotorOutcome,
    };
}