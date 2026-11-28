/**
 * AAA unit & integration tests (Happy & Unhappy paths) for:
 * - public/js/skinned_clone.js (independent Skeleton cloning, Mixamo/AccuRIG bone resolution, 4-state selector)
 * - public/js/remote_players.js (SkinnedMesh AnimationMixer crossfade, bone-attached hitboxes, legacy fallback)
 * - model/assets/fsb_ready_for_rig.glb (preprocessed FSB operator geometry, scale, 1024px textures, no Draco)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SOLDIER_BONE_ALIASES,
  cloneSkinnedHierarchy,
  findSoldierClip,
  hasSkinnedMesh,
  resolveRigBone,
  selectSoldierAnimState,
} from "../../public/js/skinned_clone.js";
import { createRemotePlayersManager } from "../../public/js/remote_players.js";
import { computeRecoilModifiers } from "../../public/js/recoil.js";
import { FLAG, TEAM_META, computeWeaponSpread, getMoveSpeedMultiplier } from "../weapons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// Lightweight Three.js mock sufficient to exercise cloneSkinnedHierarchy & createRemotePlayersManager
function createMockThree() {
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
    setScalar(s) {
      return this.set(s, s, s);
    }
    copy(v) {
      return this.set(v.x, v.y, v.z);
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
  }

  class Matrix4 {
    constructor(tag = "I") {
      this.tag = tag;
    }
    clone() {
      return new Matrix4(this.tag);
    }
  }

  class Object3D {
    constructor(name = "") {
      this.name = name;
      this.children = [];
      this.parent = null;
      this.position = new Vector3();
      this.rotation = new Vector3();
      this.scale = new Vector3(1, 1, 1);
      this.visible = true;
      this.userData = {};
      this.layers = { set() {} };
    }
    add(...objs) {
      for (const o of objs) {
        o.parent = this;
        this.children.push(o);
      }
      return this;
    }
    remove(o) {
      const i = this.children.indexOf(o);
      if (i !== -1) this.children.splice(i, 1);
      o.parent = null;
    }
    traverse(fn) {
      fn(this);
      for (const c of this.children) c.traverse(fn);
    }
    getObjectByName(name) {
      if (this.name === name) return this;
      for (const c of this.children) {
        const hit = c.getObjectByName(name);
        if (hit) return hit;
      }
      return null;
    }
    getWorldPosition(target) {
      return target.copy(this.position);
    }
    worldToLocal(v) {
      return v;
    }
    clone(recursive = true) {
      const copy = new this.constructor();
      copy.name = this.name;
      copy.position.copy(this.position);
      copy.rotation.copy(this.rotation);
      copy.scale.copy(this.scale);
      copy.isMesh = this.isMesh;
      copy.isSkinnedMesh = this.isSkinnedMesh;
      copy.isBone = this.isBone;
      copy.material = this.material;
      copy.skeleton = this.skeleton;
      copy.bindMatrix = this.bindMatrix ? this.bindMatrix.clone() : undefined;
      if (recursive) {
        for (const c of this.children) copy.add(c.clone(true));
      }
      return copy;
    }
  }

  class Group extends Object3D {}
  class Bone extends Object3D {
    constructor(name = "") {
      super(name);
      this.isBone = true;
    }
  }
  class Mesh extends Object3D {
    constructor(geo, mat) {
      super("");
      this.isMesh = true;
      this.geometry = geo;
      this.material = mat;
    }
  }
  class SkinnedMesh extends Mesh {
    constructor(geo, mat) {
      super(geo, mat);
      this.isSkinnedMesh = true;
      this.bindMatrix = new Matrix4("bind");
      this.skeleton = null;
    }
    bind(skeleton, bindMatrix) {
      this.skeleton = skeleton;
      this.bindMatrix = bindMatrix;
    }
  }
  class Skeleton {
    constructor(bones, boneInverses) {
      this.bones = bones;
      this.boneInverses = boneInverses;
    }
  }
  class Action {
    constructor(clip) {
      this.clip = clip;
      this.loop = null;
      this.clampWhenFinished = false;
      this.playing = false;
      this.timeScale = 1;
      this.weight = 1;
      this.crossFadedTo = [];
    }
    setLoop(mode) {
      this.loop = mode;
      return this;
    }
    reset() {
      return this;
    }
    setEffectiveWeight(w) {
      this.weight = w;
      return this;
    }
    setEffectiveTimeScale(s) {
      this.timeScale = s;
      return this;
    }
    play() {
      this.playing = true;
      return this;
    }
    crossFadeTo(other, dur) {
      this.crossFadedTo.push({ to: other.clip.name, dur });
    }
  }
  class AnimationMixer {
    constructor(root) {
      this.root = root;
      this.updatedDt = 0;
      this.actions = new Map();
    }
    clipAction(clip) {
      if (!this.actions.has(clip.name)) this.actions.set(clip.name, new Action(clip));
      return this.actions.get(clip.name);
    }
    update(dt) {
      this.updatedDt += dt;
    }
  }
  class Material {
    constructor(opts = {}) {
      Object.assign(this, opts);
    }
  }
  class Geometry {
    constructor(...args) {
      this.args = args;
    }
  }
  class Sprite extends Object3D {
    constructor(mat) {
      super("sprite");
      this.material = mat;
    }
  }

  return {
    Vector3,
    Matrix4,
    Object3D,
    Group,
    Bone,
    Mesh,
    SkinnedMesh,
    Skeleton,
    AnimationMixer,
    MeshBasicMaterial: Material,
    MeshStandardMaterial: Material,
    SpriteMaterial: Material,
    CanvasTexture: Material,
    Geometry,
    BoxGeometry: Geometry,
    SphereGeometry: Geometry,
    Sprite,
    LoopOnce: 2200,
    LoopRepeat: 2201,
    MathUtils: {
      lerp: (a, b, t) => a + (b - a) * t,
    },
  };
}

function buildMockSkinnedSoldierProto(THREE) {
  const root = new THREE.Group("soldier_root");
  const hips = new THREE.Bone("mixamorig:Hips");
  const spine = new THREE.Bone("mixamorig:Spine2");
  const head = new THREE.Bone("mixamorig:Head");
  const rightHand = new THREE.Bone("mixamorig:RightHand");
  const weaponMount = new THREE.Object3D("weapon_mount");
  const leftUpLeg = new THREE.Bone("mixamorig:LeftUpLeg");
  const rightUpLeg = new THREE.Bone("mixamorig:RightUpLeg");

  rightHand.add(weaponMount);
  spine.add(head, rightHand);
  hips.add(spine, leftUpLeg, rightUpLeg);

  const skinMesh = new THREE.SkinnedMesh(new THREE.Geometry(), { name: "FSB_Operator_PBR" });
  skinMesh.name = "FSB_Soldier";
  const bones = [hips, spine, head, rightHand, leftUpLeg, rightUpLeg];
  const inverses = bones.map((_, idx) => new THREE.Matrix4(`inv_${idx}`));
  skinMesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4("bind"));

  const teamPatch = new THREE.Mesh(new THREE.Geometry(), { name: "TeamColor" });
  teamPatch.name = "head_team_iff";
  head.add(teamPatch);

  root.add(hips, skinMesh);
  return root;
}

test("selectSoldierAnimState enforces FPS priority dead > jump > prone_move/prone > crouch > run > idle", () => {
  // Arrange & Act & Assert
  assert.equal(selectSoldierAnimState({ alive: false, mv: 1, flags: FLAG.AIR | FLAG.PRONE, FLAG }), "dead");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 1.2, flags: FLAG.AIR | FLAG.PRONE | FLAG.CROUCH, FLAG }), "jump");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 0.5, flags: FLAG.PRONE, FLAG }), "prone_move");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 0.02, flags: FLAG.PRONE, FLAG }), "prone");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 0.9, flags: FLAG.CROUCH, FLAG }), "crouch");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 0.45, flags: 0, FLAG }), "run");
  assert.equal(selectSoldierAnimState({ alive: true, mv: 0.02, flags: 0, FLAG }), "idle");
  // Unhappy path: omitted parameters default cleanly to idle
  assert.equal(selectSoldierAnimState(), "idle");
});

test("FLAG.PRONE lowers move speed, weapon spread, and M416 recoil cleanly", () => {
  // Arrange & Act & Assert
  assert.equal(getMoveSpeedMultiplier(FLAG.PRONE), 0.3);
  assert.ok(computeWeaponSpread("m416", FLAG.PRONE) < computeWeaponSpread("m416", FLAG.CROUCH));
  const proneMod = computeRecoilModifiers({ prone: true, ads: false, grounded: true });
  const crouchMod = computeRecoilModifiers({ crouched: true, ads: false, grounded: true });
  assert.equal(proneMod.vertical, 0.65);
  assert.ok(proneMod.vertical < crouchMod.vertical);
});

test("findSoldierClip matches exact, case-insensitive, and Mixamo-style names without confusing prone vs prone_move", () => {
  // Arrange
  const clips = [
    { name: "Rifle_Idle" },
    { name: "run" },
    { name: "Crouch Idle" },
    { name: "Jump_Air" },
    { name: "prone_move" },
    { name: "prone" },
  ];

  // Act & Assert
  assert.equal(findSoldierClip(clips, "run").name, "run");
  assert.equal(findSoldierClip(clips, "idle").name, "Rifle_Idle");
  assert.equal(findSoldierClip(clips, "crouch").name, "Crouch Idle");
  assert.equal(findSoldierClip(clips, "jump").name, "Jump_Air");
  assert.equal(findSoldierClip(clips, "prone").name, "prone");
  assert.equal(findSoldierClip(clips, "prone_move").name, "prone_move");
  // Unhappy path: when only prone_move exists, searching 'prone' must NOT mismatch 'prone_move'
  assert.equal(findSoldierClip([{ name: "prone_move" }], "prone"), null);
  assert.equal(findSoldierClip(null, "idle"), null);
});

test("cloneSkinnedHierarchy binds completely independent Skeleton & Bone arrays per clone", () => {
  // Arrange
  const THREE = createMockThree();
  const proto = buildMockSkinnedSoldierProto(THREE);

  // Act
  const cloneA = cloneSkinnedHierarchy(proto, THREE);
  const cloneB = cloneSkinnedHierarchy(proto, THREE);
  const meshA = cloneA.getObjectByName("FSB_Soldier");
  const meshB = cloneB.getObjectByName("FSB_Soldier");

  // Assert
  assert.equal(hasSkinnedMesh(proto), true);
  assert.notEqual(meshA.skeleton, meshB.skeleton);
  assert.notEqual(meshA.skeleton.bones[0], meshB.skeleton.bones[0]);
  assert.equal(meshA.skeleton.bones[2], resolveRigBone(cloneA, SOLDIER_BONE_ALIASES.head));
  assert.equal(meshB.skeleton.bones[2], resolveRigBone(cloneB, SOLDIER_BONE_ALIASES.head));

  // Mutating clone A head rotation must not leak to clone B or proto
  meshA.skeleton.bones[2].rotation.x = 0.77;
  assert.equal(meshB.skeleton.bones[2].rotation.x, 0);
  assert.equal(resolveRigBone(proto, SOLDIER_BONE_ALIASES.head).rotation.x, 0);

  // Unhappy path: null source returns null safely
  assert.equal(cloneSkinnedHierarchy(null, THREE), null);
  assert.equal(hasSkinnedMesh(null), false);
});

test("resolveRigBone handles Three.js r128 GLTFLoader sanitized bone names (colon stripped)", () => {
  const THREE = createMockThree();
  const root = new THREE.Group("soldier_root");
  const hips = new THREE.Bone("mixamorigHips");
  const spine = new THREE.Bone("mixamorigSpine2");
  const head = new THREE.Bone("mixamorigHead");
  const lThigh = new THREE.Bone("mixamorigLeftUpLeg");
  const rHand = new THREE.Bone("mixamorigRightHand");
  hips.add(spine, lThigh);
  spine.add(head, rHand);
  root.add(hips);

  assert.equal(resolveRigBone(root, SOLDIER_BONE_ALIASES.hips), hips);
  assert.equal(resolveRigBone(root, SOLDIER_BONE_ALIASES.spine), spine);
  assert.equal(resolveRigBone(root, SOLDIER_BONE_ALIASES.head), head);
  assert.equal(resolveRigBone(root, SOLDIER_BONE_ALIASES.leftUpLeg), lThigh);
  assert.equal(resolveRigBone(root, SOLDIER_BONE_ALIASES.rightHand), rHand);
});

test("remote_players manager drives AnimationMixer crossfades & bone hitboxes for SkinnedMesh soldiers", () => {
  // Arrange
  const THREE = createMockThree();
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 256,
        height: 64,
        getContext() {
          return {
            clearRect() {},
            fillRect() {},
            strokeRect() {},
            fillText() {},
          };
        },
      };
    },
  };

  try {
    const scene = new THREE.Group("scene");
    const soldierProto = buildMockSkinnedSoldierProto(THREE);
    const soldierAnimations = [
      { name: "idle" },
      { name: "run" },
      { name: "crouch" },
      { name: "jump" },
      { name: "prone" },
      { name: "prone_move" },
    ];
    const teamAccentMats = {
      A: { name: "TeamColor_A" },
      B: { name: "TeamColor_B" },
      FFA: { name: "TeamColor_FFA" },
    };

    const mgr = createRemotePlayersManager({
      THREE,
      scene,
      net: { clockOffsetMs: 0 },
      TEAM_META,
      FLAG,
      INTERP_DELAY_MS: 0,
      remoteMuzFlashGeo: new THREE.Geometry(),
      remoteMuzFlashMat: new THREE.MeshBasicMaterial(),
      getPrototypes: () => ({
        soldierProto,
        soldierAnimations,
        m416WorldProto: null,
        pistolWorldProto: null,
        awmWorldProto: null,
      }),
      getTeamAccentMats: () => teamAccentMats,
      getMatchMeta: () => ({ currentMode: "TDM", meTeam: "A" }),
    });

    const av = mgr.createRemoteAvatar({ id: "enemy-1", name: "FSB_Bot", team: "B", hp: 100, alive: true });

    // Assert bone hitboxes (head + body + limbs) & TeamColor override & weapon_mount
    assert.equal(av.rig.isSkinned, true);
    assert.ok(av.hitMeshes.some((m) => m.userData.hitTarget.part === "head"));
    assert.ok(av.hitMeshes.some((m) => m.userData.hitTarget.part === "body"));
    assert.ok(av.hitMeshes.some((m) => m.userData.hitTarget.part === "limb"));
    assert.equal(av.rig.weaponMount.name, "weapon_mount");
    assert.equal(av.rig.root.getObjectByName("head_team_iff").material, teamAccentMats.B);

    // Act: transition idle -> run -> crouch -> jump via snapshots
    const t0 = Date.now();
    av.snapshots = [{ t: t0 - 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0.2, mv: 1.0, flags: 0, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "run");

    av.snapshots = [{ t: t0 - 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, mv: 0, flags: FLAG.CROUCH, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "crouch");
    // Dedicated crouch clip owns hip height -> root stays grounded at y=0 (no double sinking)
    assert.equal(av.rig.root.position.y, 0);

    av.snapshots = [{ t: t0 - 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, mv: 0, flags: FLAG.PRONE, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "prone");
    assert.equal(av.rig.root.position.y, 0);

    av.snapshots = [{ t: t0 - 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, mv: 0.55, flags: FLAG.PRONE, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "prone_move");

    av.snapshots = [{ t: t0 - 10, x: 0, y: 1.2, z: 0, yaw: 0, pitch: 0, mv: 0.8, flags: FLAG.AIR, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "jump");
    assert.equal(av.rig.actions.jump.loop, THREE.LoopOnce);
    assert.equal(av.rig.actions.jump.clampWhenFinished, true);
    const jumpFade = av.rig.actions.prone_move.crossFadedTo.at(-1);
    assert.equal(jumpFade.to, "jump");
    assert.equal(jumpFade.dur, 0.07);

    av.snapshots = [{ t: t0 - 10, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, mv: 0, flags: 0, hp: 100, alive: true }];
    mgr.updateRemotePlayers(0.016);
    assert.equal(av.rig.activeState, "idle");
    const landFade = av.rig.actions.jump.crossFadedTo.at(-1);
    assert.equal(landFade.to, "idle");
    assert.equal(landFade.dur, 0.07);
    assert.ok(av.rig.mixer.updatedDt > 0.08);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("Exported model/dist/soldier.glb contains 6-clip FSB/SWAT SkinnedMesh, weapon_mount, TeamColor, and no Draco", () => {
  // Arrange
  const glbPath = path.join(REPO_ROOT, "model", "dist", "soldier.glb");
  assert.ok(fs.existsSync(glbPath), "model/dist/soldier.glb must exist");

  // Act
  const buf = fs.readFileSync(glbPath);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const animNames = (gltf.animations || []).map((a) => a.name);
  const nodeNames = (gltf.nodes || []).map((n) => n.name);
  const matNames = (gltf.materials || []).map((m) => m.name);

  // Assert
  assert.equal((gltf.extensionsRequired || []).includes("KHR_draco_mesh_compression"), false);
  assert.equal((gltf.skins || []).length, 1);
  assert.ok(gltf.skins[0].joints.length >= 40, `Expected >=40 joints, got ${gltf.skins[0].joints.length}`);
  for (const clip of ["idle", "run", "crouch", "jump", "prone", "prone_move"]) {
    assert.ok(animNames.includes(clip), `Missing animation clip '${clip}' in soldier.glb`);
  }
  for (const anim of gltf.animations) {
    assert.ok(anim.channels.length > 0, `Animation '${anim.name}' must have non-empty channels`);
  }
  assert.ok(nodeNames.includes("weapon_mount"), "soldier.glb must include weapon_mount socket");
  assert.ok(matNames.includes("TeamColor"), "soldier.glb must include TeamColor material");
  assert.ok(matNames.includes("FSB_Operator_PBR"), "soldier.glb must include FSB_Operator_PBR material");
});

test("Preprocessed fsb_ready_for_rig.glb meets WebGL budget (<=20k tris, 1.76m, 1024px textures, no Draco)", () => {
  // Arrange
  const glbPath = path.join(REPO_ROOT, "model", "assets", "fsb_ready_for_rig.glb");
  if (!fs.existsSync(glbPath)) return; // Skip cleanly if asset hasn't been preprocessed on CI

  // Act
  const buf = fs.readFileSync(glbPath);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;

  let tris = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const idxAcc = gltf.accessors[prim.indices];
      tris += Math.floor(idxAcc.count / 3);
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      minY = Math.min(minY, posAcc.min[1]);
      maxY = Math.max(maxY, posAcc.max[1]);
      assert.ok(prim.attributes.TEXCOORD_0 !== undefined, "Primary UVMap must be preserved");
    }
  }

  // Assert geometry, scale, texture resolution and no Draco requirement
  assert.ok(tris > 5000 && tris <= 20000, `Expected 5k..20k tris, got ${tris}`);
  assert.ok(Math.abs(minY) < 0.02, `Feet should sit at Y=0, got ${minY}`);
  assert.ok(Math.abs(maxY - minY - 1.76) < 0.03, `Height should be ~1.76m, got ${maxY - minY}`);
  assert.equal((gltf.extensionsRequired || []).includes("KHR_draco_mesh_compression"), false);
  assert.ok(buf.length < 6 * 1024 * 1024, `Preprocessed GLB should be <6MB, got ${(buf.length / 1048576).toFixed(2)}MB`);

  for (const im of gltf.images || []) {
    const bv = gltf.bufferViews[im.bufferView];
    const off = binStart + (bv.byteOffset || 0);
    const w = buf.readUInt32BE(off + 16);
    const h = buf.readUInt32BE(off + 20);
    assert.ok(w <= 1024 && h <= 1024, `Texture must be resized <=1024px, got ${w}x${h}`);
  }
});
