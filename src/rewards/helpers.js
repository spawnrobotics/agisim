// rewards/helpers.js
export function quatUpDot(qw, qx, qy, qz) {
    const z = 1 - 2 * (qx * qx + qy * qy);
    return Math.max(-1, Math.min(1, z));
}

export function rmsArray(arr, n) {
    let s = 0;
    const m = Math.max(1, n | 0);
    for (let i = 0; i < m; i++) {
        const v = Number(arr[i]) || 0;
        s += v * v;
    }
    return Math.sqrt(s / m);
}

export function clamp11(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
}

export function clamp01(x) {
    return Math.max(0, Math.min(1, Number(x) || 0));
}

export function mjObjType(mujoco, key) {
    const e = mujoco?.mjtObj?.[key];
    if (e == null) return null;
    if (typeof e === 'number' && Number.isFinite(e)) return e;
    if (typeof e.value === 'number' && Number.isFinite(e.value)) return e.value;
    return null;
}

export function mjId2Name(mujoco, model, typeKey, id) {
    const typ = mjObjType(mujoco, typeKey);
    if (typ == null || !mujoco?.mj_id2name || id == null || id < 0) return null;
    try {
        return mujoco.mj_id2name(model, typ, id) || null;
    } catch (_) {
        return null;
    }
}

export function resolveNamedId(mujoco, model, typeKey, name) {
    if (!model || !name) return -1;
    const typ = mjObjType(mujoco, typeKey);
    if (typ != null && mujoco?.mj_name2id) {
        try {
            const id = mujoco.mj_name2id(model, typ, name);
            if (id >= 0) return id;
        } catch (_) { /* */ }
    }
    return -1;
}

export function resolveBodyId(mujoco, model, name) {
    const id = resolveNamedId(mujoco, model, 'mjOBJ_BODY', name);
    if (id >= 0) return id;
    try {
        if (typeof model.body === 'function') {
            const bid = model.body(name)?.id;
            if (bid >= 0) return bid;
        }
    } catch (_) { /* */ }
    return -1;
}

export function resolveSiteId(mujoco, model, name) {
    const id = resolveNamedId(mujoco, model, 'mjOBJ_SITE', name);
    if (id >= 0) return id;
    try {
        if (typeof model.site === 'function') {
            const sid = model.site(name)?.id;
            if (sid >= 0) return sid;
        }
    } catch (_) { /* */ }
    return -1;
}

export function listBodyNames(mujoco, model, max = 80) {
    const n = Number(model?.nbody) || 0;
    const out = [];
    for (let i = 0; i < n && out.length < max; i++) {
        let name = mjId2Name(mujoco, model, 'mjOBJ_BODY', i);
        if (!name) {
            try {
                name = typeof model.body === 'function' ? model.body(i)?.name : null;
            } catch (_) {
                name = null;
            }
        }
        out.push({ id: i, name: name || `body_${i}` });
    }
    return out;
}

export function bodyZById(data, id) {
    if (id == null || id < 0 || !data?.xpos) return null;
    const z = Number(data.xpos[id * 3 + 2]);
    return Number.isFinite(z) ? z : null;
}

export function siteZById(data, id) {
    if (id == null || id < 0 || !data?.site_xpos) return null;
    const z = Number(data.site_xpos[id * 3 + 2]);
    return Number.isFinite(z) ? z : null;
}

export function bodyLocalZ(data, bodyId, lx, ly, lz) {
    if (bodyId == null || bodyId < 0 || !data?.xpos || !data?.xmat) return null;
    const i = bodyId * 3;
    const m = bodyId * 9;
    const z =
        data.xpos[i + 2] +
        data.xmat[m + 6] * lx +
        data.xmat[m + 7] * ly +
        data.xmat[m + 8] * lz;
    return Number.isFinite(z) ? z : null;
}

export function blendHeight(pelvis, head, cfg = {}) {
    const wp = cfg.wPelvisH ?? 0.5;
    const wh = cfg.wHeadH ?? 0.5;
    const s = Math.max(1e-6, wp + wh);
    return (wp * pelvis + wh * head) / s;
}

function num3(src, fallback = [0, 0, 0]) {
    if (!Array.isArray(src) || src.length < 3) return fallback.slice();
    return [
        Number(src[0]) || 0,
        Number(src[1]) || 0,
        Number(src[2]) || 0,
    ];
}

export function emptyOutcome() {
    return {
        height: 0,
        pelvisHeight: 0,
        headHeight: 0,
        upright: 0,
        gx: 0,
        gy: 0,
        gz: 0,
        wz: 0,
        fallen: false,
        onFloor: false,
        success: false,
        hold: 0,
        sway: 0,
        holdTicks: 0,
        gene: null,
        source: 'plant',
        ts: 0,
        cmd: [0, 0, 0],
        headCmd: [0, 0, 0, 0],
        vErr: [0, 0, 0],
        vLocal: [0, 0, 0],
        imu: null,
        imuBySlot: null,
    };
}

export function normalizeOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') return emptyOutcome();
    const base = emptyOutcome();
    return {
        ...base,
        ...outcome,
        height: Number(outcome.height) || 0,
        pelvisHeight: Number(outcome.pelvisHeight ?? outcome.pelvis_z) || 0,
        headHeight: Number(outcome.headHeight) || 0,
        upright: Number(outcome.upright) || 0,
        gx: Number(outcome.gx ?? outcome.imu?.gx) || 0,
        gy: Number(outcome.gy ?? outcome.imu?.gy) || 0,
        gz: Number(outcome.gz ?? outcome.imu?.gz) || 0,
        wz: Number(outcome.wz ?? outcome.imu?.wz) || 0,
        fallen: !!outcome.fallen,
        onFloor: !!(outcome.onFloor || outcome.fallen),
        success: false,
        hold: clamp01(outcome.hold),
        sway: clamp01(outcome.sway),
        holdTicks: Math.max(0, Math.floor(Number(outcome.holdTicks) || 0)),
        gene: outcome.gene ?? null,
        source: outcome.source || 'plant',
        ts: outcome.ts || Date.now(),
        cmd: num3(outcome.cmd),
        headCmd: Array.isArray(outcome.headCmd)
            ? [
                Number(outcome.headCmd[0]) || 0,
                Number(outcome.headCmd[1]) || 0,
                Number(outcome.headCmd[2]) || 0,
                Number(outcome.headCmd[3]) || 0,
            ]
            : [0, 0, 0, 0],
        vErr: num3(outcome.vErr),
        vLocal: num3(outcome.vLocal),
        imu: outcome.imu || null,
        imuBySlot: outcome.imuBySlot || null,
        pelvis_z: Number(outcome.pelvis_z ?? outcome.pelvisHeight) || 0,
        head_z: Number(outcome.head_z ?? outcome.headHeight) || 0,
    };
}