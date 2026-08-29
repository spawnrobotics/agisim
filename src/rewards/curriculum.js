// rewards/curriculum.js
import { extractReward, setLastMotorOutcome } from './rewards.js';
import {
    GENE_ORDER,
    GENE_DEFAULTS,
    nextGene,
    isLastGene,
    geneExpression,
} from './genes.js';
import { clamp01, clamp11, rmsArray } from './helpers.js';

const DEFAULTS = {
    enabled: true,
    startGene: 'stand',
    autoAdvance: false,
    decayAdvance: false,
    ema: 0.12,
    logEvery: 40,
};

function cfgFor(name, geneOpts) {
    const key = GENE_ORDER.includes(name) ? name : 'stand';
    return { ...GENE_DEFAULTS[key], ...(geneOpts?.[key] || {}) };
}

export function createRewardCurriculum(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    cfg.startGene = 'stand';
    cfg.autoAdvance = false;

    let gene = 'stand';
    let prev = null;
    let age = 0;
    let prevAge = 0;
    let steps = 0;
    let prevX = null;
    let prevY = null;
    let lastLogAt = -1;

    const stats = {
        steps: 0,
        motionEma: 0,
        ctrlEma: 0,
        rollEma: 0,
        forwardEma: 0,
        rewardEma: 0,
        targetEma: 0,
        repeatEma: 0,
        proneEma: 0,
        chestEma: 0,
        spinEma: 0,
        yawVelEma: 0,
    };

    function advance() {
        gene = 'stand';
        prev = null;
        prevAge = 0;
        age = 0;
        return false;
    }

    function logStatus(pose) {
        const every = Math.max(1, Number(cfg.logEvery) || 40);
        if (steps - lastLogAt < every) return;
        lastLogAt = steps;
        console.log(
            `[gene] stand 100% | r=${stats.rewardEma.toFixed(2)} | ` +
            `pelvis=${pose.pelvisHeight.toFixed(2)} ` +
            `head=${pose.headHeight.toFixed(2)} ` +
            `upright=${pose.upright.toFixed(2)}` +
            (pose.fallen ? ' fallen' : '') +
            (pose.success ? ' success' : '')
        );
    }

    function tick(model, data, extractOpts = {}) {
        const robot = extractOpts.robot || cfg.robot || null;

        const stand = extractReward(model, data, {
            ...extractOpts,
            ...(robot?.stand || {}),
            robot,
            cache: false,
        });

        const qvelRms = rmsArray(data.qvel, model.nv | 0);
        const ctrlRms = rmsArray(data.ctrl, model.nu | 0);
        const x = Number(data.qpos[0]) || 0;
        const y = Number(data.qpos[1]) || 0;
        const dx = prevX == null ? 0 : x - prevX;
        const dy = prevY == null ? 0 : y - prevY;
        prevX = x;
        prevY = y;

        const reward = clamp11(Number(stand.reward) || 0);
        const a = cfg.ema;

        stats.steps = ++steps;
        stats.motionEma = stats.motionEma * (1 - a) + clamp01(qvelRms / 0.35) * a;
        stats.ctrlEma = stats.ctrlEma * (1 - a) + clamp01(ctrlRms) * a;
        stats.rollEma = stats.rollEma * (1 - a) + clamp01((stand.upright + 0.2) / 0.55) * a;
        stats.forwardEma =
            stats.forwardEma * (1 - a) + clamp01(Math.hypot(dx, dy) / 0.04) * a;
        stats.rewardEma = stats.rewardEma * (1 - a) + reward * a;

        gene = 'stand';
        prev = null;
        age++;

        const outcome = {
            ...stand,
            reward,
            posSum: Math.max(0, reward),
            negSum: Math.max(0, -reward),
            valence: reward,
            gene: 'stand',
            prevGene: null,
            expression: 1,
            prevExpression: 0,
            geneAge: age,
            geneSteps: steps,
            source: 'stand',
            actuatorRewards: null,
        };

        if (extractOpts.cache !== false) setLastMotorOutcome(outcome);
        logStatus(stand);
        return outcome;
    }

    return {
        tick,
        getGene: () => 'stand',
        setGene: () => {
            gene = 'stand';
            prev = null;
            prevAge = 0;
            age = 0;
            steps = 0;
            lastLogAt = -1;
            return gene;
        },
        getStats: () => ({
            ...stats,
            gene: 'stand',
            prev: null,
            age,
            expression: 1,
            prevExpression: 0,
        }),
        setEnabled: (on) => { cfg.enabled = !!on; },
        isEnabled: () => !!cfg.enabled,
        advance: () => advance(),
    };
}

export default createRewardCurriculum;