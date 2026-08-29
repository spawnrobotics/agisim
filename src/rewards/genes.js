// rewards/genes.js
export const GENE_ORDER = [
    'stand',
];

export const GENE_DEFAULTS = {
    stand: {
        lifetimeSteps: Infinity,
        tauSteps: Infinity,
        fadeInSteps: 1,
        fadeOutFloor: 0,
        handoffFloor: 0,
        useStandExtractor: true,
    },
};

export function geneIndex(name) {
    const i = GENE_ORDER.indexOf(String(name || ''));
    return i < 0 ? 0 : i;
}

export function nextGene(name) {
    return 'stand';
}

export function isLastGene(name) {
    return true;
}

export function geneExpression(age, geneCfg = {}) {
    const geneName = String(geneCfg.name || geneCfg.gene || '');
    if (GENE_ORDER.length === 1 && GENE_ORDER[0] === 'stand') {
        return 1;
    }

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