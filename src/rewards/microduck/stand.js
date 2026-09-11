// rewards/duck/stand.js
// Stand score in [0, 1]. Hard negative only when onFloor.

import { clamp01, normalizeOutcome } from '../helpers.js';
import { DUCK_REWARD_DEFAULTS, HEAD_JOINTS } from './defaults.js';
import {
    state,
    mergeDuckCfg,
    measureDuck,
    resetDuckRewardState,
    publishReward,
} from './measure.js';

export { DUCK_REWARD_DEFAULTS, HEAD_JOINTS } from './defaults.js';
export {
    state,
    mergeDuckCfg,
    measureDuck,
    resetDuckRewardState,
    publishReward,
} from './measure.js';

export function extractDuckStandReward(model, data, opts = {}) {
    const cfg = mergeDuckCfg(opts);
    if (opts.reset) resetDuckRewardState();
    const m = measureDuck(model, data, opts, cfg);

    const height = clamp01(m.pelvis / Math.max(1e-3, m.pelvisStand));
    const standScore = clamp01(
        0.42 * m.uprightGauss +
        0.28 * m.hold +
        0.18 * height +
        0.08 * m.balanceTerm +
        0.04 * m.pose
    );

    let score = standScore;
    if (m.success) score = Math.max(score, 0.95);
    if (m.atStand && m.stable) score = Math.max(score, 0.90);
    if (m.stable && state.holdTicks >= (cfg.holdTicksNeed ?? 8)) {
        score = Math.min(1, score + (cfg.wHeld ?? 0.08));
    }
    if (m.success) score = Math.min(1, score + (cfg.wSuccess ?? 0.15));
    if (m.belowStand) score = Math.max(score * 0.65, (cfg.wRise ?? 0.20) * m.riseTerm);

    const reward = publishReward(score, m.onFloor, cfg);

    let gene = 'rise';
    if (m.onFloor) gene = 'stand';
    else if (m.atStand) gene = 'upright';

    return normalizeOutcome({
        reward,
        height: +((m.pelvis + m.headZ) * 0.5).toFixed(4),
        pelvisHeight: +m.pelvis.toFixed(4),
        pelvis_z: +m.pelvis.toFixed(4),
        headHeight: +m.headZ.toFixed(4),
        upright: +m.upright.toFixed(4),
        tiltDeg: +m.tiltDeg.toFixed(2),
        rollDeg: +m.rollDeg.toFixed(2),
        pitchDeg: +m.pitchDeg.toFixed(2),
        heightTerm: +height.toFixed(4),
        uprightTerm: +clamp01(m.uprightGauss).toFixed(4),
        progressTerm: +clamp01(m.hold).toFixed(4),
        success: m.success,
        fallen: m.fallen,
        onFloor: m.onFloor,
        hold: m.hold,
        sway: +m.sway.toFixed(4),
        holdTicks: state.holdTicks,
        posSum: Math.max(0, reward),
        negSum: Math.max(0, -reward),
        valence: reward,
        gene,
        source: m.onFloor ? 'duck-floor' : 'duck-upright',
        ts: Date.now(),
        raw: +score.toFixed(4),
        terms: {
            upright: m.uprightGauss,
            hold: m.hold,
            sway: m.sway,
            lean: m.lean,
            leanRoll: m.leanRoll,
            leanPitch: m.leanPitch,
            pose: m.pose,
            headPose: m.headPose,
            headBias: m.headBias,
            balance: m.balanceTerm,
            rise: m.riseTerm,
            slip: -m.slip,
            bodyAng: -m.bodyAng,
            actionRate: -m.dA2,
            vex: m.vLocal[0] - m.vxCmd,
            vey: m.vLocal[1] - m.vyCmd,
            wez: m.w[2] - m.wzCmd,
        },
        cmd: [m.vxCmd, m.vyCmd, m.wzCmd],
        headCmd: m.headCmd,
        trackLin: 0,
        trackAng: 0,
        vErr: [
            +(m.vLocal[0] - m.vxCmd).toFixed(4),
            +(m.vLocal[1] - m.vyCmd).toFixed(4),
            +(m.w[2] - m.wzCmd).toFixed(4),
        ],
        vLocal: [+m.vLocal[0].toFixed(4), +m.vLocal[1].toFixed(4), +m.vLocal[2].toFixed(4)],
        qvelRms: m.velPen,
        ctrlRms: m.ctrlPen,
    });
}

export default extractDuckStandReward;