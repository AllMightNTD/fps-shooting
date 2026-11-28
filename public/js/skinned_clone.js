/**
 * Pure Three.js r128 helpers for cloning SkinnedMesh avatars with independent
 * Skeletons, mapping Mixamo/AccuRIG bone names, and selecting FPS animation states.
 */

export const SOLDIER_BONE_ALIASES = Object.freeze({
  hips: Object.freeze(["mixamorig:Hips", "Hips", "hips", "pelvis", "Pelvis", "CC_Base_Hip"]),
  spine: Object.freeze(["mixamorig:Spine2", "Spine2", "mixamorig:Spine1", "Spine1", "mixamorig:Spine", "Spine", "chest"]),
  head: Object.freeze(["mixamorig:Head", "Head", "head", "CC_Base_Head", "head_group"]),
  rightHand: Object.freeze(["weapon_mount", "mixamorig:RightHand", "RightHand", "hand_r", "Hand_R", "CC_Base_R_Hand"]),
  leftHand: Object.freeze(["mixamorig:LeftHand", "LeftHand", "hand_l", "Hand_L", "CC_Base_L_Hand"]),
  leftArm: Object.freeze(["mixamorig:LeftArm", "LeftArm", "upperarm_l", "CC_Base_L_Upperarm"]),
  leftForeArm: Object.freeze(["mixamorig:LeftForeArm", "LeftForeArm", "lowerarm_l", "CC_Base_L_Forearm"]),
  rightArm: Object.freeze(["mixamorig:RightArm", "RightArm", "upperarm_r", "CC_Base_R_Upperarm"]),
  rightForeArm: Object.freeze(["mixamorig:RightForeArm", "RightForeArm", "lowerarm_r", "CC_Base_R_Forearm"]),
  leftUpLeg: Object.freeze(["mixamorig:LeftUpLeg", "LeftUpLeg", "thigh_l", "CC_Base_L_Thigh"]),
  leftLeg: Object.freeze(["mixamorig:LeftLeg", "LeftLeg", "calf_l", "CC_Base_L_Calf"]),
  rightUpLeg: Object.freeze(["mixamorig:RightUpLeg", "RightUpLeg", "thigh_r", "CC_Base_R_Thigh"]),
  rightLeg: Object.freeze(["mixamorig:RightLeg", "RightLeg", "calf_r", "CC_Base_R_Calf"]),
});

export function hasSkinnedMesh(root) {
  if (!root || typeof root.traverse !== "function") return false;
  let found = false;
  root.traverse((obj) => {
    if (!found && obj && obj.isSkinnedMesh) found = true;
  });
  return found;
}

function normalizeBoneShortName(name) {
  const low = String(name || "").toLowerCase();
  const colonIdx = low.lastIndexOf(":");
  if (colonIdx !== -1) return low.slice(colonIdx + 1);
  if (low.startsWith("mixamorig")) return low.slice("mixamorig".length).replace(/^[_:.-]+/, "");
  if (low.startsWith("cc_base_")) return low.slice("cc_base_".length);
  return low;
}

export function resolveRigBone(root, candidates) {
  if (!root || !Array.isArray(candidates) || candidates.length === 0) return null;
  const byExact = new Map();
  const byLower = new Map();
  const byShort = new Map();

  root.traverse((obj) => {
    if (!obj || !obj.name) return;
    if (!byExact.has(obj.name)) byExact.set(obj.name, obj);
    const low = obj.name.toLowerCase();
    if (!byLower.has(low)) byLower.set(low, obj);
    const short = normalizeBoneShortName(low);
    if (short && !byShort.has(short)) byShort.set(short, obj);
  });

  for (const cand of candidates) {
    if (byExact.has(cand)) return byExact.get(cand);
  }
  for (const cand of candidates) {
    const low = cand.toLowerCase();
    if (byLower.has(low)) return byLower.get(low);
  }
  for (const cand of candidates) {
    const short = normalizeBoneShortName(cand);
    if (short && byShort.has(short)) return byShort.get(short);
  }
  return null;
}

function mapParallelNodes(srcNode, dstNode, nodeMap, skinnedPairs) {
  nodeMap.set(srcNode, dstNode);
  if (srcNode.isSkinnedMesh && dstNode.isSkinnedMesh) {
    skinnedPairs.push([srcNode, dstNode]);
  }
  const srcChildren = srcNode.children || [];
  const dstChildren = dstNode.children || [];
  const count = Math.min(srcChildren.length, dstChildren.length);
  for (let i = 0; i < count; i++) {
    mapParallelNodes(srcChildren[i], dstChildren[i], nodeMap, skinnedPairs);
  }
}

