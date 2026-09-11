// rewards/duck/index.js
// Mixer only. Backend owns motion. Frontend never writes ctrl here.
// Negative only when onFloor. Stand/walk otherwise stay in [0, 1].

import { clamp11 } from '../helpers.js';
import {
    DUCK_REWARD_DEFAULTS,
    state,
    mergeDuckCfg,
    resetDuckRewardState,
    extractDuckStandReward,
} from './stand.js';
import { extractDuckWalkReward } from './walk.js';

export {
    DUCK_REWARD_DEFAULTS,
    state,
    resetDuckRewardState,
    extractDuckStandReward,
} from './stand.js';
export { extractDuckWalkReward } from './walk.js';

export function extractDuckReward(model, data, opts = {}) {
    const task = String(opts.task || opts.robot?.task || 'stand').toLowerCase();
    const forceMove = task === 'walk' || task === 'velocity' || task === 'forward';
    const cfg = mergeDuckCfg(opts);
    const cmd = Array.isArray(opts.cmd) ? opts.cmd
        : Array.isArray(cfg.cmd) ? cfg.cmd
            : Array.isArray(opts.robot?.cmd) ? opts.robot.cmd
                : [0, 0, 0];
    const wantMove = Math.hypot(Number(cmd[0]) || 0, Number(cmd[1]) || 0, Number(cmd[2]) || 0)
        > (cfg.cmdEps ?? DUCK_REWARD_DEFAULTS.cmdEps);

    if (!forceMove && !wantMove) {
        return extractDuckStandReward(model, data, opts);
    }

    const move = extractDuckWalkReward(model, data, { ...opts, cmd });
    if (move.onFloor) {
        const floor = Number(cfg.floorReward ?? DUCK_REWARD_DEFAULTS.floorReward ?? -1);
        return {
            ...move,
            reward: floor,
            valence: floor,
            posSum: 0,
            negSum: Math.abs(floor),
            success: false,
            gene: 'stand',
            source: 'duck-floor',
        };
    }

    const mixed = clamp11(Math.max(0, Number(move.reward || 0)));

    return {
        ...move,
        reward: mixed,
        valence: mixed,
        posSum: mixed,
        negSum: 0,
        holdTicks: state.holdTicks,
        gene: wantMove && (Number(move.hold) || 0) > (cfg.indexForwardHold ?? 0.75)
            ? 'forward'
            : (move.gene || 'upright'),
        source: forceMove ? 'duck-velocity' : 'duck-upright-forward',
    };
}

export default extractDuckReward;