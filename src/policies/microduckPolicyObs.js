// policies/microduckPolicyObs.js
export const OBS_N = 61;
export const ACT_N = 14;
export const POLICY_HZ = 50;
export const ACTION_SCALE = 1.0;

/** Official STAND2 / HOME_FRAME. Not model.qpos0. */
export const DEFAULT_POSE = new Float32Array([
    0.0,
    -0.0873,
    -0.4579,
    -0.0049,
    0.4530,
    0.3491,
    0.3491,
    0.0,
    0.0,
    0.0,
    0.0873,
    0.4579,
    0.0049,
    -0.4530,
]);

export const EXPECT_JOINTS = [
    'left_hip_yaw',
    'left_hip_roll',
    'left_hip_pitch',
    'left_knee',
    'left_ankle',
    'neck_pitch',
    'head_pitch',
    'head_yaw',
    'head_roll',
    'right_hip_yaw',
    'right_hip_roll',
    'right_hip_pitch',
    'right_knee',
    'right_ankle',
];

/** Official aliases from sensors.xml / infer_policy.py */
export const GYRO_SENSOR_NAMES = Object.freeze([
    'imu_ang_vel',
    'angular-velocity',
]);

/** mjSENS_GYRO in MuJoCo. Never treat sensor 0 (usually framequat "orientation") as gyro. */
export const MJSENS_GYRO = 3;
export const MJSENS_ACCELEROMETER = 1;

export function clip(v, lo, hi) {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return v;
    return Math.max(lo, Math.min(hi, v));
}

export function quatRotateInverse(qw, qx, qy, qz, vx, vy, vz) {
    const tw = -qx * vx - qy * vy - qz * vz;
    const tx = qw * vx + qy * vz - qz * vy;
    const ty = qw * vy + qz * vx - qx * vz;
    const tz = qw * vz + qx * vy - qy * vx;
    return [
        -tw * qx + tx * qw - ty * qz + tz * qy,
        -tw * qy + ty * qw + tx * qz - tz * qx,
        -tw * qz + tz * qw - tx * qy + ty * qx,
    ];
}

function readCString(names, start) {
    if (names == null || start == null || start < 0) return '';
    if (typeof names === 'string') {
        const end = names.indexOf('\0', start);
        return names.slice(start, end < 0 ? undefined : end);
    }
    const bytes = names.subarray ? names : new Uint8Array(names.buffer || names);
    let s = start | 0;
    if (s < 0 || s >= bytes.length) return '';
    let e = s;
    while (e < bytes.length && bytes[e] !== 0) e++;
    return new TextDecoder().decode(bytes.subarray(s, e));
}

function nameFromAdr(model, adrTable, i) {
    try {
        if (adrTable && model.names != null) {
            const start = adrTable[i] ?? adrTable.get?.(i);
            const name = readCString(model.names, start);
            if (name) return name;
        }
    } catch (_) { /* ignore */ }
    return '';
}

export function actuatorName(model, i) {
    const fromTable = nameFromAdr(
        model,
        model.name_actuatoradr || model.actuator_nameadr,
        i
    );
    if (fromTable) return fromTable;
    try {
        const name = String(model.id2name?.(3, i) || model.id2name?.(8, i) || '');
        if (name) return name;
    } catch (_) { /* ignore */ }
    return `act_${i}`;
}

export function sensorName(model, i) {
    const fromTable = nameFromAdr(
        model,
        model.name_sensoradr || model.sensor_nameadr,
        i
    );
    if (fromTable) return fromTable;
    // mjOBJ_SENSOR is 20 in current MuJoCo; 0 and 7 are not sensors.
    for (const obj of [20, 19, 18, 7, 0]) {
        try {
            const name = String(model.id2name?.(obj, i) || '');
            if (name) return name;
        } catch (_) { /* ignore */ }
    }
    return `sensor_${i}`;
}

