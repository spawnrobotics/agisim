// rewards/geneReward.js
import { GENE_DEFAULTS } from './genes.js';
import { clamp01, clamp11, resolveNamedId, mjId2Name } from './helpers.js';
import CONFIG from '../config.js';

const JNT_FREE = 0;
const JNT_SLIDE = 2;
const JNT_HINGE = 3;

const WAIST_YAW_NAMES = [
    'waist_yaw_joint',
    'waist_yaw',
    'head_yaw',
    'neck_yaw',
];

function yawNamesFromRobot(robot) {
    const extra = [];
    if (robot?.waistYawJoint) extra.push(robot.waistYawJoint);
    if (Array.isArray(robot?.yawJoints)) extra.push(...robot.yawJoints);
    return extra.map((s) => String(s || '').trim()).filter(Boolean);
}

export function resolveWaistYaw(mujoco, model, robot = CONFIG.robot) {
    const names = [...yawNamesFromRobot(robot), ...WAIST_YAW_NAMES];
    for (const name of names) {
        const id = resolveNamedId(mujoco, model, 'mjOBJ_JOINT', name);
        if (id >= 0) {
            return {
                j: id,
                qadr: model.jnt_qposadr[id] | 0,
                vadr: model.jnt_dofadr[id] | 0,
                name,
                source: 'joint',
            };
        }
    }

    const nj = model?.njnt | 0;
    for (let j = 0; j < nj; j++) {
        const n = String(mjId2Name(mujoco, model, 'mjOBJ_JOINT', j) || '').toLowerCase();
        if (!n || n.startsWith('passive_') || n.includes('backlash')) continue;
        if (n.includes('waist') && n.includes('yaw') && !n.includes('hip')) {
            return {
                j,
                qadr: model.jnt_qposadr[j] | 0,
                vadr: model.jnt_dofadr[j] | 0,
                name: n,
                source: 'joint',
            };
        }
        if (n === 'head_yaw' || n.endsWith('_head_yaw') || n === 'neck_yaw') {
            return {
                j,
                qadr: model.jnt_qposadr[j] | 0,
                vadr: model.jnt_dofadr[j] | 0,
                name: n,
                source: 'joint',
            };
        }
    }

    for (let j = 0; j < nj; j++) {
        if ((model.jnt_type?.[j] | 0) !== JNT_FREE) continue;
        const qadr = model.jnt_qposadr[j] | 0;
        const vadr = model.jnt_dofadr[j] | 0;
        return {
            j,
            qadr: qadr + 6,
            vadr: vadr + 5,
            name: 'freejoint_yaw',
            source: 'freejoint',
        };
    }

    return null;
}

export function readWaistYaw(model, data, cache, mujoco = null, robot = null) {
    if (cache.waist === undefined) {
        cache.waist = resolveWaistYaw(mujoco, model, robot || CONFIG.robot);
        if (!cache.waist) {
            console.warn('[roll] no yaw joint — yaw reward will stay 0');
        } else {
            console.log('[roll] tracking', cache.waist.name, {
                qadr: cache.waist.qadr,
                vadr: cache.waist.vadr,
                source: cache.waist.source,
            });
        }
    }
    const w = cache.waist;
    if (!w) return { yaw: 0, yawVel: 0, ok: false };
    return {
        yaw: Number(data.qpos[w.qadr]) || 0,
        yawVel: w.vadr >= 0 ? (Number(data.qvel[w.vadr]) || 0) : 0,
        ok: true,
    };
}

function bandReward(x, lo, hi) {
    const v = Number(x) || 0;
    if (v < lo) return clamp01(v / Math.max(1e-3, lo)) * 0.35;
    if (v > hi) {
        const over = (v - hi) / Math.max(1e-3, hi);
        return clamp01(1 - over);
    }
    return 1;
}

function readNum(arr, i) {
    if (!arr) return null;
    const v = Number(arr[i]);
    return Number.isFinite(v) ? v : null;
}

function jointRange(model, j, fallback) {
    const lo = readNum(model.jnt_range, j * 2);
    const hi = readNum(model.jnt_range, j * 2 + 1);
    if (lo == null || hi == null || hi - lo < 1e-4) {
        return { lo: -fallback, hi: fallback };
    }
    return { lo, hi };
}

