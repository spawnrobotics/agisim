// renderer.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    setPositionFromMujoco,
    setQuaternionFromMujoco,
    mujocoToThreeVec3,
} from './utils.js';

const LAYER_DEFAULT = 0;
const LAYER_HEAD_SELF = 1; 

const mjGEOM_PLANE = 0;
const mjGEOM_HFIELD = 1;
const mjGEOM_SPHERE = 2;
const mjGEOM_CAPSULE = 3;
const mjGEOM_ELLIPSOID = 4;
const mjGEOM_CYLINDER = 5;
const mjGEOM_BOX = 6;
const mjGEOM_MESH = 7;
const COLLISION_GROUP_MIN = 3;

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

function getBodyName(model, bodyId) {
    try {
        const adr = model.name_bodyadr || model.body_nameadr;
        if (adr && model.names != null) {
            const start = adr[bodyId] ?? adr.get?.(bodyId);
            return readCString(model.names, start);
        }
    } catch (_) { /* ignore */ }
    return '';
}

function findHeadHostBodyId(model, preferredName) {
    const n = model.nbody | 0;
    const named = [];
    for (let i = 1; i < n; i++) {
        named.push({ i, name: (getBodyName(model, i) || '').toLowerCase() });
    }

    const want = String(preferredName || '').trim().toLowerCase();
    if (want) {
        const exact = named.find((b) => b.name === want);
        if (exact) return exact.i;
        const part = named.find((b) => b.name.includes(want));
        if (part) return part.i;
    }

    const hints = ['head_link', 'head', 'camera', 'torso_link', 'torso', 'pelvis'];
    for (const hint of hints) {
        const exact = named.find((b) => b.name === hint);
        if (exact) return exact.i;
        const part = named.find((b) => b.name.includes(hint));
        if (part) return part.i;
    }
    return 1;
}

function readVec4(arr, i) {
    if (!arr) return null;
    const a = arr[i * 4];
    const b = arr[i * 4 + 1];
    const c = arr[i * 4 + 2];
    const d = arr[i * 4 + 3];
    if (![a, b, c, d].every(Number.isFinite)) return null;
    return [a, b, c, d];
}

function geomRgba(model, g) {
    const matid = model.geom_matid?.[g] ?? model.geom_matid?.get?.(g) ?? -1;
    if (matid >= 0) {
        const mat = readVec4(model.mat_rgba, matid);
        if (mat) {
            const geom = readVec4(model.geom_rgba, g) || [1, 1, 1, 1];
            return [
                mat[0] * geom[0],
                mat[1] * geom[1],
                mat[2] * geom[2],
                mat[3] * geom[3],
            ];
        }
    }
    return readVec4(model.geom_rgba, g) || [0.7, 0.7, 0.7, 1];
}

function isCollisionOnly(model, g) {
    const group = model.geom_group?.[g] ?? 0;
    if (group >= COLLISION_GROUP_MIN) return true;

    const contype = model.geom_contype?.[g] ?? 0;
    const conaffinity = model.geom_conaffinity?.[g] ?? 0;
    const type = model.geom_type[g];
    if (type !== mjGEOM_MESH && contype !== 0 && conaffinity !== 0) {
        const bodyId = model.geom_bodyid[g];
        for (let k = 0; k < model.ngeom; k++) {
            if (k === g) continue;
            if (model.geom_bodyid[k] !== bodyId) continue;
            if (model.geom_type[k] === mjGEOM_MESH && (model.geom_group?.[k] ?? 0) < COLLISION_GROUP_MIN) {
                return true;
            }
        }
    }
    return false;
}

