/**
 * Analytical 2-bone arm IK solver and skinned finger controller for fps_arms.glb.
 * Pure ES module with zero external runtime dependencies (accepts Three.js-compatible MathApi).
 */

const DEFAULT_UPPER_LEN = 0.2587;
const DEFAULT_FOREARM_LEN = 0.2543;
const CORE_BONE_NAMES = Object.freeze([
  "L_arm_01",
  "L_elbow_02",
  "L_wrist_03",
  "R_arm_023",
  "R_elbow_024",
  "R_wrist_025",
]);
const FINGER_BONE_RE = /^(L|R)_(thumb|point|middle|ring|pink)([1-4])(?:_\d+)?$/;

const LEFT_RELOAD_TRACK = Object.freeze([
  [0, "grip"],
  [0.05, "grip"],
  [0.22, "mag"],
  [0.29, "mag"],
  [0.44, "out"],
  [0.52, "out"],
  [0.66, "mag"],
  [0.72, "mag"],
  [0.8, "ch"],
  [0.83, "ch"],
  [0.9, "chPulled"],
  [0.93, "chPulled"],
  [1, "grip"],
]);

function freezePose(p, q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return Object.freeze({
    p: Object.freeze([...p]),
    q: Object.freeze([q[0] / len, q[1] / len, q[2] / len, q[3] / len]),
  });
}

/**
 * Weapon-specific wrist targets, shoulder anchors, elbow pole hints (in gun space),
 * and subtle relative finger curl offsets for M416, Glock-17, and AWM Sniper.
 */
export const SKINNED_ARM_POSES = Object.freeze({
  m416: Object.freeze({
    leftShoulder: Object.freeze([-0.22, -0.14, 0.34]),
    rightShoulder: Object.freeze([0.19, -0.14, 0.34]),
    leftPole: Object.freeze([-0.48, -0.78, 0.12]),
    rightPole: Object.freeze([0.48, -0.78, 0.12]),
    grip: freezePose([-0.092, -0.055, -0.132], [-0.171175, -0.269161, 0.248702, 0.914549]),
    mag: freezePose([-0.088, -0.118, 0.012], [-0.26198, -0.144335, 0.377022, 0.876578]),
    out: freezePose([-0.118, -0.192, 0.042], [-0.26198, -0.144335, 0.377022, 0.876578]),
    ch: freezePose([-0.086, 0.012, 0.195], [-0.188127, -0.19971, 0.307767, 0.911045]),
    chPulled: freezePose([-0.086, 0.012, 0.25], [-0.188127, -0.19971, 0.307767, 0.911045]),
    rightGrip: freezePose([0.03, -0.125, 0.162], [0.069495, 0.134143, -0.343584, 0.92689]),
    fingerCurls: Object.freeze({
      L_thumb: -0.05,
      L_point: -0.08,
      L_middle: -0.12,
      L_ring: -0.14,
      L_pink: -0.14,
      R_thumb: -0.08,
      R_pointBase: 0.0,
      R_middle: -0.12,
      R_ring: -0.14,
      R_pink: -0.16,
      triggerPullMax: Object.freeze([0.34, 0.42, 0.28]),
    }),
  }),
  pistol: Object.freeze({
    leftShoulder: Object.freeze([-0.19, -0.11, 0.28]),
    rightShoulder: Object.freeze([0.16, -0.11, 0.28]),
    leftPole: Object.freeze([-0.44, -0.76, 0.14]),
    rightPole: Object.freeze([0.44, -0.76, 0.14]),
    grip: freezePose([-0.088, -0.062, 0.095], [-0.262245, -0.318783, 0.347844, 0.841789]),
    mag: freezePose([-0.068, -0.125, 0.112], [-0.285191, -0.170057, 0.402353, 0.853147]),
    out: freezePose([-0.092, -0.232, 0.144], [-0.285191, -0.170057, 0.402353, 0.853147]),
    ch: freezePose([-0.075, 0.042, 0.058], [-0.225704, -0.223728, 0.336821, 0.886316]),
    chPulled: freezePose([-0.075, 0.042, 0.103], [-0.225704, -0.223728, 0.336821, 0.886316]),
    rightGrip: freezePose([0.026, -0.082, 0.115], [0.069495, 0.134143, -0.343584, 0.92689]),
    fingerCurls: Object.freeze({
      L_thumb: -0.06,
      L_point: -0.14,
      L_middle: -0.18,
      L_ring: -0.2,
      L_pink: -0.22,
      R_thumb: -0.06,
      R_pointBase: 0.0,
      R_middle: -0.16,
      R_ring: -0.18,
      R_pink: -0.2,
      triggerPullMax: Object.freeze([0.38, 0.46, 0.32]),
    }),
  }),
  sniper: Object.freeze({
    leftShoulder: Object.freeze([-0.22, -0.14, 0.34]),
    rightShoulder: Object.freeze([0.19, -0.14, 0.34]),
    leftPole: Object.freeze([-0.48, -0.78, 0.12]),
    rightPole: Object.freeze([0.48, -0.78, 0.12]),
    grip: freezePose([-0.09, -0.068, -0.125], [-0.17299, -0.262275, 0.225713, 0.922139]),
    mag: freezePose([-0.085, -0.122, -0.065], [-0.256156, -0.155891, 0.36056, 0.883221]),
    out: freezePose([-0.115, -0.205, -0.042], [-0.256156, -0.155891, 0.36056, 0.883221]),
    ch: freezePose([-0.082, 0.015, 0.165], [-0.188127, -0.19971, 0.307767, 0.911045]),
    chPulled: freezePose([-0.082, 0.015, 0.22], [-0.188127, -0.19971, 0.307767, 0.911045]),
    rightGrip: freezePose([0.034, -0.128, 0.172], [0.069495, 0.134143, -0.343584, 0.92689]),
    fingerCurls: Object.freeze({
      L_thumb: -0.04,
      L_point: -0.1,
      L_middle: -0.12,
      L_ring: -0.14,
      L_pink: -0.14,
      R_thumb: -0.08,
      R_pointBase: 0.0,
      R_middle: -0.12,
      R_ring: -0.14,
      R_pink: -0.16,
      triggerPullMax: Object.freeze([0.34, 0.42, 0.28]),
    }),
  }),
});

