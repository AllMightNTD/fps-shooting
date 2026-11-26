/**
 * AAA unit tests (Happy & Unhappy paths) for public/js/arm_rig.js:
 * - Weapon socket -> wrist conversion with palmOffset compensation (0mm palm drift)
 * - Twist-stabilized analytical 2-bone IK (shoulder -> elbow -> wrist)
 * - Clavicle protraction & NaN guards on extreme overextension / zero-distance collapse
 * - Trigger discipline (index finger outside guard at idle -> curled onto trigger when firing)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HAND_INTRINSIC_BASIS,
  computeWristFromSocket,
  createSkinnedArmsController,
  solveTwoBoneArmIK,
  viewmodelPointToWorld,
} from "../../public/js/arm_rig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../../model/dist");

// Minimal Three.js-compatible math classes for pure Node.js testing (zero npm deps)
class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new Vec3(this.x, this.y, this.z);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  length() {
    return Math.sqrt(this.lengthSq());
  }
  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }
  normalize() {
    const l = this.length();
    return l > 0 ? this.multiplyScalar(1 / l) : this.set(0, 0, 0);
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
}

class Euler {
  constructor(x = 0, y = 0, z = 0, order = "XYZ") {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }
  set(x, y, z, order = this.order) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }
}

class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
  copy(q) {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }
  clone() {
    return new Quat(this.x, this.y, this.z, this.w);
  }
  invert() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this.normalize();
  }
  normalize() {
    let l = Math.hypot(this.x, this.y, this.z, this.w);
    if (l === 0) {
      this.x = this.y = this.z = 0;
      this.w = 1;
    } else {
      l = 1 / l;
      this.x *= l;
      this.y *= l;
      this.z *= l;
      this.w *= l;
    }
    return this;
  }
  multiply(q) {
    return this.multiplyQuaternions(this, q);
  }
  premultiply(q) {
    return this.multiplyQuaternions(q, this);
  }
  multiplyQuaternions(a, b) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
  setFromEuler(e) {
    const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2);
    const s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
    this.x = s1 * c2 * c3 + c1 * s2 * s3;
    this.y = c1 * s2 * c3 - s1 * c2 * s3;
    this.z = c1 * c2 * s3 + s1 * s2 * c3;
    this.w = c1 * c2 * c3 - s1 * s2 * s3;
    return this;
  }
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-6) {
      r = 0;
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) {
        this.x = -vFrom.y;
        this.y = vFrom.x;
        this.z = 0;
        this.w = r;
      } else {
        this.x = 0;
        this.y = -vFrom.z;
        this.z = vFrom.y;
        this.w = r;
      }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    return this.normalize();
  }
  setFromRotationMatrix(m) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this.normalize();
  }
  slerp(qb, t) {
    if (t === 0) return this;
    if (t === 1) return this.copy(qb);
    const x = this.x, y = this.y, z = this.z, w = this.w;
    let cosHalfTheta = w * qb.w + x * qb.x + y * qb.y + z * qb.z;
    if (cosHalfTheta < 0) {
      this.w = -qb.w; this.x = -qb.x; this.y = -qb.y; this.z = -qb.z;
      cosHalfTheta = -cosHalfTheta;
    } else {
      this.copy(qb);
    }
    if (cosHalfTheta >= 1.0) {
      this.w = w; this.x = x; this.y = y; this.z = z;
      return this;
    }
    const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;
    if (sqrSinHalfTheta <= Number.EPSILON) {
      const s = 1 - t;
      this.w = s * w + t * this.w;
      this.x = s * x + t * this.x;
      this.y = s * y + t * this.y;
      this.z = s * z + t * this.z;
      return this.normalize();
    }
    const sinHalfTheta = Math.sqrt(sqrSinHalfTheta);
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    this.w = w * ratioA + this.w * ratioB;
    this.x = x * ratioA + this.x * ratioB;
    this.y = y * ratioA + this.y * ratioB;
    this.z = z * ratioA + this.z * ratioB;
    return this;
  }
}

class Mat4 {
  constructor() {
    this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  makeBasis(xAxis, yAxis, zAxis) {
    this.elements = [
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      0, 0, 0, 1,
    ];
    return this;
  }
}

const MathApi = { Vector3: Vec3, Quaternion: Quat, Matrix4: Mat4, Euler };

function assertFiniteUnitQuat(q, label) {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  assert.ok(Number.isFinite(n), `${label}: quaternion contains NaN/Infinity`);
  assert.ok(Math.abs(n - 1) < 1e-4, `${label}: expected unit quaternion, got |q|=${n}`);
}

function createMockNode(name, pos = [0, 0, 0], quat = [0, 0, 0, 1], extra = {}) {
  const node = {
    name,
    position: new Vec3(...pos),
    quaternion: new Quat(...quat),
    scale: new Vec3(1, 1, 1),
    visible: true,
    children: [],
    userData: {},
    ...extra,
    add(...kids) {
      this.children.push(...kids);
    },
    traverse(fn) {
      fn(this);
      for (const c of this.children) c.traverse(fn);
    },
    getObjectByName(target) {
      if (this.name === target) return this;
      for (const c of this.children) {
        const hit = c.getObjectByName(target);
        if (hit) return hit;
      }
      return null;
    },
  };
  return node;
}

test("computeWristFromSocket locks palm grip center onto socket position with zero drift", () => {
  // Arrange
  const socketPos = new Vec3(0.151, -0.159, -0.683);
  const socketQuat = new Quat().setFromEuler(new Euler(-0.25, 0.48, -0.32));
  const outWristPos = new Vec3();
  const outWristQuat = new Quat();

  // Act
  computeWristFromSocket(socketPos, socketQuat, false, outWristPos, outWristQuat, MathApi);

  // Assert: wristPos + wristQuat * leftPalmOffset === socketPos
  const palmOffset = new Vec3(...HAND_INTRINSIC_BASIS.left.palmOffset).applyQuaternion(outWristQuat);
  const reconstructedPalm = outWristPos.clone().add(palmOffset);
  assert.ok(reconstructedPalm.distanceTo(socketPos) < 1e-6);

  // Assert: wristQuat * distal === socketQuat * [0, 0, -1]
  const worldDistal = new Vec3(...HAND_INTRINSIC_BASIS.left.distal).applyQuaternion(outWristQuat);
  const socketNegZ = new Vec3(0, 0, -1).applyQuaternion(socketQuat);
  assert.ok(worldDistal.distanceTo(socketNegZ) < 1e-4);
});

test("solveTwoBoneArmIK reaches target within 0.1mm and guards extreme/degenerate inputs", () => {
  // Arrange
  const shoulder = new Vec3(-0.20, -0.25, -0.06);
  const target = new Vec3(0.10, -0.18, -0.44);
  const pole = new Vec3(-0.35, -0.75, -0.10);
  const wristQ = new Quat().setFromEuler(new Euler(0.15, -0.35, 0.22));
  const restElbowQ = new Quat(0.202, -0.559, 0.292, 0.749).normalize();
  const restWristQ = new Quat(-0.18, -0.004, -0.111, 0.977).normalize();
  const outShoulderWorldQ = new Quat();
  const outElbowWorldQ = new Quat();

  // Act (Happy Path)
  solveTwoBoneArmIK(
    {
      shoulderPos: shoulder,
      targetPos: target,
      upperLen: 0.2587,
      forearmLen: 0.25432,
      poleHint: pole,
      wristWorldQuat: wristQ,
      restElbowLocalQuat: restElbowQ,
      restWristLocalQuat: restWristQ,
      outShoulderWorldQuat: outShoulderWorldQ,
      outElbowWorldQuat: outElbowWorldQ,
    },
    MathApi,
  );

  // Assert exact bone chain lengths & target reach
  assertFiniteUnitQuat(outShoulderWorldQ, "shoulder happy");
  assertFiniteUnitQuat(outElbowWorldQ, "elbow happy");
  const elbowPos = shoulder.clone().add(new Vec3(0, 0, -0.2587).applyQuaternion(outShoulderWorldQ));
  const wristPos = elbowPos.clone().add(new Vec3(0, 0, -0.25432).applyQuaternion(outElbowWorldQ));
  assert.ok(wristPos.distanceTo(target) < 1e-4, `Expected exact reach, err=${wristPos.distanceTo(target)}`);

  // Act / Assert (Unhappy Paths: extreme overextension 2.0m & collapsed 0.0001m)
  for (const extremeTarget of [new Vec3(0, 0, -2.0), shoulder.clone().add(new Vec3(0, 1e-5, -1e-5))]) {
    solveTwoBoneArmIK(
      {
        shoulderPos: shoulder,
        targetPos: extremeTarget,
        upperLen: 0.2587,
        forearmLen: 0.25432,
        poleHint: pole,
        wristWorldQuat: wristQ,
        restElbowLocalQuat: restElbowQ,
        restWristLocalQuat: restWristQ,
        outShoulderWorldQuat: outShoulderWorldQ,
        outElbowWorldQuat: outElbowWorldQ,
      },
      MathApi,
    );
    assertFiniteUnitQuat(outShoulderWorldQ, "shoulder extreme");
    assertFiniteUnitQuat(outElbowWorldQ, "elbow extreme");
  }
});

test("createSkinnedArmsController disables frustum culling, enforces trigger discipline, and handles missing bones", () => {
  // Arrange: Unhappy path first (null or incomplete skeleton)
  const emptyCtrl = createSkinnedArmsController(null, MathApi);
  assert.equal(emptyCtrl.ready, false);
  assert.doesNotThrow(() => emptyCtrl.update({}));

  // Arrange: Mock full 6-arm-bone + right index chain + SkinnedMesh
  const root = createMockNode("arms_root");
  root.scale.set(0.01, 0.01, 0.01);
  root.quaternion.set(0, 1, 0, 0);
  const rootJoint = createMockNode("_rootJoint");
  const skinnedMesh = createMockNode("armmesh_Mat_0", [0, 0, 0], [0, 0, 0, 1], {
    isSkinnedMesh: true,
    frustumCulled: true,
  });
  const lArm = createMockNode("L_arm_01", [10.03, 12.44, -18.11], [-0.097, 0.868, 0.404, -0.272]);
  const lElbow = createMockNode("L_elbow_02", [0, 0, -25.87], [0.202, -0.559, 0.292, 0.749]);
  const lWrist = createMockNode("L_wrist_03", [0, 0, -25.432], [-0.18, -0.004, -0.111, 0.977]);
  const rArm = createMockNode("R_arm_023", [-13.72, 14.86, -18.71], [-0.008, 0.847, 0.46, 0.267]);
  const rElbow = createMockNode("R_elbow_024", [0, 0, -25.87], [0.306, 0.543, -0.159, 0.765]);
  const rWrist = createMockNode("R_wrist_025", [0, 0, -25.432], [-0.078, -0.197, 0.028, 0.977]);
  const rPoint1 = createMockNode("R_point1_030", [-2.39, 6.08, -9.08], [0.048, 0.033, -0.013, 0.998]);
  const rPoint2 = createMockNode("R_point2_031", [0, 0, -3.21], [-0.077, 0.066, -0.003, 0.995]);
  const rPoint3 = createMockNode("R_point3_032", [0, 0, -2.35], [-0.088, -0.063, -0.006, 0.994]);

  lArm.add(lElbow);
  lElbow.add(lWrist);
  rArm.add(rElbow);
  rElbow.add(rWrist);
  rWrist.add(rPoint1);
  rPoint1.add(rPoint2);
  rPoint2.add(rPoint3);
  rootJoint.add(lArm, rArm);
  root.add(rootJoint, skinnedMesh);

  // Act
  const ctrl = createSkinnedArmsController(root, MathApi);
  assert.equal(ctrl.ready, true);
  assert.equal(skinnedMesh.frustumCulled, false);

  const leftSocket = { p: new Vec3(0.15, -0.16, -0.66), q: new Quat() };
  const rightSocket = { p: new Vec3(0.18, -0.21, -0.36), q: new Quat() };

  ctrl.update({
    weaponId: "m416",
    leftSocketPos: leftSocket.p,
    leftSocketQuat: leftSocket.q,
    rightSocketPos: rightSocket.p,
    rightSocketQuat: rightSocket.q,
    triggerPull: 0,
    ads: 0,
    hideArms: false,
  });
  const idlePoint1Q = rPoint1.quaternion.clone();
  const idlePoint2Q = rPoint2.quaternion.clone();

  ctrl.update({
    weaponId: "m416",
    leftSocketPos: leftSocket.p,
    leftSocketQuat: leftSocket.q,
    rightSocketPos: rightSocket.p,
    rightSocketQuat: rightSocket.q,
    triggerPull: 1,
    ads: 0,
    hideArms: false,
  });

  // Assert: firing pulls index finger onto trigger (distinct inward curl from idle trigger-discipline pose)
  const dot1 = Math.abs(
    idlePoint1Q.x * rPoint1.quaternion.x +
      idlePoint1Q.y * rPoint1.quaternion.y +
      idlePoint1Q.z * rPoint1.quaternion.z +
      idlePoint1Q.w * rPoint1.quaternion.w,
  );
  const dot2 = Math.abs(
    idlePoint2Q.x * rPoint2.quaternion.x +
      idlePoint2Q.y * rPoint2.quaternion.y +
      idlePoint2Q.z * rPoint2.quaternion.z +
      idlePoint2Q.w * rPoint2.quaternion.w,
  );
  assert.ok(dot1 < 0.992, `Expected R_point1_030 to swing onto trigger, dot=${dot1}`);
  assert.ok(dot2 < 0.985, `Expected R_point2_031 to flex onto trigger, dot=${dot2}`);

  // Assert: clavicle protraction keeps palm locked onto socket even at 0.66m forward reach!
  assertFiniteUnitQuat(lArm.quaternion, "lArm");
  assertFiniteUnitQuat(lElbow.quaternion, "lElbow");
  assertFiniteUnitQuat(lWrist.quaternion, "lWrist");
});

test("viewmodelPointToWorld maps viewmodel NDC coordinates cleanly into world camera rays", () => {
  // Arrange
  const vmLocalPt = new Vec3(0.16, -0.12, -0.80);
  const worldCamPos = new Vec3(2, 1.7, -5);
  const worldCamQuat = new Quat();
  const outWorld = new Vec3();

  // Act: wider world FOV (80 deg) vs narrower viewmodel FOV (60 deg) scales X/Y proportionally
  viewmodelPointToWorld(vmLocalPt, 60, 80, worldCamPos, worldCamQuat, outWorld, MathApi);

  // Assert
  const expectedScale = Math.tan((80 * Math.PI) / 360) / Math.tan((60 * Math.PI) / 360);
  assert.ok(Math.abs(outWorld.x - (2 + 0.16 * expectedScale)) < 1e-6);
  assert.ok(Math.abs(outWorld.y - (1.7 - 0.12 * expectedScale)) < 1e-6);
  assert.ok(Math.abs(outWorld.z - (-5 - 0.80)) < 1e-6);
});

test("Real built m416.glb + fps_arms.glb sockets enforce thumb-forward support & trigger discipline", () => {
  // Arrange: parse built GLB scene graphs directly from model/dist/
  function loadGlbRoot(glbPath) {
    const raw = fs.readFileSync(glbPath);
    const jsonLen = raw.readUInt32LE(12);
    const gltf = JSON.parse(raw.subarray(20, 20 + jsonLen).toString("utf8"));
    const objs = gltf.nodes.map((n, i) => {
      const node = createMockNode(n.name || `node_${i}`, n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1]);
      if (n.scale) node.scale.set(...n.scale);
      if (n.matrix) {
        node.position.set(n.matrix[12], n.matrix[13], n.matrix[14]);
        const sx = Math.hypot(n.matrix[0], n.matrix[1], n.matrix[2]) || 1;
        node.scale.set(sx, sx, sx);
        node.quaternion.setFromRotationMatrix({
          elements: [
            n.matrix[0] / sx, n.matrix[1] / sx, n.matrix[2] / sx, 0,
            n.matrix[4] / sx, n.matrix[5] / sx, n.matrix[6] / sx, 0,
            n.matrix[8] / sx, n.matrix[9] / sx, n.matrix[10] / sx, 0,
            0, 0, 0, 1,
          ],
        });
      }
      node.parent = null;
      return node;
    });
    gltf.nodes.forEach((n, i) =>
      (n.children || []).forEach((c) => {
        objs[i].children.push(objs[c]);
        objs[c].parent = objs[i];
      }),
    );
    return objs[gltf.scenes[0].nodes[0]];
  }

  function evalWorldTRS(node) {
    const chain = [];
    for (let cur = node; cur; cur = cur.parent) chain.push(cur);
    chain.reverse();
    const p = new Vec3(0, 0, 0);
    const q = new Quat(0, 0, 0, 1);
    let s = 1;
    for (const n of chain) {
      p.add(n.position.clone().multiplyScalar(s).applyQuaternion(q));
      q.multiplyQuaternions(q.clone(), n.quaternion);
      s *= n.scale.x;
    }
    return { p, q };
  }

  const m416Root = loadGlbRoot(path.join(DIST_DIR, "m416.glb"));
  const armsRoot = loadGlbRoot(path.join(DIST_DIR, "fps_arms.glb"));
  const ctrl = createSkinnedArmsController(armsRoot, MathApi);
  assert.equal(ctrl.ready, true);

  const sockHg = evalWorldTRS(m416Root.getObjectByName("socket_handguard"));
  const sockGrip = evalWorldTRS(m416Root.getObjectByName("socket_grip"));

  // Act 1: Idle pose (triggerPull = 0)
  ctrl.update({
    weaponId: "m416",
    leftSocketPos: sockHg.p,
    leftSocketQuat: sockHg.q,
    rightSocketPos: sockGrip.p,
    rightSocketQuat: sockGrip.q,
    triggerPull: 0,
    ads: 0,
  });

  const lThumb1 = evalWorldTRS(armsRoot.getObjectByName("L_thumb1_04")).p;
  const lThumb4 = evalWorldTRS(armsRoot.getObjectByName("L_thumb4_07")).p;
  const lMid4 = evalWorldTRS(armsRoot.getObjectByName("L_middle4_014")).p;
  const rMid1 = evalWorldTRS(armsRoot.getObjectByName("R_middle1_034")).p;
  const rIdx4Idle = evalWorldTRS(armsRoot.getObjectByName("R_point4_033")).p;

  // Assert 1: Left thumb points toward muzzle (-Z) & stays strictly below top Picatinny rail (y < 0.045)
  assert.ok(lThumb4.z < lThumb1.z - 0.06, `Left thumb must point forward (-Z), dz=${lThumb4.z - lThumb1.z}`);
  assert.ok(lThumb4.y < 0.042, `Left thumb must stay below top rail (0.056m), got y=${lThumb4.y}`);
  assert.ok(lMid4.y < 0.02, `Left fingers must cradle underneath handguard, got y=${lMid4.y}`);

  // Assert 2: Right hand wraps pistol grip (z > 0.02, NOT magwell z=-0.064) & idle index stays outside trigger guard
  assert.ok(rMid1.z > 0.025, `Right hand must sit on pistol grip, not magwell, got z=${rMid1.z}`);
  assert.ok(rIdx4Idle.x > 0.015, `Idle right index tip must stay outside right side of trigger guard, got x=${rIdx4Idle.x}`);

  // Act 2: Firing pose (triggerPull = 1)
  ctrl.update({
    weaponId: "m416",
    leftSocketPos: sockHg.p,
    leftSocketQuat: sockHg.q,
    rightSocketPos: sockGrip.p,
    rightSocketQuat: sockGrip.q,
    triggerPull: 1,
    ads: 0,
  });
  const rIdx2Fire = evalWorldTRS(armsRoot.getObjectByName("R_point2_031")).p;
  const rIdx4Fire = evalWorldTRS(armsRoot.getObjectByName("R_point4_033")).p;

  // Assert 3: Firing swings index finger inward across trigger blade (x=0)
  assert.ok(rIdx4Fire.x < 0.002 && rIdx2Fire.x > -0.005, "Index finger must cross trigger blade at x≈0 when firing");
});

test("Real built awm.glb + fps_arms.glb sockets position left forend, right grip, and right-side bolt handle cleanly", () => {
  const awmRaw = fs.readFileSync(path.join(DIST_DIR, "awm.glb"));
  const armsRaw = fs.readFileSync(path.join(DIST_DIR, "fps_arms.glb"));

  function parseRoot(raw) {
    const jsonLen = raw.readUInt32LE(12);
    const gltf = JSON.parse(raw.subarray(20, 20 + jsonLen).toString("utf8"));
    const objs = gltf.nodes.map((n, i) => {
      const node = createMockNode(n.name || `node_${i}`, n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1]);
      if (n.scale) node.scale.set(...n.scale);
      if (n.matrix) {
        node.position.set(n.matrix[12], n.matrix[13], n.matrix[14]);
        const sx = Math.hypot(n.matrix[0], n.matrix[1], n.matrix[2]) || 1;
        node.scale.set(sx, sx, sx);
        node.quaternion.setFromRotationMatrix({
          elements: [
            n.matrix[0] / sx, n.matrix[1] / sx, n.matrix[2] / sx, 0,
            n.matrix[4] / sx, n.matrix[5] / sx, n.matrix[6] / sx, 0,
            n.matrix[8] / sx, n.matrix[9] / sx, n.matrix[10] / sx, 0,
            0, 0, 0, 1,
          ],
        });
      }
      node.parent = null;
      return node;
    });
    gltf.nodes.forEach((n, i) =>
      (n.children || []).forEach((c) => {
        objs[i].children.push(objs[c]);
        objs[c].parent = objs[i];
      }),
    );
    return objs[gltf.scenes[0].nodes[0]];
  }

  function worldTRS(node) {
    const chain = [];
    for (let cur = node; cur; cur = cur.parent) chain.push(cur);
    chain.reverse();
    const p = new Vec3(0, 0, 0);
    const q = new Quat(0, 0, 0, 1);
    let s = 1;
    for (const n of chain) {
      p.add(n.position.clone().multiplyScalar(s).applyQuaternion(q));
      q.multiplyQuaternions(q.clone(), n.quaternion);
      s *= n.scale.x;
    }
    return { p, q };
  }

  const awmRoot = parseRoot(awmRaw);
  const armsRoot = parseRoot(armsRaw);
  const ctrl = createSkinnedArmsController(armsRoot, MathApi);
  assert.equal(ctrl.ready, true);

  const sockHg = worldTRS(awmRoot.getObjectByName("socket_handguard"));
  const sockGrip = worldTRS(awmRoot.getObjectByName("socket_grip"));
  const sockBolt = worldTRS(awmRoot.getObjectByName("socket_bolt_right"));

  // Act 1: Sniper hipfire grip
  ctrl.update({
    weaponId: "sniper",
    leftSocketPos: sockHg.p,
    leftSocketQuat: sockHg.q,
    rightSocketPos: sockGrip.p,
    rightSocketQuat: sockGrip.q,
    triggerPull: 0,
    ads: 0,
    rightAction: "grip",
  });
  const lThumb4 = worldTRS(armsRoot.getObjectByName("L_thumb4_07")).p;
  const rMid1 = worldTRS(armsRoot.getObjectByName("R_middle1_034")).p;
  assert.ok(lThumb4.z < -0.22, `Expected left hand on AWM forend, got z=${lThumb4.z}`);
  assert.ok(rMid1.z > 0.02, `Expected right hand on AWM grip, got z=${rMid1.z}`);

  // Act 2: Bolt-action right hand cycling
  ctrl.update({
    weaponId: "sniper",
    leftSocketPos: sockHg.p,
    leftSocketQuat: sockHg.q,
    rightSocketPos: sockBolt.p,
    rightSocketQuat: sockBolt.q,
    triggerPull: 0,
    ads: 0,
    rightAction: "bolt",
  });
  const rWristBolt = worldTRS(armsRoot.getObjectByName("R_wrist_025")).p;
  assert.ok(rWristBolt.x > 0.04 && Number.isFinite(rWristBolt.x), `Expected right wrist on right bolt handle, got x=${rWristBolt.x}`);
});
