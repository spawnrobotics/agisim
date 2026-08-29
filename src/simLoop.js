// simLoop.js
import { readStandHeights } from './rewards/rewards.js';
import { createRewardCurriculum } from './rewards/curriculum.js';
import CONFIG from './config.js';

const REWARD_EVERY_N = 5;
const REWARD_MIN_DT_MS = 50;

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
}) {
    let rafId = 0;
    let stepCount = 0;
    let lastRewardAt = 0;
    let running = false;

    const geneOpts = {
        ...(robot?.geneOpts || {}),
        ...(curriculumOpts.geneOpts || {}),
    };

    const curriculum = createRewardCurriculum({
        enabled: curriculumOpts.enabled !== false,
        startGene: curriculumOpts.startGene || 'limits',
        autoAdvance: curriculumOpts.autoAdvance !== false,
        decayAdvance: curriculumOpts.decayAdvance !== false,
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
                const outcome = curriculum.tick(model, data, {
                    ...rewardOpts,
                    ...(robot?.stand || {}),
                    robot,
                    prevHeight: prevRewardHeight,
                    prevPelvis: prevRewardPelvis,
                    prevHead: prevRewardHead,
                    mujoco,
                });
                prevRewardHeight = outcome.height;
                prevRewardPelvis = outcome.pelvisHeight;
                prevRewardHead = outcome.headHeight;
                lastRewardAt = now;

                if (typeof brainWS.pushMotorOutcome === 'function') {
                    brainWS.pushMotorOutcome(outcome);
                } else {
                    brainWS.updateMotorOutcome?.(outcome);
                    brainWS.sendOutcome?.(outcome);
                }

                if (typeof brainPanelRef.setReward === 'function') {
                    brainPanelRef.setReward(outcome);
                }
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
    };
}