export function bodyName(model, i) {
    const fromTable = nameFromAdr(
        model,
        model.name_bodyadr || model.body_nameadr,
        i
    );
    if (fromTable) return fromTable;
    try {
        const name = String(model.id2name?.(1, i) || '');
        if (name) return name;
    } catch (_) { /* ignore */ }
    return `body_${i}`;
}

export function listSensorNames(model) {
    const n = model?.nsensor | 0;
    const out = [];
    for (let i = 0; i < n; i++) out.push(sensorName(model, i));
    return out;
}

export function listActuatorNames(model, nAct) {
    const n = nAct != null ? nAct : (model.nu | 0);
    const names = [];
    for (let a = 0; a < n; a++) names.push(actuatorName(model, a));
    return names;
}

function jointNameMatch(got, want) {
    const g = String(got || '').toLowerCase();
    const w = String(want || '').toLowerCase();
    if (!g || !w) return false;
    if (g === w) return true;
    if (g.includes(w)) return true;
    return w.split('_').every((p) => p && g.includes(p));
}

export function jointOrderReport(names) {
    const rows = EXPECT_JOINTS.map((want, i) => {
        const got = names[i];
        return { i, want, got, ok: jointNameMatch(got, want) };
    });
    return {
        ok: rows.every((r) => r.ok),
        mismatches: rows.filter((r) => !r.ok),
        rows,
    };
}

/**
 * Policy slot i → MuJoCo actuator index, even if XML actuator order
 * is not STAND2 / EXPECT_JOINTS order.
 */
export function resolveActuatorMap(model, nAct) {
    const n = Math.min(nAct | 0, model.nu | 0);
    const names = listActuatorNames(model, model.nu | 0);
    const qadr = new Int32Array(n);
    const dadr = new Int32Array(n);
    const actIdx = new Int32Array(n);
    const used = new Set();

    for (let i = 0; i < n; i++) {
        const want = EXPECT_JOINTS[i];
        let found = -1;
        for (let a = 0; a < names.length; a++) {
            if (used.has(a)) continue;
            if (jointNameMatch(names[a], want)) {
                found = a;
                break;
            }
        }
        const a = found >= 0 ? found : i;
        used.add(a);
        actIdx[i] = a;
        const jnt = model.actuator_trnid[a * 2] | 0;
        qadr[i] = model.jnt_qposadr[jnt] | 0;
        dadr[i] = model.jnt_dofadr[jnt] | 0;
    }

    const mappedNames = Array.from(actIdx, (a) => names[a]);
    return {
        qadr,
        dadr,
        actIdx,
        names: mappedNames,
        rawNames: names,
        order: jointOrderReport(mappedNames),
    };
}

/**
 * Address in data.sensordata for a named sensor.
 * Exact name first. Never fall back to sensor 0.
 */
export function findSensorAdr(model, want) {
    const n = model.nsensor | 0;
    const wantLc = String(want || '').toLowerCase();
    if (!wantLc) return -1;

    for (let i = 0; i < n; i++) {
        const name = sensorName(model, i);
        if (name === want || name.toLowerCase() === wantLc) {
            return model.sensor_adr[i] | 0;
        }
    }
    return -1;
}

export function sensorType(model, i) {
    return model.sensor_type ? (model.sensor_type[i] | 0) : -1;
}

