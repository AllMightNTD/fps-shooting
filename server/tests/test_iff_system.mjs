/**
 * AAA unit & integration tests (Happy & Unhappy paths) for Package A Competitive IFF:
 * - Relative Friend/Foe resolution across TDM (Team A & Team B) and FFA
 * - Colorblind presets (Red/Yellow/Purple) & 2B default Strong Valorant rim settings
 * - Map-calibrated linear/sRGB shader uniforms & single-program Geometric-Normal Fresnel injection
 * - PUBG Crosshair Proximity Fade + ADS Fade on Smart Friendly Markers
 * - 1A Relative Top Scoreboard view model
 * - 3B Clean Enemies (hidden TeamColor boxes, enemy rim material, hidden nameplate) vs Blue-LED Allies
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLY_IFF_META,
  DEFAULT_ENEMY_HIGHLIGHT_COLOR,
  DEFAULT_ENEMY_RIM_STRENGTH,
  SOLDIER_IFF_CACHE_KEY,
  applySoldierIffShader,
  computeFriendlyMarkerLayout,
  computeIffUniformValues,
  createSoldierIffUniforms,
  normalizeEnemyHighlightColor,
  normalizeEnemyRimStrength,
  resolvePlayerRelation,
  resolveTopScoreboardView,
  syncSoldierIffUniforms,
} from "../../public/js/iff_system.js";
import { createRemotePlayersManager } from "../../public/js/remote_players.js";
import { FLAG, TEAM_META } from "../weapons.js";

function createMockThreeForIff() {
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

  class Vector4 {
    constructor(x = 0, y = 0, z = 0, w = 0) {
      this.set(x, y, z, w);
    }
    set(x, y, z, w) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
      return this;
    }
  }

  class Color {
    constructor(r = 0, g = 0, b = 0) {
      this.r = r;
      this.g = g;
      this.b = b;
      this.hex = 0;
    }
    setRGB(r, g, b) {
      this.r = r;
      this.g = g;
      this.b = b;
      return this;
    }
    setHex(h) {
      this.hex = h;
      return this;
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
    }
    setLoop() {
      return this;
    }
    reset() {
      return this;
    }
    setEffectiveWeight() {
      return this;
    }
    setEffectiveTimeScale() {
      return this;
    }
    play() {
      return this;
    }
    crossFadeTo() {}
  }
  class AnimationMixer {
    constructor() {
      this.actions = new Map();
    }
    clipAction(clip) {
      if (!this.actions.has(clip.name)) this.actions.set(clip.name, new Action(clip));
      return this.actions.get(clip.name);
    }
    update() {}
  }
  class Material {
    constructor(opts = {}) {
      Object.assign(this, opts);
      this.color = new Color();
      if (typeof opts.color === "number") this.color.setHex(opts.color);
    }
  }
  class Geometry {}
  class Sprite extends Object3D {
    constructor(mat) {
      super("sprite");
      this.material = mat;
    }
  }

  return {
    Vector3,
    Vector4,
    Color,
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
    MathUtils: { lerp: (a, b, t) => a + (b - a) * t },
  };
}

function buildSwatProto(THREE) {
  const root = new THREE.Group("soldier_root");
  const hips = new THREE.Bone("mixamorig:Hips");
  const head = new THREE.Bone("mixamorig:Head");
  const lArm = new THREE.Bone("mixamorig:LeftArm");
  const rArm = new THREE.Bone("mixamorig:RightArm");
  const rHand = new THREE.Bone("mixamorig:RightHand");
  hips.add(head, lArm, rArm, rHand);

  const skin = new THREE.SkinnedMesh(new THREE.Geometry(), { name: "FSB_Operator_PBR" });
  skin.name = "FSB_Soldier";
  const bones = [hips, head, lArm, rArm, rHand];
  skin.bind(
    new THREE.Skeleton(bones, bones.map((_, i) => new THREE.Matrix4(`inv_${i}`))),
    new THREE.Matrix4("bind"),
  );

  const crown = new THREE.Mesh(new THREE.Geometry(), { name: "TeamColor" });
  crown.name = "head_team_iff";
  const armL = new THREE.Mesh(new THREE.Geometry(), { name: "TeamColor" });
  armL.name = "team_armband_L";
  const armR = new THREE.Mesh(new THREE.Geometry(), { name: "TeamColor" });
  armR.name = "team_armband_R";
  head.add(crown);
  lArm.add(armL);
  rArm.add(armR);

  root.add(hips, skin);
  return root;
}

test("resolvePlayerRelation computes relative Ally/Enemy across TDM Team A, TDM Team B, and FFA", () => {
  // Happy paths
  assert.equal(resolvePlayerRelation({ currentMode: "TDM", meTeam: "A", targetTeam: "A" }), "ally");
  assert.equal(resolvePlayerRelation({ currentMode: "TDM", meTeam: "A", targetTeam: "B" }), "enemy");
  assert.equal(resolvePlayerRelation({ currentMode: "TDM", meTeam: "B", targetTeam: "B" }), "ally");
  assert.equal(resolvePlayerRelation({ currentMode: "TDM", meTeam: "B", targetTeam: "A" }), "enemy");
  assert.equal(resolvePlayerRelation({ currentMode: "FFA", meTeam: "FFA", targetTeam: "FFA" }), "enemy");
  assert.equal(resolvePlayerRelation({ currentMode: "FFA", meTeam: "A", targetTeam: "A" }), "enemy");

  // Unhappy paths: missing/invalid teams safely default to enemy
  assert.equal(resolvePlayerRelation({ currentMode: "TDM", meTeam: "FFA", targetTeam: "FFA" }), "enemy");
  assert.equal(resolvePlayerRelation({}), "enemy");
});

test("IFF preference normalizers enforce 2B defaults and reject invalid/malicious strings", () => {
  assert.equal(DEFAULT_ENEMY_HIGHLIGHT_COLOR, "red");
  assert.equal(DEFAULT_ENEMY_RIM_STRENGTH, "strong");

  assert.equal(normalizeEnemyHighlightColor("yellow"), "yellow");
  assert.equal(normalizeEnemyHighlightColor("purple"), "purple");
  assert.equal(normalizeEnemyHighlightColor("<script>alert(1)</script>"), "red");
  assert.equal(normalizeEnemyHighlightColor(null), "red");

  assert.equal(normalizeEnemyRimStrength("strong"), "strong");
  assert.equal(normalizeEnemyRimStrength("crisp"), "crisp");
  assert.equal(normalizeEnemyRimStrength("off"), "off");
  assert.equal(normalizeEnemyRimStrength("neon_cheat"), "strong");
});

test("computeIffUniformValues converts military sRGB highlight to deep linear RGB and calibrates harbor", () => {
  const milRed = computeIffUniformValues({ enemyColor: "red", rimStrength: "strong", mapId: "military" });
  const harborRed = computeIffUniformValues({ enemyColor: "red", rimStrength: "strong", mapId: "harbor" });
  const offCfg = computeIffUniformValues({ enemyColor: "red", rimStrength: "off", mapId: "military" });

  // Linear conversion keeps red deeply saturated (green < 0.03 instead of washed salmon 0.14)
  assert.ok(milRed.rgb[0] > 0.99);
  assert.ok(milRed.rgb[1] < 0.03, `Expected deep linear red green channel <0.03, got ${milRed.rgb[1]}`);
  assert.ok(milRed.hdrBoost > harborRed.hdrBoost, "Daylight military should have higher HDR rim gain than dark harbor");
  assert.equal(offCfg.intensity, 0);
});

test("computeFriendlyMarkerLayout implements PUBG Crosshair Proximity Fade, occluded compact mode, and ADS fade", () => {
  // Direct LoS away from crosshair -> full crisp marker
  const direct = computeFriendlyMarkerLayout({ dist: 14, occluded: false, ndcDist: 0.5, ads: 0 });
  assert.equal(direct.visible, true);
  assert.equal(direct.compact, false);
  assert.ok(direct.opacity >= 0.9);

  // Behind wall -> compact chevron + moderate opacity (readable against walls)
  const behindWall = computeFriendlyMarkerLayout({ dist: 18, occluded: true, ndcDist: 0.45, ads: 0 });
  assert.equal(behindWall.compact, true);
  assert.ok(behindWall.opacity > 0.65 && behindWall.opacity < 0.85);

  // Behind wall directly behind player's crosshair -> Crosshair Proximity Fade drops opacity <= 0.16!
  const behindCrosshair = computeFriendlyMarkerLayout({ dist: 18, occluded: true, ndcDist: 0.03, ads: 0 });
  assert.ok(behindCrosshair.opacity <= 0.16, `Expected crosshair fade <=0.16, got ${behindCrosshair.opacity}`);

  // ADS scope further attenuates occluded ally markers
  const scoped = computeFriendlyMarkerLayout({ dist: 24, occluded: true, ndcDist: 0.45, ads: 1.0 });
  assert.ok(scoped.opacity < behindWall.opacity * 0.35);

  // Behind camera -> hidden
  const behindCam = computeFriendlyMarkerLayout({ dist: 10, occluded: false, ndcDist: 0.2, ads: 0, behindCamera: true });
  assert.equal(behindCam.visible, false);
});

test("resolveTopScoreboardView (1A) always places local player team on left in Blue and enemy team on right", () => {
  const asTeamA = resolveTopScoreboardView({
    currentMode: "TDM",
    meTeam: "A",
    teamScores: { A: 12, B: 7 },
    enemyColor: "red",
  });
  assert.equal(asTeamA.leftScore, 12);
  assert.equal(asTeamA.rightScore, 7);
  assert.equal(asTeamA.leftColor, ALLY_IFF_META.hex);
  assert.equal(asTeamA.rightColor, "#FF3535");
  assert.ok(asTeamA.leftLabel.includes("ĐỘI BẠN"));

  // Playing as Team B: Team B score MUST move to the LEFT in Blue, Team A on RIGHT in selected enemy color!
  const asTeamB = resolveTopScoreboardView({
    currentMode: "TDM",
    meTeam: "B",
    teamScores: { A: 12, B: 7 },
    enemyColor: "yellow",
  });
  assert.equal(asTeamB.leftScore, 7);
  assert.equal(asTeamB.rightScore, 12);
  assert.equal(asTeamB.leftColor, ALLY_IFF_META.hex);
  assert.equal(asTeamB.rightColor, "#FFE135");
  assert.ok(asTeamB.leftLabel.includes("●"));
  assert.ok(asTeamB.rightLabel.includes("▲"));

  // FFA mode displays leader vs kill limit
  const ffa = resolveTopScoreboardView({
    currentMode: "FFA",
    meTeam: "FFA",
    topKills: 9,
    topName: "Ghost",
    killLimit: 20,
    clockText: "08:15",
  });
  assert.equal(ffa.leftScore, 9);
  assert.equal(ffa.rightScore, 20);
  assert.ok(ffa.metaText.includes("Ghost"));
});

test("applySoldierIffShader injects Geometric-Normal Fresnel and shares 1 cache key for Ally & Enemy", () => {
  const THREE = createMockThreeForIff();
  const allyUniforms = createSoldierIffUniforms(THREE, { rimStrength: "off" });
  const enemyUniforms = createSoldierIffUniforms(THREE, { enemyColor: "red", rimStrength: "strong" });
  const allyMat = new THREE.MeshStandardMaterial({ name: "FSB_Ally" });
  const enemyMat = new THREE.MeshStandardMaterial({ name: "FSB_Enemy" });

  applySoldierIffShader(allyMat, allyUniforms);
  applySoldierIffShader(enemyMat, enemyUniforms);

  assert.equal(allyMat.customProgramCacheKey(), SOLDIER_IFF_CACHE_KEY);
  assert.equal(enemyMat.customProgramCacheKey(), SOLDIER_IFF_CACHE_KEY);

  const mockShader = {
    uniforms: {},
    fragmentShader: "#include <common>\n#include <normal_fragment_begin>\n#include <normal_fragment_maps>\n#include <tonemapping_fragment>",
  };
  enemyMat.onBeforeCompile(mockShader);

  assert.equal(mockShader.uniforms.uIffColor, enemyUniforms.uIffColor);
  assert.ok(mockShader.fragmentShader.includes("vec3 iffGeomNormal = normal;"));
  assert.ok(
    mockShader.fragmentShader.indexOf("vec3 iffGeomNormal = normal;") <
      mockShader.fragmentShader.indexOf("#include <normal_fragment_maps>"),
    "Geometric normal MUST be captured BEFORE normalMap perturbation to preserve interior PBR sharpness",
  );
  assert.ok(mockShader.fragmentShader.includes("smoothstep(iffEdgeLo, iffEdgeHi, 1.0 - iffNdotV)"));

  // In-place uniform sync changes enemy color to yellow with zero shader recompile
  syncSoldierIffUniforms(enemyUniforms, { enemyColor: "yellow", rimStrength: "crisp", mapId: "harbor" });
  assert.ok(enemyUniforms.uIffColor.value.g > 0.7);
  assert.equal(enemyUniforms.uIffIntensity.value, 0.74);
});

test("remote_players manager enforces 3B (blue LED only on Allies, clean rimmed Enemies) & live team-switch sync", () => {
  const THREE = createMockThreeForIff();
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 256,
        height: 80,
        getContext() {
          return {
            clearRect() {},
            fillRect() {},
            strokeRect() {},
            fillText() {},
            strokeText() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            closePath() {},
            fill() {},
            stroke() {},
          };
        },
      };
    },
  };

  try {
    let currentMode = "TDM";
    let meTeam = "A";
    const scene = new THREE.Group("scene");
    const soldierProto = buildSwatProto(THREE);
    const bodyMats = {
      ally: { name: "FSB_Operator_PBR" },
      enemy: { name: "FSB_Operator_PBR_Enemy" },
    };
    const teamAccentMats = {
      A: { name: "TeamColor_A" },
      B: { name: "TeamColor_B" },
      FFA: { name: "TeamColor_FFA" },
      ally: { name: "TeamColor_ally" },
      enemy: { name: "TeamColor_enemy" },
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
        soldierAnimations: [{ name: "idle" }],
        m416WorldProto: null,
        pistolWorldProto: null,
        awmWorldProto: null,
      }),
      getTeamAccentMats: () => teamAccentMats,
      getSoldierBodyMats: () => bodyMats,
      getMatchMeta: () => ({ currentMode, meTeam }),
    });

    const allyAv = mgr.createRemoteAvatar({ id: "p-ally", name: "Alpha", team: "A", hp: 100, alive: true });
    const enemyAv = mgr.createRemoteAvatar({ id: "p-enemy", name: "Bravo", team: "B", hp: 100, alive: true });

    // Assert TDM (meTeam = A): Ally gets pure PBR + visible Blue LED + visible marker; Enemy gets Rim PBR + HIDDEN LED (3B) + hidden marker
    assert.equal(allyAv.relation, "ally");
    assert.equal(allyAv.rig.root.getObjectByName("FSB_Soldier").material, bodyMats.ally);
    assert.equal(allyAv.rig.root.getObjectByName("head_team_iff").visible, true);
    assert.equal(allyAv.rig.root.getObjectByName("head_team_iff").material, teamAccentMats.ally);
    assert.equal(allyAv.nameplate.visible, true);

    assert.equal(enemyAv.relation, "enemy");
    assert.equal(enemyAv.rig.root.getObjectByName("FSB_Soldier").material, bodyMats.enemy);
    assert.equal(enemyAv.rig.root.getObjectByName("head_team_iff").visible, false);
    assert.equal(enemyAv.rig.root.getObjectByName("team_armband_L").visible, false);
    assert.equal(enemyAv.rig.root.getObjectByName("team_armband_R").visible, false);
    assert.equal(enemyAv.nameplate.visible, false);

    // Act: local player switches to Team B -> syncAllRelations flips materials/LEDs WITHOUT recreating skeletons!
    const prevSkelA = allyAv.rig.root.getObjectByName("FSB_Soldier").skeleton;
    meTeam = "B";
    mgr.syncAllRelations();

    assert.equal(allyAv.relation, "enemy");
    assert.equal(allyAv.rig.root.getObjectByName("FSB_Soldier").skeleton, prevSkelA);
    assert.equal(allyAv.rig.root.getObjectByName("FSB_Soldier").material, bodyMats.enemy);
    assert.equal(allyAv.rig.root.getObjectByName("head_team_iff").visible, false);
    assert.equal(allyAv.nameplate.visible, false);

    assert.equal(enemyAv.relation, "ally");
    assert.equal(enemyAv.rig.root.getObjectByName("FSB_Soldier").material, bodyMats.ally);
    assert.equal(enemyAv.rig.root.getObjectByName("head_team_iff").visible, true);
    assert.equal(enemyAv.rig.root.getObjectByName("head_team_iff").material, teamAccentMats.ally);

    // Act: FFA mode -> everyone becomes clean rimmed enemy with no LED boxes and no markers
    currentMode = "FFA";
    mgr.syncAllRelations();
    assert.equal(allyAv.relation, "enemy");
    assert.equal(enemyAv.relation, "enemy");
    assert.equal(enemyAv.rig.root.getObjectByName("head_team_iff").visible, false);
    assert.equal(enemyAv.nameplate.visible, false);
  } finally {
    globalThis.document = prevDoc;
  }
});
