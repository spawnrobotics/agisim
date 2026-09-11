// rewards/curriculum.js

import { extractReward, setLastMotorOutcome } from './rewards.js';
import { clamp01, clamp11, rmsArray } from './helpers.js';
import CONFIG from '../config.js';

const DEFAULTS = {
    enabled: true,
    ema: 0.12,
    logEvery: 400,
    task: null,
};

const ZERO_CMD = [0, 0, 0];

function finite(n, fallback = 0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function finite11(n) {
    return clamp11(finite(n, 0));
}

function finite01(n) {
    return clamp01(finite(n, 0));
}

function readCmd3(src, fallback = ZERO_CMD) {
    const raw = Array.isArray(src) && src.length >= 3 ? src : fallback;
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
    ];
}

function readHeadCmd(src) {
    const raw = Array.isArray(src) ? src : [0, 0, 0, 0];
    return [
        Number(raw[0]) || 0,
        Number(raw[1]) || 0,
        Number(raw[2]) || 0,
        Number(raw[3]) || 0,
    ];
}

export function createRewardCurriculum(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };

    let steps = 0;
    let lastLogAt = -1;
    let prevHeight = null;
    let prevPelvis = null;
    let prevHead = null;
    let prevUpright = null;
    let prevX = null;
    let prevY = null;

    const stats = {
        steps: 0,
        rewardEma: 0,
        uprightEma: 0,
        holdEma: 0,
        swayEma: 0,
        motionEma: 0,
        ctrlEma: 0,
        forwardEma: 0,
        fallenEma: 0,
        floorEma: 0,
        successEma: 0,
        trackLinEma: 0,
        trackAngEma: 0,
        source: null,
        gene: null,
        task: null,
        cmd: ZERO_CMD.slice(),
    };

    function resetMemory() {
        steps = 0;
        lastLogAt = -1;
        prevHeight = prevPelvis = prevHead = prevUpright = null;
        prevX = prevY = null;
        stats.steps = 0;
        stats.rewardEma = 0;
        stats.uprightEma = 0;
        stats.holdEma = 0;
        stats.swayEma = 0;
        stats.motionEma = 0;
        stats.ctrlEma = 0;
        stats.forwardEma = 0;
        stats.fallenEma = 0;
        stats.floorEma = 0;
        stats.successEma = 0;
        stats.trackLinEma = 0;
        stats.trackAngEma = 0;
        stats.source = null;
        stats.gene = null;
        stats.task = cfg.task || null;
        stats.cmd = readCmd3(cfg.cmd);
    }

    function blend(prev, next, a) {
        const p = finite(prev, 0);
        const n = finite(next, p);
        const k = finite(a, 0.12);
        const out = p * (1 - k) + n * k;
        return Number.isFinite(out) ? out : n;
    }

    function logStatus(outcome, reward) {
        const every = Math.max(1, Number(cfg.logEvery) || 40);
        if (steps - lastLogAt < every) return;
        lastLogAt = steps;

        const src = outcome.source || stats.source || 'reward';
        const gene = outcome.gene || stats.gene || 'rise';
        const r = finite(stats.rewardEma, reward);
        const trackLin = finite(outcome.trackLin, stats.trackLinEma);
        const trackAng = finite(outcome.trackAng, stats.trackAngEma);
        console.log(
            `[reward] ${src} ${gene} | r=${r.toFixed(2)} | ` +
            `pelvis=${finite(outcome.pelvisHeight).toFixed(2)} ` +
            `head=${finite(outcome.headHeight).toFixed(2)} ` +
            `up=${finite(outcome.upright).toFixed(2)} ` +
            `hold=${finite(outcome.hold).toFixed(2)} ` +
            `sway=${finite(outcome.sway).toFixed(2)} ` +
            `track=${trackLin.toFixed(2)}/${trackAng.toFixed(2)}` +
            (outcome.onFloor ? ' floor' : '') +
            (outcome.fallen ? ' fallen' : '') +
            (outcome.success ? ' ok' : '')
        );
    }

    function tick(model, data, extractOpts = {}) {
        if (!cfg.enabled) {
            return extractOpts.lastOutcome || null;
        }

        const robot = extractOpts.robot || cfg.robot || CONFIG.robot || null;
        const task = extractOpts.task || cfg.task || robot?.task || undefined;

        // Prefer explicit cmd. Never default to a walk velocity.
        const cmd = readCmd3(
            extractOpts.cmd ?? robot?.cmd ?? cfg.cmd ?? ZERO_CMD,
            ZERO_CMD
        );
        const headCmd = readHeadCmd(extractOpts.headCmd || robot?.headCmd);

        const pose = extractReward(model, data, {
            ...extractOpts,
            robot,
            task,
            cmd,
            headCmd,
            prevHeight,
            prevPelvis,
            prevHead,
            prevUpright,
            cache: false,
        }) || {};

        const height = finite(pose.height, finite(pose.pelvisHeight));
        const pelvis = finite(pose.pelvisHeight);
        const head = finite(pose.headHeight, pelvis);
        const upright = finite(pose.upright);

        prevHeight = height;
        prevPelvis = pelvis;
        prevHead = head;
        prevUpright = upright;

        const qvelRms = finite(pose.qvelRms, rmsArray(data?.qvel, model?.nv | 0));
        const ctrlRms = finite(pose.ctrlRms, rmsArray(data?.ctrl, model?.nu | 0));
        const x = finite(data?.qpos?.[0]);
        const y = finite(data?.qpos?.[1]);
        const dx = prevX == null ? 0 : x - prevX;
        const dy = prevY == null ? 0 : y - prevY;
        prevX = x;
        prevY = y;

        const reward = finite11(pose.reward ?? pose.valence);
        const a = Math.min(1, Math.max(0.001, finite(cfg.ema, 0.12)));
        const onFloor = !!(pose.onFloor || pose.fallen);
        const gene = onFloor
            ? (pose.gene || 'rise')
            : (pose.gene || task || 'rise');
        const terms = pose.terms && typeof pose.terms === 'object' ? pose.terms : {};
        const trackLin = finite01(pose.trackLin ?? terms.trackLin);
        const trackAng = finite01(pose.trackAng ?? terms.trackAng);
        const hold = finite01(pose.hold);
        const sway = finite01(pose.sway);

        stats.steps = ++steps;
        stats.rewardEma = blend(stats.rewardEma, reward, a);
        stats.uprightEma = blend(stats.uprightEma, finite01(upright), a);
        stats.holdEma = blend(stats.holdEma, hold, a);
        stats.swayEma = blend(stats.swayEma, sway, a);
        stats.motionEma = blend(stats.motionEma, finite01(qvelRms / 0.35), a);
        stats.ctrlEma = blend(stats.ctrlEma, finite01(ctrlRms), a);
        stats.forwardEma = blend(stats.forwardEma, finite01(Math.hypot(dx, dy) / 0.04), a);
        stats.fallenEma = blend(stats.fallenEma, pose.fallen ? 1 : 0, a);
        stats.floorEma = blend(stats.floorEma, onFloor ? 1 : 0, a);
        stats.successEma = blend(stats.successEma, pose.success && !onFloor ? 1 : 0, a);
        stats.trackLinEma = blend(stats.trackLinEma, trackLin, a);
        stats.trackAngEma = blend(stats.trackAngEma, trackAng, a);
        stats.source = pose.source || null;
        stats.gene = gene;
        stats.task = task || null;
        stats.cmd = cmd;

        const outcome = {
            ...pose,
            reward,
            height,
            pelvisHeight: pelvis,
            pelvis_z: pelvis,
            headHeight: head,
            upright,
            hold,
            sway,
            holdTicks: Math.max(0, Math.floor(Number(pose.holdTicks) || 0)),
            posSum: Math.max(0, reward),
            negSum: Math.max(0, -reward),
            valence: reward,
            fallen: !!pose.fallen,
            onFloor,
            success: !!pose.success && !onFloor,
            gene,
            expression: 1,
            geneAge: steps,
            geneSteps: steps,
            qvelRms,
            ctrlRms,
            dx,
            dy,
            terms,
            trackLin,
            trackAng,
            cmd,
            headCmd,
        };

        setLastMotorOutcome(outcome);
        //logStatus(outcome, reward);
        return outcome;
    }

    return {
        tick,
        reset: resetMemory,
        getGene: () => stats.gene || 'rise',
        setGene: (name) => {
            cfg.task = name ? String(name) : null;
            resetMemory();
            return cfg.task || 'stand';
        },
        setTask: (name) => {
            cfg.task = name ? String(name) : null;
            return cfg.task;
        },
        getTask: () => cfg.task,
        getCmd: () => stats.cmd.slice(),
        setCmd: (next) => {
            cfg.cmd = readCmd3(next, ZERO_CMD);
            stats.cmd = cfg.cmd.slice();
            return stats.cmd.slice();
        },
        getStats: () => ({ ...stats, cmd: stats.cmd.slice(), expression: 1 }),
        setEnabled: (on) => {
            cfg.enabled = !!on;
        },
        isEnabled: () => !!cfg.enabled,
        advance: () => false,
    };
}

export default createRewardCurriculum;