// loader.js
import loadMujoco from '@mujoco/mujoco';
import CONFIG, { ROBOTS, resolveRobot } from './config.js';

const MESH_EXT = /\.(stl|obj|msh)$/i;
const XML_EXT = /\.xml$/i;

function vfsJoin(...parts) {
    return parts
        .filter(Boolean)
        .join('/')
        .replace(/\/+/g, '/')
        .replace(/^\//, '');
}

async function writeFile(mujoco, vfsPath, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());

    const parts = vfsPath.split('/');
    let current = '/working';
    for (let i = 0; i < parts.length - 1; i++) {
        current += '/' + parts[i];
        try { mujoco.FS.mkdir(current); } catch { /* exists */ }
    }
    mujoco.FS.writeFile('/working/' + vfsPath, data);
}

function attrFiles(doc, selector, attr = 'file') {
    const out = [];
    doc.querySelectorAll(selector).forEach((el) => {
        const file = el.getAttribute(attr);
        if (file) out.push(file);
    });
    return out;
}

async function collectAssets(xmlUrl, collected = new Set()) {
    const res = await fetch(xmlUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${xmlUrl} (${res.status})`);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');

    for (const file of [
        ...attrFiles(doc, 'include[file]'),
        ...attrFiles(doc, 'mesh[file]'),
        ...attrFiles(doc, 'hfield[file]'),
        ...attrFiles(doc, 'texture[file]'),
        ...attrFiles(doc, 'compiler[meshdir]', 'meshdir'),
    ]) {
        collected.add(file);
    }

    return collected;
}

function meshVfsPath(file) {
    // MJCF often uses file="foo.stl" with compiler meshdir="assets"
    if (file.includes('/')) return file;
    return `assets/${file}`;
}

export async function loadRobotScene(robotOrId = CONFIG.robot) {
    const robot = typeof robotOrId === 'string'
        ? resolveRobot(robotOrId)
        : (robotOrId || CONFIG.robot);

    if (!robot?.basePath || !robot?.scene) {
        throw new Error(`[loader] unknown robot: ${JSON.stringify(robotOrId)}`);
    }

    const basePath = String(robot.basePath).replace(/\/$/, '');
    const sceneFile = robot.scene || 'scene.xml';
    const sceneUrl = `${basePath}/${sceneFile}`;

    const mujoco = await loadMujoco();

    try { mujoco.FS.mkdir('/working'); } catch { /* exists */ }
    try { mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working'); } catch { /* mounted */ }

    const collected = await collectAssets(sceneUrl);
    await writeFile(mujoco, sceneFile, sceneUrl);

    const pending = [...collected];
    const written = new Set([sceneFile]);

    while (pending.length) {
        const file = pending.shift();
        if (!file || written.has(file)) continue;
        written.add(file);

        if (XML_EXT.test(file)) {
            const url = `${basePath}/${file}`;
            const more = await collectAssets(url);
            await writeFile(mujoco, file, url);
            more.forEach((m) => {
                if (!written.has(m)) pending.push(m);
            });
            continue;
        }

        if (MESH_EXT.test(file) || file.includes('/')) {
            const vfsPath = meshVfsPath(file);
            const url = `${basePath}/${vfsPath.replace(/^assets\//, 'assets/')}`;
            // Prefer assets/ on disk; fall back to the path as written in XML
            try {
                await writeFile(mujoco, vfsPath, `${basePath}/${vfsPath}`);
            } catch {
                await writeFile(mujoco, file, `${basePath}/${file}`);
            }
        }
    }

    const model = mujoco.MjModel.mj_loadXML(`/working/${sceneFile}`);
    if (!model) throw new Error(`[loader] mj_loadXML failed for ${sceneUrl}`);

    const data = new mujoco.MjData(model);

    console.log('[loader]', {
        robot: robot.id,
        scene: sceneUrl,
        nq: model.nq,
        nu: model.nu,
        nbody: model.nbody,
    });

    return { mujoco, model, data, robot };
}

/** Default: robot from VITE_ROBOT / CONFIG.robot */
export async function loadConfiguredRobot() {
    return loadRobotScene(CONFIG.robot);
}

export default loadConfiguredRobot;