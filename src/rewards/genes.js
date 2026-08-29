// rewards/genes.js
export const GENE_ORDER = [
    'limits',
    'roll',
    'quad',
    'stand',
];

export const GENE_DEFAULTS = {
    limits: {
        lifetimeSteps: 1200,
        tauSteps: 700,
        fadeInSteps: 40,
        fadeOutFloor: 0.06,
        handoffFloor: 0.12,
        wTarget: 0.55,
        wApproach: 0.40,
        wRepeat: 0.50,
        wMotion: 0.08,
        wSmooth: 0.08,
        wUpright: 0,
        wHeight: 0,
        wCtrl: 0.06,
        motionScale: 0.35,
        ctrlScale: 0.8,
        nTargets: 4,
        extreme: 0.88,
        arrive: 0.16,
        retargetHold: 6,
        activeJoints: 6,
        repeatEps: 0.03,
        errScale: 0.85,
        fallbackRange: 1.6,
    },
    roll: {
        lifetimeSteps: 4500,
        tauSteps: 2550,
        fadeInSteps: 144,
        fadeOutFloor: 0.06,
        handoffFloor: 0.12,
        wRoll: 0.70,
        wProgress: 0.28,
        wFlip: 0.40,
        wFlat: 0.70,
        wFlatBelly: 0.40,
        wStuckFlat: 0.55,
        wFlail: 0.35,
        wHeight: 0.04,
        wCtrl: 0.02,
        yawVelScale: 1.4,
        spinScale: 1.1,
        dChestScale: 0.08,
        motionScale: 0.35,
        flatStart: 0.22,
        bellyStart: 0.12,
        rollDeadzone: 0.14,
        flailNoise: 0.03,
        pelvisLo: 0.08,
        pelvisHi: 0.32,
    },
    quad: {
        lifetimeSteps: 4800,
        tauSteps: 2700,
        fadeInSteps: 168,
        fadeOutFloor: 0.06,
        handoffFloor: 0.12,
        pelvisLo: 0.18,
        pelvisHi: 0.42,
        headLo: 0.22,
        headHi: 0.55,
        wPose: 0.65,
        wUpright: 0.15,
        wProgress: 0.15,
        wCtrl: 0.08,
        targetUpright: 0.25,
    },
    stand: {
        lifetimeSteps: Infinity,
        tauSteps: Infinity,
        fadeInSteps: 192,
        fadeOutFloor: 0,
        handoffFloor: 0.12,
        useStandExtractor: true,
    },
};

export function geneIndex(name) {
    const i = GENE_ORDER.indexOf(String(name || ''));
    return i < 0 ? 0 : i;
}

export function nextGene(name) {
    const i = geneIndex(name);
    return GENE_ORDER[Math.min(GENE_ORDER.length - 1, i + 1)];
}

export function isLastGene(name) {
    return geneIndex(name) >= GENE_ORDER.length - 1;
}

/**
 * Expression in [0, 1].
 * rise 0→1 over fadeIn, then exp decay, hard-off after lifetime.
 */
export function geneExpression(age, geneCfg = {}) {
    const life = Number(geneCfg.lifetimeSteps);
    const tau = Number(geneCfg.tauSteps);
    const fadeIn = Math.max(1, Number(geneCfg.fadeInSteps) || 1);
    const floor = Math.max(0, Number(geneCfg.fadeOutFloor) || 0);
    const a = Math.max(0, Number(age) || 0);

    if (Number.isFinite(life) && a >= life) return 0;

    const rise = Math.min(1, a / fadeIn);
    let decay = 1;
    if (Number.isFinite(tau) && tau > 0) {
        decay = Math.exp(-a / tau);
    }
    const e = rise * decay;
    if (e < floor && a > fadeIn) return 0;
    return e > 1 ? 1 : e < 0 ? 0 : e;
}