export function createRenderer(model, data, mujoco, options = {}) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        0.01,
        100
    );
    camera.position.set(2.8, 1.6, 2.8);
    camera.layers.enable(LAYER_DEFAULT);
    camera.layers.enable(LAYER_HEAD_SELF);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    if ('outputColorSpace' in renderer) {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.85, 0);
    controls.enableDamping = true;
    controls.update();

    let followRobot = true;
    const FOLLOW_LERP = 0.18;
    const LOOK_AT_HEIGHT = 0;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a3a, 0.85));
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(4, 8, 5);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x8899cc, 0.35);
    fill.position.set(-3, 2, -4);
    scene.add(fill);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(40, 40),
        new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.85, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.layers.set(LAYER_DEFAULT);
    scene.add(ground);

    const headHostBodyId = findHeadHostBodyId(model, options.headBody);
    const bodyNames = [];
    const bodyGroups = [];

    for (let i = 0; i < model.nbody; i++) {
        const group = new THREE.Group();
        const name = getBodyName(model, i) || (i === 0 ? 'world' : `body_${i}`);
        group.name = name;
        bodyNames[i] = name;
        if (i > 0) scene.add(group);
        bodyGroups.push(group);
    }

    for (let g = 0; g < model.ngeom; g++) {
        const type = model.geom_type[g];
        if (type === mjGEOM_PLANE || type === mjGEOM_HFIELD) continue;
        if (isCollisionOnly(model, g)) continue;

        const bodyId = model.geom_bodyid[g];
        const [r, gc, b, opacity] = geomRgba(model, g);
        const color = new THREE.Color(r, gc, b);

        let geometry = null;

        if (type === mjGEOM_MESH) {
            const meshId = model.geom_dataid[g];
            if (meshId < 0) continue;

            const vertAdr = model.mesh_vertadr[meshId];
            const vertNum = model.mesh_vertnum[meshId];
            const faceAdr = model.mesh_faceadr[meshId];
            const faceNum = model.mesh_facenum[meshId];

            const vertices = new Float32Array(vertNum * 3);
            const indices = new Uint32Array(faceNum * 3);

            for (let v = 0; v < vertNum; v++) {
                const src = (vertAdr + v) * 3;
                const dst = v * 3;
                const x = model.mesh_vert[src];
                const y = model.mesh_vert[src + 1];
                const z = model.mesh_vert[src + 2];
                vertices[dst] = x;
                vertices[dst + 1] = z;
                vertices[dst + 2] = -y;
            }

            for (let f = 0; f < faceNum * 3; f++) {
                indices[f] = model.mesh_face[faceAdr * 3 + f];
            }

            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            geometry.computeVertexNormals();
        } else if (type === mjGEOM_SPHERE) {
            const rad = model.geom_size[g * 3];
            geometry = new THREE.SphereGeometry(rad, 16, 12);
        } else if (type === mjGEOM_BOX) {
            const s = model.geom_size;
            geometry = new THREE.BoxGeometry(s[g * 3] * 2, s[g * 3 + 2] * 2, s[g * 3 + 1] * 2);
        } else if (type === mjGEOM_CAPSULE) {
            const rad = model.geom_size[g * 3];
            const h = model.geom_size[g * 3 + 1] * 2;
            geometry = new THREE.CapsuleGeometry(rad, h, 4, 8);
        } else if (type === mjGEOM_CYLINDER) {
            const rad = model.geom_size[g * 3];
            const h = model.geom_size[g * 3 + 1] * 2;
            geometry = new THREE.CylinderGeometry(rad, rad, h, 12);
        } else if (type === mjGEOM_ELLIPSOID) {
            const s = model.geom_size;
            geometry = new THREE.SphereGeometry(1, 16, 12);
            geometry.scale(s[g * 3], s[g * 3 + 2], s[g * 3 + 1]);
        } else {
            continue;
        }

        if (!geometry) continue;

        const material = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.45,
            metalness: 0.08,
            transparent: opacity < 0.99,
            opacity,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);

        const gp = model.geom_pos;
        const gq = model.geom_quat;
        mujocoToThreeVec3(gp[g * 3], gp[g * 3 + 1], gp[g * 3 + 2], mesh.position);
        setQuaternionFromMujoco(mesh.quaternion, gq, g);

        if (bodyId === headHostBodyId) {
            mesh.layers.set(LAYER_HEAD_SELF);
        } else {
            mesh.layers.set(LAYER_DEFAULT);
        }

        bodyGroups[bodyId].add(mesh);
    }

    function update() {
        for (let i = 1; i < model.nbody; i++) {
            const group = bodyGroups[i];
            setPositionFromMujoco(group.position, data.xpos, i);
            setQuaternionFromMujoco(group.quaternion, data.xquat, i);
        }

        if (followRobot && bodyGroups[1]) {
            const target = bodyGroups[1].position.clone();
            target.y += LOOK_AT_HEIGHT;
            controls.target.lerp(target, FOLLOW_LERP);
        }
    }

    function render() {
        controls.update();
        renderer.render(scene, camera);
    }

    function setFollow(enabled) {
        followRobot = !!enabled;
    }

    function resetCamera() {
        if (!bodyGroups[1]) return;
        const p = bodyGroups[1].position;
        camera.position.set(p.x + 2.8, p.y + 1.6, p.z + 2.8);
        controls.target.set(p.x, p.y + LOOK_AT_HEIGHT, p.z);
        controls.update();
    }

    function configureHeadCamera(headCam) {
        if (!headCam) return;
        headCam.layers.enable(LAYER_DEFAULT);
        headCam.layers.disable(LAYER_HEAD_SELF);
    }

    function dispose() {
        window.removeEventListener('resize', onResize);
        controls.dispose();
        renderer.dispose();
        renderer.domElement?.remove();
    }

    function onResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    window.addEventListener('resize', onResize);

    return {
        scene,
        camera,
        renderer,
        controls,
        bodyGroups,
        bodyNames,
        headHostBodyId,
        update,
        render,
        setFollow,
        resetCamera,
        configureHeadCamera,
        dispose,
        LAYER_DEFAULT,
        LAYER_HEAD_SELF,
    };
}