import CONFIG from '../config.js';

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export function policyCfg(robot) {
    return robot?.policy && typeof robot.policy === 'object' ? robot.policy : {};
}

export function readSimCfg(robot) {
    const p = policyCfg(robot);
    const sim = robot?.sim && typeof robot.sim === 'object' ? robot.sim : {};
    const inferHz = Math.max(1, num(p.hz ?? sim.inferHz ?? CONFIG.policyHz, 50));
    const playbackRate = Math.max(
        0.01,
        num(p.playbackRate ?? sim.playbackRate ?? CONFIG.playbackRate, .25)
    );
    const maxSteps = Math.max(
        1,
        Math.floor(num(sim.maxStepsPerFrame ?? CONFIG.maxStepsPerFrame, 24))
    );
    const rewardEveryN = Math.max(
        1,
        Math.floor(num(sim.rewardEveryN ?? CONFIG.rewardEveryN, 1))
    );
    const rewardMinDtMs = Math.max(
        0,
        num(sim.rewardMinDtMs ?? CONFIG.rewardMinDtMs, 20)
    );
    const motorFps = Math.max(1, num(CONFIG.motorFps, inferHz));
    return { inferHz, playbackRate, maxSteps, rewardEveryN, rewardMinDtMs, motorFps };
}

export function readPhysDt(model) {
    return Math.max(1e-4, Number(model?.opt?.timestep) || 0.002);
}

export function controlPeriod(model, inferHz) {
    const physDt = readPhysDt(model);
    const hz = Math.max(1, Number(inferHz) || 50);
    const inferDt = 1 / hz;
    const decimation = Math.max(1, Math.round(inferDt / physDt));
    return {
        physDt,
        inferHz: hz,
        inferDt,
        inferMs: inferDt * 1000,
        decimation,
        controlDt: physDt * decimation,
    };
}

/**
 * Integrator that can either free-run from wall time or hold a control period
 * (exactly `decimation` steps per action).
 */
export function createPhysicsClock({
    mujoco,
    model,
    data,
    inferHz,
    playbackRate,
    maxSteps,
    onStep = () => { },
}) {
    const period = controlPeriod(model, inferHz);
    const { physDt, decimation } = period;

    let physCarry = 0;
    let stepsInPeriod = 0;
    let controlDue = true;
    let stepCount = 0;

    function stepOnce(now) {
        mujoco.mj_step(model, data);
        stepCount++;
        stepsInPeriod++;
        onStep(now, stepCount);
        if (stepsInPeriod >= decimation) {
            controlDue = true;
            stepsInPeriod = 0;
        }
    }

    function consumeCarry(now, limit) {
        const cap = Math.max(1, Math.min(maxSteps, limit ?? maxSteps));
        let n = 0;
        while (physCarry >= physDt && n < cap) {
            stepOnce(now);
            physCarry -= physDt;
            n++;
        }
        return n;
    }

    function stepFromFrame(frameDt, now) {
        physCarry += Math.max(0, frameDt) * playbackRate;
        const maxCarry = physDt * maxSteps;
        if (physCarry > maxCarry) physCarry = maxCarry;
        return consumeCarry(now, maxSteps);
    }

    function stepDecimation(now) {
        const n = Math.min(decimation, maxSteps);
        for (let i = 0; i < n; i++) stepOnce(now);
        return n;
    }

    function markActionApplied() {
        controlDue = false;
        stepsInPeriod = 0;
    }

    function reset() {
        physCarry = 0;
        stepsInPeriod = 0;
        controlDue = true;
        stepCount = 0;
    }

    return {
        ...period,
        playbackRate,
        maxSteps,
        get stepCount() {
            return stepCount;
        },
        get controlDue() {
            return controlDue;
        },
        get stepsInPeriod() {
            return stepsInPeriod;
        },
        stepOnce,
        stepFromFrame,
        stepDecimation,
        markActionApplied,
        reset,
        snapshot: () => ({
            inferHz: period.inferHz,
            playbackRate,
            maxSteps,
            physDt,
            decimation,
            controlDt: period.controlDt,
            inferDt: period.inferDt,
            inferMs: period.inferMs,
            stepCount,
            controlDue,
            stepsInPeriod,
        }),
    };
}

export default createPhysicsClock;