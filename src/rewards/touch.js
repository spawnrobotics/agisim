// rewards/touch.js
const TOUCH_HEADERS = new Set(
    Array.from({ length: 9 }, (_, i) => `MOT${i + 1}`)
);

function clampReward(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
}

export function normalizeTouchOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') return null;
    const reward = clampReward(outcome.reward ?? outcome.valence ?? 0);
    const posSum = Math.max(0, Number(outcome.posSum) || 0);
    const negSum = Math.max(
        0,
        Number(outcome.negSum) || (reward < 0 ? Math.abs(reward) : 0)
    );
    return {
        reward,
        posSum: reward > 0 && posSum <= 0 ? Math.abs(reward) : posSum,
        negSum,
        valence: reward,
        source: outcome.source || 'touch',
        ts: outcome.ts || Date.now(),
    };
}

export function createTouchOutcome({ enabled = false } = {}) {
    let on = !!enabled;
    const byHeader = new Map();

    function headerOf(h) {
        return String(h || '').toUpperCase().slice(0, 4);
    }

    function setGroupTouchOutcome(header, outcome) {
        const h = headerOf(header);
        if (!TOUCH_HEADERS.has(h) && h !== 'MOTO' && h !== 'MOTR') return false;
        if (outcome == null) {
            byHeader.delete(h);
            return true;
        }
        const norm = normalizeTouchOutcome(outcome);
        if (!norm) {
            byHeader.delete(h);
            return false;
        }
        byHeader.set(h, norm);
        return true;
    }

    function getGroupTouchOutcome(header) {
        if (!on) return null;
        const h = headerOf(header);
        return byHeader.get(h) || (h === 'MOT1' ? byHeader.get('MOTO') : null) || null;
    }

    return {
        isTouchEnabled: () => on,
        enableTouch: (next = true) => {
            on = !!next;
            if (!on) byHeader.clear();
            return on;
        },
        setGroupTouchOutcome,
        clearGroupTouchOutcome: (header) => setGroupTouchOutcome(header, null),
        clearAllTouchOutcomes: () => byHeader.clear(),
        getGroupTouchOutcome,
        resolveGroupOutcome: (header, globalOutcome) =>
            getGroupTouchOutcome(header) || globalOutcome || null,
        getTouchSnapshot: () => {
            const groups = {};
            for (const [h, o] of byHeader) groups[h] = { ...o };
            return { enabled: on, groups };
        },
    };
}

export { TOUCH_HEADERS };
export default createTouchOutcome;