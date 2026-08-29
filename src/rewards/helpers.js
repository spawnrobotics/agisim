// rewards/helpers.js
export function quatUpDot(qw, qx, qy, qz) {
    const z = 1 - 2 * (qx * qx + qy * qy);
    return Math.max(-1, Math.min(1, z));
}

export function heightTermFromZ(z, z0, z1, z2) {
    const zz = Number(z) || 0;
    if (zz <= z0) return 0;
    if (zz < z1) return 0.25 * (zz - z0) / Math.max(1e-3, z1 - z0);
    if (zz < z2) return 0.25 + 0.75 * (zz - z1) / Math.max(1e-3, z2 - z1);
    return 1;
}

export function uprightTermFromDot(upright, cfg) {
    const u01 = Math.max(0, Math.min(1, Number(upright) || 0));
    const p = Math.max(0.5, Number(cfg.uprightPower) || 1);
    return Math.pow(u01, p);
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
        const name = mujoco.mj_id2name(model, typ, id);
        return name || null;
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
            const b = model.body(name);
            const bid = b && b.id != null ? b.id : -1;
            if (bid >= 0) return bid;
        }
    } catch (_) { /* */ }
    try {
        if (typeof model.name2id === 'function') {
            const bid = model.name2id('body', name);
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
            const s = model.site(name);
            const sid = s && s.id != null ? s.id : -1;
            if (sid >= 0) return sid;
        }
    } catch (_) { /* */ }
    return -1;
}

export function listBodyNames(mujoco, model, max = 80) {
    const n = Number(model?.nbody) || 0;
    const out = [];
    for (let i = 0; i < n && out.length < max; i++) {
        const name =
            mjId2Name(mujoco, model, 'mjOBJ_BODY', i) ||
            (() => {
                try {
                    return typeof model.body === 'function' ? model.body(i)?.name : null;
                } catch (_) {
                    return null;
                }
            })();
        out.push({ id: i, name: name || `body_${i}` });
    }
    return out;
}

export function bodyZ(model, data, name) {
    try {
        const b = typeof model.body === 'function' ? model.body(name) : null;
        const id = b && b.id != null ? b.id : -1;
        if (id >= 0) {
            const z = Number(data.xpos[id * 3 + 2]);
            if (Number.isFinite(z)) return z;
        }
    } catch (_) { /* */ }
    return null;
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

export function blendHeight(pelvis, head, cfg) {
    const wp = cfg.wPelvisH ?? 0.5;
    const wh = cfg.wHeadH ?? 0.5;
    const s = Math.max(1e-6, wp + wh);
    return (wp * pelvis + wh * head) / s;
}

export function emptyOutcome() {
    return {
        reward: 0,
        height: 0,
        pelvisHeight: 0,
        headHeight: 0,
        upright: 0,
        heightTerm: 0,
        uprightTerm: 0,
        progressTerm: 0,
        success: false,
        fallen: false,
        posSum: 0,
        negSum: 0,
        valence: 0,
        gene: null,
        expression: 1,
        source: 'reward',
        ts: 0,
        actuatorRewards: null,
        groupRewards: null,
    };
}

export function normalizeOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') return emptyOutcome();

    const reward = clamp11(outcome.reward);
    const valence = clamp11(outcome.valence ?? reward);
    const posSum = Math.max(0, Number(outcome.posSum) || Math.max(0, reward));
    const negSum = Math.max(0, Number(outcome.negSum) || Math.max(0, -reward));

    const out = {
        reward,
        height: Number(outcome.height) || 0,
        pelvisHeight: Number(outcome.pelvisHeight) || 0,
        headHeight: Number(outcome.headHeight) || 0,
        upright: Number(outcome.upright) || 0,
        heightTerm: clamp01(outcome.heightTerm),
        uprightTerm: clamp01(outcome.uprightTerm),
        progressTerm: clamp01(outcome.progressTerm),
        success: !!outcome.success,
        fallen: !!outcome.fallen,
        posSum,
        negSum,
        valence,
        gene: outcome.gene ?? null,
        expression: clamp01(outcome.expression ?? 1),
        source: outcome.source || 'reward',
        ts: outcome.ts || Date.now(),
    };

    if (outcome.actuatorRewards) out.actuatorRewards = outcome.actuatorRewards;
    if (outcome.groupRewards) out.groupRewards = outcome.groupRewards;
    return out;
}