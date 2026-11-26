/**
 * Skinned FPS Arms Rig Controller & Analytical 2-Bone IK Solver (pure ES Module, zero external deps).
 * - Converts weapon attachment sockets (socket_handguard, socket_grip, socket_mag, socket_charging/slide)
 *   into exact wrist transforms with palmOffset compensation (0mm palm-to-socket drift).
 * - Solves twist-stabilized 2-bone IK (shoulder -> elbow -> wrist) in viewmodel camera metric space
 *   with clavicle protraction so hands never slip off sockets and wrists never candy-wrapper twist.
 * - Drives all 30 finger joints including right-index trigger discipline (outside guard idle -> on trigger firing).
 */

const UPPER_ARM_LEN = 0.2587;
const FOREARM_LEN = 0.25432;
const MAX_COMFORT_REACH = 0.488; // Preserves ~18 deg minimum natural elbow bend

export const HAND_INTRINSIC_BASIS = Object.freeze({
  left: Object.freeze({
    distal: Object.freeze([-0.0289, 0.5375, -0.8428]),
    radial: Object.freeze([0.8447, 0.4639, 0.2669]),
    palmNormal: Object.freeze([0.5344, -0.7042, -0.4674]),
    palmOffset: Object.freeze([0.0067, 0.0225, -0.0604]),
  }),
  right: Object.freeze({
    distal: Object.freeze([0.0289, 0.5375, -0.8428]),
    radial: Object.freeze([-0.8447, 0.4639, 0.2669]),
    palmNormal: Object.freeze([-0.5344, -0.7042, -0.4674]),
    palmOffset: Object.freeze([-0.0067, 0.0225, -0.0604]),
  }),
});

