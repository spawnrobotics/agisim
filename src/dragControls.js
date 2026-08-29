// dragControls.js
import * as THREE from 'three';
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
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    const targetPos = new THREE.Vector3();
    const grabWorld = new THREE.Vector3();
    const forceThree = new THREE.Vector3();
    const offsetThree = new THREE.Vector3();
    const torqueThree = new THREE.Vector3();

    let isPulling = false;
    let bodyId = -1;

    // Grab point in body-local frame (MuJoCo axes: X right, Y forward, Z up)
    // local = R^T * (world - xpos)
    const grabLocalMj = new Float64Array(3);

    // ── Coordinate helpers (Three Y-up ↔ MuJoCo Z-up) ─────────
    function threeToMj(x, y, z, out) {
        // three (x,y,z) → mj (x, -z, y)
        out[0] = x;
        out[1] = -z;
        out[2] = y;
    }

    function mjToThree(mx, my, mz, target) {
        // mj (x,y,z) → three (x, z, -y)
        return target.set(mx, mz, -my);
    }

    function clearExternalForces() {
        // xfrc_applied: nbody × 6  (fx,fy,fz, tx,ty,tz) in world / MuJoCo frame
        if (data.xfrc_applied) {
            data.xfrc_applied.fill(0);
        }
    }

    function updateMouse(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function pick(event) {
        updateMouse(event);
        raycaster.setFromCamera(mouse, camera);

        const meshes = [];
        for (let i = 1; i < bodyGroups.length; i++) {
            bodyGroups[i].traverse((obj) => {
                if (obj.isMesh) {
                    obj.userData.bodyId = i;
                    meshes.push(obj);
                }
            });
        }

        const hits = raycaster.intersectObjects(meshes, true);
        if (hits.length === 0) return null;
        return hits[0];
    }

    /** Body rotation matrix from data.xmat (row-major 3×3, MuJoCo) */
    function bodyRotMj(bid, out9) {
        const o = bid * 9;
        for (let i = 0; i < 9; i++) out9[i] = data.xmat[o + i];
    }

    const R = new Float64Array(9);

    function worldGrabPointMj(out3) {
        // world = xpos + R * local
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

    const grabMj = new Float64Array(3);
    const targetMj = new Float64Array(3);
    const forceMj = new Float64Array(3);
    const rMj = new Float64Array(3); // vector from COM to grab point
    const torqueMj = new Float64Array(3);

    /**
     * Call every frame *before* mj_step while pulling.
     * Recomputes spring-damper force at the moving grab point.
     */
    function update() {
        if (!isPulling || bodyId < 1) return;

        worldGrabPointMj(grabMj);
        mjToThree(grabMj[0], grabMj[1], grabMj[2], grabWorld);

        // Spring toward mouse target (in Three space, then convert force)
        forceThree.copy(targetPos).sub(grabWorld).multiplyScalar(stiffness);

        // Simple damping using body COM velocity (good enough)
        const cvel = data.cvel; // rotational then translational in body frame — skip for simplicity
        // Use qvel of free joint if body 1, else approximate with 0 damping on other bodies
        // Better: use data.qvel mapped via body — for robustness use finite difference optional.
        // Lightweight: damp in world using subtree linear vel if available.
        // MuJoCo: data.cvel is 6 * nbody (ang, then lin) in body frame.
        // Convert body linear vel to world for damping along force direction only.
        const linBody = bodyId * 6 + 3;
        // cvel linear is in body frame; rotate to world
        bodyRotMj(bodyId, R);
        const vx =
            R[0] * data.cvel[linBody] +
            R[1] * data.cvel[linBody + 1] +
            R[2] * data.cvel[linBody + 2];
        const vy =
            R[3] * data.cvel[linBody] +
            R[4] * data.cvel[linBody + 1] +
            R[5] * data.cvel[linBody + 2];
        const vz =
            R[6] * data.cvel[linBody] +
            R[7] * data.cvel[linBody + 1] +
            R[8] * data.cvel[linBody + 2];

        // damping force in MuJoCo world frame
        const dampFx = -damping * vx;
        const dampFy = -damping * vy;
        const dampFz = -damping * vz;

        threeToMj(forceThree.x, forceThree.y, forceThree.z, forceMj);
        forceMj[0] += dampFx;
        forceMj[1] += dampFy;
        forceMj[2] += dampFz;

        // Clamp magnitude
        const mag = Math.hypot(forceMj[0], forceMj[1], forceMj[2]);
        if (mag > maxForce && mag > 1e-8) {
            const s = maxForce / mag;
            forceMj[0] *= s;
            forceMj[1] *= s;
            forceMj[2] *= s;
        }

        // Torque = r × F  (r = grab - COM)
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

    // ── Pointer events ────────────────────────────────────────
    function onPointerDown(e) {
        if (e.button !== 0) return;

        const hit = pick(e);
        if (!hit) return;

        isPulling = true;
        bodyId = hit.object.userData.bodyId;
        controls.enabled = false;

        // Hit point in Three.js world
        hitPoint.copy(hit.point);
        targetPos.copy(hit.point);

        // Horizontal plane by default (pull mostly in XZ / height).
        // Use camera-facing plane for more natural 3D pull:
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), hitPoint);

        // Store grab point in body-local MuJoCo frame
        const mx = data.xpos[bodyId * 3];
        const my = data.xpos[bodyId * 3 + 1];
        const mz = data.xpos[bodyId * 3 + 2];

        const hitMj = new Float64Array(3);
        threeToMj(hit.point.x, hit.point.y, hit.point.z, hitMj);

        // local = R^T * (hit - xpos)
        bodyRotMj(bodyId, R);
        const dx = hitMj[0] - mx;
        const dy = hitMj[1] - my;
        const dz = hitMj[2] - mz;
        // R is row-major; R^T * v
        grabLocalMj[0] = R[0] * dx + R[3] * dy + R[6] * dz;
        grabLocalMj[1] = R[1] * dx + R[4] * dy + R[7] * dz;
        grabLocalMj[2] = R[2] * dx + R[5] * dy + R[8] * dz;

        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!isPulling) return;

        updateMouse(e);
        raycaster.setFromCamera(mouse, camera);

        if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
            targetPos.copy(hitPoint);
        }
    }

    function onPointerUp() {
        if (!isPulling) return;
        isPulling = false;
        bodyId = -1;
        controls.enabled = true;
        clearExternalForces();
    }

    const el = renderer.domElement;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    return {
        /** Apply current pull force — call every frame before mj_step */
        update,

        isDragging: () => isPulling, // keep name for compatibility
        isPulling: () => isPulling,

        setStiffness: (v) => {
            stiffness = v;
        },
        setDamping: (v) => {
            damping = v;
        },
        setMaxForce: (v) => {
            maxForce = v;
        },

        dispose() {
            clearExternalForces();
            el.removeEventListener('pointerdown', onPointerDown);
            el.removeEventListener('pointermove', onPointerMove);
            el.removeEventListener('pointerup', onPointerUp);
            el.removeEventListener('pointerleave', onPointerUp);
            el.removeEventListener('pointercancel', onPointerUp);
        },
    };
}