function resolveMathApi(MathApi) {
  const api = MathApi || globalThis.THREE;
  if (!api || !api.Vector3 || !api.Quaternion || !api.Matrix4 || !api.Euler) {
    throw new Error("MathApi must provide Vector3, Quaternion, Matrix4, and Euler constructors");
  }
  return api;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function createIKScratch(api) {
  const { Vector3, Quaternion, Matrix4 } = api;
  return {
    delta: new Vector3(),
    dir: new Vector3(),
    poleDir: new Vector3(),
    fallback: new Vector3(),
    effTarget: new Vector3(),
    elbowPos: new Vector3(),
    upperDir: new Vector3(),
    forearmDir: new Vector3(),
    upHint: new Vector3(),
    wristUp: new Vector3(),
    worldUp: new Vector3(0, 1, 0),
    xAxis: new Vector3(),
    yAxis: new Vector3(),
    zAxis: new Vector3(),
    altUp: new Vector3(),
    basisMat: new Matrix4(),
    shoulderWorldQ: new Quaternion(),
    forearmWorldQ: new Quaternion(),
    parentQ: new Quaternion(),
    invQ: new Quaternion(),
    targetWristQ: new Quaternion(),
  };
}

function buildNegZFrame(boneDir, upHint, outQuat, s) {
  s.zAxis.copy(boneDir).multiplyScalar(-1);
  s.xAxis.crossVectors(upHint, s.zAxis);
  if (s.xAxis.lengthSq() < 1e-12) {
    s.altUp.set(Math.abs(s.zAxis.y) < 0.9 ? 0 : 1, Math.abs(s.zAxis.y) < 0.9 ? 1 : 0, 0);
    s.xAxis.crossVectors(s.altUp, s.zAxis);
  }
  s.xAxis.normalize();
  s.yAxis.crossVectors(s.zAxis, s.xAxis).normalize();
  s.basisMat.makeBasis(s.xAxis, s.yAxis, s.zAxis);
  outQuat.setFromRotationMatrix(s.basisMat).normalize();
}

function orthogonalizePole(poleHint, dir, outPole, fallback) {
  if (poleHint) {
    outPole.copy(poleHint);
  } else {
    outPole.set(0, -1, 0);
  }
  outPole.addScaledVector(dir, -outPole.dot(dir));
  if (outPole.lengthSq() >= 1e-12) {
    return outPole.normalize();
  }
  // Collinear or zero poleHint: try world down first, then +X.
  outPole.set(0, -1, 0).addScaledVector(dir, dir.y);
  if (outPole.lengthSq() >= 1e-12) {
    return outPole.normalize();
  }
  fallback.set(1, 0, 0);
  return outPole.copy(fallback).addScaledVector(dir, -dir.x).normalize();
}

function resolveUpperArmUpHint(s) {
  // Keep upper-arm dorsal +Y generally upright away from the downward elbow pole.
  s.upHint.copy(s.worldUp).multiplyScalar(0.65).addScaledVector(s.poleDir, -0.35);
  if (s.upHint.lengthSq() < 1e-10 || Math.abs(s.upHint.dot(s.upperDir)) / s.upHint.length() > 0.99) {
    return s.upHint.copy(s.poleDir).multiplyScalar(-1);
  }
  return s.upHint.normalize();
}

function resolveForearmUpHint(wristWorldQuat, s) {
  // Align forearm dorsal +Y with wrist dorsal +Y to avoid cuff twist discontinuity.
  if (wristWorldQuat) {
    s.wristUp.set(0, 1, 0).applyQuaternion(wristWorldQuat);
    const lenSq = s.wristUp.lengthSq();
    if (lenSq >= 1e-10) {
      s.wristUp.multiplyScalar(1 / Math.sqrt(lenSq));
      if (Math.abs(s.wristUp.dot(s.forearmDir)) < 0.99) {
        return s.upHint.copy(s.wristUp);
      }
    }
  }
  return s.upHint.copy(s.poleDir).multiplyScalar(-1);
}

/**
 * Solve analytical 2-bone IK where each bone's local -Z axis aims along its child segment.
 */
export function solveTwoBoneArmIK(
  {
    shoulderPos,
    targetPos,
    upperLen = DEFAULT_UPPER_LEN,
    forearmLen = DEFAULT_FOREARM_LEN,
    poleHint = null,
    wristWorldQuat = null,
    parentWorldQuat = null,
    upperWorldMatInv = null,
    outShoulderQuat = null,
    outElbowQuat = null,
    outWristQuat = null,
  },
  MathApi,
  scratch = null,
) {
  void upperWorldMatInv; // Optional caller hint reserved; parentWorldQuat governs local frame conversion.
  const api = resolveMathApi(MathApi);
  const s = scratch || createIKScratch(api);

  const l1 = Math.max(1e-4, Number.isFinite(upperLen) ? upperLen : DEFAULT_UPPER_LEN);
  const l2 = Math.max(1e-4, Number.isFinite(forearmLen) ? forearmLen : DEFAULT_FOREARM_LEN);

  s.delta.subVectors(targetPos, shoulderPos);
  const rawDist = s.delta.length();
  if (rawDist < 1e-6) s.dir.set(0, 0, -1);
  else s.dir.copy(s.delta).multiplyScalar(1 / rawDist);

  const minDist = Math.abs(l1 - l2) + 0.015;
  const maxDist = Math.max(minDist + 1e-4, l1 + l2 - 0.002);
  const d = clamp(rawDist, minDist, maxDist);

  orthogonalizePole(poleHint, s.dir, s.poleDir, s.fallback);

  const cosAlpha = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  s.effTarget.copy(shoulderPos).addScaledVector(s.dir, d);
  s.elbowPos.copy(shoulderPos).addScaledVector(s.dir, l1 * cosAlpha).addScaledVector(s.poleDir, l1 * sinAlpha);
  s.upperDir.subVectors(s.elbowPos, shoulderPos).normalize();
  s.forearmDir.subVectors(s.effTarget, s.elbowPos).normalize();

  buildNegZFrame(s.upperDir, resolveUpperArmUpHint(s), s.shoulderWorldQ, s);
  buildNegZFrame(s.forearmDir, resolveForearmUpHint(wristWorldQuat, s), s.forearmWorldQ, s);

  if (parentWorldQuat) s.parentQ.copy(parentWorldQuat).normalize();
  else s.parentQ.set(0, 0, 0, 1);

  const shoulderOut = outShoulderQuat || new api.Quaternion();
  const elbowOut = outElbowQuat || new api.Quaternion();
  const wristOut = outWristQuat || new api.Quaternion();

  shoulderOut.copy(s.invQ.copy(s.parentQ).invert()).multiply(s.shoulderWorldQ).normalize();
  elbowOut.copy(s.invQ.copy(s.shoulderWorldQ).invert()).multiply(s.forearmWorldQ).normalize();
  if (wristWorldQuat) {
    s.targetWristQ.copy(wristWorldQuat).normalize();
    wristOut.copy(s.invQ.copy(s.forearmWorldQ).invert()).multiply(s.targetWristQ).normalize();
  } else {
    wristOut.set(0, 0, 0, 1);
  }

  return {
    shoulderQuat: shoulderOut,
    elbowQuat: elbowOut,
    wristQuat: wristOut,
    elbowPos: s.elbowPos.clone(),
    wristPos: s.effTarget.clone(),
  };
}

function samplePresetLeftTrack(poseSet, reloadProgress, isTactical, outPos, outQuat, tmpA, tmpB, tmpQ) {
  const rl = clamp(Number(reloadProgress) || 0, 0, 1);
  if (isTactical && rl > 0.72) {
    const kBack = smooth01((rl - 0.72) / 0.26);
    tmpA.set(...poseSet.mag.p);
    tmpB.set(...poseSet.grip.p);
    outPos.lerpVectors(tmpA, tmpB, kBack);
    outQuat.set(...poseSet.mag.q);
    tmpQ.set(...poseSet.grip.q);
    outQuat.slerp(tmpQ, kBack);
    return;
  }

  let idx = 0;
  while (idx < LEFT_RELOAD_TRACK.length - 2 && rl > LEFT_RELOAD_TRACK[idx + 1][0]) {
    idx++;
  }
  const [t0, keyA] = LEFT_RELOAD_TRACK[idx];
  const [t1, keyB] = LEFT_RELOAD_TRACK[idx + 1];
  const k = smooth01((rl - t0) / (t1 - t0 || 1));
  const pA = poseSet[keyA];
  const pB = poseSet[keyB];
  tmpA.set(...pA.p);
  tmpB.set(...pB.p);
  outPos.lerpVectors(tmpA, tmpB, k);
  outQuat.set(...pA.q);
  tmpQ.set(...pB.q);
  outQuat.slerp(tmpQ, k);
}

function captureSkeletonBones(root) {
  const byName = new Map();
  const fingerBones = [];
  const skinnedMeshes = [];

  root.traverse((obj) => {
    if (!obj) return;
    if (obj.isSkinnedMesh || obj.type === "SkinnedMesh") {
      obj.frustumCulled = false;
      skinnedMeshes.push(obj);
    }
    if (!obj.name) return;
    byName.set(obj.name, obj);
    const match = FINGER_BONE_RE.exec(obj.name);
    if (match) {
      fingerBones.push({
        node: obj,
        name: obj.name,
        side: match[1],
        finger: match[2],
        segment: Number(match[3]),
        restQ: obj.quaternion.clone(),
        restPos: obj.position.clone(),
      });
    }
  });

  const core = {};
  for (const boneName of CORE_BONE_NAMES) {
    const node = byName.get(boneName);
    if (!node) return null;
    core[boneName] = {
      node,
      restQ: node.quaternion.clone(),
      restPos: node.position.clone(),
    };
  }

  return { core, fingerBones, skinnedMeshes };
}

function measureArmLengths(core, vA, vB, vC) {
  core.L_arm_01.node.getWorldPosition(vA);
  core.L_elbow_02.node.getWorldPosition(vB);
  core.L_wrist_03.node.getWorldPosition(vC);
  const leftUpper = vA.distanceTo(vB);
  const leftForearm = vB.distanceTo(vC);

  core.R_arm_023.node.getWorldPosition(vA);
  core.R_elbow_024.node.getWorldPosition(vB);
  core.R_wrist_025.node.getWorldPosition(vC);
  const rightUpper = vA.distanceTo(vB);
  const rightForearm = vB.distanceTo(vC);

  return {
    leftUpper: leftUpper > 1e-4 ? leftUpper : DEFAULT_UPPER_LEN,
    leftForearm: leftForearm > 1e-4 ? leftForearm : DEFAULT_FOREARM_LEN,
    rightUpper: rightUpper > 1e-4 ? rightUpper : DEFAULT_UPPER_LEN,
    rightForearm: rightForearm > 1e-4 ? rightForearm : DEFAULT_FOREARM_LEN,
  };
}

function updateTopMatrixWorld(root) {
  let top = root;
  while (top.parent) top = top.parent;
  if (typeof top.updateMatrixWorld === "function") {
    top.updateMatrixWorld(true);
  }
}

/**
 * Create a runtime skinned-arm & finger controller for the converted fps_arms.glb scene.
 */
export function createSkinnedArmsController(root, MathApi) {
  const api = resolveMathApi(MathApi);
  if (!root || typeof root.traverse !== "function" || typeof root.updateMatrixWorld !== "function") {
    return { ready: false, update() {}, getBoneSummary: () => null };
  }

  const captured = captureSkeletonBones(root);
  if (!captured) {
    return { ready: false, update() {}, getBoneSummary: () => null };
  }

  updateTopMatrixWorld(root);
  const { Vector3, Quaternion, Matrix4, Euler } = api;
  const ikScratch = createIKScratch(api);
  const vA = new Vector3();
  const vB = new Vector3();
  const vC = new Vector3();
  const boneLengths = measureArmLengths(captured.core, vA, vB, vC);

  const gunToWorldMat = new Matrix4();
  const gunToWorldQuat = new Quaternion();
  const invParentMat = new Matrix4();
  const parentWorldQuat = new Quaternion();
  const shGunPos = new Vector3();
  const shWorldPos = new Vector3();
  const wrGunPos = new Vector3();
  const wrWorldPos = new Vector3();
  const wrGunQuat = new Quaternion();
  const wrWorldQuat = new Quaternion();
  const poleWorld = new Vector3();
  const tmpVecA = new Vector3();
  const tmpVecB = new Vector3();
  const tmpQuat = new Quaternion();
  const fingerEuler = new Euler(0, 0, 0, "XYZ");
  const fingerDeltaQ = new Quaternion();

  function solveArmSide(armEntry, elbowEntry, wristEntry, shArr, poleArr, targetGunPos, targetGunQuat, upperLen, forearmLen) {
    const shBone = armEntry.node;
    const shParent = shBone.parent;

    shGunPos.set(shArr[0], shArr[1], shArr[2]);
    shWorldPos.copy(shGunPos).applyMatrix4(gunToWorldMat);

    if (shParent) {
      invParentMat.copy(shParent.matrixWorld).invert();
      shBone.position.copy(shWorldPos).applyMatrix4(invParentMat);
      shParent.getWorldQuaternion(parentWorldQuat);
    } else {
      shBone.position.copy(shWorldPos);
      parentWorldQuat.set(0, 0, 0, 1);
    }

    wrWorldPos.copy(targetGunPos).applyMatrix4(gunToWorldMat);
    wrWorldQuat.copy(gunToWorldQuat).multiply(targetGunQuat).normalize();
    poleWorld.set(poleArr[0], poleArr[1], poleArr[2]).applyQuaternion(gunToWorldQuat);

    shBone.matrixAutoUpdate = true;
    elbowEntry.node.matrixAutoUpdate = true;
    wristEntry.node.matrixAutoUpdate = true;

    solveTwoBoneArmIK(
      {
        shoulderPos: shWorldPos,
        targetPos: wrWorldPos,
        upperLen,
        forearmLen,
        poleHint: poleWorld,
        wristWorldQuat: wrWorldQuat,
        parentWorldQuat,
        upperWorldMatInv: null,
        outShoulderQuat: shBone.quaternion,
        outElbowQuat: elbowEntry.node.quaternion,
        outWristQuat: wristEntry.node.quaternion,
      },
      api,
      ikScratch,
    );
  }

  function applyFingerPosing(poseSet, triggerPull) {
    const curls = poseSet.fingerCurls;
    const pull = clamp(Number(triggerPull) || 0, 0, 1);
    const pullAngles = curls.triggerPullMax || [0.34, 0.42, 0.28];

    for (const entry of captured.fingerBones) {
      entry.node.position.copy(entry.restPos);
      entry.node.quaternion.copy(entry.restQ);
      if (entry.segment > 3) continue;

      let curl = 0;
      if (entry.side === "R" && entry.finger === "point") {
        const baseCurl = entry.segment === 1 ? (curls.R_pointBase || 0) : 0;
        const segPull = pullAngles[entry.segment - 1] || 0;
        curl = baseCurl - pull * segPull;
      } else {
        const key = `${entry.side}_${entry.finger}`;
        const fingerCurl = curls[key] || 0;
        const segWeight = entry.segment === 1 ? 0.55 : entry.segment === 2 ? 0.85 : 0.6;
        curl = fingerCurl * segWeight;
      }

      if (Math.abs(curl) > 1e-6) {
        fingerDeltaQ.setFromEuler(fingerEuler.set(curl, 0, 0));
        entry.node.quaternion.multiply(fingerDeltaQ);
      }
    }
  }

  function update(params = {}) {
    const {
      weaponId = "m416",
      leftWristPos = null,
      leftWristQuat = null,
      rightWristPos = null,
      rightWristQuat = null,
      triggerPull = 0,
      reloadProgress = 0,
      isTactical = false,
      isSprinting = false,
      ads = 0,
      hideArms = false,
    } = params;

    void isSprinting;
    void ads;

    root.visible = !hideArms;
    if (hideArms) return;

    updateTopMatrixWorld(root);

    if (root.parent) {
      gunToWorldMat.copy(root.parent.matrixWorld);
      root.parent.getWorldQuaternion(gunToWorldQuat);
    } else {
      gunToWorldMat.identity();
      gunToWorldQuat.set(0, 0, 0, 1);
    }

    const poseSet = SKINNED_ARM_POSES[weaponId] || SKINNED_ARM_POSES.m416;

    if (leftWristPos && leftWristQuat) {
      wrGunPos.copy(leftWristPos);
      wrGunQuat.copy(leftWristQuat);
    } else {
      samplePresetLeftTrack(poseSet, reloadProgress, Boolean(isTactical), wrGunPos, wrGunQuat, tmpVecA, tmpVecB, tmpQuat);
    }
    solveArmSide(
      captured.core.L_arm_01,
      captured.core.L_elbow_02,
      captured.core.L_wrist_03,
      poseSet.leftShoulder,
      poseSet.leftPole,
      wrGunPos,
      wrGunQuat,
      boneLengths.leftUpper,
      boneLengths.leftForearm,
    );

    if (rightWristPos && rightWristQuat) {
      wrGunPos.copy(rightWristPos);
      wrGunQuat.copy(rightWristQuat);
    } else {
      wrGunPos.set(...poseSet.rightGrip.p);
      wrGunQuat.set(...poseSet.rightGrip.q);
    }
    solveArmSide(
      captured.core.R_arm_023,
      captured.core.R_elbow_024,
      captured.core.R_wrist_025,
      poseSet.rightShoulder,
      poseSet.rightPole,
      wrGunPos,
      wrGunQuat,
      boneLengths.rightUpper,
      boneLengths.rightForearm,
    );

    applyFingerPosing(poseSet, triggerPull);
    root.updateMatrixWorld(true);
  }

  return {
    ready: true,
    update,
    getBoneSummary() {
      return {
        coreBones: [...CORE_BONE_NAMES],
        fingerBoneCount: captured.fingerBones.length,
        totalCapturedBones: CORE_BONE_NAMES.length + captured.fingerBones.length,
        upperLen: boneLengths.leftUpper,
        forearmLen: boneLengths.leftForearm,
        skinnedMeshCount: captured.skinnedMeshes.length,
      };
    },
  };
}
