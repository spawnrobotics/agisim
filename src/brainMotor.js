// brainMotor.js
import CONFIG from './config.js';
import {
    getLastMotorOutcome,
    resolveAdvantageFromOutcome,
} from './rewards/rewards.js';
import { createTouchOutcome } from './rewards/touch.js';
import {
    createMotorGroups,
    getLegGroups,
    getWaistGroup,
    getManipGroups,
    getGazeGroup,
    assertGroupsCoverNu,
} from './motorGroups.js';
import {
    packGroupObservation,
    packAllGroupObservations,
    readGlobalMotorState,
    obsSizeForGroup,
    getObsSizes,
    GLOBAL_OBS_N,
    LOCAL_PLANES,
    OUTCOME_OBS_N,
} from './motorObs.js';

export function createBrainMotor({
    model,
    data,
    isReady = () => false,
    sendBinary = () => { },
    onCtrlChanged = () => { },
    groups: groupsOverride = null,
    enableTouch = false,
    extractOpts = {},
}) {
    const groups = (groupsOverride?.length
        ? groupsOverride
        : createMotorGroups(model)
    ).filter((g) => g?.indices?.length);

    const fullActionSize = model.nu | 0;
    const actionSizes = groups.map((g) => g.actionSize);
    const obsSizes = getObsSizes(groups);
    const motorCount = groups.length;

    const legGroups = getLegGroups(groups);
    const waistGroup = getWaistGroup(groups);
    const manipGroups = getManipGroups(groups);
    const gazeGroup = getGazeGroup(groups);

    const cover = assertGroupsCoverNu(groups, fullActionSize);
    if (!cover.ok) {
        console.warn('[BrainMotor] actuator cover', cover.reason, {
            nu: fullActionSize,
            groups: groups.map((g) => `${g.header}:${g.id}:${g.actionSize}`),
        });
    }

    const MOTOR_INTERVAL_MS = 1000 / (CONFIG.motorFps || 20);
    const MOTOR_LOG = false;
    const MOTOR_LOG_EVERY_MS = 1000;

    const touch = createTouchOutcome({ enabled: enableTouch });

    let lastMotorSend = 0;
    let motorTimer = null;

    let txCount = 0;
    let rxCount = 0;
    let lastTxLogAt = 0;
    let lastRxLogAt = 0;

    /** @type {Map<string, { queue: Float32Array[]|null, index: number, timer: any, seqId: number }>} */
    const play = new Map();
    for (const g of groups) {
        play.set(g.header, {
            queue: null,
            index: 0,
            timer: null,
            seqId: 0,
        });
    }

    const headerToGroup = new Map();
    for (const g of groups) headerToGroup.set(g.header, g);

    function motorLog(...args) {
        if (MOTOR_LOG) console.log('[BrainMotor]', ...args);
    }
    function motorWarn(...args) {
        console.warn('[BrainMotor]', ...args);
    }

    function resolveGroup(header) {
        const h = String(header || '').toUpperCase();
        if (headerToGroup.has(h)) return headerToGroup.get(h);
        if (h === 'MOTO' || h === 'MOTR') return groups[0] || null;
        return null;
    }

    function packHeader(tag, floats) {
        const header = new TextEncoder().encode(String(tag).slice(0, 4).padEnd(4, ' '));
        const out = new Uint8Array(4 + floats.byteLength);
        out.set(header, 0);
        out.set(
            new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength),
            4
        );
        return out.buffer;
    }

    /** Shared stand/walk outcome on every group. Touch is additive metadata only. */
    function outcomeForGroup(_group) {
        return getLastMotorOutcome();
    }

    function packGroupTx(group, globalState, outcome) {
        return packGroupObservation(model, data, group, outcome, globalState);
    }

    function applyGroupAction(group, actions) {
        const n = Math.min(group.indices.length, actions.length);
        for (let j = 0; j < n; j++) {
            const i = group.indices[j];
            let v = Number(actions[j]);
            if (!Number.isFinite(v)) v = 0;
            const low = model.actuator_ctrlrange[i * 2];
            const high = model.actuator_ctrlrange[i * 2 + 1];
            if (low !== high) v = Math.max(low, Math.min(high, v));
            data.ctrl[i] = v;
        }
        onCtrlChanged();
    }

    function applyAction(actions) {
        const n = Math.min(model.nu, actions.length);
        for (let i = 0; i < n; i++) {
            let v = Number(actions[i]);
            if (!Number.isFinite(v)) v = 0;
            const low = model.actuator_ctrlrange[i * 2];
            const high = model.actuator_ctrlrange[i * 2 + 1];
            if (low !== high) v = Math.max(low, Math.min(high, v));
            data.ctrl[i] = v;
        }
        onCtrlChanged();
    }

    function stopPlayback(header) {
        const st = play.get(header);
        if (!st) return;
        if (st.timer != null) {
            clearTimeout(st.timer);
            st.timer = null;
        }
        st.queue = null;
        st.index = 0;
    }

    function stopAllPlayback() {
        for (const g of groups) stopPlayback(g.header);
    }

    function startPlayback(group, frames) {
        if (!group || !frames?.length) return;

        const header = group.header;
        let st = play.get(header);
        if (!st) {
            st = { queue: null, index: 0, timer: null, seqId: 0 };
            play.set(header, st);
        }

        stopPlayback(header);
        st.seqId++;
        const myId = st.seqId;

        st.queue = frames;
        st.index = 0;

        motorLog('RX sequence start', {
            header,
            group: group.id,
            role: group.role,
            seqId: myId,
            frameCount: frames.length,
            actionSize: group.actionSize,
            intervalMs: MOTOR_INTERVAL_MS,
        });

        const step = () => {
            const cur = play.get(header);
            if (!cur || myId !== cur.seqId) return;

            if (!cur.queue || cur.index >= cur.queue.length) {
                motorLog('RX sequence done', {
                    header,
                    seqId: myId,
                    played: cur.index,
                });
                cur.timer = null;
                cur.queue = null;
                cur.index = 0;
                return;
            }

            applyGroupAction(group, cur.queue[cur.index]);
            cur.index++;

            if (cur.index < cur.queue.length && myId === cur.seqId) {
                cur.timer = setTimeout(step, MOTOR_INTERVAL_MS);
            } else if (myId === cur.seqId) {
                motorLog('RX sequence done', {
                    header,
                    seqId: myId,
                    played: cur.index,
                });
                cur.timer = null;
                cur.queue = null;
                cur.index = 0;
            }
        };

        step();
    }

    function sendMotorFrame() {
        if (!isReady()) return;
        const now = performance.now();
        if (now - lastMotorSend < MOTOR_INTERVAL_MS) return;
        lastMotorSend = now;

        const outcome = getLastMotorOutcome();
        const globalState = readGlobalMotorState(model, data, outcome, extractOpts);

        if (!groups.length) {
            const packed = packGroupObservation(
                model,
                data,
                {
                    header: 'MOTO',
                    id: 'all',
                    indices: Array.from({ length: fullActionSize }, (_, i) => i),
                    actionSize: fullActionSize,
                },
                outcome,
                globalState
            );
            sendBinary(packHeader('MOTO', packed));
            txCount++;
            return;
        }

        for (const group of groups) {
            const packed = packGroupTx(group, globalState, outcome);
            sendBinary(packHeader(group.header, packed));
        }

        txCount++;
        if (now - lastTxLogAt >= MOTOR_LOG_EVERY_MS) {
            const snap = touch.getTouchSnapshot();
            motorLog('TX MOT*', {
                packetsThisSec: txCount,
                groups: groups.map(
                    (g) => `${g.header}:${g.id}:${g.role}:act=${g.actionSize}:obs=${obsSizeForGroup(g)}`
                ),
                layout: {
                    global: GLOBAL_OBS_N,
                    localPlanes: LOCAL_PLANES,
                    outcome: OUTCOME_OBS_N,
                },
                global: {
                    reward: outcome?.reward,
                    posSum: outcome?.posSum,
                    negSum: outcome?.negSum,
                    advantage: +resolveAdvantageFromOutcome(outcome).toFixed(3),
                    upright: globalState.upright,
                    pelvis_z: globalState.pelvis_z,
                    vx: globalState.vx,
                },
                touch: snap.enabled ? snap.groups : 'off',
            });
            lastTxLogAt = now;
            txCount = 0;
        }
    }

    function sendZeroActionSequence() {
        if (!isReady()) return false;

        const outcome = getLastMotorOutcome();
        const globalState = readGlobalMotorState(model, data, outcome, extractOpts);

        if (!groups.length) {
            const zeros = new Float32Array(fullActionSize);
            applyAction(zeros);
            const packed = packGroupObservation(
                model,
                data,
                {
                    header: 'MOTO',
                    id: 'all',
                    indices: Array.from({ length: fullActionSize }, (_, i) => i),
                    actionSize: fullActionSize,
                },
                outcome,
                globalState
            );
            sendBinary(packHeader('MOTO', packed));
            return true;
        }

        for (const group of groups) {
            const zeros = new Float32Array(group.actionSize);
            startPlayback(group, [zeros]);
            sendBinary(packHeader(group.header, packGroupTx(group, globalState, outcome)));
        }

        motorLog('TX zero action sequence', {
            groups: groups.map((g) => `${g.header}:${g.actionSize}`),
            obsSizes,
        });
        return true;
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
        stopAllPlayback();
        for (const st of play.values()) st.seqId++;
    }

    function handleRx(uint8) {
        if (!uint8 || uint8.length < 8) {
            motorWarn('RX too short', { length: uint8?.length });
            return;
        }

        const header = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);
        const group = resolveGroup(header);
        if (!group) {
            motorWarn('RX unknown motor header', { header });
            return;
        }

        const as = group.actionSize;
        let frames = null;

        if (uint8.length >= 8 && uint8[4] === 2) {
            const frameCount = uint8[5] | (uint8[6] << 8);
            const payload = uint8.subarray(8);
            if (payload.byteLength % 4 !== 0) {
                motorWarn('RX multi-frame misaligned', {
                    header,
                    payloadBytes: payload.byteLength,
                });
                return;
            }
            const floats = new Float32Array(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength / 4
            );
            const actualFrames = Math.min(
                frameCount || 1,
                Math.floor(floats.length / as)
            );
            if (actualFrames < 1) {
                motorWarn('RX no complete frames', {
                    header,
                    frameCount,
                    floats: floats.length,
                    actionSize: as,
                });
                return;
            }

            frames = new Array(actualFrames);
            for (let f = 0; f < actualFrames; f++) {
                const base = f * as;
                frames[f] = floats.subarray(base, base + as);
            }
        } else {
            const payload = uint8.subarray(4);
            if (payload.byteLength % 4 !== 0) {
                motorWarn('RX single-frame misaligned', {
                    header,
                    payloadBytes: payload.byteLength,
                });
                return;
            }
            const floats = new Float32Array(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength / 4
            );
            frames = [floats.subarray(0, Math.min(as, floats.length))];
        }

        startPlayback(group, frames);

        rxCount++;
        const now = performance.now();
        if (now - lastRxLogAt >= MOTOR_LOG_EVERY_MS) {
            const st = play.get(group.header);
            motorLog('RX MOT*', {
                packetsThisSec: rxCount,
                header: group.header,
                role: group.role,
                lastSeqFrames: frames.length,
                actionSize: as,
                multiFrame: uint8[4] === 2,
                playing: st?.queue
                    ? { index: st.index, total: st.queue.length, seqId: st.seqId }
                    : null,
            });
            lastRxLogAt = now;
            rxCount = 0;
        }
    }

    function resetCounters() {
        txCount = rxCount = 0;
        lastTxLogAt = lastRxLogAt = 0;
        lastMotorSend = 0;
    }

    return {
        actionSize: groups[0]?.actionSize ?? fullActionSize,
        actionSizes,
        obsSizes,
        motorCount,
        groups,
        legGroups,
        waistGroup,
        manipGroups,
        gazeGroup,
        getGroups: () => groups,
        getObsSizes: () => obsSizes.slice(),
        packAll: (outcome) =>
            packAllGroupObservations(model, data, groups, outcome || getLastMotorOutcome(), extractOpts),
        startLoop,
        stopLoop,
        sendMotorFrame,
        sendZeroActionSequence,
        handleRx,
        resetCounters,
        applyGroupAction,
        applyAction,
        isPlaying: () => [...play.values()].some((s) => !!s.queue),
        getPlayProgress: () => {
            const out = {};
            for (const [h, st] of play) {
                out[h] = st.queue
                    ? { index: st.index, total: st.queue.length, seqId: st.seqId }
                    : null;
            }
            return out;
        },
        enableTouch: (on) => touch.enableTouch(on),
        isTouchEnabled: () => touch.isTouchEnabled(),
        setGroupTouchOutcome: (header, outcome) =>
            touch.setGroupTouchOutcome(header, outcome),
        clearGroupTouchOutcome: (header) => touch.clearGroupTouchOutcome(header),
        clearAllTouchOutcomes: () => touch.clearAllTouchOutcomes(),
        getTouchSnapshot: () => touch.getTouchSnapshot(),
    };
}