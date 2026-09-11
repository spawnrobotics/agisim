// stimSend.js
const NEAR_ZERO = 0.01;

function clamp11(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
}

export function sendCortexStim(sendBinary, header4, payload = {}) {
    if (typeof sendBinary !== 'function') return false;

    const header = String(header4 || '').toUpperCase().padEnd(4, ' ').slice(0, 4);
    if (!/^[A-Z0-9 ]{4}$/.test(header)) {
        console.warn('[StimSend] header must match [A-Z0-9 ]{4}:', header4);
        return false;
    }

    const body = payload && typeof payload === 'object' ? { ...payload } : {};
    const amount = +clamp11(body.amount).toFixed(4);
    body.amount = amount;
    if (Math.abs(amount) < NEAR_ZERO) return false;

    try {
        const tag = new TextEncoder().encode(header);
        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        const combined = new Uint8Array(4 + jsonBytes.length);
        combined.set(tag, 0);
        combined.set(jsonBytes, 4);
        sendBinary(combined.buffer);
        return true;
    } catch (err) {
        console.warn('[StimSend] TX threw', err);
        return false;
    }
}

export function outcomeToStimBody(outcome, opts = {}) {
    if (!outcome || typeof outcome !== 'object') return null;

    const scale = opts.scale != null ? Number(opts.scale) : 1;
    const minAbs = opts.minAbs != null ? Number(opts.minAbs) : NEAR_ZERO;
    const amount = +clamp11((Number(outcome.reward ?? outcome.valence) || 0) * scale).toFixed(4);
    if (Math.abs(amount) < minAbs) return null;

    return {
        amount,
        height: outcome.height,
        pelvisHeight: outcome.pelvisHeight,
        headHeight: outcome.headHeight,
        upright: outcome.upright,
        heightTerm: outcome.heightTerm,
        uprightTerm: outcome.uprightTerm,
        progressTerm: outcome.progressTerm,
        success: !!outcome.success,
        fallen: !!outcome.fallen,
        posSum: outcome.posSum,
        negSum: outcome.negSum,
        gene: outcome.gene || null,
        source: opts.source || outcome.source || 'mujoco',
        cmd: outcome.cmd || undefined,
    };
}

export function sendOutcomeStim(sendBinary, outcome, opts = {}) {
    const body = outcomeToStimBody(outcome, opts);
    if (!body) return false;
    return sendCortexStim(sendBinary, opts.header || 'STIM', body);
}

export { NEAR_ZERO };
export default sendOutcomeStim;