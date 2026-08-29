// rewards/curriculum.js
import { extractReward, setLastMotorOutcome } from './rewards.js';
import {
    GENE_ORDER,
    GENE_DEFAULTS,
    nextGene,
    isLastGene,
    geneExpression,
} from './genes.js';
import {
    rewardForGene,
    createLimitsExplorer,
    tickLimitsExplorer,
    readWaistYaw,
} from './geneReward.js';
import { clamp01, clamp11, rmsArray } from './helpers.js';

const DEFAULTS = {
    enabled: true,
    startGene: 'limits',
    autoAdvance: true,
    decayAdvance: true,
    ema: 0.12,
    logEvery: 40,
};

function cfgFor(name, geneOpts) {
    return { ...GENE_DEFAULTS[name], ...(geneOpts?.[name] || {}) };
}

function pct(x) {
    return `${Math.round(clamp01(x) * 100)}%`;
}

/** World-Z of a body-local axis from freejoint quat (wxyz). */
function localAxisWorldZ(qw, qx, qy, qz, axis = 'x') {
    const a = String(axis || 'x').toLowerCase();
    if (a === 'z') return 1 - 2 * (qx * qx + qy * qy);
    if (a === 'y') return 2 * (qy * qz + qw * qx);
    // +X (G1 chest-forward)
    return 2 * (qx * qz - qw * qy);
}

