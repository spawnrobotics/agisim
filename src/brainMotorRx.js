import CONFIG from './config.js';

export function packHeader(tag, floats) {
    const header = new TextEncoder().encode(String(tag).slice(0, 4).padEnd(4, ' '));
    const out = new Uint8Array(4 + floats.byteLength);
    out.set(header, 0);
    out.set(
        new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength),
        4
    );
    return out.buffer;
}

export function parseFrames(uint8, actionSize) {
    if (uint8.length >= 8 && uint8[4] === 2) {
        const frameCount = uint8[5] | (uint8[6] << 8);
        const payload = uint8.subarray(8);
        if (payload.byteLength % 4 !== 0) {
            return { error: 'multi-frame misaligned', payloadBytes: payload.byteLength };
        }
        const floats = new Float32Array(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength / 4
        );
        const actualFrames = Math.min(
            frameCount || 1,
            Math.floor(floats.length / actionSize)
        );
        if (actualFrames < 1) {
            return { error: 'no complete frames', frameCount, floats: floats.length };
        }
        const frames = new Array(actualFrames);
        for (let f = 0; f < actualFrames; f++) {
            const base = f * actionSize;
            frames[f] = floats.subarray(base, base + actionSize);
        }
        return { frames, multiFrame: true };
    }

    const payload = uint8.subarray(4);
    if (payload.byteLength % 4 !== 0) {
        return { error: 'single-frame misaligned', payloadBytes: payload.byteLength };
    }
    const floats = new Float32Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength / 4
    );
    return {
        frames: [floats.subarray(0, Math.min(actionSize, floats.length))],
        multiFrame: false,
    };
}

function clampCtrl(model, i, v) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = 0;
    const low = model.actuator_ctrlrange[i * 2];
    const high = model.actuator_ctrlrange[i * 2 + 1];
    if (low !== high) n = Math.max(low, Math.min(high, n));
    return n;
}

/**
 * Incoming brain motor packets. applyRx is the only gate that writes joints.
 * Latest packet wins: apply immediately, never queue a clip.
 */
export function createBrainMotorRx({
    model,
    data,
    groups,
    onCtrlChanged = () => { },
    applyRx: applyRxInit = CONFIG.applyRx,
    intervalMs = 1000 / (CONFIG.motorFps || 20),
    log = () => { },
    warn = (...args) => console.warn('[BrainMotor]', ...args),
} = {}) {
    let applyRx = !!applyRxInit;

    let rxCount = 0;
    let rxDropped = 0;
    let lastRxLogAt = 0;
    let lastHeader = null;
    let lastFrameCount = 0;
    let lastAppliedAt = 0;

    const headerToGroup = new Map();
    for (const g of groups || []) headerToGroup.set(g.header, g);

    function resolveGroup(header) {
        const h = String(header || '').toUpperCase();
        if (headerToGroup.has(h)) return headerToGroup.get(h);
        if (h === 'MOTO' || h === 'MOTR') return groups?.[0] || null;
        return null;
    }

    function applyGroupAction(group, actions) {
        if (!applyRx || !group || !actions) return;
        const n = Math.min(group.indices.length, actions.length);
        for (let j = 0; j < n; j++) {
            const i = group.indices[j];
            data.ctrl[i] = clampCtrl(model, i, actions[j]);
        }
        lastAppliedAt = performance.now();
        onCtrlChanged();
    }

    function applyAction(actions) {
        if (!applyRx || !actions) return;
        const n = Math.min(model.nu, actions.length);
        for (let i = 0; i < n; i++) {
            data.ctrl[i] = clampCtrl(model, i, actions[i]);
        }
        lastAppliedAt = performance.now();
        onCtrlChanged();
    }

    function latestFrame(frames) {
        if (!frames?.length) return null;
        return frames[frames.length - 1];
    }

    function applyIncoming(group, frames) {
        const action = latestFrame(frames);
        if (!action) return;
        applyGroupAction(group, action);
    }

    function handleRx(uint8) {
        if (!uint8 || uint8.length < 8) {
            warn('RX too short', { length: uint8?.length });
            return;
        }

        const header = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);
        const group = resolveGroup(header);
        if (!group) {
            warn('RX unknown motor header', { header });
            return;
        }

        const parsed = parseFrames(uint8, group.actionSize);
        if (parsed.error) {
            warn('RX ' + parsed.error, { header, ...parsed });
            return;
        }

        const frames = parsed.frames;
        lastHeader = group.header;
        lastFrameCount = frames.length;

        if (!applyRx) {
            rxDropped++;
            rxCount++;
            return;
        }

        applyIncoming(group, frames);

        rxCount++;
        const now = performance.now();
        if (now - lastRxLogAt >= 1000) {
            log('RX MOT*', {
                packetsThisSec: rxCount,
                droppedWhileMuted: rxDropped,
                applyRx,
                header: group.header,
                role: group.role,
                lastSeqFrames: frames.length,
                used: 'latest',
                actionSize: group.actionSize,
                multiFrame: parsed.multiFrame,
                queued: false,
            });
            lastRxLogAt = now;
            rxCount = 0;
            rxDropped = 0;
        }
    }

    function setApplyRx(v) {
        const next = !!v;
        if (next === applyRx) return applyRx;
        applyRx = next;
        log('applyRx', applyRx);
        return applyRx;
    }

    function resetCounters() {
        rxCount = rxDropped = 0;
        lastRxLogAt = 0;
        lastHeader = null;
        lastFrameCount = 0;
        lastAppliedAt = 0;
    }

    return {
        resolveGroup,
        applyGroupAction,
        applyAction,
        startPlayback(group, frames) {
            if (!applyRx) {
                rxDropped++;
                return;
            }
            applyIncoming(group, frames);
        },
        stopPlayback() { },
        stopAllPlayback() { },
        handleRx,
        setApplyRx,
        isApplyRx: () => applyRx,
        isPlaying: () => false,
        getPlayProgress: () => ({
            queued: false,
            lastHeader,
            lastFrameCount,
            lastAppliedAt,
        }),
        resetCounters,
        bumpSeqIds() { },
        getRxStats: () => ({
            rxCount,
            rxDropped,
            applyRx,
            queued: false,
            intervalMs,
            lastHeader,
            lastFrameCount,
        }),
    };
}

export default createBrainMotorRx;