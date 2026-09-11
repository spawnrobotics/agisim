// rewards/duck/walk.js
// Walk score in [0, 1] while upright. Hard negative only when onFloor.
// Walk-only: always score velocity tracking. No stand-hold path.

import { clamp01, normalizeOutcome } from '../helpers.js';
import {
    DUCK_REWARD_DEFAULTS,
    state,
    mergeDuckCfg,
    measureDuck,
    resetDuckRewardState,
    publishReward,
} from './stand.js';

export function extractDuckWalkReward(model, data, opts = {}) {
    const cfg = mergeDuckCfg(opts);
    if (opts.reset) resetDuckRewardState();
    const m = measureDuck(model, data, opts, cfg);

    const wantMove = true;
    const moveGate = Math.max(m.postureGate, m.hold);
    const poseScale = cfg.poseMoveScale ?? 0.55;

    const standPart = clamp01(
        0.35 * m.uprightGauss +
        0.25 * m.hold +
        0.15 * clamp01(m.pelvis / Math.max(1e-3, m.pelvisStand)) +
        0.10 * m.pose * poseScale +
        0.05 * m.headPose
    );

    const walkPart = clamp01(
        0.45 * m.trackLin +
        0.20 * m.trackAng +
        0.25 * m.forwardAlign +
        0.10 * clamp01(m.air)
    );

    let score = clamp01(0.40 * standPart + 0.60 * walkPart * Math.max(0.35, moveGate));

    if (!m.onFloor && m.success && m.trackLin >= (cfg.walkSuccessTrack ?? 0.50)) {
        score = Math.max(score, 0.95);
    }
    if (m.stable && state.holdTicks >= (cfg.holdTicksNeed ?? 8)) {
        score = Math.min(1, score + (cfg.wHeld ?? 0.08));
    }

    const success =
        !m.onFloor &&
        m.hold > (cfg.walkSuccessHold ?? 0.70) &&
        m.upright >= (cfg.successUpright ?? 0.78) &&
        m.pelvis >= (cfg.successPelvis ?? 0.10) &&
        m.trackLin >= (cfg.walkSuccessTrack ?? 0.50) &&
        m.forwardAlign > (cfg.walkSuccessForward ?? 0.30);

    if (success) score = Math.min(1, Math.max(score, 0.98));

    const reward = publishReward(score, m.onFloor, cfg);

    const terms = {
        trackLin: m.trackLin,
        trackAng: m.trackAng,
        upright: m.uprightGauss,
        hold: m.hold,
        sway: m.sway,
        forward: m.forwardAlign,
        air: m.air,
        pose: m.pose,
        headPose: m.headPose,
        headBias: m.headBias,
        slip: -m.slip,
        selfCol: 0,
        bodyAng: -m.bodyAng,
        actionRate: -m.dA2,
        clear: -m.clear,
        swing: -m.swing,
        vex: m.vLocal[0] - m.vxCmd,
        vey: m.vLocal[1] - m.vyCmd,
        wez: m.w[2] - m.wzCmd,
    };

    return normalizeOutcome({
        reward,
        height: +((m.pelvis + m.headZ) * 0.5).toFixed(4),
        pelvisHeight: +m.pelvis.toFixed(4),
        pelvis_z: +m.pelvis.toFixed(4),
        headHeight: +m.headZ.toFixed(4),
        upright: +m.upright.toFixed(4),
        tiltDeg: +m.tiltDeg.toFixed(2),
        heightTerm: +clamp01(m.pelvis / Math.max(1e-3, m.pelvisStand)).toFixed(4),
        uprightTerm: +clamp01(m.uprightGauss).toFixed(4),
        progressTerm: +clamp01(Math.max(m.trackLin, m.forwardAlign) * moveGate).toFixed(4),
        success,
        fallen: m.fallen,
        onFloor: m.onFloor,
        hold: m.hold,
        sway: +m.sway.toFixed(4),
        holdTicks: state.holdTicks,
        posSum: Math.max(0, reward),
        negSum: Math.max(0, -reward),
        valence: reward,
        gene: m.onFloor ? 'stand' : (moveGate > 0.75 ? 'forward' : m.atStand ? 'hold' : 'sway'),
        source: m.onFloor ? 'duck-floor' : 'duck-velocity',
        ts: Date.now(),
        raw: +score.toFixed(4),
        terms,
        cmd: [m.vxCmd, m.vyCmd, m.wzCmd],
        headCmd: m.headCmd,
        trackLin: +(m.trackLin * moveGate).toFixed(4),
        trackAng: +(m.trackAng * moveGate).toFixed(4),
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