export function createRewardCurriculum(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    let gene = GENE_ORDER.includes(cfg.startGene) ? cfg.startGene : 'limits';
    let prev = null;
    let age = 0;
    let prevAge = 0;
    let steps = 0;
    let prevX = null;
    let prevY = null;
    let lastLogAt = -1;
    let lastLoggedKey = '';
    let limitsExplore = createLimitsExplorer();
    const rollCache = {};

    const stats = {
        steps: 0,
        motionEma: 0,
        ctrlEma: 0,
        rollEma: 0,
        forwardEma: 0,
        rewardEma: 0,
        targetEma: 0,
        repeatEma: 0,
        proneEma: 0,
        chestEma: 0,
        spinEma: 0,
        yawVelEma: 0,
    };

    function resetLimitsExplorer() {
        limitsExplore = createLimitsExplorer();
        stats.targetEma = 0;
        stats.repeatEma = 0;
    }

    function resetRollCache() {
        rollCache.lastChestUp = null;
        rollCache.lastFace = null;
        rollCache.flipCount = 0;
    }

    function advance(reason) {
        if (isLastGene(gene)) return false;
        const from = gene;
        prev = from;
        prevAge = 0;
        gene = nextGene(gene);
        age = 0;
        steps = 0;
        stats.steps = 0;
        lastLogAt = -1;
        lastLoggedKey = '';
        if (from === 'limits' || gene === 'limits') resetLimitsExplorer();
        if (from === 'roll' || gene === 'roll') resetRollCache();
        if (typeof cfg.onAdvance === 'function') {
            cfg.onAdvance(from, gene, reason);
        }
        return true;
    }

    function progressNote(geneName, pose) {
        if (geneName === 'limits') {
            const ex = pose.limitsExplore || {};
            return `tgt=${pct(ex.targetTerm)} appr=${pct(ex.approachTerm)} same=${pct(ex.repeatPen)} motion=${pct(stats.motionEma)}`;
        }
        if (geneName === 'roll') {
            return `yaw=${(pose.waistYaw || 0).toFixed(2)} ẏ=${(pose.waistYawVel || 0).toFixed(2)} chest=${(pose.chestUp ?? 0).toFixed(2)} flips=${pose.flipCount || 0} pelvis=${pose.pelvisHeight.toFixed(2)}`;
        }
        if (geneName === 'quad') {
            return `pelvis=${pose.pelvisHeight.toFixed(2)} head=${pose.headHeight.toFixed(2)} upright=${pose.upright.toFixed(2)}`;
        }
        return `pelvis=${pose.pelvisHeight.toFixed(2)} head=${pose.headHeight.toFixed(2)} upright=${pose.upright.toFixed(2)}`;
    }

    function logStatus({ pose, express, prevExpress, prevAlive }) {
        const every = Math.max(1, Number(cfg.logEvery) || 40);
        const key = `${gene}|${prev || '-'}|${prevAlive ? 1 : 0}`;
        const due = steps - lastLogAt >= every || key !== lastLoggedKey;
        if (!due) return;
        lastLogAt = steps;
        lastLoggedKey = key;

        const parts = [];
        if (prev && prevExpress > 0.01) {
            parts.push(`${prev} ${pct(prevExpress)}${prevAlive ? ' (lead)' : ' (fading)'}`);
        }
        if (express > 0.01) {
            parts.push(`${gene} ${pct(express)}${prevAlive ? ' (waiting)' : ''}`);
        } else if (!prevAlive) {
            parts.push(`${gene} 0% (rising)`);
        } else {
            parts.push(`${gene} 0% (held for ${prev})`);
        }

        const note = progressNote(prevAlive && prev ? prev : gene, pose);
        console.log(
            `[gene] ${parts.join(' + ')} | r=${stats.rewardEma.toFixed(2)} | decay-only | ${note}`
        );
    }

    function tick(model, data, extractOpts = {}) {
        const robot = extractOpts.robot || cfg.robot || null;

        const stand = extractReward(model, data, {
            ...extractOpts,
            ...(robot?.stand || {}),
            robot,
            cache: false,
        });

        const qvelRms = rmsArray(data.qvel, model.nv | 0);
        const ctrlRms = rmsArray(data.ctrl, model.nu | 0);
        const x = Number(data.qpos[0]) || 0;
        const y = Number(data.qpos[1]) || 0;
        const dx = prevX == null ? 0 : x - prevX;
        const dy = prevY == null ? 0 : y - prevY;
        prevX = x;
        prevY = y;

        const qw = Number(data.qpos[3]);
        const qx = Number(data.qpos[4]) || 0;
        const qy = Number(data.qpos[5]) || 0;
        const qz = Number(data.qpos[6]) || 0;
        const qwSafe = Number.isFinite(qw) ? qw : 1;

        const chestAxis = robot?.chestAxis || cfg.chestAxis || 'x';
        const bodyUpZ = localAxisWorldZ(qwSafe, qx, qy, qz, 'z');
        const chestUp = localAxisWorldZ(qwSafe, qx, qy, qz, chestAxis);

        const FLIP_BAND = 0.28;
        const dChest = rollCache.lastChestUp == null
            ? 0
            : chestUp - rollCache.lastChestUp;

        let flipped = 0;
        if (Math.abs(chestUp) >= FLIP_BAND) {
            const faceNow = chestUp >= 0 ? 1 : -1;
            const lastFace = rollCache.lastFace;
            if (lastFace != null && faceNow !== lastFace) {
                flipped = 1;
                rollCache.flipCount = (rollCache.flipCount || 0) + 1;
            }
            rollCache.lastFace = faceNow;
        }
        rollCache.lastChestUp = chestUp;

        const spinRms = Math.sqrt(
            ((Number(data.qvel[3]) || 0) ** 2 +
                (Number(data.qvel[4]) || 0) ** 2 +
                (Number(data.qvel[5]) || 0) ** 2) / 3
        );

        let wy = { yaw: 0, yawVel: 0 };
        try {
            wy = readWaistYaw(model, data, rollCache, extractOpts.mujoco, robot) || wy;
        } catch (_) {
            wy = { yaw: 0, yawVel: 0 };
        }

        const pose = {
            ...stand,
            qvelRms,
            ctrlRms,
            dx,
            dy,
            qw: qwSafe,
            qx,
            qy,
            qz,
            chestUp,
            bodyUpZ,
            dChest,
            flipped,
            flipCount: rollCache.flipCount || 0,
            spinRms,
            waistYaw: wy.yaw,
            waistYawVel: wy.yawVel,
        };

        const curCfg = cfgFor(gene, cfg.geneOpts);
        const pCfg = prev ? cfgFor(prev, cfg.geneOpts) : null;

        if (gene === 'limits' || prev === 'limits') {
            pose.limitsExplore = tickLimitsExplorer(
                limitsExplore,
                model,
                data,
                cfgFor('limits', cfg.geneOpts),
                extractOpts.mujoco
            );
        }

        let prevExpress = 0;
        let prevR = 0;
        if (cfg.enabled && prev && pCfg) {
            prevExpress = geneExpression(prevAge, pCfg);
            prevR = prev === 'stand'
                ? stand.reward
                : rewardForGene(prev, pose, cfg.geneOpts);
            prevAge++;
            if (prevExpress <= 0) prev = null;
        }

        const handoff = Number(pCfg?.handoffFloor ?? curCfg.handoffFloor ?? 0.12);
        const prevAlive = !!(prev && prevExpress > handoff);
        const express = cfg.enabled
            ? (prevAlive ? 0 : geneExpression(age, curCfg))
            : 1;

        const curR = gene === 'stand'
            ? stand.reward
            : rewardForGene(gene, pose, cfg.geneOpts);

        let reward = stand.reward;
        if (cfg.enabled) {
            const wCur = express;
            const wPrev = prevExpress;
            const wSum = wCur + wPrev;
            if (wSum > 1e-6) {
                reward = (wCur * curR + wPrev * prevR) / wSum;
            } else {
                reward = curR;
            }
        }
        reward = clamp11(reward);

        const a = cfg.ema;
        stats.steps = ++steps;
        stats.motionEma = stats.motionEma * (1 - a) + clamp01(qvelRms / 0.35) * a;
        stats.ctrlEma = stats.ctrlEma * (1 - a) + clamp01(ctrlRms) * a;
        stats.rollEma = stats.rollEma * (1 - a) + clamp01((pose.upright + 0.2) / 0.55) * a;
        stats.forwardEma =
            stats.forwardEma * (1 - a) + clamp01(Math.hypot(dx, dy) / 0.04) * a;
        stats.proneEma = stats.proneEma * (1 - a) + clamp01((0.55 - pose.chestUp) / 1.2) * a;
        stats.chestEma = stats.chestEma * (1 - a) + pose.chestUp * a;
        stats.targetEma = pose.limitsExplore?.targetTerm ?? stats.targetEma;
        stats.repeatEma = pose.limitsExplore?.repeatPen ?? stats.repeatEma;
        stats.spinEma = stats.spinEma * (1 - a) + clamp01((pose.spinRms || 0) / 1.1) * a;
        stats.yawVelEma =
            stats.yawVelEma * (1 - a) + clamp01(Math.abs(pose.waistYawVel || 0) / 1.4) * a;

        const limitsOn = !!(pose.limitsExplore && (gene === 'limits' || prev === 'limits'));
        const actuatorRewards = limitsOn ? pose.limitsExplore.actuatorRewards : null;

        let limitsAvg = 0;
        if (actuatorRewards && actuatorRewards.length) {
            let s = 0;
            let n = 0;
            for (let i = 0; i < actuatorRewards.length; i++) {
                const v = Number(actuatorRewards[i]);
                if (!Number.isFinite(v)) continue;
                s += v;
                n++;
            }
            limitsAvg = n ? clamp11(s / n) : 0;
        }

        const uprightGate = clamp01((stand.upright + 0.15) / 1.0);
        const sideGate = stand.fallen || uprightGate < 0.35;

        let shown = reward;
        if (limitsOn && !sideGate) {
            shown = 0.65 * limitsAvg + 0.35 * stand.reward;
        } else if (limitsOn && sideGate) {
            shown = Math.min(stand.reward, limitsAvg * uprightGate - 0.6);
        }
        shown = clamp11(shown);
        stats.rewardEma = stats.rewardEma * (1 - a) + shown * a;

        const outcome = {
            ...stand,
            reward: shown,
            posSum: Math.max(0, shown),
            negSum: Math.max(0, -shown),
            valence: shown,
            gene,
            prevGene: prev,
            expression: express,
            prevExpression: prevExpress,
            geneAge: age,
            geneSteps: steps,
            source: `gene:${gene}`,
            actuatorRewards,
            chestUp: pose.chestUp,
            bodyUpZ: pose.bodyUpZ,
            spinRms: pose.spinRms,
            waistYaw: pose.waistYaw,
            waistYawVel: pose.waistYawVel,
            flipped: pose.flipped,
            flipCount: pose.flipCount,
        };

        if (extractOpts.cache !== false) setLastMotorOutcome(outcome);

        logStatus({ pose, express, prevExpress, prevAlive });

        const rollSeen = (pose.flipCount || 0) >= 1;
        const holdDecay = gene === 'roll' && !prevAlive && !rollSeen;
        const holdAt = Math.max(1, Number(curCfg.fadeInSteps) || 1);

        if (cfg.enabled && cfg.autoAdvance && !isLastGene(gene)) {
            const life = Number(curCfg.lifetimeSteps);
            const expired =
                !holdDecay &&
                cfg.decayAdvance &&
                !prevAlive &&
                Number.isFinite(life) &&
                age >= life;
            const faded =
                !holdDecay &&
                cfg.decayAdvance &&
                !prevAlive &&
                express <= (curCfg.fadeOutFloor ?? 0.08) &&
                age > (curCfg.fadeInSteps || 1);

            if (expired || faded) {
                advance('decay');
            } else if (!prevAlive) {
                if (holdDecay) {
                    age = age >= holdAt ? holdAt : age + 1;
                } else {
                    age++;
                }
            }
        } else if (!prevAlive) {
            if (holdDecay) {
                age = age >= holdAt ? holdAt : age + 1;
            } else {
                age++;
            }
        }

        return outcome;
    }

    return {
        tick,
        getGene: () => gene,
        setGene: (g) => {
            if (!GENE_ORDER.includes(g)) return gene;
            const from = gene;
            prev = gene !== g ? gene : null;
            prevAge = 0;
            gene = g;
            age = 0;
            steps = 0;
            lastLogAt = -1;
            lastLoggedKey = '';
            if (from === 'limits' || gene === 'limits') resetLimitsExplorer();
            if (from === 'roll' || gene === 'roll') resetRollCache();
            return gene;
        },
        getStats: () => ({
            ...stats,
            gene,
            prev,
            age,
            expression: geneExpression(age, cfgFor(gene, cfg.geneOpts)),
            prevExpression: prev
                ? geneExpression(prevAge, cfgFor(prev, cfg.geneOpts))
                : 0,
        }),
        setEnabled: (on) => { cfg.enabled = !!on; },
        isEnabled: () => !!cfg.enabled,
        advance: (reason = 'manual') => advance(reason),
    };
}

export default createRewardCurriculum;