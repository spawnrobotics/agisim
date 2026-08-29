// rewards/index.js
export {
    extractReward,
    getLastMotorOutcome,
    setLastMotorOutcome,
    clearMotorOutcome,
    packJointsWithOutcome,
    resolveAdvantageFromOutcome,
    outcomeToJsonMessage,
    outcomeToStimPayload,
    readStandHeights,
    REWARD_DEFAULTS,
    STANDUP_REWARD_DEFAULTS,
    MOTOR_OUTCOME_EXTRA,
    createRewardCurriculum,
    createTouchOutcome,
    GENE_ORDER,
} from './rewards.js';

export { extractReward as extractStandUpReward } from './rewards.js';

export { meanActuatorReward } from './geneReward.js';

export { geneExpression } from './genes.js';