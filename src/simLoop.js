import {
    readStandHeights,
    resolveAdvantageFromOutcome,
} from './rewards/rewards.js';
import { createRewardCurriculum } from './rewards/curriculum.js';
import { ADV_MIN, ADV_MAX, ADV_GAIN } from './rewards/constants.js';
import CONFIG from './config.js';

const REWARD_EVERY_N = 5;
const REWARD_MIN_DT_MS = 50;

function withAdvantage(outcome) {
    if (!outcome || typeof outcome !== 'object') return outcome;

    const packed = Number(outcome.advantage);
    const reward = Number(outcome.reward ?? outcome.valence) || 0;
    const advantage = Number.isFinite(packed)
        ? Math.max(ADV_MIN, Math.min(ADV_MAX, packed))
        : Math.max(ADV_MIN, Math.min(ADV_MAX, 1 + ADV_GAIN * reward));

    return {
        ...outcome,
        reward,
        valence: Number.isFinite(Number(outcome.valence))
            ? Number(outcome.valence)
            : reward,
        advantage,
        posSum: Math.max(0, Number(outcome.posSum) || Math.max(0, reward)),
        negSum: Math.max(0, Number(outcome.negSum) || Math.max(0, -reward)),
        fallen: !!outcome.fallen,
        success: !!outcome.success,
    };
}

export function createSimLoop({
    mujoco,
    model,
    data,
    ui,
    drag,
    update,
    render,
    headCam,
    hud,
    brainWS,
    brainPanelRef,
    rewardOpts = {},
    curriculumOpts = {},
    robot = CONFIG.robot,
    motorGroups = null,
}) {
    let rafId = 0;
    let stepCount = 0;
    let lastRewardAt = 0;
    let running = false;

    const groups = motorGroups
        || brainWS?.getMotorGroups?.()
        || brainWS?.getGroups?.()
        || brainWS?.groups
        || [];

    const geneOpts = {
        ...(robot?.geneOpts || {}),
        ...(curriculumOpts.geneOpts || {}),
    };

    const curriculum = createRewardCurriculum({
        enabled: curriculumOpts.enabled !== false,
        startGene: curriculumOpts.startGene || 'stand',
        autoAdvance: false,
        decayAdvance: false,
        robot,
        geneOpts,
        chestAxis: robot?.chestAxis,
        onAdvance: (from, to, reason) => {
            console.log(`[gene] ${from} → ${to} (${reason})`);
            curriculumOpts.onAdvance?.(from, to, reason);
        },
    });

    const init = readStandHeights(model, data, mujoco, { robot });
    let prevRewardHeight = init.pelvis;
    let prevRewardPelvis = init.pelvis;
    let prevRewardHead = init.head;

    function publishOutcome(raw) {
        const outcome = withAdvantage(raw);
        if (!outcome) return null;

        if (typeof brainWS.pushMotorOutcome === 'function') {
            brainWS.pushMotorOutcome(outcome);
        } else {
            brainWS.updateMotorOutcome?.(outcome);
            brainWS.sendOutcome?.(outcome);
        }

        if (typeof brainPanelRef?.setReward === 'function') {
            brainPanelRef.setReward(outcome);
        }

        return outcome;
    }

    function tick() {
        rafId = requestAnimationFrame(tick);

        drag?.update();

        if (ui.shouldStep()) {
            mujoco.mj_step(model, data);
            stepCount++;

            const now = performance.now();
            if (
                stepCount % REWARD_EVERY_N === 0 &&
                now - lastRewardAt >= REWARD_MIN_DT_MS
            ) {
                const raw = curriculum.tick(model, data, {
                    ...rewardOpts,
                    ...(robot?.stand || {}),
                    robot,
                    prevHeight: prevRewardHeight,
                    prevPelvis: prevRewardPelvis,
                    prevHead: prevRewardHead,
                    mujoco,
                });

                const outcome = publishOutcome(raw);
                if (outcome) {
                    prevRewardHeight = outcome.height;
                    prevRewardPelvis = outcome.pelvisHeight;
                    prevRewardHead = outcome.headHeight;
                }
                lastRewardAt = now;
            }
        }

        update();
        headCam?.renderFrame();
        hud?.blitPreview();
        render();
    }

    function start() {
        if (running) return;
        running = true;
        tick();
    }

    function stop() {
        running = false;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    }

    function resetRewardBaseline(z) {
        const h = readStandHeights(model, data, mujoco, { robot });
        prevRewardPelvis = h.pelvis;
        prevRewardHead = h.head;
        prevRewardHeight =
            z != null && Number.isFinite(Number(z))
                ? Number(z)
                : h.pelvis * 0.5 + h.head * 0.5;
    }

    return {
        start,
        stop,
        resetRewardBaseline,
        getCurriculum: () => curriculum,
        getGene: () => curriculum.getGene(),
        setGene: (g) => curriculum.setGene(g),
        getMotorGroups: () => groups,
        publishOutcome,
    };
}