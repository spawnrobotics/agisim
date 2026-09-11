// rewards/constants.js
/** Trailer after group-local planes + limb IMU. Slots stay zeroed. */
export const MOTOR_OUTCOME_EXTRA = 3;

export const STIM_NEAR_ZERO = 0.01;

export const REWARD_DEFAULTS = {
    pelvisStand: 0.79,
    pelvisFall: 0.12,
    pelvisSit: 0.35,
    pelvisFloor: 0.05,
    headStand: 1.22,
    headFall: 0.20,
    headFloor: 0.12,
    standWalkVx: 0.4,
};

export const STANDUP_REWARD_DEFAULTS = REWARD_DEFAULTS;