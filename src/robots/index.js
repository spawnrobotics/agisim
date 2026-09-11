import { G1_ROBOT } from './g1.js';
import { MICRODUCK_ROBOT } from './microduck.js';

export { G1_ROBOT } from './g1.js';
export {
    MICRODUCK_ROBOT,
    MICRODUCK_STAND2,
    MICRODUCK_JOINTS,
} from './microduck.js';

export const ROBOTS = {
    g1: G1_ROBOT,
    microduck: MICRODUCK_ROBOT,
    miniduck: MICRODUCK_ROBOT,
    duck: MICRODUCK_ROBOT,
};

export const DEFAULT_ROBOT_ID = 'g1';

export function isDuckRobot(robotOrId) {
    if (!robotOrId) return false;
    if (typeof robotOrId === 'string') {
        const id = robotOrId.trim().toLowerCase();
        return id.includes('duck');
    }
    const id = String(robotOrId.id || robotOrId.name || robotOrId.family || '').toLowerCase();
    return id.includes('duck') || robotOrId.family === 'microduck';
}

export function resolveRobot(raw) {
    const key = String(raw || DEFAULT_ROBOT_ID).trim().toLowerCase();
    return ROBOTS[key] || ROBOTS[DEFAULT_ROBOT_ID];
}

export default ROBOTS;