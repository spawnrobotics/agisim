// rewards/constants.js
export const REWARD_DEFAULTS = {
    heightStand: 0.98,
    heightFall: 0.10,
    heightFloor: 0.03,
    pelvisStand: 0.79,
    pelvisFall: 0.12,
    pelvisSit: 0.35,
    pelvisFloor: 0.05,
    headStand: 1.22,
    headFall: 0.20,
    headFloor: 0.12,
    wPelvisH: 0.50,
    wHeadH: 0.50,
    wHeight: 0.45,
    wUpright: 0.35,
    wProgress: 0.65,
    wSuccess: 0.20,
    wVel: 0.01,
    wCtrl: 0.005,
    fallenFloor: -0.30,
    fallMix: 0.50,
    successHeight: 0.92,
    successUpright: 0.75,
    successPelvis: 0.70,
    successHead: 1.10,
    progressScale: 0.03,
    uprightPower: 1.25,
};

export const MOTOR_OUTCOME_EXTRA = 3;

export const STIM_NEAR_ZERO = 0.01;
export const ADV_MIN = 0.12;
export const ADV_MAX = 2.4;
export const ADV_GAIN = 0.90;

/** Default stand-up alias — same object */
export const STANDUP_REWARD_DEFAULTS = REWARD_DEFAULTS;