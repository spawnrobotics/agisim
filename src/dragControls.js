// dragControls.js
import * as THREE from 'three';

const SKIP_NAME = /floor|ground|plane|sky|world|terrain|visual_only/i;

export function createDragControls({
    renderer,
    camera,
    controls,
    bodyGroups,
    model,
    data,
    mujoco,
    stiffness = 400,
    damping = 20,
    maxForce = 250,
}) {
    const el = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    const targetPos = new THREE.Vector3();
    const grabWorld = new THREE.Vector3();
    const forceThree = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const planeN = new THREE.Vector3();

    let isPulling = false;
    let bodyId = -1;
    let pointerId = null;

    const grabLocalMj = new Float64Array(3);
    const R = new Float64Array(9);
    const grabMj = new Float64Array(3);
    const forceMj = new Float64Array(3);
    const rMj = new Float64Array(3);
    const torqueMj = new Float64Array(3);

    function threeToMj(x, y, z, out) {
        out[0] = x;
        out[1] = -z;
        out[2] = y;
    }

    function mjToThree(mx, my, mz, target) {
        return target.set(mx, mz, -my);
    }

    function bodyNameOf(bid) {
        try {
            return String(model.id2name?.(1, bid) || '');
        } catch (_) {
            return '';
        }
    }

    function isDraggableBody(bid) {
        if (!(bid >= 1)) return false;
        const name = bodyNameOf(bid);
        if (SKIP_NAME.test(name)) return false;
        return true;
    }

    function clearExternalForces() {
        data.xfrc_applied?.fill(0);
    }

    function setOrbitEnabled(on) {
        if (!controls) return;
        controls.enabled = !!on;
        if (typeof controls.enablePan === 'boolean') controls.enablePan = !!on;
        if (typeof controls.enableRotate === 'boolean') controls.enableRotate = !!on;
        if (typeof controls.enableZoom === 'boolean') controls.enableZoom = true;
    }

    function updateMouse(event) {
        const rect = el.getBoundingClientRect();
        const w = rect.width || 1;
        const h = rect.height || 1;
        mouse.x = ((event.clientX - rect.left) / w) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / h) * 2 + 1;
    }

    function collectMeshes() {
        const meshes = [];
        const n = bodyGroups?.length | 0;
        for (let i = 1; i < n; i++) {
            if (!isDraggableBody(i)) continue;
            const g = bodyGroups[i];
            if (!g) continue;
            g.traverse((obj) => {
                if (!obj.isMesh || !obj.visible) return;
                obj.userData.bodyId = i;
                meshes.push(obj);
            });
        }
        return meshes;
    }

    function pick(event) {
        updateMouse(event);
        raycaster.setFromCamera(mouse, camera);
        const meshes = collectMeshes();
        if (!meshes.length) return null;
        const hits = raycaster.intersectObjects(meshes, true);
        for (const hit of hits) {
            const bid = hit.object?.userData?.bodyId | 0;
            if (isDraggableBody(bid)) return hit;
        }
        return null;
    }

    function bodyRotMj(bid, out9) {
        const o = bid * 9;
        const m = data.xmat;
        for (let i = 0; i < 9; i++) out9[i] = m[o + i];
    }

    function worldGrabPointMj(out3) {
        bodyRotMj(bodyId, R);
        const px = data.xpos[bodyId * 3];
        const py = data.xpos[bodyId * 3 + 1];
        const pz = data.xpos[bodyId * 3 + 2];
        const lx = grabLocalMj[0];
        const ly = grabLocalMj[1];
        const lz = grabLocalMj[2];
        out3[0] = px + R[0] * lx + R[1] * ly + R[2] * lz;
        out3[1] = py + R[3] * lx + R[4] * ly + R[5] * lz;
        out3[2] = pz + R[6] * lx + R[7] * ly + R[8] * lz;
    }

    function update() {
        if (!isPulling || bodyId < 1) return;

        worldGrabPointMj(grabMj);
        mjToThree(grabMj[0], grabMj[1], grabMj[2], grabWorld);

        forceThree.copy(targetPos).sub(grabWorld).multiplyScalar(stiffness);
        threeToMj(forceThree.x, forceThree.y, forceThree.z, forceMj);

        const lin = bodyId * 6 + 3;
        forceMj[0] += -damping * (data.cvel[lin] || 0);
        forceMj[1] += -damping * (data.cvel[lin + 1] || 0);
        forceMj[2] += -damping * (data.cvel[lin + 2] || 0);

        const mag = Math.hypot(forceMj[0], forceMj[1], forceMj[2]);
        if (mag > maxForce && mag > 1e-8) {
            const s = maxForce / mag;
            forceMj[0] *= s;
            forceMj[1] *= s;
            forceMj[2] *= s;
        }

        rMj[0] = grabMj[0] - data.xpos[bodyId * 3];
        rMj[1] = grabMj[1] - data.xpos[bodyId * 3 + 1];
        rMj[2] = grabMj[2] - data.xpos[bodyId * 3 + 2];

        torqueMj[0] = rMj[1] * forceMj[2] - rMj[2] * forceMj[1];
        torqueMj[1] = rMj[2] * forceMj[0] - rMj[0] * forceMj[2];
        torqueMj[2] = rMj[0] * forceMj[1] - rMj[1] * forceMj[0];

        clearExternalForces();
        const base = bodyId * 6;
        data.xfrc_applied[base] = forceMj[0];
        data.xfrc_applied[base + 1] = forceMj[1];
        data.xfrc_applied[base + 2] = forceMj[2];
        data.xfrc_applied[base + 3] = torqueMj[0];
        data.xfrc_applied[base + 4] = torqueMj[1];
        data.xfrc_applied[base + 5] = torqueMj[2];
    }

    function beginPull(e, hit) {
        const bid = hit.object?.userData?.bodyId | 0;
        if (!isDraggableBody(bid)) return false;

        isPulling = true;
        bodyId = bid;
        pointerId = e.pointerId;
        setOrbitEnabled(false);

        hitPoint.copy(hit.point);
        targetPos.copy(hit.point);

        camera.getWorldDirection(camDir);
        planeN.copy(camDir).negate();
        dragPlane.setFromNormalAndCoplanarPoint(planeN, hitPoint);

        const mx = data.xpos[bodyId * 3];
        const my = data.xpos[bodyId * 3 + 1];
        const mz = data.xpos[bodyId * 3 + 2];

        threeToMj(hit.point.x, hit.point.y, hit.point.z, grabMj);
        bodyRotMj(bodyId, R);
        const dx = grabMj[0] - mx;
        const dy = grabMj[1] - my;
        const dz = grabMj[2] - mz;
        grabLocalMj[0] = R[0] * dx + R[3] * dy + R[6] * dz;
        grabLocalMj[1] = R[1] * dx + R[4] * dy + R[7] * dz;
        grabLocalMj[2] = R[2] * dx + R[5] * dy + R[8] * dz;

        try {
            el.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }

        return true;
    }

    function endPull(e) {
        if (!isPulling) return;
        isPulling = false;
        bodyId = -1;
        clearExternalForces();
        setOrbitEnabled(true);
        try {
            const id = e?.pointerId ?? pointerId;
            if (id != null) el.releasePointerCapture(id);
        } catch (_) { /* ignore */ }
        pointerId = null;
    }

    function onPointerDown(e) {
        if (e.button !== 0) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

        const hit = pick(e);
        if (!hit) return;

        if (!beginPull(e, hit)) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function onPointerMove(e) {
        if (!isPulling) return;
        updateMouse(e);
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
            targetPos.copy(hitPoint);
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function onPointerUp(e) {
        if (!isPulling) return;
        endPull(e);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', onPointerDown, { capture: true });
    el.addEventListener('pointermove', onPointerMove, { capture: true });
    el.addEventListener('pointerup', onPointerUp, { capture: true });
    el.addEventListener('pointercancel', onPointerUp, { capture: true });
    window.addEventListener('pointerup', onPointerUp, { capture: true });

    return {
        update,
        isDragging: () => isPulling,
        isPulling: () => isPulling,
        getBodyId: () => bodyId,
        setStiffness: (v) => {
            stiffness = Number(v) || 0;
        },
        setDamping: (v) => {
            damping = Number(v) || 0;
        },
        setMaxForce: (v) => {
            maxForce = Number(v) || 0;
        },
        dispose() {
            endPull();
            el.removeEventListener('pointerdown', onPointerDown, { capture: true });
            el.removeEventListener('pointermove', onPointerMove, { capture: true });
            el.removeEventListener('pointerup', onPointerUp, { capture: true });
            el.removeEventListener('pointercancel', onPointerUp, { capture: true });
            window.removeEventListener('pointerup', onPointerUp, { capture: true });
        },
    };
}

export default createDragControls;