// Relative finger Euler deltas [rx, ry, rz] on top of fps_arms.glb bind pose (rx < 0 = flexion inward).
const WEAPON_FINGER_PROFILES = Object.freeze({
  m416: Object.freeze({
    // Support hand cradles beneath handguard; thumb lies flat pointing forward (-Z) toward muzzle
    leftSupport: Object.freeze({
      thumb: [[-0.26, -0.34, 0.06], [-0.10, 0.0, 0.0], [0.04, 0.0, 0.0]],
      point: [[-0.44, 0.04, 0.0], [-0.54, 0.0, 0.0], [-0.36, 0.0, 0.0]],
      middle: [[-0.26, 0.0, 0.0], [-0.30, 0.0, 0.0], [-0.22, 0.0, 0.0]],
      ring: [[-0.24, 0.0, 0.0], [-0.26, 0.0, 0.0], [-0.20, 0.0, 0.0]],
      pink: [[-0.22, 0.0, 0.0], [-0.20, 0.0, 0.0], [-0.16, 0.0, 0.0]],
    }),
    leftMag: Object.freeze({
      thumb: [[-0.36, 0.14, -0.12], [-0.28, 0.0, 0.0], [-0.18, 0.0, 0.0]],
      point: [[-0.50, 0.0, 0.0], [-0.56, 0.0, 0.0], [-0.38, 0.0, 0.0]],
      middle: [[-0.34, 0.0, 0.0], [-0.36, 0.0, 0.0], [-0.26, 0.0, 0.0]],
      ring: [[-0.32, 0.0, 0.0], [-0.32, 0.0, 0.0], [-0.24, 0.0, 0.0]],
      pink: [[-0.28, 0.0, 0.0], [-0.24, 0.0, 0.0], [-0.20, 0.0, 0.0]],
    }),
    leftBolt: Object.freeze({
      thumb: [[-0.44, 0.18, -0.16], [-0.36, 0.0, 0.0], [-0.24, 0.0, 0.0]],
      point: [[-0.72, 0.0, 0.0], [-0.82, 0.0, 0.0], [-0.52, 0.0, 0.0]],
      middle: [[-0.54, 0.0, 0.0], [-0.58, 0.0, 0.0], [-0.38, 0.0, 0.0]],
      ring: [[-0.44, 0.0, 0.0], [-0.42, 0.0, 0.0], [-0.30, 0.0, 0.0]],
      pink: [[-0.36, 0.0, 0.0], [-0.32, 0.0, 0.0], [-0.24, 0.0, 0.0]],
    }),
    rightGrip: Object.freeze({
      thumb: [[-0.28, 0.34, 0.06], [-0.34, 0.0, 0.0], [-0.24, 0.0, 0.0]],
      indexIdle: [[0.06, -0.14, 0.0], [0.08, 0.0, 0.0], [0.06, 0.0, 0.0]],
      indexFire: [[-0.48, 0.24, 0.0], [-0.68, 0.0, 0.0], [-0.42, 0.0, 0.0]],
      middle: [[-0.46, 0.0, 0.0], [-0.58, 0.0, 0.0], [-0.40, 0.0, 0.0]],
      ring: [[-0.42, 0.0, 0.0], [-0.52, 0.0, 0.0], [-0.36, 0.0, 0.0]],
      pink: [[-0.38, 0.0, 0.0], [-0.46, 0.0, 0.0], [-0.34, 0.0, 0.0]],
    }),
  }),
  pistol: Object.freeze({
    leftSupport: Object.freeze({
      thumb: [[-0.14, -0.22, 0.06], [-0.08, 0.0, 0.0], [0.02, 0.0, 0.0]],
      point: [[-0.52, 0.0, 0.0], [-0.62, 0.0, 0.0], [-0.42, 0.0, 0.0]],
      middle: [[-0.38, 0.0, 0.0], [-0.44, 0.0, 0.0], [-0.32, 0.0, 0.0]],
      ring: [[-0.36, 0.0, 0.0], [-0.40, 0.0, 0.0], [-0.28, 0.0, 0.0]],
      pink: [[-0.32, 0.0, 0.0], [-0.34, 0.0, 0.0], [-0.24, 0.0, 0.0]],
    }),
    rightGrip: Object.freeze({
      thumb: [[-0.22, 0.28, 0.04], [-0.28, 0.0, 0.0], [-0.18, 0.0, 0.0]],
      indexIdle: [[0.06, -0.13, 0.0], [0.08, 0.0, 0.0], [0.06, 0.0, 0.0]],
      indexFire: [[-0.52, 0.24, 0.0], [-0.72, 0.0, 0.0], [-0.44, 0.0, 0.0]],
      middle: [[-0.50, 0.0, 0.0], [-0.62, 0.0, 0.0], [-0.42, 0.0, 0.0]],
      ring: [[-0.46, 0.0, 0.0], [-0.56, 0.0, 0.0], [-0.38, 0.0, 0.0]],
      pink: [[-0.42, 0.0, 0.0], [-0.48, 0.0, 0.0], [-0.36, 0.0, 0.0]],
    }),
  }),
  sniper: Object.freeze({
    leftSupport: Object.freeze({
      thumb: [[-0.24, -0.32, 0.06], [-0.10, 0.0, 0.0], [0.04, 0.0, 0.0]],
      point: [[-0.42, 0.04, 0.0], [-0.50, 0.0, 0.0], [-0.34, 0.0, 0.0]],
      middle: [[-0.28, 0.0, 0.0], [-0.32, 0.0, 0.0], [-0.22, 0.0, 0.0]],
      ring: [[-0.26, 0.0, 0.0], [-0.28, 0.0, 0.0], [-0.20, 0.0, 0.0]],
      pink: [[-0.22, 0.0, 0.0], [-0.22, 0.0, 0.0], [-0.18, 0.0, 0.0]],
    }),
    rightGrip: Object.freeze({
      thumb: [[-0.28, 0.34, 0.06], [-0.34, 0.0, 0.0], [-0.24, 0.0, 0.0]],
      indexIdle: [[0.06, -0.14, 0.0], [0.08, 0.0, 0.0], [0.06, 0.0, 0.0]],
      indexFire: [[-0.48, 0.24, 0.0], [-0.68, 0.0, 0.0], [-0.42, 0.0, 0.0]],
      middle: [[-0.46, 0.0, 0.0], [-0.58, 0.0, 0.0], [-0.40, 0.0, 0.0]],
      ring: [[-0.42, 0.0, 0.0], [-0.52, 0.0, 0.0], [-0.36, 0.0, 0.0]],
      pink: [[-0.38, 0.0, 0.0], [-0.46, 0.0, 0.0], [-0.34, 0.0, 0.0]],
    }),
    rightBolt: Object.freeze({
      thumb: [[-0.42, 0.20, -0.10], [-0.38, 0.0, 0.0], [-0.26, 0.0, 0.0]],
      indexIdle: [[-0.64, 0.08, 0.0], [-0.74, 0.0, 0.0], [-0.48, 0.0, 0.0]],
      indexFire: [[-0.64, 0.08, 0.0], [-0.74, 0.0, 0.0], [-0.48, 0.0, 0.0]],
      middle: [[-0.58, 0.0, 0.0], [-0.64, 0.0, 0.0], [-0.42, 0.0, 0.0]],
      ring: [[-0.48, 0.0, 0.0], [-0.48, 0.0, 0.0], [-0.34, 0.0, 0.0]],
      pink: [[-0.40, 0.0, 0.0], [-0.38, 0.0, 0.0], [-0.28, 0.0, 0.0]],
    }),
  }),
});

