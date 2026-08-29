//stimSend.js

const NEAR_ZERO = 0.01;

export function sendCortexStim(sendBinary, header4, payload = {}) {
    if (typeof sendBinary !== 'function') return false;
    if (typeof header4 !== 'string' || header4.length !== 4) {
        console.warn('[StimSend] header must be exactly 4 chars:', header4);
        return false;
    }
    if (!/^[A-Z0-9 ]{4}$/.test(header4)) {
        console.warn('[StimSend] header must match [A-Z0-9 ]{4}:', header4);
        return false;
    }

    const body = payload && typeof payload === 'object' ? { ...payload } : {};
    let amount = Number(body.amount);
    if (!Number.isFinite(amount)) amount = 0;
    amount = Math.max(-1, Math.min(1, +amount.toFixed(4)));
    body.amount = amount;

    if (Math.abs(amount) < NEAR_ZERO) return false;

    try {
        const header = new TextEncoder().encode(header4);
        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        const combined = new Uint8Array(4 + jsonBytes.length);
        combined.set(header, 0);
        combined.set(jsonBytes, 4);
        sendBinary(combined.buffer);
        return true;
    } catch (err) {
        console.warn('[StimSend] TX threw', err);
        return false;
    }
}

export function sendStandUpStim(sendBinary, outcome, opts = {}) {
    if (!outcome) return false;
    const scale = opts.scale != null ? Number(opts.scale) : 1;
    const minAbs = opts.minAbs != null ? Number(opts.minAbs) : NEAR_ZERO;

    let amount = Number(outcome.reward ?? outcome.valence ?? 0);
    if (!Number.isFinite(amount)) amount = 0;
    amount = Math.max(-1, Math.min(1, amount * scale));
    if (Math.abs(amount) < minAbs) return false;

    return sendCortexStim(sendBinary, opts.header || 'STND', {
        amount: +amount.toFixed(4),
        height: outcome.height,
        upright: outcome.upright,
        fallen: !!outcome.fallen,
        posSum: outcome.posSum,
        negSum: outcome.negSum,
        source: 'mujoco_g1',
    });
}