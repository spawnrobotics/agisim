// simSetup.js
import {
    assertGroupsCoverNu,
    getLegGroups,
    getWaistGroup,
    getLocoGroup,
    getManipGroups,
    getGazeGroup,
} from '../motorGroups.js';
import CONFIG from '../config.js';
import { DEFAULT_POSE, ACT_N, clip } from '../policies/microduckPolicyObs.js';

export function jointQpos(model, data, j) {
    const adr = model.jnt_qposadr?.[j];
    if (adr == null || adr < 0) return null;
    return Number(data.qpos[adr]);
}

function isDuck(robot = {}) {
    const id = String(robot.id || robot.name || '').toLowerCase();
    return id.includes('duck');
}

function writeFreeJoint(data, robot = {}) {
    const s = robot.spawn || {};
    const quat = Array.isArray(s.quat) && s.quat.length === 4 ? s.quat : [1, 0, 0, 0];
    const standZ = isDuck(robot)
        ? (Number.isFinite(s.z) ? s.z : 0.125)
        : (Number.isFinite(s.z) ? s.z : 0.92);

    data.qpos[0] = Number.isFinite(s.x) ? s.x : 0;
    data.qpos[1] = Number.isFinite(s.y) ? s.y : 0;
    data.qpos[2] = standZ;
    data.qpos[3] = quat[0];
    data.qpos[4] = quat[1];
    data.qpos[5] = quat[2];
    data.qpos[6] = quat[3];
}

function zeroVel(model, data) {
    const nv = model.nv | 0;
    for (let i = 0; i < nv; i++) data.qvel[i] = 0;
    const na = model.na | 0;
    if (data.act && na > 0) {
        for (let i = 0; i < na; i++) data.act[i] = 0;
    }
}

/** STAND2 on the 14 policy servos. qpos0 is not the policy home. */
export function applyDuckStandingPose(model, data, duckPolicy = null) {
    const nAct = Math.min(ACT_N, model.nu | 0);
    const pose = duckPolicy?.defaultPose || DEFAULT_POSE;
    const qadr = duckPolicy?.qadr;

    for (let a = 0; a < nAct; a++) {
        const jnt = model.actuator_trnid[a * 2] | 0;
        const adr = qadr ? (qadr[a] | 0) : (model.jnt_qposadr[jnt] | 0);
        const target = Number(pose[a]) || 0;
        data.qpos[adr] = target;
        const lo = Number(model.actuator_ctrlrange[a * 2]);
        const hi = Number(model.actuator_ctrlrange[a * 2 + 1]);
        data.ctrl[a] = clip(target, lo, hi);
    }

    if (duckPolicy?.lastAction) duckPolicy.lastAction.fill(0);
}

export function applyStandingQpos(model, data, robot = {}, duckPolicy = null) {
    writeFreeJoint(data, robot);

    const nj = model.njnt | 0;
    for (let j = 0; j < nj; j++) {
        const typ = model.jnt_type?.[j] | 0;
        if (typ !== 2 && typ !== 3) continue;
        const adr = model.jnt_qposadr[j] | 0;
        data.qpos[adr] = Number(model.qpos0[adr]) || 0;
    }

    if (isDuck(robot) || duckPolicy) {
        applyDuckStandingPose(model, data, duckPolicy);
    }

    zeroVel(model, data);
}

export function holdStandingCtrl(model, data, duckPolicy = null) {
    if (duckPolicy) {
        applyDuckStandingPose(model, data, duckPolicy);
        return;
    }
    const nu = model.nu | 0;
    for (let i = 0; i < nu; i++) {
        let v = 0;
        const jnt = model.actuator_trnid ? (model.actuator_trnid[i * 2] | 0) : -1;
        if (jnt >= 0) {
            const q = jointQpos(model, data, jnt);
            if (q != null) v = q;
        }
        const low = Number(model.actuator_ctrlrange[i * 2]);
        const high = Number(model.actuator_ctrlrange[i * 2 + 1]);
        if (Number.isFinite(low) && Number.isFinite(high) && low !== high) {
            v = Math.max(low, Math.min(high, v));
        }
        data.ctrl[i] = v;
    }
}

export function spawnStanding(mujoco, model, data, robot = CONFIG.robot, duckPolicy = null) {
    applyStandingQpos(model, data, robot, duckPolicy);
    holdStandingCtrl(model, data, duckPolicy);
    if (Number.isFinite(Number(robot?.spawn?.z))) {
        data.qpos[2] = Number(robot.spawn.z);
    } else if (isDuck(robot) && (!Number.isFinite(data.qpos[2]) || data.qpos[2] < 0.10)) {
        data.qpos[2] = 0.125;
    }
    zeroVel(model, data);
    mujoco.mj_forward(model, data);
}

export function resetStanding(mujoco, model, data, {
    robot = CONFIG.robot,
    duckPolicy = null,
    joints = null,
    loop = null,
    startCmd = null,
} = {}) {
    duckPolicy?.clearSkill?.();
    duckPolicy?.setSit?.(0);
    duckPolicy?.setEnabled?.(true);

    spawnStanding(mujoco, model, data, robot, duckPolicy);
    duckPolicy?.applyHome?.();

    data.qpos[0] = Number.isFinite(robot?.spawn?.x) ? robot.spawn.x : 0;
    data.qpos[1] = Number.isFinite(robot?.spawn?.y) ? robot.spawn.y : 0;
    data.qpos[2] = Number.isFinite(robot?.spawn?.z)
        ? robot.spawn.z
        : (isDuck(robot) ? 0.125 : data.qpos[2]);
    data.qpos[3] = 1;
    data.qpos[4] = 0;
    data.qpos[5] = 0;
    data.qpos[6] = 0;
    zeroVel(model, data);

    // Always enter the stand net. Do not start on walk with cmd=0 flicker.
    duckPolicy?.setSkill?.('stand');
    duckPolicy?.setVel?.(0, 0, 0);
    duckPolicy?.setHead?.(robot?.headCmd || [0, 0, 0, 0]);
    duckPolicy?.setBody?.([0, 0, 0, 0, 0, 0]);

    mujoco.mj_forward(model, data);

    joints?.syncFromData?.();
    loop?.resetStandingPlant?.();
    loop?.getCurriculum?.()?.reset?.();
    loop?.resetRewardBaseline?.(data.qpos[2]);

    return {
        z: data.qpos[2],
        quat: [data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]],
        skill: duckPolicy?.getSkill?.() || 'stand',
    };
}

export function logMotorLayout(robot, model, motorGroups) {
    const nu = model?.nu | 0;
    const cover = assertGroupsCoverNu(motorGroups, nu);
    const legs = getLegGroups(motorGroups);
    const waist = getWaistGroup(motorGroups);
    const loco = getLocoGroup(motorGroups) || waist;
    const gaze = getGazeGroup(motorGroups);
    const manip = getManipGroups(motorGroups);

    console.log(
        `[${robot?.id || 'robot'}] motor groups`,
        motorGroups.map(
            (g) =>
                `${g.header} ${g.id} role=${g.role || '?'} n=${g.actionSize} [${g.indices.join(',')}]`
        )
    );

    if (!cover.ok) {
        console.warn(`[${robot?.id || 'robot'}] actuator cover failed:`, cover.reason, {
            nu,
            sum: motorGroups.reduce((s, g) => s + (g.actionSize | 0), 0),
        });
    } else {
        console.log(`[${robot?.id || 'robot'}] actuator cover ok nu=${nu}`);
    }

    return { cover, legs, waist, loco, gaze, manip };
}