export function buildSocketPose(pos, distal, palmNormal, isRightHand, MathApi) {
  const { Vector3, Quaternion, Matrix4 } = MathApi;
  const zAxis = new Vector3(-distal[0], -distal[1], -distal[2]).normalize();
  const sign = isRightHand ? -1 : 1;
  const xAxis = new Vector3(palmNormal[0] * sign, palmNormal[1] * sign, palmNormal[2] * sign);
  xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis)).normalize();
  const yAxis = new Vector3().crossVectors(zAxis, xAxis).normalize();
  const m = new Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return {
    p: new Vector3(pos[0], pos[1], pos[2]),
    q: new Quaternion().setFromRotationMatrix(m),
  };
}

function buildHandBasisInvQuat(isRightHand, MathApi) {
  const info = isRightHand ? HAND_INTRINSIC_BASIS.right : HAND_INTRINSIC_BASIS.left;
  const pose = buildSocketPose([0, 0, 0], info.distal, info.palmNormal, isRightHand, MathApi);
  return pose.q.invert();
}

export function computeWristFromSocket(socketPos, socketQuat, isRightHand, outWristPos, outWristQuat, MathApi) {
  const { Vector3 } = MathApi;
  const info = isRightHand ? HAND_INTRINSIC_BASIS.right : HAND_INTRINSIC_BASIS.left;
  const basisInvQ = buildHandBasisInvQuat(isRightHand, MathApi);

  outWristQuat.multiplyQuaternions(socketQuat, basisInvQ).normalize();
  const worldPalmOffset = new Vector3(
    info.palmOffset[0],
    info.palmOffset[1],
    info.palmOffset[2],
  ).applyQuaternion(outWristQuat);
  outWristPos.copy(socketPos).sub(worldPalmOffset);
  return { wristPos: outWristPos, wristQuat: outWristQuat };
}

export function solveTwoBoneArmIK(params, MathApi) {
  const {
    shoulderPos,
    targetPos,
    upperLen = UPPER_ARM_LEN,
    forearmLen = FOREARM_LEN,
    poleHint,
    wristWorldQuat,
    restElbowLocalQuat,
    restWristLocalQuat,
    outShoulderWorldQuat,
    outElbowWorldQuat,
  } = params;
  const { Vector3, Quaternion } = MathApi;

  const dirTarget = new Vector3().subVectors(targetPos, shoulderPos);
  const rawDist = dirTarget.length();
  if (rawDist > 1e-6) {
    dirTarget.multiplyScalar(1 / rawDist);
  } else {
    dirTarget.set(0, 0, -1);
  }

  const minReach = Math.abs(upperLen - forearmLen) + 0.012;
  const maxReach = upperLen + forearmLen - 0.00005;
  const d = Math.max(minReach, Math.min(maxReach, rawDist));

  const cosAlpha = Math.max(
    -1,
    Math.min(1, (upperLen * upperLen + d * d - forearmLen * forearmLen) / (2 * upperLen * d)),
  );
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  const bendDir = new Vector3().copy(poleHint);
  bendDir.addScaledVector(dirTarget, -bendDir.dot(dirTarget));
  if (bendDir.lengthSq() < 1e-8) {
    bendDir.set(Math.abs(dirTarget.y) < 0.9 ? 0 : 1, Math.abs(dirTarget.y) < 0.9 ? -1 : 0, 0);
    bendDir.addScaledVector(dirTarget, -bendDir.dot(dirTarget));
  }
  bendDir.normalize();

  const elbowPos = new Vector3()
    .copy(shoulderPos)
    .addScaledVector(dirTarget, upperLen * cosAlpha)
    .addScaledVector(bendDir, upperLen * sinAlpha);
  const effWristPos = new Vector3().copy(shoulderPos).addScaledVector(dirTarget, d);

  const dirUpper = new Vector3().subVectors(elbowPos, shoulderPos).normalize();
  const dirForearm = new Vector3().subVectors(effWristPos, elbowPos).normalize();
  const negZ = new Vector3(0, 0, -1);

  // Twist-free forearm: shortest-arc swing from ideal untwisted wrist frame onto forearm direction
  const invRestWrist = restWristLocalQuat.clone().invert();
  const idealForearmQ = new Quaternion().multiplyQuaternions(wristWorldQuat, invRestWrist).normalize();
  const vForearmIdeal = negZ.clone().applyQuaternion(idealForearmQ).normalize();
  const swingForearm = new Quaternion().setFromUnitVectors(vForearmIdeal, dirForearm);
  outElbowWorldQuat.multiplyQuaternions(swingForearm, idealForearmQ).normalize();

  // Twist-free upper arm: shortest-arc swing from ideal untwisted elbow frame onto upper-arm direction
  const invRestElbow = restElbowLocalQuat.clone().invert();
  const idealUpperQ = new Quaternion().multiplyQuaternions(outElbowWorldQuat, invRestElbow).normalize();
  const vUpperIdeal = negZ.clone().applyQuaternion(idealUpperQ).normalize();
  const swingUpper = new Quaternion().setFromUnitVectors(vUpperIdeal, dirUpper);
  outShoulderWorldQuat.multiplyQuaternions(swingUpper, idealUpperQ).normalize();

  return { elbowPos, effWristPos };
}

