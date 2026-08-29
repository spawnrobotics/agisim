// utils.js
import * as THREE from 'three';

/** MuJoCo (Z-up) → Three.js (Y-up) position */
export function setPositionFromMujoco(target, buffer, index) {
    const i = index * 3;
    target.set(buffer[i], buffer[i + 2], -buffer[i + 1]);
}

/** MuJoCo quaternion (w,x,y,z) → Three.js */
export function setQuaternionFromMujoco(target, buffer, index) {
    const i = index * 4;
    target.set(-buffer[i + 1], -buffer[i + 3], buffer[i + 2], -buffer[i]);
}

/** Apply the same conversion to a local Vector3 */
export function mujocoToThreeVec3(x, y, z, target = new THREE.Vector3()) {
    return target.set(x, z, -y);
}