function extremeTarget(lo, hi, extreme) {
    const e = Math.max(0.5, Math.min(0.99, Number(extreme) || 0.88));
    const span = hi - lo;
    const useHi = Math.random() < 0.5;
    return useHi ? hi - (1 - e) * span : lo + (1 - e) * span;
}

function jointName(mujoco, model, j) {
    try {
        return String(mjId2Name(mujoco, model, 'mjOBJ_JOINT', j) || '');
    } catch (_) {
        return '';
    }
}

function actuatorForJoint(model, jntId) {
    const nu = model?.nu | 0;
    const trn = model.actuator_trnid;
    if (!trn || jntId < 0) return -1;
    for (let a = 0; a < nu; a++) {
        const tgt = trn[a * 2] ?? trn.get?.(a * 2);
        if ((tgt | 0) === (jntId | 0)) return a;
    }
    return -1;
}

function listScalarJoints(model, mujoco = null) {
    const nj = model?.njnt | 0;
    const out = [];
    for (let j = 0; j < nj; j++) {
        const typ = model.jnt_type?.[j] | 0;
        if (typ !== JNT_HINGE && typ !== JNT_SLIDE) continue;
        const name = jointName(mujoco, model, j).toLowerCase();
        if (name.startsWith('passive_') || name.includes('backlash')) continue;
        const adr = model.jnt_qposadr?.[j];
        const qadr = adr == null ? -1 : adr | 0;
        if (qadr < 0) continue;
        const act = actuatorForJoint(model, j);
        out.push({ j, qadr, act, typ, name });
    }
    return out;
}

function pickActive(n, k) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = idx[i];
        idx[i] = idx[j];
        idx[j] = tmp;
    }
    return idx.slice(0, Math.min(k, n));
}

export function createLimitsExplorer() {
    return {
        inited: false,
        joints: [],
        targets: [],
        cur: [],
        lastQ: [],
        lastErr: [],
        hold: [],
        active: [],
        activeAge: 0,
        hitEma: 0,
        errEma: 1,
        moveEma: 0,
        actuatorRewards: null,
    };
}