export function viewmodelPointToWorld(vmPoint, vmFovDeg, worldFovDeg, worldCamPos, worldCamQuat, outWorldPos, MathApi) {
  const { Vector3 } = MathApi;
  const tanVm = Math.tan((vmFovDeg * Math.PI) / 360) || 1;
  const tanWorld = Math.tan((worldFovDeg * Math.PI) / 360) || 1;
  const xyScale = tanWorld / tanVm;

  const scaled = new Vector3(vmPoint.x * xyScale, vmPoint.y * xyScale, vmPoint.z).applyQuaternion(worldCamQuat);
  outWorldPos.copy(worldCamPos).add(scaled);
  return outWorldPos;
}

const FINGER_BONE_GROUPS = Object.freeze({
  left: Object.freeze({
    thumb: ["L_thumb1_04", "L_thumb2_05", "L_thumb3_06"],
    point: ["L_point1_08", "L_point2_09", "L_point3_010"],
    middle: ["L_middle1_012", "L_middle2_00", "L_middle3_013"],
    ring: ["L_ring1_015", "L_ring2_016", "L_ring3_017"],
    pink: ["L_pink1_019", "L_pink2_020", "L_pink3_021"],
  }),
  right: Object.freeze({
    thumb: ["R_thumb1_026", "R_thumb2_027", "R_thumb3_028"],
    point: ["R_point1_030", "R_point2_031", "R_point3_032"],
    middle: ["R_middle1_034", "R_middle2_035", "R_middle3_036"],
    ring: ["R_ring1_038", "R_ring2_039", "R_ring3_040"],
    pink: ["R_pink1_042", "R_pink2_043", "R_pink3_044"],
  }),
});

