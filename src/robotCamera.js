// robotCamera.js
import * as THREE from 'three';
import CONFIG from './config.js';

const LAYER_DEFAULT = 0;
const LAYER_HEAD_SELF = 1;

const HEAD_NAME_HINTS = [
    'jaw_soft',
    'head_link',
    'head_camera',
    'head',
    'imu_in_head',
    'neck_pitch',
    'neck',
    'torso_link',
    'torso',
    'trunk_base',
    'pelvis',
];

function readCString(names, start) {
    if (names == null || start == null || start < 0) return '';
    if (typeof names === 'string') {
        const end = names.indexOf('\0', start);
        return names.slice(start, end < 0 ? undefined : end);
    }
    const bytes = names.subarray ? names : new Uint8Array(names);
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(start, end));
}

export function getBodyName(model, bodyId) {
    try {
        const adrArr = model.name_bodyadr || model.body_nameadr;
        if (adrArr && model.names != null) {
            return readCString(model.names, adrArr[bodyId] ?? adrArr.get?.(bodyId));
        }
    } catch (_) { /* ignore */ }
    return '';
}

function listBodies(model) {
    const n = model.nbody | 0;
    const names = [];
    for (let i = 1; i < n; i++) {
        names.push({ i, name: (getBodyName(model, i) || '').toLowerCase() });
    }
    return names;
}

function pickBody(names, hints) {
    for (const raw of hints) {
        const hint = String(raw || '').trim().toLowerCase();
        if (!hint) continue;
        const exact = names.find((b) => b.name === hint);
        if (exact) return exact.i;
        const part = names.find((b) => b.name.includes(hint));
        if (part) return part.i;
    }
    return -1;
}

export function findHeadBodyId(model, preferred) {
    const names = listBodies(model);
    const extras = [];
    if (preferred) extras.push(preferred);
    const robot = CONFIG.robot;
    if (robot?.headBody) extras.push(robot.headBody);
    if (robot?.torsoBody) extras.push(robot.torsoBody);

    const id = pickBody(names, [...extras, ...HEAD_NAME_HINTS]);
    return id >= 0 ? id : 1;
}

function applyHeadCamLayers(cam) {
    if (!cam?.layers) return;
    cam.layers.enable(LAYER_DEFAULT);
    cam.layers.disable(LAYER_HEAD_SELF);
}

function defaultLocalPose(bodyName) {
    const n = String(bodyName || '');
    if (/jaw_soft|head_camera/i.test(n)) {
        // MJCF camera on jaw_soft: pos 0.0155, -9e-5, -0.0733
        return {
            position: [0.016, 0, -0.073],
            rotation: [0, Math.PI, 0],
        };
    }
    const isTorso = /torso|pelvis|trunk/i.test(n);
    return {
        position: [isTorso ? 0.10 : 0.06, isTorso ? 0.42 : 0.08, 0],
        rotation: [-0.18, -Math.PI / 2, 0],
    };
}

function makeAxisLabels(size = 0.08) {
    const root = new THREE.Group();
    root.name = 'headCamAxes';

    const axes = new THREE.AxesHelper(size);
    root.add(axes);

    const makeLabel = (text, color, pos) => {
        const c = document.createElement('canvas');
        c.width = 128;
        c.height = 64;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.font = 'bold 36px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 8;
        ctx.strokeText(text, 64, 32);
        ctx.fillStyle = color;
        ctx.fillText(text, 64, 32);
        const tex = new THREE.CanvasTexture(c);
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
        const spr = new THREE.Sprite(mat);
        spr.position.copy(pos);
        spr.scale.set(0.04, 0.02, 1);
        spr.renderOrder = 10;
        return spr;
    };

    root.add(makeLabel('+X', '#ff4444', new THREE.Vector3(size, 0, 0)));
    root.add(makeLabel('+Y', '#44ff44', new THREE.Vector3(0, size, 0)));
    root.add(makeLabel('+Z', '#4488ff', new THREE.Vector3(0, 0, size)));
    root.add(makeLabel('−Z look', '#88ccff', new THREE.Vector3(0, 0, -size)));
    return root;
}