export function cloneSkinnedHierarchy(source, THREE) {
  if (!source) return null;
  const clone = source.clone(true);
  if (!hasSkinnedMesh(source) || !THREE || typeof THREE.Skeleton !== "function") {
    return clone;
  }

  const nodeMap = new Map();
  const skinnedPairs = [];
  mapParallelNodes(source, clone, nodeMap, skinnedPairs);

  for (const [srcMesh, dstMesh] of skinnedPairs) {
    const srcSkeleton = srcMesh.skeleton;
    if (!srcSkeleton || !Array.isArray(srcSkeleton.bones)) continue;
    const clonedBones = srcSkeleton.bones.map((bone) => nodeMap.get(bone) || clone.getObjectByName(bone.name));
    if (clonedBones.some((b) => !b)) continue;
    const clonedInverses = (srcSkeleton.boneInverses || []).map((mat) => mat.clone());
    const clonedSkeleton = new THREE.Skeleton(clonedBones, clonedInverses);
    const bindMat = dstMesh.bindMatrix ? dstMesh.bindMatrix.clone() : srcMesh.bindMatrix.clone();
    dstMesh.bind(clonedSkeleton, bindMat);
    dstMesh.frustumCulled = false;
  }
  return clone;
}

export const CROUCH_DIR_KEYS = Object.freeze([
  "crouch_forward",
  "crouch_backward",
  "crouch_left",
  "crouch_right",
]);

export const SOLDIER_CLIP_KEYS = Object.freeze([
  "idle",
  "run",
  "crouch",
  "crouch_forward",
  "crouch_backward",
  "crouch_left",
  "crouch_right",
  "crouch_move",
  "jump",
  "prone",
  "prone_move",
]);

const CLIP_MATCH_EXCLUSIONS = Object.freeze({
  run: Object.freeze(["crouch"]),
  crouch: Object.freeze(["move", "walk", "run", "forward", "backward", "left", "right"]),
  prone: Object.freeze(["move", "crawl", "forward"]),
});

export function findSoldierClip(animations, clipKey) {
  if (!Array.isArray(animations) || !animations.length || !clipKey) return null;
  const key = String(clipKey).toLowerCase();
  const exact = animations.find((clip) => clip && typeof clip.name === "string" && clip.name.toLowerCase() === key);
  if (exact) return exact;

  const excl = CLIP_MATCH_EXCLUSIONS[key] || null;
  const partial =
    animations.find((clip) => {
      if (!clip || typeof clip.name !== "string") return false;
      const low = clip.name.toLowerCase();
      if (excl && excl.some((tok) => low.includes(tok))) return false;
      return low.includes(key);
    }) || null;
  if (partial) return partial;

  if (key === "crouch_move") {
    return findSoldierClip(animations, "crouch_forward");
  }
  return null;
}

/**
 * Resolve normalized 4-way directional crouch weights (sum === 1.0) from local horizontal velocity.
 * Suppresses minor-axis jitter below deadzoneRatio * dominantAxis while preserving smooth diagonals.
 */
export function computeCrouchDirectionalWeights(fwdVel = 0, rightVel = 0, deadzoneRatio = 0.14) {
  let f = Number.isFinite(fwdVel) ? fwdVel : 0;
  let r = Number.isFinite(rightVel) ? rightVel : 0;
  const absF = Math.abs(f);
  const absR = Math.abs(r);
  const dom = Math.max(absF, absR);
  if (dom < 1e-4) {
    return {
      crouch_forward: 1,
      crouch_backward: 0,
      crouch_left: 0,
      crouch_right: 0,
      dominant: "crouch_forward",
    };
  }
  const thresh = dom * Math.max(0, Math.min(0.45, deadzoneRatio));
  if (absF < thresh) f = 0;
  if (absR < thresh) r = 0;

  const wF = Math.max(0, f);
  const wB = Math.max(0, -f);
  const wR = Math.max(0, r);
  const wL = Math.max(0, -r);
  const sum = wF + wB + wL + wR;
  if (sum <= 1e-6) {
    return {
      crouch_forward: 1,
      crouch_backward: 0,
      crouch_left: 0,
      crouch_right: 0,
      dominant: "crouch_forward",
    };
  }
  const inv = 1 / sum;
  const nF = wF * inv;
  const nB = wB * inv;
  const nL = wL * inv;
  const nR = wR * inv;
  let dominant = "crouch_forward";
  let best = nF;
  if (nB > best) {
    best = nB;
    dominant = "crouch_backward";
  }
  if (nL > best) {
    best = nL;
    dominant = "crouch_left";
  }
  if (nR > best) {
    dominant = "crouch_right";
  }
  return {
    crouch_forward: nF,
    crouch_backward: nB,
    crouch_left: nL,
    crouch_right: nR,
    dominant,
  };
}