export function createSkinnedArmsController(root, MathApi) {
  if (!root || typeof root.getObjectByName !== "function") {
    return { ready: false, update() {}, getBoneSummary: () => null };
  }

  const { Vector3, Quaternion, Euler } = MathApi;
  const lArm = root.getObjectByName("L_arm_01");
  const lElbow = root.getObjectByName("L_elbow_02");
  const lWrist = root.getObjectByName("L_wrist_03");
  const rArm = root.getObjectByName("R_arm_023");
  const rElbow = root.getObjectByName("R_elbow_024");
  const rWrist = root.getObjectByName("R_wrist_025");

  if (!lArm || !lElbow || !lWrist || !rArm || !rElbow || !rWrist) {
    return { ready: false, update() {}, getBoneSummary: () => null };
  }

  root.traverse((obj) => {
    if (obj.isSkinnedMesh) {
      obj.frustumCulled = false;
    }
  });

  const restElbowLocalL = lElbow.quaternion.clone().normalize();
  const restWristLocalL = lWrist.quaternion.clone().normalize();
  const restElbowLocalR = rElbow.quaternion.clone().normalize();
  const restWristLocalR = rWrist.quaternion.clone().normalize();

  // Root transform of _rootJoint under arms_root (scale=0.01, rotY=PI => rotQ = [0, 1, 0, 0])
  const rootRotInv = new Quaternion(0, -1, 0, 0);
  const leftBasisInv = buildHandBasisInvQuat(false, MathApi);
  const rightBasisInv = buildHandBasisInvQuat(true, MathApi);

  const fingerBones = { left: {}, right: {} };
  for (const side of ["left", "right"]) {
    for (const [digit, names] of Object.entries(FINGER_BONE_GROUPS[side])) {
      fingerBones[side][digit] = names.map((n) => {
        const bone = root.getObjectByName(n);
        return bone ? { bone, restQ: bone.quaternion.clone().normalize() } : null;
      });
    }
  }

  // Reusable scratch math objects for zero per-frame GC allocation
  const _lWristPos = new Vector3();
  const _lWristQuat = new Quaternion();
  const _rWristPos = new Vector3();
  const _rWristQuat = new Quaternion();
  const _lPalmOff = new Vector3();
  const _rPalmOff = new Vector3();
  const _lShoulder = new Vector3();
  const _rShoulder = new Vector3();
  const _lPole = new Vector3(-0.36, -0.86, -0.06);
  const _rPole = new Vector3(0.38, -0.86, 0.08);
  const _lShoulderWorldQ = new Quaternion();
  const _lElbowWorldQ = new Quaternion();
  const _rShoulderWorldQ = new Quaternion();
  const _rElbowWorldQ = new Quaternion();
  const _qInv = new Quaternion();
  const _eu = new Euler(0, 0, 0, "XYZ");
  const _dq = new Quaternion();
  const _dqB = new Quaternion();
  const _protractDir = new Vector3();

  function applyClavicleProtraction(shoulderPos, wristPos, maxReach) {
    _protractDir.subVectors(wristPos, shoulderPos);
    const dist = _protractDir.length();
    if (dist > maxReach && dist > 1e-6) {
      shoulderPos.addScaledVector(_protractDir, (dist - maxReach) / dist);
    }
  }

  function applyDigitDelta(chain, deltasA, deltasB = null, blend = 0) {
    if (!chain || !deltasA) return;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      if (!entry) continue;
      const a = deltasA[i] || [0, 0, 0];
      _dq.setFromEuler(_eu.set(a[0], a[1], a[2]));
      if (deltasB && blend > 0) {
        const b = deltasB[i] || [0, 0, 0];
        _dqB.setFromEuler(_eu.set(b[0], b[1], b[2]));
        _dq.slerp(_dqB, blend);
      }
      entry.bone.quaternion.multiplyQuaternions(entry.restQ, _dq).normalize();
    }
  }

  function solveFastWrist(socketPos, socketQuat, isRight, basisInv, outPos, outQuat, scratchOff) {
    const info = isRight ? HAND_INTRINSIC_BASIS.right : HAND_INTRINSIC_BASIS.left;
    outQuat.multiplyQuaternions(socketQuat, basisInv).normalize();
    scratchOff.set(info.palmOffset[0], info.palmOffset[1], info.palmOffset[2]).applyQuaternion(outQuat);
    outPos.copy(socketPos).sub(scratchOff);
  }

  function update(state = {}) {
    const {
      weaponId = "m416",
      leftSocketPos,
      leftSocketQuat,
      rightSocketPos,
      rightSocketQuat,
      triggerPull = 0,
      ads = 0,
      leftAction = "support", // "support" | "mag" | "bolt"
      rightAction = "grip", // "grip" | "bolt"
      hideArms = false,
    } = state;

    root.visible = !hideArms;
    if (hideArms || !leftSocketPos || !leftSocketQuat || !rightSocketPos || !rightSocketQuat) {
      return;
    }

    // 1. Convert weapon sockets into exact wrist targets (0mm palm drift)
    solveFastWrist(leftSocketPos, leftSocketQuat, false, leftBasisInv, _lWristPos, _lWristQuat, _lPalmOff);
    solveFastWrist(rightSocketPos, rightSocketQuat, true, rightBasisInv, _rWristPos, _rWristQuat, _rPalmOff);

    // 2. Torso-space shoulders behind/below vmCam -> short natural exposed forearms + clavicle protraction
    const adsK = Math.max(0, Math.min(1, ads));
    _lShoulder.set(-0.21 + 0.03 * adsK, -0.26 + 0.02 * adsK, -0.10 + 0.04 * adsK);
    _rShoulder.set(0.22 - 0.05 * adsK, -0.26 + 0.03 * adsK, -0.04 + 0.05 * adsK);
    applyClavicleProtraction(_lShoulder, _lWristPos, MAX_COMFORT_REACH);
    applyClavicleProtraction(_rShoulder, _rWristPos, MAX_COMFORT_REACH);

    // Convert vmCam metric shoulder positions into _rootJoint centimeter space (-100x, +100y, -100z)
    lArm.position.set(-_lShoulder.x * 100, _lShoulder.y * 100, -_lShoulder.z * 100);
    rArm.position.set(-_rShoulder.x * 100, _rShoulder.y * 100, -_rShoulder.z * 100);

    // 3. Solve twist-stabilized 2-bone analytical IK for both arms
    solveTwoBoneArmIK(
      {
        shoulderPos: _lShoulder,
        targetPos: _lWristPos,
        upperLen: UPPER_ARM_LEN,
        forearmLen: FOREARM_LEN,
        poleHint: _lPole,
        wristWorldQuat: _lWristQuat,
        restElbowLocalQuat: restElbowLocalL,
        restWristLocalQuat: restWristLocalL,
        outShoulderWorldQuat: _lShoulderWorldQ,
        outElbowWorldQuat: _lElbowWorldQ,
      },
      MathApi,
    );

    solveTwoBoneArmIK(
      {
        shoulderPos: _rShoulder,
        targetPos: _rWristPos,
        upperLen: UPPER_ARM_LEN,
        forearmLen: FOREARM_LEN,
        poleHint: _rPole,
        wristWorldQuat: _rWristQuat,
        restElbowLocalQuat: restElbowLocalR,
        restWristLocalQuat: restWristLocalR,
        outShoulderWorldQuat: _rShoulderWorldQ,
        outElbowWorldQuat: _rElbowWorldQ,
      },
      MathApi,
    );

    // Convert vmCam world quaternions into bone local quaternions
    lArm.quaternion.multiplyQuaternions(rootRotInv, _lShoulderWorldQ).normalize();
    _qInv.copy(_lShoulderWorldQ).invert();
    lElbow.quaternion.multiplyQuaternions(_qInv, _lElbowWorldQ).normalize();
    _qInv.copy(_lElbowWorldQ).invert();
    lWrist.quaternion.multiplyQuaternions(_qInv, _lWristQuat).normalize();

    rArm.quaternion.multiplyQuaternions(rootRotInv, _rShoulderWorldQ).normalize();
    _qInv.copy(_rShoulderWorldQ).invert();
    rElbow.quaternion.multiplyQuaternions(_qInv, _rElbowWorldQ).normalize();
    _qInv.copy(_rElbowWorldQ).invert();
    rWrist.quaternion.multiplyQuaternions(_qInv, _rWristQuat).normalize();

    // 4. Pose fingers & trigger discipline (idle outside trigger guard -> curled onto trigger when firing)
    const profile = WEAPON_FINGER_PROFILES[weaponId] || WEAPON_FINGER_PROFILES.m416;
    const leftProfile =
      leftAction === "bolt"
        ? WEAPON_FINGER_PROFILES.m416.leftBolt
        : leftAction === "mag"
          ? WEAPON_FINGER_PROFILES.m416.leftMag
          : profile.leftSupport;

    for (const digit of ["thumb", "point", "middle", "ring", "pink"]) {
      applyDigitDelta(fingerBones.left[digit], leftProfile[digit]);
    }

    const trigK = Math.max(0, Math.min(1, triggerPull));
    const rightProfile =
      rightAction === "bolt" && profile.rightBolt ? profile.rightBolt : profile.rightGrip;
    applyDigitDelta(fingerBones.right.thumb, rightProfile.thumb);
    applyDigitDelta(fingerBones.right.point, rightProfile.indexIdle, rightProfile.indexFire, trigK);
    applyDigitDelta(fingerBones.right.middle, rightProfile.middle);
    applyDigitDelta(fingerBones.right.ring, rightProfile.ring);
    applyDigitDelta(fingerBones.right.pink, rightProfile.pink);
  }

  return {
    ready: true,
    update,
    getBoneSummary: () => ({
      leftWrist: lWrist.name,
      rightWrist: rWrist.name,
      hasIndexChain: fingerBones.right.point.every(Boolean),
    }),
  };
}
