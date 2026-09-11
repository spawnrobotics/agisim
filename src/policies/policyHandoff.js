// policyHandoff.js
export function createPolicyHandoff({
    duckPolicy,
    brainWS,
    warmupMs = 12000,
    minUpright = 0.7,
    holdOkMs = 2000,
    autoTakeover = false,
    onPhase = () => { },
}) {
    let phase = duckPolicy ? 'demo' : 'brain';
    let startedAt = 0;
    let okSince = 0;

    function ensureLearning() {
        brainWS?.setTxEnabled?.(true);
        brainWS?.startLoop?.();
        brainWS?.startMotorLoop?.();
    }

    function setPhase(next) {
        const target = duckPolicy ? next : 'brain';
        const demo = target === 'demo' || target === 'blend';

        duckPolicy?.setEnabled?.(demo);     // ONNX still runs in demo
        brainWS?.setApplyRx?.(true);        // server also writes ctrl
        ensureLearning();

        if (target === phase) return phase;
        phase = target;
        onPhase(phase);
        return phase;
    }

    function start() {
        startedAt = performance.now();
        okSince = 0;
        ensureLearning();
        setPhase(duckPolicy ? 'demo' : 'brain');
    }

    function tick(outcome) {
        ensureLearning();
        if (!autoTakeover || phase === 'brain' || !duckPolicy) return phase;

        const now = performance.now();
        const warmed = now - startedAt >= warmupMs;
        const upright = Number(outcome?.upright);
        const ok =
            !!outcome &&
            !outcome.fallen &&
            ((Number.isFinite(upright) && upright >= minUpright) || !!outcome.success);

        if (ok) {
            if (!okSince) okSince = now;
        } else {
            okSince = 0;
        }

        const stable = okSince && now - okSince >= holdOkMs;
        if (warmed && stable) setPhase('brain');
        return phase;
    }

    function forceBrain() {
        setPhase('brain');
    }

    function forceDemo() {
        if (!duckPolicy) {
            setPhase('brain');
            return;
        }
        startedAt = performance.now();
        okSince = 0;
        setPhase('demo');
    }

    return {
        start,
        tick,
        forceBrain,
        forceDemo,
        getPhase: () => phase,
        isPolicyActor: () => phase !== 'brain',
        ensureLearning,
    };
}

export default createPolicyHandoff;