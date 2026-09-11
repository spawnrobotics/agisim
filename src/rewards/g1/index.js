// rewards/g1/index.js
export {
    G1_WALK_DEFAULTS,
    state,
    resetG1RewardState,
    extractG1StandReward,
} from './stand.js';

export { extractG1StandReward as extractG1WalkReward } from './stand.js';

import { extractG1StandReward } from './stand.js';

export function extractG1Reward(model, data, opts = {}) {
    return extractG1StandReward(model, data, opts);
}

export default extractG1Reward;