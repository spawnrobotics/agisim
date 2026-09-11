// rewards/g1/defaults.js
export const HEAD_LOCAL = { x: 0.0039635, y: 0, z: 0.38 };
export const G1_WALK_DEFAULTS = {
    torsoBody: 'torso_link',
    headBody: 'head_link',
    headSite: 'imu_in_torso',
    headLocal: HEAD_LOCAL,
};
export default G1_WALK_DEFAULTS;