export function findGyroAdr(model, want = 'imu_ang_vel') {
    const names = [want, ...GYRO_SENSOR_NAMES];
    const seen = new Set();
    for (const name of names) {
        const key = String(name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const adr = findSensorAdr(model, name);
        if (adr >= 0) return adr;
    }

    const n = model.nsensor | 0;
    for (let i = 0; i < n; i++) {
        if (sensorType(model, i) === MJSENS_GYRO) {
            return model.sensor_adr[i] | 0;
        }
    }
    return -1;
}

export function findBody(model, want) {
    const nbody = model.nbody | 0;
    const wantLc = String(want || '').toLowerCase();
    for (let b = 0; b < nbody; b++) {
        const name = bodyName(model, b);
        if (name === want || name.toLowerCase() === wantLc) return b;
    }
    return 1;
}

export function projGFromQuat(qw, qx, qy, qz) {
    return quatRotateInverse(
        Number.isFinite(qw) ? qw : 1,
        qx || 0,
        qy || 0,
        qz || 0,
        0,
        0,
        -1
    );
}

export function projGFromQpos(data) {
    const q = data.qpos;
    return projGFromQuat(
        Number.isFinite(q[3]) ? q[3] : 1,
        q[4] || 0,
        q[5] || 0,
        q[6] || 0
    );
}

export function projGFromXquat(data, torso) {
    if (!data?.xquat || torso == null || torso < 0) return projGFromQpos(data);
    const o = torso * 4;
    return projGFromQuat(
        data.xquat[o],
        data.xquat[o + 1],
        data.xquat[o + 2],
        data.xquat[o + 3]
    );
}

/**
 * Body-frame gyro. Official plant: data.sensordata[imu_ang_vel].
 * Fallback rotates world cvel[0:3] into trunk_base via xmat — never raw cvel.
 */
export function readGyro(model, data, gyroAdr, torso) {
    if (gyroAdr >= 0 && data.sensordata) {
        return [
            data.sensordata[gyroAdr] || 0,
            data.sensordata[gyroAdr + 1] || 0,
            data.sensordata[gyroAdr + 2] || 0,
        ];
    }

    const b = torso | 0;
    const wx = data.cvel[b * 6] || 0;
    const wy = data.cvel[b * 6 + 1] || 0;
    const wz = data.cvel[b * 6 + 2] || 0;
    const m = data.xmat;
    if (!m) return [wx, wy, wz];
    const o = b * 9;
    return [
        m[o] * wx + m[o + 3] * wy + m[o + 6] * wz,
        m[o + 1] * wx + m[o + 4] * wy + m[o + 7] * wz,
        m[o + 2] * wx + m[o + 5] * wy + m[o + 8] * wz,
    ];
}

export function packPolicyObs({
    obs,
    data,
    nAct,
    qadr,
    dadr,
    defaultPose,
    lastAction,
    gyro,
    g,
    skill,
    cmd,
}) {
    let k = 0;
    obs[k++] = gyro[0];
    obs[k++] = gyro[1];
    obs[k++] = gyro[2];
    obs[k++] = g[0];
    obs[k++] = g[1];
    obs[k++] = g[2];
    for (let i = 0; i < nAct; i++) obs[k++] = (data.qpos[qadr[i]] || 0) - defaultPose[i];
    for (let i = 0; i < nAct; i++) obs[k++] = data.qvel[dadr[i]] || 0;
    for (let i = 0; i < nAct; i++) obs[k++] = lastAction[i];
    obs[k++] = cmd.vel[0];
    obs[k++] = cmd.vel[1];
    obs[k++] = cmd.vel[2];
    for (let i = 0; i < 4; i++) obs[k++] = cmd.head[i];
    for (let i = 0; i < 6; i++) obs[k++] = cmd.body[i];
    return obs;
}

export function gravityFlags(gQ, gX, z) {
    const gNorm = Math.hypot(gQ[0], gQ[1], gQ[2]);
    const xNorm = Math.hypot(gX[0], gX[1], gX[2]);
    const dot = gQ[0] * gX[0] + gQ[1] * gX[1] + gQ[2] * gX[2];
    const flags = [];
    if (Math.abs(gNorm - 1) > 0.15) flags.push(`|g_qpos|=${gNorm.toFixed(3)}`);
    if (Math.abs(xNorm - 1) > 0.15) flags.push(`|g_xquat|=${xNorm.toFixed(3)}`);
    if (gNorm > 1e-6 && xNorm > 1e-6 && dot / (gNorm * xNorm) < 0.85) {
        flags.push('qpos-g vs xquat-g diverge — use xquat[trunk_base]');
    }
    if (z < 0.08 && gQ[2] < -0.7) flags.push('g says upright but z is floor');
    if (z > 0.10 && gQ[2] > -0.3) flags.push('z up but gz not ~-1 (sign/frame?)');
    return { gNorm, xNorm, dot, flags };
}

export function logPolicyContract({
    model,
    data,
    nAct,
    torso,
    torsoBodyName,
    gyroAdr,
    gyroSensorName,
    walk,
    obs,
    defaultPose,
    names,
    actIdx,
}) {
    const actNames = names || listActuatorNames(model, nAct);
    const order = jointOrderReport(actNames);
    const sensors = listSensorNames(model);
    const gQ = projGFromQpos(data);
    const gX = projGFromXquat(data, torso);
    const { flags } = gravityFlags(gQ, gX, Number(data.qpos[2]) || 0);
    if (gyroAdr < 0) flags.push('gyroAdr=-1 using body-frame cvel fallback');
    if (gyroSensorName && !sensors.some((s) => s.toLowerCase() === String(gyroSensorName).toLowerCase())) {
        flags.push(`missing sensor ${gyroSensorName}`);
    }

    console.log('[microduckPolicy] contract', {
        obsN: OBS_N,
        packed: obs.length,
        actN: nAct,
        sessionIn: walk?.inputNames,
        sessionOut: walk?.outputNames,
        torso,
        torsoBodyName,
        gyroAdr,
        gyroSensorName,
        sensors,
        names: actNames,
        actIdx: actIdx ? Array.from(actIdx) : null,
        expect: EXPECT_JOINTS,
        jointOrderOk: order.ok,
        jointOrderSuspect: order.ok ? false : order.mismatches,
        home: Array.from(defaultPose),
        qposFree: [
            data.qpos[0], data.qpos[1], data.qpos[2],
            data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6],
        ],
        xquatTorso: data.xquat
            ? [
                data.xquat[torso * 4],
                data.xquat[torso * 4 + 1],
                data.xquat[torso * 4 + 2],
                data.xquat[torso * 4 + 3],
            ]
            : null,
        g_qpos: gQ.map((x) => +x.toFixed(3)),
        g_xquat: gX.map((x) => +x.toFixed(3)),
        flags: flags.length ? flags : 'ok',
    });
    return { names: actNames, order, sensors };
}