/**
 * Smoothly step every action weight toward targetWeights and enforce sum(weights) === 1.0
 * across all animation states (zero-GC in-place update).
 */
export function stepNormalizedActionWeights(currentWeights, targetWeights, actionKeys, dt = 0.016, blendDurSec = 0.11) {
  if (!currentWeights || !targetWeights || !Array.isArray(actionKeys) || !actionKeys.length) return 0;
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const tau = Math.max(0.012, (Number.isFinite(blendDurSec) ? blendDurSec : 0.11) * 0.35);
  const alpha = safeDt > 0 ? 1 - Math.exp(-safeDt / tau) : 1;

  let total = 0;
  for (let i = 0; i < actionKeys.length; i++) {
    const key = actionKeys[i];
    const cur = Number.isFinite(currentWeights[key]) ? currentWeights[key] : 0;
    const tgt = Number.isFinite(targetWeights[key]) ? Math.max(0, targetWeights[key]) : 0;
    let next = cur + (tgt - cur) * alpha;
    if (tgt === 0 && next < 0.004) next = 0;
    else if (next < 0) next = 0;
    currentWeights[key] = next;
    total += next;
  }

  if (total <= 1e-6) {
    let tgtSum = 0;
    for (let i = 0; i < actionKeys.length; i++) {
      const key = actionKeys[i];
      const tgt = Number.isFinite(targetWeights[key]) ? Math.max(0, targetWeights[key]) : 0;
      currentWeights[key] = tgt;
      tgtSum += tgt;
    }
    total = tgtSum;
    if (total <= 1e-6) {
      currentWeights[actionKeys[0]] = 1;
      return 1;
    }
  }

  const invTotal = 1 / total;
  let normSum = 0;
  for (let i = 0; i < actionKeys.length; i++) {
    const key = actionKeys[i];
    const v = (currentWeights[key] || 0) * invTotal;
    currentWeights[key] = v;
    normSum += v;
  }
  return normSum;
}

export function decodeMoveIntentFromFlags(flags = 0, FLAG = {}) {
  const fBit = typeof FLAG.MOVE_FWD === "number" ? FLAG.MOVE_FWD : 128;
  const bBit = typeof FLAG.MOVE_BACK === "number" ? FLAG.MOVE_BACK : 256;
  const lBit = typeof FLAG.MOVE_LEFT === "number" ? FLAG.MOVE_LEFT : 512;
  const rBit = typeof FLAG.MOVE_RIGHT === "number" ? FLAG.MOVE_RIGHT : 1024;
  const fwd = (flags & fBit ? 1 : 0) - (flags & bBit ? 1 : 0);
  const right = (flags & rBit ? 1 : 0) - (flags & lBit ? 1 : 0);
  return {
    hasIntent: Boolean(flags & (fBit | bBit | lBit | rBit)),
    fwd,
    right,
  };
}

export function selectSoldierAnimState({
  alive = true,
  mv = 0,
  flags = 0,
  FLAG = { CROUCH: 1, AIR: 8, PRONE: 64, MOVE_FWD: 128, MOVE_BACK: 256, MOVE_LEFT: 512, MOVE_RIGHT: 1024 },
  fwdVel = 0,
  rightVel = 0,
  hasDirectionalCrouch = false,
} = {}) {
  if (!alive) return "dead";
  const airBit = FLAG && typeof FLAG.AIR === "number" ? FLAG.AIR : 8;
  const proneBit = FLAG && typeof FLAG.PRONE === "number" ? FLAG.PRONE : 64;
  const crouchBit = FLAG && typeof FLAG.CROUCH === "number" ? FLAG.CROUCH : 1;
  if (flags & airBit) return "jump";
  const intent = decodeMoveIntentFromFlags(flags, FLAG);
  const isMoving = mv > 0.08 || (intent.hasIntent && (intent.fwd !== 0 || intent.right !== 0));
  if (flags & proneBit) return isMoving ? "prone_move" : "prone";
  if (flags & crouchBit) {
    if (isMoving) {
      if (hasDirectionalCrouch) {
        if (intent.hasIntent) {
          return computeCrouchDirectionalWeights(intent.fwd, intent.right).dominant;
        }
        return computeCrouchDirectionalWeights(fwdVel, rightVel).dominant;
      }
      return "crouch_move";
    }
    return "crouch";
  }
  if (isMoving) return "run";
  return "idle";
}
