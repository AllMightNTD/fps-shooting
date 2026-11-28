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

export function findSoldierClip(animations, clipKey) {
  if (!Array.isArray(animations) || !animations.length || !clipKey) return null;
  const key = String(clipKey).toLowerCase();
  const exact = animations.find((clip) => clip && typeof clip.name === "string" && clip.name.toLowerCase() === key);
  if (exact) return exact;
  return (
    animations.find((clip) => {
      if (!clip || typeof clip.name !== "string") return false;
      const low = clip.name.toLowerCase();
      if (key === "prone" && (low.includes("move") || low.includes("crawl") || low.includes("forward"))) {
        return false;
      }
      return low.includes(key);
    }) || null
  );
}

export function selectSoldierAnimState({ alive = true, mv = 0, flags = 0, FLAG = { CROUCH: 1, AIR: 8, PRONE: 64 } } = {}) {
  if (!alive) return "dead";
  const airBit = FLAG && typeof FLAG.AIR === "number" ? FLAG.AIR : 8;
  const proneBit = FLAG && typeof FLAG.PRONE === "number" ? FLAG.PRONE : 64;
  const crouchBit = FLAG && typeof FLAG.CROUCH === "number" ? FLAG.CROUCH : 1;
  if (flags & airBit) return "jump";
  if (flags & proneBit) return mv > 0.08 ? "prone_move" : "prone";
  if (flags & crouchBit) return "crouch";
  if (mv > 0.08) return "run";
  return "idle";
}
