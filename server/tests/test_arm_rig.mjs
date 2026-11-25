/**
 * AAA unit tests for public/js/arm_rig.js:
 * - Analytical 2-bone arm IK geometry, reachability & twist stability
 * - Edge/unhappy cases (overextended, collapsed, zero/collinear pole)
 * - Scaled/rotated glTF arms_root coordinate conversion (Pre-flight Ruling)
 * - SkinnedMesh frustumCulled = false, triggerPull finger curl, null-safety
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SKINNED_ARM_POSES,
  createSkinnedArmsController,
  solveTwoBoneArmIK,
} from "../../public/js/arm_rig.js";

// Lightweight Three.js r128-compatible math shim (zero external dependencies)
class Vector3 {
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
    return new Vector3(this.x, this.y, this.z);
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
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
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
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  normalize() {
    const len = this.length();
    return len > 0 ? this.multiplyScalar(1 / len) : this.set(0, 0, 0);
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
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }
  setFromMatrixPosition(m) {
    const e = m.elements;
    this.x = e[12];
    this.y = e[13];
    this.z = e[14];
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

class Quaternion {
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
    return new Quaternion(this.x, this.y, this.z, this.w);
  }
  length() {
    return Math.hypot(this.x, this.y, this.z, this.w);
  }
  normalize() {
    const len = this.length();
    if (len === 0) return this.set(0, 0, 0, 1);
    const inv = 1 / len;
    this.x *= inv;
    this.y *= inv;
    this.z *= inv;
    this.w *= inv;
    return this;
  }
  conjugate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }
  invert() {
    return this.conjugate().normalize();
  }
  dot(q) {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }
  angleTo(q) {
    const d = Math.min(1, Math.max(-1, Math.abs(this.dot(q))));
    return 2 * Math.acos(d);
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
  slerp(qb, t) {
    if (t === 0) return this;
    if (t === 1) return this.copy(qb);
    const x = this.x, y = this.y, z = this.z, w = this.w;
    let cosHalfTheta = w * qb.w + x * qb.x + y * qb.y + z * qb.z;
    let qbx = qb.x, qby = qb.y, qbz = qb.z, qbw = qb.w;
    if (cosHalfTheta < 0) {
      qbw = -qbw;
      qbx = -qbx;
      qby = -qby;
      qbz = -qbz;
      cosHalfTheta = -cosHalfTheta;
    }
    if (cosHalfTheta >= 1.0) return this;
    const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;
    if (sqrSinHalfTheta <= Number.EPSILON) {
      const s = 1 - t;
      this.w = s * w + t * qbw;
      this.x = s * x + t * qbx;
      this.y = s * y + t * qby;
      this.z = s * z + t * qbz;
      return this.normalize();
    }
    const sinHalfTheta = Math.sqrt(sqrSinHalfTheta);
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    this.w = w * ratioA + qbw * ratioB;
    this.x = x * ratioA + qbx * ratioB;
    this.y = y * ratioA + qby * ratioB;
    this.z = z * ratioA + qbz * ratioB;
    return this;
  }
  setFromEuler(euler) {
    const c1 = Math.cos(euler.x / 2);
    const c2 = Math.cos(euler.y / 2);
    const c3 = Math.cos(euler.z / 2);
    const s1 = Math.sin(euler.x / 2);
    const s2 = Math.sin(euler.y / 2);
    const s3 = Math.sin(euler.z / 2);
    // Intrinsic XYZ (Three.js default)
    this.x = s1 * c2 * c3 + c1 * s2 * s3;
    this.y = c1 * s2 * c3 - s1 * c2 * s3;
    this.z = c1 * c2 * s3 + s1 * s2 * c3;
    this.w = c1 * c2 * c3 - s1 * s2 * s3;
    return this;
  }
  setFromAxisAngle(axis, angle) {
    const halfAngle = angle * 0.5;
    const s = Math.sin(halfAngle);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(halfAngle);
    return this;
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
    return this;
  }
}

class Matrix4 {
  constructor() {
    this.elements = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
  }
  identity() {
    const e = this.elements;
    e[0] = 1; e[4] = 0; e[8] = 0; e[12] = 0;
    e[1] = 0; e[5] = 1; e[9] = 0; e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = 1; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }
  copy(m) {
    const src = m.elements;
    for (let i = 0; i < 16; i++) this.elements[i] = src[i];
    return this;
  }
  clone() {
    return new Matrix4().copy(this);
  }
  makeBasis(xAxis, yAxis, zAxis) {
    const e = this.elements;
    e[0] = xAxis.x; e[4] = yAxis.x; e[8] = zAxis.x; e[12] = 0;
    e[1] = xAxis.y; e[5] = yAxis.y; e[9] = zAxis.y; e[13] = 0;
    e[2] = xAxis.z; e[6] = yAxis.z; e[10] = zAxis.z; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }
  compose(position, quaternion, scale) {
    const te = this.elements;
    const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;

    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;
    return this;
  }
  decompose(position, quaternion, scale) {
    const te = this.elements;
    let sx = Math.hypot(te[0], te[1], te[2]);
    const sy = Math.hypot(te[4], te[5], te[6]);
    const sz = Math.hypot(te[8], te[9], te[10]);
    const det = this.determinant();
    if (det < 0) sx = -sx;
    position.x = te[12];
    position.y = te[13];
    position.z = te[14];
    const m = this.clone();
    const invSX = sx !== 0 ? 1 / sx : 0;
    const invSY = sy !== 0 ? 1 / sy : 0;
    const invSZ = sz !== 0 ? 1 / sz : 0;
    m.elements[0] *= invSX; m.elements[1] *= invSX; m.elements[2] *= invSX;
    m.elements[4] *= invSY; m.elements[5] *= invSY; m.elements[6] *= invSY;
    m.elements[8] *= invSZ; m.elements[9] *= invSZ; m.elements[10] *= invSZ;
    quaternion.setFromRotationMatrix(m);
    scale.x = sx;
    scale.y = sy;
    scale.z = sz;
    return this;
  }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return this;
  }
  determinant() {
    const te = this.elements;
    const n11 = te[0], n12 = te[4], n13 = te[8], n14 = te[12];
    const n21 = te[1], n22 = te[5], n23 = te[9], n24 = te[13];
    const n31 = te[2], n32 = te[6], n33 = te[10], n34 = te[14];
    const n41 = te[3], n42 = te[7], n43 = te[11], n44 = te[15];
    return (
      n41 * (+n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34) +
      n42 * (+n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31) +
      n43 * (+n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31) +
      n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31)
    );
  }
  invert() {
    const te = this.elements;
    const n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
    const n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
    const n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
    const n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) return this.identity();
    const detInv = 1 / det;
    te[0] = t11 * detInv;
    te[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    te[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    te[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;
    te[4] = t12 * detInv;
    te[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    te[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    te[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;
    te[8] = t13 * detInv;
    te[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    te[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    te[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;
    te[12] = t14 * detInv;
    te[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    te[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    te[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;
    return this;
  }
}

const MathApi = { Vector3, Quaternion, Matrix4, Euler };

class MockNode {
  constructor(name, opts = {}) {
    this.name = name;
    this.type = opts.type || "Object3D";
    this.isSkinnedMesh = Boolean(opts.isSkinnedMesh);
    this.frustumCulled = opts.frustumCulled !== undefined ? opts.frustumCulled : true;
    this.visible = true;
    this.position = new Vector3(...(opts.position || [0, 0, 0]));
    this.quaternion = new Quaternion(...(opts.quaternion || [0, 0, 0, 1]));
    this.scale = new Vector3(...(opts.scale || [1, 1, 1]));
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.matrixAutoUpdate = true;
    this.parent = null;
    this.children = [];
  }
  add(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
    return this;
  }
  getObjectByName(name) {
    if (this.name === name) return this;
    for (const c of this.children) {
      const found = c.getObjectByName(name);
      if (found) return found;
    }
    return null;
  }
  traverse(fn) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
  }
  updateMatrixWorld(force = false) {
    if (this.matrixAutoUpdate || force) this.updateMatrix();
    if (this.parent) {
      this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    } else {
      this.matrixWorld.copy(this.matrix);
    }
    for (const c of this.children) c.updateMatrixWorld(force);
  }
  getWorldPosition(target) {
    return target.setFromMatrixPosition(this.matrixWorld);
  }
  getWorldQuaternion(target) {
    const p = new Vector3();
    const s = new Vector3();
    this.matrixWorld.decompose(p, target, s);
    return target;
  }
}

function assertFiniteUnitQuaternion(q, label) {
  assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w), `${label} has non-finite components`);
  assert.ok(Math.abs(q.length() - 1) < 1e-4, `${label} is not unit length: ${q.length()}`);
}

function buildMockSkinnedArmsRig() {
  const gun = new MockNode("gun", { position: [0.155, -0.14, -0.395], quaternion: [0.05, -0.02, 0.01, 0.9985] });
  const armsRoot = new MockNode("arms_root", {
    position: [0, 0, 0],
    quaternion: [0, 1, 0, 0], // rotY = pi
    scale: [0.01, 0.01, 0.01], // centimeters -> meters
  });
  const rootJoint = new MockNode("_rootJoint");
  const skinnedMesh = new MockNode("armmesh_Mat_0", { type: "SkinnedMesh", isSkinnedMesh: true, frustumCulled: true });

  const lArm = new MockNode("L_arm_01", { position: [10.03, 12.44, -18.11] });
  const lElbow = new MockNode("L_elbow_02", { position: [0, 0, -25.8697] });
  const lWrist = new MockNode("L_wrist_03", { position: [0, 0, -25.4316] });

  const rArm = new MockNode("R_arm_023", { position: [-13.72, 14.86, -18.71] });
  const rElbow = new MockNode("R_elbow_024", { position: [0, 0, -25.8697] });
  const rWrist = new MockNode("R_wrist_025", { position: [0, 0, -25.4316] });

  const lThumb1 = new MockNode("L_thumb1_04", { position: [2.5, 0.75, -3.69], quaternion: [0.19, -0.24, -0.53, 0.79] });
  const lPoint1 = new MockNode("L_point1_08", { position: [2.39, 6.08, -9.08], quaternion: [0.02, -0.06, -0.17, 0.98] });
  const lMid1 = new MockNode("L_middle1_012", { position: [-0.31, 5.82, -9.12], quaternion: [0.0, 0.0, 0.22, 0.975] });
  const lMid2 = new MockNode("L_middle2_00", { position: [0, 0, -3.495], quaternion: [-0.32, 0.04, 0.03, 0.946] });
  const lRing1 = new MockNode("L_ring1_015", { position: [-2.19, 4.23, -8.97], quaternion: [-0.07, -0.02, 0.27, 0.96] });
  const lPink1 = new MockNode("L_pink1_019", { position: [-3.17, 1.60, -8.69], quaternion: [-0.16, -0.04, 0.43, 0.89] });

  const rThumb1 = new MockNode("R_thumb1_026", { position: [-2.5, 0.75, -3.69], quaternion: [0.28, 0.30, 0.42, 0.81] });
  const rPoint1 = new MockNode("R_point1_030", { position: [-2.39, 6.08, -9.08], quaternion: [0.0476, 0.0326, -0.0127, 0.9983] });
  const rPoint2 = new MockNode("R_point2_031", { position: [0, 0, -3.2098], quaternion: [-0.0769, 0.0656, -0.0029, 0.9949] });
  const rPoint3 = new MockNode("R_point3_032", { position: [0, 0, -2.3491], quaternion: [-0.0884, -0.0629, -0.0056, 0.9941] });
  const rPoint4 = new MockNode("R_point4_033", { position: [0, 0, -2.0011] });
  const rMid1 = new MockNode("R_middle1_034", { position: [0.31, 5.82, -9.12], quaternion: [-0.015, 0.02, -0.264, 0.964] });
  const rRing1 = new MockNode("R_ring1_038", { position: [2.19, 4.23, -8.97], quaternion: [-0.05, 0.046, -0.248, 0.966] });
  const rPink1 = new MockNode("R_pink1_042", { position: [3.17, 1.60, -8.69], quaternion: [0.008, -0.026, -0.425, 0.905] });

  lArm.add(lElbow);
  lElbow.add(lWrist);
  lMid1.add(lMid2);
  lWrist.add(lThumb1, lPoint1, lMid1, lRing1, lPink1);

  rArm.add(rElbow);
  rElbow.add(rWrist);
  rPoint1.add(rPoint2);
  rPoint2.add(rPoint3);
  rPoint3.add(rPoint4);
  rWrist.add(rThumb1, rPoint1, rMid1, rRing1, rPink1);

  rootJoint.add(lArm, rArm);
  armsRoot.add(rootJoint, skinnedMesh);
  gun.add(armsRoot);
  gun.updateMatrixWorld(true);

  return { gun, armsRoot, rootJoint, skinnedMesh, lArm, lElbow, lWrist, rArm, rElbow, rWrist, rPoint1, rPoint2, rPoint3, rPoint4 };
}

test("solveTwoBoneArmIK places elbow at L1 and wrist at L2 within < 1e-3m across M416, Pistol, and Sniper poses", () => {
  // Arrange
  const L1 = 0.2587;
  const L2 = 0.2543;
  const parentWorldQuat = new Quaternion(0, 1, 0, 0); // rotY = pi (_rootJoint under arms_root)
  const cases = [
    ["m416.grip", SKINNED_ARM_POSES.m416.leftShoulder, SKINNED_ARM_POSES.m416.grip, SKINNED_ARM_POSES.m416.leftPole],
    ["m416.mag", SKINNED_ARM_POSES.m416.leftShoulder, SKINNED_ARM_POSES.m416.mag, SKINNED_ARM_POSES.m416.leftPole],
    ["m416.out", SKINNED_ARM_POSES.m416.leftShoulder, SKINNED_ARM_POSES.m416.out, SKINNED_ARM_POSES.m416.leftPole],
    ["m416.ch", SKINNED_ARM_POSES.m416.leftShoulder, SKINNED_ARM_POSES.m416.ch, SKINNED_ARM_POSES.m416.leftPole],
    ["m416.chPulled", SKINNED_ARM_POSES.m416.leftShoulder, SKINNED_ARM_POSES.m416.chPulled, SKINNED_ARM_POSES.m416.leftPole],
    ["m416.rightGrip", SKINNED_ARM_POSES.m416.rightShoulder, SKINNED_ARM_POSES.m416.rightGrip, SKINNED_ARM_POSES.m416.rightPole],
    ["pistol.grip", SKINNED_ARM_POSES.pistol.leftShoulder, SKINNED_ARM_POSES.pistol.grip, SKINNED_ARM_POSES.pistol.leftPole],
    ["pistol.mag", SKINNED_ARM_POSES.pistol.leftShoulder, SKINNED_ARM_POSES.pistol.mag, SKINNED_ARM_POSES.pistol.leftPole],
    ["pistol.out", SKINNED_ARM_POSES.pistol.leftShoulder, SKINNED_ARM_POSES.pistol.out, SKINNED_ARM_POSES.pistol.leftPole],
    ["pistol.ch", SKINNED_ARM_POSES.pistol.leftShoulder, SKINNED_ARM_POSES.pistol.ch, SKINNED_ARM_POSES.pistol.leftPole],
    ["pistol.chPulled", SKINNED_ARM_POSES.pistol.leftShoulder, SKINNED_ARM_POSES.pistol.chPulled, SKINNED_ARM_POSES.pistol.leftPole],
    ["pistol.rightGrip", SKINNED_ARM_POSES.pistol.rightShoulder, SKINNED_ARM_POSES.pistol.rightGrip, SKINNED_ARM_POSES.pistol.rightPole],
    ["sniper.grip", SKINNED_ARM_POSES.sniper.leftShoulder, SKINNED_ARM_POSES.sniper.grip, SKINNED_ARM_POSES.sniper.leftPole],
    ["sniper.rightGrip", SKINNED_ARM_POSES.sniper.rightShoulder, SKINNED_ARM_POSES.sniper.rightGrip, SKINNED_ARM_POSES.sniper.rightPole],
  ];

  for (const [label, shArr, pose, poleArr] of cases) {
    const shoulderPos = new Vector3(...shArr);
    const targetPos = new Vector3(...pose.p);
    const poleHint = new Vector3(...poleArr);
    const wristWorldQuat = new Quaternion(...pose.q);
    const outShoulderQuat = new Quaternion();
    const outElbowQuat = new Quaternion();
    const outWristQuat = new Quaternion();

    // Act
    solveTwoBoneArmIK(
      {
        shoulderPos,
        targetPos,
        upperLen: L1,
        forearmLen: L2,
        poleHint,
        wristWorldQuat,
        parentWorldQuat,
        upperWorldMatInv: null,
        outShoulderQuat,
        outElbowQuat,
        outWristQuat,
      },
      MathApi,
    );

    // Assert forward kinematics along local -Z
    assertFiniteUnitQuaternion(outShoulderQuat, `${label}.outShoulderQuat`);
    assertFiniteUnitQuaternion(outElbowQuat, `${label}.outElbowQuat`);
    assertFiniteUnitQuaternion(outWristQuat, `${label}.outWristQuat`);

    const shoulderWorldQ = parentWorldQuat.clone().multiply(outShoulderQuat);
    const elbowPos = shoulderPos.clone().add(new Vector3(0, 0, -L1).applyQuaternion(shoulderWorldQ));
    const elbowWorldQ = shoulderWorldQ.clone().multiply(outElbowQuat);
    const wristPos = elbowPos.clone().add(new Vector3(0, 0, -L2).applyQuaternion(elbowWorldQ));
    const finalWristQ = elbowWorldQ.clone().multiply(outWristQuat);

    assert.ok(Math.abs(elbowPos.distanceTo(shoulderPos) - L1) < 1e-5, `${label} shoulder-elbow distance mismatch`);
    assert.ok(Math.abs(wristPos.distanceTo(elbowPos) - L2) < 1e-5, `${label} elbow-wrist distance mismatch`);
    assert.ok(wristPos.distanceTo(targetPos) < 1e-3, `${label} wrist target miss: ${wristPos.distanceTo(targetPos)}`);
    assert.ok(finalWristQ.angleTo(wristWorldQuat) < 1e-4, `${label} wrist orientation mismatch`);
  }
});

test("solveTwoBoneArmIK handles overextended, collapsed, and collinear pole targets without NaN", () => {
  // Arrange
  const L1 = 0.2587;
  const L2 = 0.2543;
  const shoulderPos = new Vector3(-0.22, -0.14, 0.34);
  const parentWorldQuat = new Quaternion(0, 0, 0, 1);
  const wristWorldQuat = new Quaternion(0, 0, 0, 1);

  const edgeTargets = [
    { name: "overextended", targetPos: shoulderPos.clone().add(new Vector3(0, 0, -1.2)), poleHint: new Vector3(-0.48, -0.78, 0.12) },
    { name: "collapsed_1mm", targetPos: shoulderPos.clone().add(new Vector3(0, 0, -0.001)), poleHint: new Vector3(0, -1, 0) },
    { name: "zero_delta", targetPos: shoulderPos.clone(), poleHint: new Vector3(0, 0, 0) },
    { name: "collinear_pole", targetPos: shoulderPos.clone().add(new Vector3(0, 0, -0.35)), poleHint: new Vector3(0, 0, -1) },
  ];

  for (const tc of edgeTargets) {
    const outShoulderQuat = new Quaternion();
    const outElbowQuat = new Quaternion();
    const outWristQuat = new Quaternion();

    // Act
    solveTwoBoneArmIK(
      {
        shoulderPos,
        targetPos: tc.targetPos,
        upperLen: L1,
        forearmLen: L2,
        poleHint: tc.poleHint,
        wristWorldQuat,
        parentWorldQuat,
        upperWorldMatInv: null,
        outShoulderQuat,
        outElbowQuat,
        outWristQuat,
      },
      MathApi,
    );

    // Assert
    assertFiniteUnitQuaternion(outShoulderQuat, `${tc.name}.outShoulderQuat`);
    assertFiniteUnitQuaternion(outElbowQuat, `${tc.name}.outElbowQuat`);
    assertFiniteUnitQuaternion(outWristQuat, `${tc.name}.outWristQuat`);
  }
});

test("createSkinnedArmsController converts arms_root cm/rotY space, disables frustumCulled, curls trigger finger, and handles invalid roots safely", () => {
  // Arrange (Happy Path)
  const rig = buildMockSkinnedArmsRig();
  const ctrl = createSkinnedArmsController(rig.armsRoot, MathApi);

  assert.equal(ctrl.ready, true);
  assert.equal(rig.skinnedMesh.frustumCulled, false);
  const summary = ctrl.getBoneSummary();
  assert.ok(summary && summary.coreBones.length === 6);

  const gunLeftTarget = new Vector3(...SKINNED_ARM_POSES.m416.grip.p);
  const gunLeftQuat = new Quaternion(...SKINNED_ARM_POSES.m416.grip.q);
  const gunRightTarget = new Vector3(...SKINNED_ARM_POSES.m416.rightGrip.p);
  const gunRightQuat = new Quaternion(...SKINNED_ARM_POSES.m416.rightGrip.q);

  // Act & Assert across triggerPull 0 -> 0.5 -> 1.0
  const tipLocalY = [];
  const p1Angles = [];
  const p2Angles = [];
  const restP1 = rig.rPoint1.quaternion.clone();
  const restP2 = rig.rPoint2.quaternion.clone();

  for (const pull of [0, 0.5, 1.0]) {
    ctrl.update({
      weaponId: "m416",
      leftWristPos: gunLeftTarget,
      leftWristQuat: gunLeftQuat,
      rightWristPos: gunRightTarget,
      rightWristQuat: gunRightQuat,
      triggerPull: pull,
      reloadProgress: 0,
      isTactical: false,
      isSprinting: false,
      ads: 0,
      hideArms: false,
    });

    // Convert gun-space wrist target to world space via rig.gun.matrixWorld and compare against solved bone world pos
    const expectedLWorld = gunLeftTarget.clone().applyMatrix4(rig.gun.matrixWorld);
    const expectedRWorld = gunRightTarget.clone().applyMatrix4(rig.gun.matrixWorld);
    const actualLWorld = rig.lWrist.getWorldPosition(new Vector3());
    const actualRWorld = rig.rWrist.getWorldPosition(new Vector3());

    assert.ok(actualLWorld.distanceTo(expectedLWorld) < 1e-3, `L_wrist world mismatch: ${actualLWorld.distanceTo(expectedLWorld)}`);
    assert.ok(actualRWorld.distanceTo(expectedRWorld) < 1e-3, `R_wrist world mismatch: ${actualRWorld.distanceTo(expectedRWorld)}`);

    p1Angles.push(restP1.angleTo(rig.rPoint1.quaternion));
    p2Angles.push(restP2.angleTo(rig.rPoint2.quaternion));

    // Fingertip position in R_wrist local frame moves inward toward palm (-Y) on curl
    const invWristWorld = rig.rWrist.matrixWorld.clone().invert();
    const tipInWrist = rig.rPoint4.getWorldPosition(new Vector3()).applyMatrix4(invWristWorld);
    tipLocalY.push(tipInWrist.y);
  }

  assert.ok(p1Angles[1] > p1Angles[0] && p1Angles[2] > p1Angles[1], `R_point1_030 curl not strictly increasing: ${p1Angles}`);
  assert.ok(p2Angles[1] > p2Angles[0] && p2Angles[2] > p2Angles[1], `R_point2_031 curl not strictly increasing: ${p2Angles}`);
  assert.ok(tipLocalY[1] < tipLocalY[0] && tipLocalY[2] < tipLocalY[1], `Index fingertip did not flex toward palm (-Y): ${tipLocalY}`);

  // Visibility toggle
  ctrl.update({ hideArms: true });
  assert.equal(rig.armsRoot.visible, false);
  ctrl.update({ hideArms: false });
  assert.equal(rig.armsRoot.visible, true);

  // Moved camera parent + preset reload fallback without explicit wrist targets
  const cam = new MockNode("cam", { position: [12, 1.72, -18], quaternion: [0.05, 0.35, -0.02, 0.935] });
  cam.add(rig.gun);
  ctrl.update({ weaponId: "pistol", reloadProgress: 0.48, triggerPull: 0.25, hideArms: false });
  const expectedPistolOutWorld = new Vector3(...SKINNED_ARM_POSES.pistol.out.p).applyMatrix4(rig.gun.matrixWorld);
  const actualPistolOutWorld = rig.lWrist.getWorldPosition(new Vector3());
  assert.ok(actualPistolOutWorld.distanceTo(expectedPistolOutWorld) < 1e-3, `Cam-parented pistol.out mismatch: ${actualPistolOutWorld.distanceTo(expectedPistolOutWorld)}`);

  // Arrange / Act / Assert (Unhappy Paths: null root and missing core arm bone)
  const nullCtrl = createSkinnedArmsController(null, MathApi);
  assert.equal(nullCtrl.ready, false);
  assert.equal(nullCtrl.getBoneSummary(), null);
  assert.doesNotThrow(() => nullCtrl.update({ weaponId: "m416", triggerPull: 1 }));

  const incompleteRoot = new MockNode("arms_root");
  incompleteRoot.add(new MockNode("L_arm_01"));
  const badCtrl = createSkinnedArmsController(incompleteRoot, MathApi);
  assert.equal(badCtrl.ready, false);
  assert.equal(badCtrl.getBoneSummary(), null);
  assert.doesNotThrow(() => badCtrl.update({ weaponId: "pistol" }));
});
