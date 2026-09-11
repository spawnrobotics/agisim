// robotSwitch.js
import CONFIG, {
    DEFAULT_ROBOT_ID,
    resolveRobot,
} from './config.js';

export const ROBOT_STORAGE_KEY = 'agiSimRobot';
export const ROBOT_PENDING_KEY = 'agiSimRobotPending';
export const ROBOT_PREV_KEY = 'agiSimRobotPrev';
export const ROBOT_REVERT_FLAG = 'agiSimRobotReverting';

export function readLocal(key) {
    try {
        const v = localStorage.getItem(key);
        return v ? String(v).toLowerCase() : null;
    } catch (_) {
        return null;
    }
}

export function writeLocal(key, value) {
    try {
        if (value == null || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
    } catch (_) { }
}

export function persistRobotId(id) {
    if (!id) return;
    writeLocal(ROBOT_STORAGE_KEY, id);
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('robot', id);
        window.history.replaceState({}, '', url);
    } catch (_) { }
}

export function readStoredRobotId() {
    try {
        const q = new URLSearchParams(window.location.search).get('robot');
        if (q) return String(q).toLowerCase();
        const stored = localStorage.getItem(ROBOT_STORAGE_KEY);
        if (stored) return String(stored).toLowerCase();
    } catch (_) { }
    return String(CONFIG.robot?.id || DEFAULT_ROBOT_ID || 'g1').toLowerCase();
}

export function resolveBootRobotId() {
    return readLocal(ROBOT_PENDING_KEY) || readStoredRobotId();
}

export function setActiveRobot(id, { persist = true } = {}) {
    const robot = resolveRobot(id || readStoredRobotId()) || CONFIG.robot;
    if (!robot?.id) throw new Error(`[main] unknown robot: ${id}`);
    CONFIG.robot = robot;
    if (persist) persistRobotId(robot.id);
    return robot;
}

export function markSwitchPending(nextId, prevId) {
    writeLocal(ROBOT_PREV_KEY, prevId);
    writeLocal(ROBOT_PENDING_KEY, nextId);
    writeLocal(ROBOT_REVERT_FLAG, null);
}

export function markLoadSuccess(id) {
    persistRobotId(id);
    writeLocal(ROBOT_PENDING_KEY, null);
    writeLocal(ROBOT_REVERT_FLAG, null);
    writeLocal(ROBOT_PREV_KEY, id);
}

/**
 * On failed load: restore last good robot and reload once.
 * Returns true if a revert reload was started.
 */
export async function revertRobotLoad(failedId, err, { setBoot } = {}) {
    const prev = readLocal(ROBOT_PREV_KEY) || DEFAULT_ROBOT_ID || 'g1';
    const alreadyReverting = readLocal(ROBOT_REVERT_FLAG) === '1';
    writeLocal(ROBOT_PENDING_KEY, null);

    console.error('[main] robot load failed', { failedId, prev, err });

    const failed = String(failedId || '').toLowerCase();
    if (!alreadyReverting && prev && prev !== failed) {
        writeLocal(ROBOT_REVERT_FLAG, '1');
        persistRobotId(prev);
        setBoot?.(`Failed to load ${failedId}. Reverting to ${prev}…`, 8);
        window.location.reload();
        return true;
    }

    writeLocal(ROBOT_REVERT_FLAG, null);
    return false;
}

export async function switchRobot(id, ctx = {}) {
    const {
        session,
        switching,
        setSwitching,
        setSession,
        setBoot,
        disposeSession,
        clearStoredBrainId,
    } = ctx;

    const next = resolveRobot(id);
    if (!next?.id) {
        console.warn('[main] unknown robot', id);
        return false;
    }
    if (session?.robot?.id === next.id || switching) return false;

    setSwitching?.(true);
    const prevId = session?.robot?.id || readStoredRobotId();
    setBoot?.(`Switching to ${next.name || next.id}…`, 8);

    markSwitchPending(next.id, prevId);
    setActiveRobot(next.id, { persist: false });

    const prev = session;
    setSession?.(null);
    await disposeSession?.(prev);

    clearStoredBrainId?.();
    window.location.reload();
    return true;
}