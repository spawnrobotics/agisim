// rewards/index.js
export {
    extractReward,
    extractStandUpReward,
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