export function tickLimitsExplorer(state, model, data, cfg = {}, mujoco = null) {
    const nTargets = Math.max(2, Math.min(8, cfg.nTargets | 0 || 4));
    const extreme = cfg.extreme ?? 0.88;
    const arrive = Math.max(0.04, cfg.arrive ?? 0.16);
    const retargetHold = Math.max(1, cfg.retargetHold | 0 || 6);
    const fallback = cfg.fallbackRange ?? 1.6;
    const repeatEps = Math.max(1e-4, cfg.repeatEps ?? 0.03);
    const errScale = Math.max(0.2, cfg.errScale ?? 0.85);
    const activeN = Math.max(1, cfg.activeJoints | 0 || 6);
    const nu = model?.nu | 0;

    if (!state.inited) {
        state.joints = listScalarJoints(model, mujoco);
        state.targets = state.joints.map(({ j }) => {
            const { lo, hi } = jointRange(model, j, fallback);
            const ts = [];
            for (let k = 0; k < nTargets; k++) ts.push(extremeTarget(lo, hi, extreme));
            return ts;
        });
        state.cur = state.joints.map(() => (Math.random() * nTargets) | 0);
        state.lastQ = state.joints.map(({ qadr }) => Number(data.qpos[qadr]) || 0);
        state.lastErr = state.joints.map(() => 1);
        state.hold = state.joints.map(() => 0);
        state.active = pickActive(state.joints.length, activeN);
        state.activeAge = 0;
        state.actuatorRewards = new Float32Array(Math.max(1, nu));
        state.inited = true;
    }

    if (!state.actuatorRewards || state.actuatorRewards.length !== Math.max(1, nu)) {
        state.actuatorRewards = new Float32Array(Math.max(1, nu));
    } else {
        state.actuatorRewards.fill(0);
    }

    state.activeAge++;
    if (state.activeAge > 80 || !state.active?.length) {
        state.active = pickActive(state.joints.length, activeN);
        state.activeAge = 0;
    }

    const activeSet = new Set(state.active);
    let errSum = 0;
    let approachSum = 0;
    let hitN = 0;
    let moveSum = 0;
    let nAct = 0;

    for (let i = 0; i < state.joints.length; i++) {
        const { j, qadr, act } = state.joints[i];
        const { lo, hi } = jointRange(model, j, fallback);
        const span = Math.max(1e-3, hi - lo);
        const q = Number(data.qpos[qadr]) || 0;
        const dq = Math.abs(q - state.lastQ[i]);
        const move = dq / span;

        moveSum += move;

        const isActive = activeSet.has(i);
        let t = state.targets[i][state.cur[i]];
        let err = Math.abs(q - t) / span;
        const dErr = (state.lastErr[i] ?? err) - err;
        const targetTerm = clamp01(1 - err / errScale);
        const approachTerm = clamp01(0.5 + 0.5 * clamp11(dErr / 0.08));
        const repeatPen = clamp01(1 - move / repeatEps);

        let r = 0;
        if (isActive) {
            nAct++;
            errSum += err;
            approachSum += clamp11(dErr / 0.08);
            r =
                0.55 * targetTerm +
                0.40 * approachTerm -
                0.50 * repeatPen;
            if (err <= arrive) {
                state.hold[i] += 1;
                hitN += 1;
                if (state.hold[i] >= retargetHold) {
                    let next = state.cur[i];
                    if (nTargets > 1) {
                        while (next === state.cur[i]) next = (Math.random() * nTargets) | 0;
                    }
                    state.targets[i][next] = extremeTarget(lo, hi, extreme);
                    state.cur[i] = next;
                    state.hold[i] = 0;
                    t = state.targets[i][next];
                    err = Math.abs(q - t) / span;
                }
            } else {
                state.hold[i] = 0;
            }
        } else {
            r = -0.35 * repeatPen;
        }

        r = clamp11(r);
        if (act >= 0 && act < state.actuatorRewards.length) {
            state.actuatorRewards[act] = r;
        }

        state.lastErr[i] = err;
        state.lastQ[i] = q;
    }

    const n = Math.max(1, nAct);
    const errMean = errSum / n;
    const moveMean = moveSum / Math.max(1, state.joints.length);
    const targetTerm = clamp01(1 - errMean / errScale);
    const approachTerm = clamp01(0.5 + 0.5 * (approachSum / n));
    const repeatPen = clamp01(1 - moveMean / repeatEps);

    const a = 0.12;
    state.hitEma = state.hitEma * (1 - a) + (hitN / n) * a;
    state.errEma = state.errEma * (1 - a) + errMean * a;
    state.moveEma = state.moveEma * (1 - a) + clamp01(moveMean / 0.08) * a;

    return {
        targetTerm,
        approachTerm,
        repeatPen,
        hitFrac: hitN / n,
        errMean,
        moveMean,
        hitEma: state.hitEma,
        errEma: state.errEma,
        moveEma: state.moveEma,
        nJoints: state.joints.length,
        nActive: nAct,
        actuatorRewards: state.actuatorRewards,
    };
}

/** Mean of per-actuator scores over any index list (arm, leg, waist, …). */
export function meanActuatorReward(actuatorRewards, indices) {
    if (!actuatorRewards || !indices?.length) return 0;
    let s = 0;
    let n = 0;
    for (let i = 0; i < indices.length; i++) {
        const k = indices[i] | 0;
        if (k < 0 || k >= actuatorRewards.length) continue;
        const v = Number(actuatorRewards[k]);
        if (!Number.isFinite(v)) continue;
        s += v;
        n++;
    }
    return n ? clamp11(s / n) : 0;
}

export function rewardForGene(gene, pose, geneOpts = {}) {
    const name = String(gene || 'stand');
    if (name !== 'stand') {
        return clamp11(Number(pose.reward) || 0);
    }

    const cfg = { ...GENE_DEFAULTS.stand, ...(geneOpts.stand || geneOpts) };
    void cfg;
    void bandReward;
    void pose.pelvisHeight;
    void pose.headHeight;
    void pose.upright;
    void pose.qvelRms;
    void pose.ctrlRms;
    void pose.dx;
    void pose.dy;

    return clamp11(Number(pose.reward) || 0);
}