export function logObsTick({
    skill,
    overrideSkill,
    session,
    obs,
    data,
    torso,
    lastAction,
    cmd,
    ticks,
    gyroAdr,
}) {
    const gQ = [obs[3], obs[4], obs[5]];
    const gX = projGFromXquat(data, torso);
    const z = Number(data.qpos[2]) || 0;
    const { gNorm, flags } = gravityFlags(gQ, gX, z);
    if (obs.length !== OBS_N) flags.push(`obsLen ${obs.length}!=${OBS_N}`);
    const gyro = [obs[0], obs[1], obs[2]];
    if (gyroAdr != null && gyroAdr < 0) flags.push('gyroAdr=-1');
    if (Math.abs(gyro[0]) > 0.5 && Math.abs(gyro[1]) < 0.05 && Math.abs(gyro[2]) < 0.05 && z > 0.1) {
        flags.push('gyro looks like quat w — wrong sensor');
    }

    console.log('[microduckPolicy] obs', {
        ticks,
        skill,
        overrideSkill,
        session: session?.inputNames?.[0],
        z: +z.toFixed(4),
        uprightLive: +(-gX[2]).toFixed(3),
        onFloor: z < 0.07 || -gX[2] < 0.45,
        gyro: gyro.map((x) => +x.toFixed(3)),
        g_obs: gQ.map((x) => +x.toFixed(3)),
        g_xquat: gX.map((x) => +x.toFixed(3)),
        '|g|': +gNorm.toFixed(3),
        gz_expect_stand: -1,
        cmd: cmd.vel.slice(),
        qRelMax: Math.max(...Array.from(obs.subarray(6, 20), Math.abs)),
        dqMax: Math.max(...Array.from(obs.subarray(20, 34), Math.abs)),
        actMax: Math.max(...Array.from(lastAction, Math.abs)),
        ctrl2: data.ctrl[2],
        flags: flags.length ? flags : 'ok',
    });
}