export function createRobotHeadCamera({
    scene,
    bodyGroups,
    model,
    frameSize = CONFIG.frameSize || 32,
    previewWidth = 320,
    previewHeight = 240,
    fov = 75,
    near = 0.02,
    far = 40,
    clearColor = 0x1a1a2e,
    configureHeadCamera = null,
    headBody = CONFIG.robot?.headBody,
} = {}) {
    const bodyId = findHeadBodyId(model, headBody);
    const parent = bodyGroups[bodyId] || bodyGroups[1];
    if (!parent) {
        console.error('[HeadCam] no body group to attach to');
        return null;
    }

    const bodyName = getBodyName(model, bodyId) || `body[${bodyId}]`;
    const cam = new THREE.PerspectiveCamera(fov, previewWidth / previewHeight, near, far);

    const pose = CONFIG.robot?.headCam || defaultLocalPose(bodyName);
    const p = pose.position || [0.06, 0.08, 0];
    const r = pose.rotation || [-0.18, -Math.PI / 2, 0];
    cam.position.set(p[0], p[1], p[2]);
    cam.rotation.set(r[0], r[1], r[2]);
    parent.add(cam);

    const debug = pose.debug !== false;
    if (debug) {
        cam.add(makeAxisLabels(0.08));

        const probe = new THREE.Mesh(
            new THREE.ConeGeometry(0.008, 0.04, 8),
            new THREE.MeshBasicMaterial({ color: 0xff3333 })
        );
        probe.rotation.x = -Math.PI / 2;
        probe.position.set(0, 0, -0.025);
        cam.add(probe);
    }

    const _fwd = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const _pos = new THREE.Vector3();
    const _quat = new THREE.Quaternion();

    function logPose(tag = 'attached') {
        cam.updateMatrixWorld(true);
        cam.getWorldPosition(_pos);
        cam.getWorldDirection(_fwd);
        cam.getWorldQuaternion(_quat);
        _up.set(0, 1, 0).applyQuaternion(_quat);
        console.log(`[HeadCam] ${tag}`, {
            bodyId,
            bodyName,
            localPos: cam.position.toArray().map((n) => +n.toFixed(4)),
            localRot: [cam.rotation.x, cam.rotation.y, cam.rotation.z].map((n) => +n.toFixed(4)),
            worldPos: _pos.toArray().map((n) => +n.toFixed(3)),
            look: _fwd.toArray().map((n) => +n.toFixed(3)),
            up: _up.toArray().map((n) => +n.toFixed(3)),
        });
    }

    logPose('attached');

    if (debug) {
        const onKey = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            const step = e.shiftKey ? 0.2 : 0.05;
            let hit = true;
            if (e.key === 'j') cam.rotation.y += step;
            else if (e.key === 'l') cam.rotation.y -= step;
            else if (e.key === 'i') cam.rotation.x += step;
            else if (e.key === 'k') cam.rotation.x -= step;
            else if (e.key === 'u') cam.rotation.z += step;
            else if (e.key === 'o') cam.rotation.z -= step;
            else if (e.key === '[') cam.position.z -= 0.005;
            else if (e.key === ']') cam.position.z += 0.005;
            else if (e.key === '-') cam.position.x -= 0.005;
            else if (e.key === '=') cam.position.x += 0.005;
            else if (e.key === 'p' || e.key === 'P') logPose('tune');
            else hit = false;
            if (hit && e.key !== 'p' && e.key !== 'P') logPose('tune');
        };
        window.addEventListener('keydown', onKey);
        cam.userData.headCamKeyHandler = onKey;
    }

    if (typeof configureHeadCamera === 'function') {
        configureHeadCamera(cam);
    } else {
        applyHeadCamLayers(cam);
    }

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = previewWidth;
    previewCanvas.height = previewHeight;

    const headRenderer = new THREE.WebGLRenderer({
        canvas: previewCanvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
    });
    headRenderer.setSize(previewWidth, previewHeight, false);
    headRenderer.setPixelRatio(1);
    headRenderer.setClearColor(clearColor);
    if ('outputColorSpace' in headRenderer) {
        headRenderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = frameSize;
    captureCanvas.height = frameSize;
    const captureCtx = captureCanvas.getContext('2d', {
        willReadFrequently: true,
        alpha: false,
    });

    function renderFrame() {
        if (!cam || !headRenderer) return null;
        cam.updateMatrixWorld(true);
        headRenderer.render(scene, cam);
        return previewCanvas;
    }

    function grabRgbaFrame() {
        const preview = renderFrame();
        if (!preview) return null;
        captureCtx.imageSmoothingEnabled = true;
        captureCtx.drawImage(preview, 0, 0, frameSize, frameSize);
        return captureCtx.getImageData(0, 0, frameSize, frameSize);
    }

    function dispose() {
        if (cam.userData.headCamKeyHandler) {
            window.removeEventListener('keydown', cam.userData.headCamKeyHandler);
        }
        if (cam.parent) cam.parent.remove(cam);
        headRenderer?.dispose();
    }

    return {
        cam,
        bodyId,
        bodyName,
        previewCanvas,
        captureCanvas,
        frameSize,
        renderFrame,
        grabRgbaFrame,
        logPose,
        dispose,
    };
}