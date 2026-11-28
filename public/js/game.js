/**
 * Three.js FPS Engine Orchestrator (Truy Kích LAN PvP + Offline Solo Drone):
 * Coordinates map building, audio, PBR assets, remote avatars, viewmodel kinematics,
 * HUD/overlays, combat ballistics, 60Hz fixed physics, and the main frame loop.
 */

import { MSG, sanitizeText, unpackSnapshot } from "/js/protocol.js";
import {
  BASE_MOVE_SPEED,
  FLAG,
  SLOT_TO_WEAPON_ID,
  TEAM_META,
  WEAPON_SLOTS,
  WEAPONS,
  computeWeaponDamage,
  computeWeaponSpread,
  createDefaultWeaponsState,
  getMoveSpeedMultiplier,
  getReloadDurationMs,
  resolveWeaponConfig,
} from "/js/weapons.js";
import { createBotMatchController } from "/js/bot_ai.js";
import { MILITARY_COLLIDERS } from "/js/military_map_data.js";
import { SPAWN_RULES, generateSpawnPoints, getSpawnRuleForMode } from "/js/spawn_rules.js";
import { createMilitaryMapLoader } from "/js/map_loader.js";
import {
  collectSceneTextures,
  compileScenePass,
  createLoadingTracker,
  createMapSwitchGuard,
  normalizeMapId,
  warmupTexturesChunked,
  yieldToUI,
} from "/js/loading_manager.js";
import {
  computeEffectivePixelRatio,
  detectHardwareTier,
  normalizeQualityChoice,
  probeHardwareInfo,
  resolveQualityPreset,
} from "/js/graphics_quality.js";
import { viewmodelPointToWorld } from "/js/arm_rig.js";
import {
  computeBulletWhizBy,
  createBallisticsVfxSystem,
  createMuzzleFlashRig,
  resolveSurfaceType,
  shouldSpawnTracer,
} from "/js/ballistics_vfx.js";
import {
  M416_RECOIL_PROFILE,
  computeRecoilModifiers,
  createRecoilController,
} from "/js/recoil.js";
import {
  AWM_SCOPE_PROFILE,
  STANCE,
  createScopeController,
  stepBallisticStep,
} from "/js/scope.js";
import {
  createCanvasTexture,
  createHarborMapBuilder,
  sampleHarborPuddle,
} from "/js/harbor_map.js";
import { createAudioEngine } from "/js/audio_engine.js";
import { createAssetLoader } from "/js/asset_loader.js";
import { createRemotePlayersManager } from "/js/remote_players.js";
import { createViewmodelAnimator } from "/js/viewmodel_anim.js";
import { createSceneManager } from "/js/scene_manager.js";
import { createHudUi } from "/js/hud_ui.js";
import { createCombatSystem } from "/js/combat.js";

const THREE = window.THREE;
const Vec = THREE.Vector3;
const VIEW_LAYER = 1;
const OPTIC_Y = 0.097;
const UP = new Vec(0, 1, 0);
const INTERP_DELAY_MS = 100;
const FIXED_DT = 1 / 60;
const JUMP_BUFFER_MS = 100;
const COYOTE_TIME_MS = 80;
const JUMP_COOLDOWN_MS = 300;
const EYE_STAND = 1.70;
const EYE_CROUCH = 1.12;
const EYE_PRONE = 0.42;
const RING_CIRCUMFERENCE = 106.81;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const VM_HIP_FOV = 62;
const VM_ADS_FOV = 50;
const MOON_EMPTY_SHADOW_Y = 500;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatClock(sec) {
  const s = Math.max(0, sec | 0);
  return `${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function createGameEngine({
  net,
  settings,
  input,
  onRequestExitToRoom,
  onRequestExitToLobby,
  onLoadingUpdate,
  onQualityStatusChange,
  onSoloDefeated,
  onBotMatchEnd,
}) {
  const $ = (id) => document.getElementById(id);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const lerp = THREE.MathUtils.lerp;

  // ---------- Renderer, Scene & Cameras ----------
  const R = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const hwInfo = probeHardwareInfo(R.getContext());
  const detectedQualityTier = detectHardwareTier(hwInfo);
  const initialQuality = resolveQualityPreset(
    settings && settings.get ? settings.get().graphicsQuality : "auto",
    detectedQualityTier,
  );
  R.setPixelRatio(computeEffectivePixelRatio(initialQuality.preset, devicePixelRatio));
  R.setSize(innerWidth, innerHeight);
  R.shadowMap.enabled = true;
  R.shadowMap.type = THREE.PCFShadowMap;
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = 1.08;
  R.autoClear = false;
  R.shadowMap.autoUpdate = false;
  document.body.prepend(R.domElement);

  const S = new THREE.Scene();
  S.background = new THREE.Color(0x050a11);
  S.fog = new THREE.FogExp2(0x050a11, 0.025);

  let vpAspect = Math.max(0.4, innerWidth / Math.max(1, innerHeight));
  const cam = new THREE.PerspectiveCamera(75, vpAspect, 0.03, initialQuality.preset.cameraFar);
  cam.rotation.order = "YXZ";
  S.add(cam);

  const vmCam = new THREE.PerspectiveCamera(VM_HIP_FOV, vpAspect, 0.01, 6.0);
  vmCam.rotation.order = "YXZ";
  vmCam.layers.set(VIEW_LAYER);
  S.add(vmCam);

  // ---------- Lights & Harbor Builder ----------
  const harborGroup = new THREE.Group();
  harborGroup.name = "HarborMapGroup";
  harborGroup.visible = false;
  S.add(harborGroup);

  const hemi = new THREE.HemisphereLight(0x28456b, 0x030509, 0.28);
  hemi.visible = false;
  S.add(hemi);

  const moon = new THREE.DirectionalLight(0x5b82b8, 0.38);
  moon.position.set(-30, 50, 20);
  moon.castShadow = true;
  moon.shadow.mapSize.set(initialQuality.preset.shadowMapSize || 16, initialQuality.preset.shadowMapSize || 16);
  Object.assign(moon.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 0.5, far: 140 });
  moon.visible = false;
  S.add(moon, moon.target);

  function applyMoonShadowPreset(preset, forceWarmupFrustum = false) {
    moon.castShadow = true;
    const useActiveFrustum = Boolean(forceWarmupFrustum || preset.shadowsEnabled);
    const nextSize = forceWarmupFrustum
      ? (preset.shadowsEnabled ? preset.shadowMapSize || 1024 : 16)
      : (preset.shadowsEnabled ? preset.shadowMapSize || 1024 : preset.shadowMapSize || 16);
    if (moon.shadow.mapSize.x !== nextSize) {
      moon.shadow.mapSize.set(nextSize, nextSize);
      if (moon.shadow.map) {
        moon.shadow.map.dispose();
        moon.shadow.map = null;
      }
    }
    if (useActiveFrustum) {
      moon.target.position.set(0, 0, 0);
      moon.target.updateMatrixWorld();
      moon.position.set(-30, 50, 20);
      if (moon.shadow.camera.right !== 50 || moon.shadow.camera.far !== 140) {
        Object.assign(moon.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 0.5, far: 140 });
        moon.shadow.camera.updateProjectionMatrix();
      }
    } else {
      moon.target.position.set(0, MOON_EMPTY_SHADOW_Y, 0);
      moon.target.updateMatrixWorld();
      moon.position.set(-30, MOON_EMPTY_SHADOW_Y + 50, 20);
      if (moon.shadow.camera.right !== 0.05 || moon.shadow.camera.far !== 1.0) {
        Object.assign(moon.shadow.camera, { left: -0.05, right: 0.05, top: 0.05, bottom: -0.05, near: 0.1, far: 1.0 });
        moon.shadow.camera.updateProjectionMatrix();
      }
    }
  }
  applyMoonShadowPreset(initialQuality.preset);

  const warmFill = new THREE.DirectionalLight(0xffb45c, 0.20);
  warmFill.position.set(12, 8, -6);
  warmFill.visible = false;
  S.add(warmFill);

  const maxAniso = Math.min(16, R.capabilities.getMaxAnisotropy ? R.capabilities.getMaxAnisotropy() : 16);
  const tex = (w, h, fn, rep) => createCanvasTexture(THREE, w, h, fn, rep, maxAniso);

  let ground = null;
  const solid = [];
  const cols = [];
  const harborBuilder = createHarborMapBuilder({
    THREE,
    renderer: R,
    harborGroup,
    solid,
    cols,
    maxAniso,
    yieldToUI,
    rnd,
    onGroundReady: (g) => { ground = g; },
  });
  const buildHarborSceneAsync = (onProgress = null) => harborBuilder.buildHarborSceneAsync(onProgress);

  // ---------- Ballistics VFX, Muzzle Flash & Spatial Audio ----------
  const ballisticsVfx = createBallisticsVfxSystem({ THREE, scene: S });
  ballisticsVfx.applyQualityPreset(initialQuality.preset);

  const remoteMuzFlashGeo = (() => {
    const p1 = new THREE.PlaneGeometry(0.28, 0.28);
    const p2 = new THREE.PlaneGeometry(0.24, 0.34);
    p2.rotateY(Math.PI * 0.5);
    p2.translate(0, 0, -0.10);
    const pos = new Float32Array(24);
    const uv = new Float32Array(16);
    pos.set(p1.attributes.position.array, 0);
    pos.set(p2.attributes.position.array, 12);
    const uv1 = p1.attributes.uv.array;
    const uv2 = p2.attributes.uv.array;
    for (let i = 0; i < 4; i++) {
      uv[i * 2] = uv1[i * 2] * 0.5;
      uv[i * 2 + 1] = 0.5 + uv1[i * 2 + 1] * 0.5;
      uv[8 + i * 2] = uv2[i * 2] * 0.5;
      uv[8 + i * 2 + 1] = 0.5 + uv2[i * 2 + 1] * 0.5;
    }
    const idx = new Uint16Array([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
    p1.dispose();
    p2.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  })();
  const remoteMuzFlashMat = new THREE.MeshBasicMaterial({
    map: ballisticsVfx.muzzleAtlasTex,
    color: 0xffd27a,
    transparent: true,
    opacity: 0.96,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  // ---------- Viewmodel Rig, Lights & Laser ----------
  const gun = new THREE.Group();
  const muz = new THREE.Object3D();
  const laserOrigin = new THREE.Object3D();
  const flashL = new THREE.PointLight(0xffbe6a, 0, 6.5, 2);
  muz.position.set(0, 0.02, -0.615);
  laserOrigin.position.set(0.046, 0.025, -0.35);
  flashL.position.set(0, 0.02, -0.68);
  gun.add(muz, laserOrigin, flashL);

  const glowTex = tex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.2, "rgba(255,255,255,.8)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const laserBeam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new Vec(), new Vec(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  laserBeam.frustumCulled = false;
  S.add(laserBeam);
  const laserDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7dff8f, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
  laserDot.visible = false;
  S.add(laserDot);

  const muzzleFlashRig = createMuzzleFlashRig({
    THREE,
    muzzleAtlasTex: ballisticsVfx.muzzleAtlasTex,
    viewLayer: VIEW_LAYER,
  });
  muzzleFlashRig.mesh.position.set(0, 0.02, -0.615);
  gun.add(muzzleFlashRig.mesh);

  const vmKey = new THREE.PointLight(0xbcd0ea, 0.42, 2.4, 1.1);
  vmKey.position.set(-0.35, 0.55, 0.25);
  const vmFill = new THREE.PointLight(0xffb36a, 0.14, 2.0, 1.2);
  vmFill.position.set(0.45, -0.2, -0.1);
  const vmRim = new THREE.PointLight(0xffc27a, 0.26, 2.2, 1.3);
  vmRim.position.set(0.32, 0.38, -0.65);
  vmCam.add(vmKey, vmFill, vmRim, gun);
  gun.traverse((o) => o.layers.set(VIEW_LAYER));
  S.traverse((o) => { if (o.isLight) o.layers.enableAll(); });
  vmKey.layers.set(VIEW_LAYER);
  vmFill.layers.set(VIEW_LAYER);
  vmRim.layers.set(VIEW_LAYER);
  flashL.visible = true;
  flashL.layers.enableAll();

  const _vmScratchPt = new Vec();
  function getViewmodelWorldPoint(node, outVec) {
    vmCam.updateMatrixWorld(true);
    node.getWorldPosition(_vmScratchPt);
    vmCam.worldToLocal(_vmScratchPt);
    return viewmodelPointToWorld(_vmScratchPt, vmCam.fov, cam.fov, cam.position, cam.quaternion, outVec, THREE);
  }

  // ---------- Core Runtime State ----------
  const P = new Vec();
  let engineMode = "idle"; // "idle" | "lan" | "solo" | "bots"
  let activeState = "menu";
  let currentMode = "TDM";
  let killLimit = 30;
  let timeLeftSec = 600;
  let teamScores = { A: 0, B: 0 };
  let lastPlayers = [];
  let meTeam = "A";
  let meAlive = true;
  let meInvuln = false;
  let awaitingInitialSpawnSnap = false;
  let hp = 100;
  let respawnMs = 0;
  let respawnTotalMs = SPAWN_RULES.TDM.respawnDelayMs;
  let deathInfo = null;
  let deathTimeSec = 0;
  let activeBotMatch = null;
  const botArenaCache = Object.create(null);

  let meProtState = {
    active: false,
    iFrames: false,
    spawnProtected: false,
    expiring: false,
    remainingMs: 0,
    totalMs: SPAWN_RULES.TDM.protectMs,
    progress: 0,
  };
  let lanProtStartedAt = 0;
  let lanProtIFramesUntil = 0;
  let lanProtUntil = 0;
  let lanProtTotalMs = SPAWN_RULES.TDM.protectMs;
  let prevProtActive = false;

  let isBootstrapped = false;
  let freezeVfxClock = false;
  let loopStarted = false;

  function buildBotArenaForMap(mapId) {
    const safeId = mapId === "harbor" ? "harbor" : "military";
    if (botArenaCache[safeId]) return botArenaCache[safeId];
    if (safeId === "military" && MILITARY_COLLIDERS) {
      botArenaCache[safeId] = MILITARY_COLLIDERS;
      return botArenaCache[safeId];
    }
    let s = 11042026;
    const msr = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const boxes = [];
    for (let gx = -3; gx <= 3; gx++) {
      for (let gz = -3; gz <= 3; gz++) {
        if ((gx === 0 && gz === 0) || msr() < 0.42) continue;
        const x = gx * 13 + (msr() - 0.5) * 3;
        const z = gz * 13 + (msr() - 0.5) * 3;
        const rot = msr() < 0.5;
        msr();
        const stacked = msr() < 0.3;
        const hx = rot ? 1.22 : 3.05;
        const hz = rot ? 3.05 : 1.22;
        boxes.push({ x0: x - hx, x1: x + hx, y0: 0, y1: stacked ? 5.2 : 2.6, z0: z - hz, z1: z + hz });
      }
    }
    for (const [x, z, w, d] of [[0, -52, 100, 1], [0, 52, 100, 1], [-52, 0, 1, 100], [52, 0, 1, 100]]) {
      boxes.push({ x0: x - w * 0.5, x1: x + w * 0.5, y0: 0, y1: 10, z0: z - d * 0.5, z1: z + d * 0.5 });
    }
    const arena = {
      mapId: "harbor",
      bounds: { minX: -48, maxX: 48, minZ: -48, maxZ: 48 },
      boxes,
      obbs: [],
      walkableSlabs: [],
      ladders: [],
      spawns: generateSpawnPoints(boxes),
    };
    botArenaCache[safeId] = arena;
    return arena;
  }

  let yaw = 0, pitch = 0, vy = 0, velX = 0, velZ = 0, eyeHeight = EYE_STAND;
  let crouched = false, prone = false, grounded = true, onLadder = false, isSprinting = false, sprintBrokenUntilShiftUp = false;
  let lastGroundedAt = 0, jumpBufferedUntil = 0, nextJumpAllowedAt = 0, physicsAccum = 0;
  let bob = 0, curFlags = 0, laserOn = false;
  let lastInputSentAt = 0, lastSentFlags = 0, nextHeartbeatAt = 0, lastStepIdx = 0, lastHudSyncMs = 0;

  function sendLanState(nowMs, mvRatio = Math.hypot(velX, velZ) > 0.25 ? 1 : 0) {
    lastInputSentAt = nowMs;
    lastSentFlags = curFlags;
    net.send(MSG.STATE, {
      pos: { x: +P.x.toFixed(3), y: +P.y.toFixed(3), z: +P.z.toFixed(3) },
      yaw: +yaw.toFixed(4),
      pitch: +pitch.toFixed(4),
      flags: curFlags,
      anim: { mv: mvRatio ? (isSprinting ? 1.4 : prone ? 0.55 : crouched ? 0.65 : 1) : 0, laser: laserOn },
    });
  }

  // Scratch vectors & raycasters for physics/laser zero-GC passes
  const laserRay = new THREE.Raycaster();
  const upRay = new THREE.Raycaster();
  const hudRay = new THREE.Raycaster();
  const _lp = new Vec();
  const _ls = new Vec();
  const _ld = new Vec();
  const _laserEnd = new Vec();
  const _upOrigin = new Vec();
  const _remoteScopePos = new Vec();

  // ---------- Composed Subsystems ----------
  let sceneMgr = null;
  let combat = null;

  const audioEngine = createAudioEngine({
    THREE,
    cam,
    yieldToUI,
    getActiveMapId: () => (sceneMgr ? sceneMgr.getActiveMapId() : "military"),
  });
  const { snd, weaponAudio, precomputeAudioBuffersAsync, initAudio } = audioEngine;

  const assetLoader = createAssetLoader({
    THREE,
    VIEW_LAYER,
    TEAM_META,
    SLOT_TO_WEAPON_ID,
    vmCam,
    gun,
    muz,
    laserOrigin,
    flashL,
    muzzleFlashRig,
    yieldToUI,
    getActiveEnvMap: () => (sceneMgr ? sceneMgr.getActiveEnvMap() : null),
    getActiveSlot: () => (combat ? combat.getActiveSlot() : 1),
    getInitialIffConfig: () => {
      const st = settings && settings.get ? settings.get() : {};
      return {
        enemyColor: st.enemyHighlightColor,
        rimStrength: st.enemyRimStrength,
        mapId: sceneMgr ? sceneMgr.getActiveMapId() : "military",
      };
    },
    getInitialAnisotropy: () => Math.min(8, initialQuality.preset.maxAnisotropy || maxAniso),
    onWeaponsUpgraded: () => remoteMgr.upgradeRemoteWeapons(),
    onSoldiersUpgraded: () => remoteMgr.upgradeRemoteSoldiers(),
    onGunAnimZero: () => vmAnim.gunAnim(0, 0),
  });

  const remoteMgr = createRemotePlayersManager({
    THREE,
    scene: S,
    net,
    TEAM_META,
    FLAG,
    INTERP_DELAY_MS,
    remoteMuzFlashGeo,
    remoteMuzFlashMat,
    getPrototypes: () => assetLoader.getPrototypes(),
    getTeamAccentMats: () => assetLoader.teamAccentMats,
    getSoldierBodyMats: () => assetLoader.soldierBodyMats,
    getIffState: () => {
      const st = settings && settings.get ? settings.get() : {};
      return {
        enemyColor: st.enemyHighlightColor || "red",
        rimStrength: st.enemyRimStrength || "strong",
      };
    },
    getMatchMeta: () => ({ currentMode, meTeam }),
    getCamera: () => cam,
    getActiveCollision: () => (sceneMgr ? sceneMgr.getActiveCollision() : null),
    getSolidMeshes: () => solid,
    getLocalAds: () => (vmAnim ? vmAnim.getAds() : 0),
  });

  const vmAnim = createViewmodelAnimator({
    THREE,
    $,
    cam,
    vmCam,
    gun,
    assetLoader,
    settings,
    input,
    snd,
    weaponAudio,
    computeWeaponSpread,
    FLAG,
    VM_HIP_FOV,
    VM_ADS_FOV,
    OPTIC_Y,
    RING_CIRCUMFERENCE,
    getStateRefs: () => ({
      activeWeapon: () => combat.activeWeapon(),
      weapons: combat.getWeapons(),
      isSprinting,
      engineMode,
      meAlive,
      curFlags,
      yaw,
      pitch,
      bob,
      recoil: combat.getRecoil(),
      gt: sceneMgr.getGt(),
      testAimHeld: combat.getTestAimHeld(),
      scopeOut: combat.getScopeOut(),
    }),
  });

  const militaryLoader = createMilitaryMapLoader({ renderer: R, THREE });
  sceneMgr = createSceneManager({
    THREE,
    $,
    R,
    S,
    cam,
    vmCam,
    harborGroup,
    hemi,
    moon,
    warmFill,
    applyMoonShadowPreset,
    vmKey,
    vmFill,
    vmRim,
    ballisticsVfx,
    muzzleFlashRig,
    glowTex,
    laserBeam,
    laserDot,
    gun,
    flashL,
    remoteMuzFlashGeo,
    remoteMuzFlashMat,
    assetLoader,
    remoteMgr,
    vmAnim,
    audioEngine,
    buildHarborSceneAsync,
    militaryLoader,
    detectHardwareTier,
    resolveQualityPreset,
    computeEffectivePixelRatio,
    normalizeQualityChoice,
    hwInfo,
    detectedQualityTier,
    initialQuality,
    normalizeMapId,
    collectSceneTextures,
    compileScenePass,
    createLoadingTracker,
    createMapSwitchGuard,
    warmupTexturesChunked,
    yieldToUI,
    TEAM_META,
    EYE_STAND,
    VIEW_LAYER,
    SLOT_TO_WEAPON_ID,
    settings,
    onLoadingUpdate,
    onQualityStatusChange,
    getDroneProtos: () => combat.getDroneProtos(),
    getGameState: () => ({
      engineMode,
      activeState,
      meAlive,
      hp,
      P,
      activeSlot: combat.getActiveSlot(),
    }),
  });

  const hudUi = createHudUi({
    $,
    el,
    formatClock,
    sanitizeText,
    TEAM_META,
    WEAPON_SLOTS,
    MSG,
    R,
    settings,
    input,
    net,
    ray: hudRay,
    cam,
    getActiveQualityLabel: () => sceneMgr.getActiveQuality().preset.label,
    getHudState: () => {
      const solo = combat.getSoloStats();
      return {
        activeWeapon: () => combat.activeWeapon(),
        activeSlot: combat.getActiveSlot(),
        localPlayerId: engineMode === "bots" ? "human-local" : net.playerId,
        hp,
        meInvuln,
        meProtState,
        deathInfo,
        respawnTotalMs,
        activeState,
        meAlive,
        isSprinting,
        isMoving: Math.hypot(velX, velZ) > 0.25,
        crouched,
        prone,
        grounded,
        ads: vmAnim.getAds(),
        engineMode,
        soloWave: solo.soloWave,
        soloScore: solo.soloScore,
        respawnMs,
        currentMode,
        timeLeftSec,
        killLimit,
        teamScores,
        lastPlayers,
        remotePlayers: remoteMgr.remotePlayers,
        meTeam,
        activeCollision: sceneMgr.getActiveCollision(),
        ground,
        solid,
        P,
        yaw,
      };
    },
    onStartSolo: () => startSolo(),
    onStopEngine: () => stopEngine(),
    onRequestExitToLobby,
    initAudio,
  });

  combat = createCombatSystem({
    THREE,
    DEG2RAD,
    WEAPONS,
    WEAPON_SLOTS,
    SLOT_TO_WEAPON_ID,
    FLAG,
    computeWeaponSpread,
    getReloadDurationMs,
    M416_RECOIL_PROFILE,
    computeRecoilModifiers,
    createRecoilController,
    AWM_SCOPE_PROFILE,
    STANCE,
    createScopeController,
    stepBallisticStep,
    shouldSpawnTracer,
    computeBulletWhizBy,
    resolveSurfaceType,
    S,
    cam,
    muz,
    flashL,
    laserRay,
    solid,
    ballisticsVfx,
    muzzleFlashRig,
    sampleHarborPuddle,
    getGround: () => ground,
    getViewmodelWorldPoint,
    sceneMgr,
    assetLoader,
    remoteMgr,
    vmAnim,
    audioEngine,
    hudUi,
    input,
    settings,
    net,
    MSG,
    INTERP_DELAY_MS,
    flushStateBeforeFire: () => {
      if (engineMode === "lan" && meAlive && activeState === "play") {
        sendLanState(performance.now());
      }
      if (engineMode === "lan" && meProtState.active) {
        lanProtUntil = 0;
        lanProtIFramesUntil = 0;
        meProtState = { active: false, iFrames: false, spawnProtected: false, expiring: false, remainingMs: 0, totalMs: lanProtTotalMs, progress: 0 };
        meInvuln = false;
        prevProtActive = false;
      }
    },
    onBotFire: (weaponId, originVec, dirVec) => {
      if (!activeBotMatch) return null;
      return activeBotMatch.handleHumanFire(
        weaponId,
        { x: originVec.x, y: originVec.y, z: originVec.z },
        { x: dirVec.x, y: dirVec.y, z: dirVec.z },
        performance.now(),
      );
    },
    onSoloDefeated,
    $,
    getPlayState: () => ({
      engineMode,
      activeState,
      meAlive,
      hp,
      isSprinting,
      crouched,
      prone,
      grounded,
      curFlags,
      P,
      yaw,
      pitch,
      setHp: (next) => { hp = next; },
    }),
    onSoloGameOver: () => {
      meAlive = false;
      activeState = "over";
      isSprinting = false;
      input.reset();
      if (document.pointerLockElement === R.domElement) document.exitPointerLock();
      $("hud").style.display = "none";
      $("sniperScope").style.display = "none";
      $("pauseOverlay").style.display = "none";
    },
    rnd,
    vpAspectGetter: () => vpAspect,
  });

  addEventListener("resize", () => {
    vpAspect = Math.max(0.4, innerWidth / Math.max(1, innerHeight));
    const aspect = innerWidth / Math.max(1, innerHeight);
    R.setPixelRatio(computeEffectivePixelRatio(sceneMgr.getActiveQuality().preset, devicePixelRatio));
    R.setSize(innerWidth, innerHeight);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    vmCam.aspect = aspect;
    vmCam.updateProjectionMatrix();
  });

  input.attach(R.domElement);

  function syncIffPreferences(st = null) {
    const cfg = st || (settings && settings.get ? settings.get() : {});
    assetLoader.applyIffSettings({
      enemyColor: cfg.enemyHighlightColor,
      rimStrength: cfg.enemyRimStrength,
      mapId: sceneMgr ? sceneMgr.getActiveMapId() : "military",
    });
    remoteMgr.syncAllRelations();
    if (hudUi && engineMode !== "idle") hudUi.hud();
  }
  syncIffPreferences();
  if (settings && typeof settings.onChange === "function") {
    settings.onChange((st) => syncIffPreferences(st));
  }

  // ---------- Networking Sync Hooks ----------
  const rosterNames = new Map();
  function syncRoomRoster(room) {
    if (!room || !Array.isArray(room.players)) return;
    rosterNames.clear();
    for (const rp of room.players) {
      if (rp && rp.id) rosterNames.set(rp.id, rp.name || rp.id);
    }
  }

  function applySnapshot(rawSnap) {
    const snap = unpackSnapshot(rawSnap, rosterNames);
    if (!snap || engineMode !== "lan") return;
    const prevMode = currentMode;
    const prevMeTeam = meTeam;
    if (snap.mode) currentMode = snap.mode;
    if (Number.isFinite(snap.killLimit)) killLimit = snap.killLimit;
    timeLeftSec = snap.timeLeftSec;
    teamScores = snap.teamScores || { A: 0, B: 0 };
    lastPlayers = snap.players || [];

    // Resolve local meTeam BEFORE spawning/updating remote avatars so first-frame IFF relation is exact
    const meEntry = lastPlayers.find((p) => p && p.id === net.playerId);
    if (meEntry && meEntry.team) {
      meTeam = meEntry.team || "FFA";
    }
    if (prevMode !== currentMode || prevMeTeam !== meTeam) {
      remoteMgr.syncAllRelations();
    }

    const seen = new Set();
    const weaponsMap = combat.getWeapons();
    for (const p of lastPlayers) {
      seen.add(p.id);
      if (p.id === net.playerId) {
        const wasAlive = meAlive;
        meTeam = p.team || "FFA";
        meAlive = p.alive;
        meInvuln = p.invulnerable;
        respawnMs = p.respawnMs;
        hp = p.hp;
        const shouldSnapToSpawn = p.alive && (awaitingInitialSpawnSnap || !wasAlive);
        if (p.alive) awaitingInitialSpawnSnap = false;
        if (shouldSnapToSpawn) {
          handleUnifiedRespawnEvent(
            {
              playerId: net.playerId,
              pos: { x: p.x, y: p.y, z: p.z },
              yaw: p.yaw,
            },
            net.playerId,
          );
        }
        syncLanProtectionState(performance.now(), p.invulnerable, p.iFrames, p.protectExpiring);
        const serverWid = p.weaponId || SLOT_TO_WEAPON_ID[combat.getActiveSlot()];
        if (weaponsMap[serverWid] && !p.reloading && Number.isFinite(p.ammo)) {
          weaponsMap[serverWid].mag = p.ammo;
          if (weaponsMap[serverWid].reloadEndsAt > performance.now() && p.ammo >= WEAPONS[serverWid].magSize) {
            weaponsMap[serverWid].reloadEndsAt = 0;
          }
        }
        continue;
      }

      let av = remoteMgr.remotePlayers.get(p.id);
      if (!av) av = remoteMgr.createRemoteAvatar(p);
      else if (av.team !== p.team) remoteMgr.swapAvatarRig(av, p.team);
      av.snapshots.push({
        t: snap.t,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        mv: p.mv || 0,
        flags: p.flags || 0,
        weaponId: p.weaponId || "m416",
        reloading: Boolean(p.reloading),
        hp: p.hp,
        alive: p.alive,
        invulnerable: p.invulnerable,
        iFrames: Boolean(p.iFrames),
        protectExpiring: Boolean(p.protectExpiring),
      });
      if (av.snapshots.length > 16) av.snapshots.shift();
    }

    for (const [id] of remoteMgr.remotePlayers.entries()) {
      if (!seen.has(id)) remoteMgr.removeRemotePlayer(id);
    }
    if (input.isDown("score")) hudUi.renderScoreboardTable();
    hudUi.hud();
  }

  function handleUnifiedHitEvent(ev, localId) {
    if (!ev) return;
    if (ev.part === "shield") {
      if (ev.targetId) remoteMgr.triggerShieldHitFlash(ev.targetId);
      if (ev.hitPoint && ev.targetId !== localId) {
        combat.spawnHitSparks(ev.hitPoint, 0x5ce1ff);
      }
      if (ev.shooterId === localId) {
        hudUi.setHitmarker("shield");
        snd.shieldBlock(ev.hitPoint || null);
        hudUi.showKillAlert("MIỄN NHIỄM HỒI SINH", "#5ce1ff");
      } else if (ev.targetId === localId) {
        snd.shieldBlock();
      }
      return;
    }

    if (ev.shooterId === localId) {
      if (ev.part === "head") { hudUi.setHitmarker("head"); snd.headshot(); }
      else { hudUi.setHitmarker("body"); snd.hit(); }
    }
    if (ev.damage > 0 && ev.hitPoint && ev.targetId !== localId) {
      combat.spawnHitSparks(ev.hitPoint);
    }
    if (ev.targetId === localId && ev.damage > 0) {
      hp = ev.hp;
      hudUi.triggerDamageVignette();
      combat.triggerHurtShake();
      snd.hurt();
      hudUi.hud();
    }
  }

  function handleUnifiedKillEvent(ev, localId) {
    if (!ev) return;
    hudUi.pushKillfeed(ev);
    if (ev.killerId === localId) {
      hudUi.showKillAlert(ev.head ? `HEADSHOT! ${ev.victim}` : `HẠ GỤC ${ev.victim}`, ev.head ? "#ff3b3b" : "#f0b429");
    } else if (ev.victimId === localId) {
      const rule = getSpawnRuleForMode(currentMode);
      meAlive = false;
      meInvuln = false;
      lanProtUntil = 0;
      lanProtIFramesUntil = 0;
      meProtState = { active: false, iFrames: false, spawnProtected: false, expiring: false, remainingMs: 0, totalMs: rule.protectMs, progress: 0 };
      prevProtActive = false;
      combat.activeWeapon().st.reloadEndsAt = 0;
      combat.awmScope.resetAll();
      $("sniperScope").style.display = "none";
      weaponAudio.clearScheduledTimers();
      input.clearAds();
      combat.setTestAimHeld(false);
      hp = 0;
      respawnTotalMs = ev.respawnMs || rule.respawnDelayMs;
      respawnMs = respawnTotalMs;
      deathTimeSec = 0;
      deathInfo = {
        killer: ev.killer,
        killerTeam: ev.killerTeam,
        weapon: ev.weapon,
        head: Boolean(ev.head),
        killerHp: ev.killerHp,
        killerPos: ev.killerPos || null,
      };
      snd.deathImpact();
      hudUi.triggerDamageVignette();
      hudUi.hud();
      hudUi.showKillAlert(`BỊ HẠ BỞI ${ev.killer}${ev.head ? " (HEADSHOT)" : ""}`, "#ff6b4a");
    }
  }

  function handleUnifiedRespawnEvent(ev, localId) {
    if (!ev || ev.playerId !== localId) return;
    const rule = getSpawnRuleForMode(currentMode);
    const nowMs = performance.now();
    const protMs = ev.invulnerableMs || rule.protectMs;
    const iMs = ev.iFramesMs || rule.iFramesMs;
    meAlive = true;
    meInvuln = true;
    hp = 100;
    deathInfo = null;
    deathTimeSec = 0;
    respawnMs = 0;
    lanProtStartedAt = nowMs;
    lanProtTotalMs = protMs;
    lanProtIFramesUntil = nowMs + iMs;
    lanProtUntil = nowMs + protMs;
    prevProtActive = true;
    meProtState = {
      active: true,
      iFrames: true,
      spawnProtected: false,
      expiring: false,
      remainingMs: protMs,
      totalMs: protMs,
      progress: 1,
    };
    crouched = false;
    prone = false;
    input.setProne(false);
    input.clearAds();
    combat.setTestAimHeld(false);
    combat.awmScope.resetAll();
    $("sniperScope").style.display = "none";
    eyeHeight = EYE_STAND;
    combat.resetAllWeapons();
    combat.armFreshFireGate();
    P.set(ev.pos.x, ev.pos.y, ev.pos.z);
    yaw = ev.yaw;
    pitch = 0;
    vy = velX = velZ = 0;
    cam.position.set(P.x, P.y + EYE_STAND, P.z);
    cam.rotation.set(pitch, yaw, 0);
    snd.respawn();
    if (ev.reason === "flip") {
      hudUi.showKillAlert("ĐỔI CĂN CỨ HỒI SINH AN TOÀN", "#4ec3b0");
    }
    hudUi.hud();
    hudUi.stepShieldVisuals(performance.now());
  }

  function syncLanProtectionState(nowMs, serverActive, serverIFrames, serverExpiring) {
    const rule = getSpawnRuleForMode(currentMode);
    if (!meAlive) {
      meProtState = { active: false, iFrames: false, spawnProtected: false, expiring: false, remainingMs: 0, totalMs: rule.protectMs, progress: 0 };
      prevProtActive = false;
      return;
    }
    if (serverActive && nowMs >= lanProtUntil) {
      lanProtStartedAt = nowMs;
      lanProtTotalMs = rule.protectMs;
      lanProtIFramesUntil = nowMs + (serverIFrames ? rule.iFramesMs : 0);
      lanProtUntil = nowMs + rule.protectMs;
    } else if (!serverActive) {
      lanProtUntil = 0;
      lanProtIFramesUntil = 0;
    }
    const remMs = lanProtUntil > nowMs ? lanProtUntil - nowMs : 0;
    const active = Boolean(serverActive && remMs > 0);
    if (prevProtActive && !active && activeState === "play") {
      snd.shieldFade();
    }
    prevProtActive = active;
    meProtState = {
      active,
      iFrames: Boolean(serverIFrames || (active && nowMs < lanProtIFramesUntil)),
      spawnProtected: active && !serverIFrames && nowMs >= lanProtIFramesUntil,
      expiring: Boolean(serverExpiring || (active && remMs <= rule.expiringWindowMs)),
      remainingMs: remMs,
      totalMs: Math.max(1, lanProtTotalMs),
      progress: active ? Math.max(0, Math.min(1, remMs / Math.max(1, lanProtTotalMs))) : 0,
    };
  }

  net.on(MSG.SNAPSHOT, (msg) => applySnapshot(msg));
  net.on(MSG.EVENT_SCOPE, (ev) => {
    if (!ev || ev.playerId === net.playerId || engineMode !== "lan") return;
    _remoteScopePos.set(ev.x || 0, ev.y || 0, ev.z || 0);
    snd.scopeClick(ev.level, _remoteScopePos);
  });
  net.on(MSG.AMMO, (msg) => {
    if (engineMode !== "lan") return;
    combat.applyAmmoMsg(msg);
    hudUi.hud();
  });
  net.on(MSG.EVENT_RELOAD, (ev) => {
    const pid = ev.playerId || ev.pid;
    if (!pid || pid === net.playerId || engineMode !== "lan") return;
    const av = remoteMgr.remotePlayers.get(pid);
    if (av) {
      av.reloadDurMs = ev.dur || 2000;
      av.reloadEndsAt = performance.now() + av.reloadDurMs;
    }
  });
  net.on(MSG.SWITCH_WEAPON, (ev) => {
    if (!ev.playerId || ev.playerId === net.playerId || engineMode !== "lan") return;
    const av = remoteMgr.remotePlayers.get(ev.playerId);
    if (av) {
      av.weaponId = ev.weaponId || "m416";
      av.weaponLockUntil = performance.now() + 260;
      av.reloadEndsAt = 0;
      remoteMgr.syncRemoteWeaponVisibility(av);
    }
  });
  net.on(MSG.EVENT_FIRE, (ev) => {
    if (ev.playerId === net.playerId || engineMode !== "lan") return;
    combat.handleRemoteFireVisuals(ev);
  });
  net.on(MSG.EVENT_HIT, (ev) => {
    if (engineMode !== "lan") return;
    handleUnifiedHitEvent(ev, net.playerId);
  });
  net.on(MSG.EVENT_KILL, (ev) => {
    if (engineMode !== "lan") return;
    handleUnifiedKillEvent(ev, net.playerId);
  });
  net.on(MSG.EVENT_RESPAWN, (ev) => {
    if (engineMode !== "lan") return;
    handleUnifiedRespawnEvent(ev, net.playerId);
  });
  net.on(MSG.CHAT, (ev) => {
    if (engineMode === "lan") hudUi.pushHudChat(ev);
  });

  // ---------- 60Hz Physics & Main Loop ----------
  const clock = new THREE.Clock();

  function canRiseTo(targetHeight = 1.85) {
    const activeCollision = sceneMgr.getActiveCollision();
    if (activeCollision) return activeCollision.canStandUp(P.x, P.y, P.z, 0.42, targetHeight);
    const minCheckY = targetHeight < 1.5 ? 0.52 : 1.05;
    for (const c of cols) {
      if (P.x >= c.x0 - 0.42 && P.x <= c.x1 + 0.42 && P.z >= c.z0 - 0.42 && P.z <= c.z1 + 0.42) {
        const baseY = c.y0 || 0;
        if (baseY > P.y + minCheckY && baseY < P.y + targetHeight) return false;
      }
    }
    const rayStartY = targetHeight < 1.5 ? 0.45 : 1.0;
    _upOrigin.set(P.x, P.y + rayStartY, P.z);
    upRay.set(_upOrigin, UP);
    upRay.far = Math.max(0.2, targetHeight - rayStartY + 0.01);
    return upRay.intersectObjects(solid, false).length === 0;
  }

  function canStandUp() {
    return canRiseTo(1.85);
  }

  function stepPhysicsFixed(dtFixed, nowMs) {
    const canAct = engineMode === "solo" || (meAlive && activeState === "play");
    combat.syncMagazineResetOnReloadComplete(nowMs);
    if (!canAct) {
      curFlags = 0;
      return;
    }

    const { st } = combat.activeWeapon();
    const activeInput = hudUi.isControlActive();
    const chatOpen = hudUi.isChatOpen();
    const f = activeInput && !chatOpen ? ((input.isDown("forward") ? 1 : 0) - (input.isDown("back") ? 1 : 0)) : 0;
    const s = activeInput && !chatOpen ? ((input.isDown("right") ? 1 : 0) - (input.isDown("left") ? 1 : 0)) : 0;
    const hasMove = f !== 0 || s !== 0;

    const rawShift = activeInput && !chatOpen && input.isDown("sprint");
    if (!rawShift) sprintBrokenUntilShiftUp = false;

    const jumpHit = activeInput && !chatOpen && input.wasHit("jump");
    const wantsCrouchRaw = activeInput && !chatOpen && input.isCrouchActive();
    const wantsProneRaw = activeInput && !chatOpen && input.isProneActive() && grounded && !onLadder;

    if (!grounded || onLadder) {
      if (prone) {
        prone = false;
        input.setProne(false);
      }
    }

    let consumedJumpForStand = false;
    if (prone && jumpHit) {
      consumedJumpForStand = true;
      if (canStandUp()) {
        prone = false;
        crouched = false;
        input.setProne(false);
      } else if (canRiseTo(1.28)) {
        prone = false;
        crouched = true;
        input.setProne(false);
      }
    } else if (wantsCrouchRaw) {
      if (prone) {
        if (canRiseTo(1.28)) {
          prone = false;
          crouched = true;
          input.setProne(false);
        }
      } else {
        crouched = true;
      }
      sprintBrokenUntilShiftUp = true;
    } else if (wantsProneRaw) {
      prone = true;
      crouched = false;
      sprintBrokenUntilShiftUp = true;
    } else {
      if (prone) {
        if (canStandUp()) {
          prone = false;
          crouched = false;
          input.setProne(false);
        } else if (canRiseTo(1.28)) {
          prone = false;
          crouched = true;
          input.setProne(false);
        }
      } else if (crouched && canStandUp()) {
        crouched = false;
      }
    }

    const isSniperWeapon = SLOT_TO_WEAPON_ID[combat.getActiveSlot()] === "sniper";
    const isSniperScopedOrAiming =
      isSniperWeapon && (combat.awmScope.getState().scoped || input.isAdsActive() || combat.getScopeOut().adsT > 0.12);
    const wantsAds = (combat.getTestAimHeld() || (activeInput && !chatOpen && input.isAdsActive())) && st.reloadEndsAt <= nowMs;
    if (wantsAds && rawShift && !isSniperScopedOrAiming) sprintBrokenUntilShiftUp = true;
    if ((input.fireJustPressed || input.fireHeld) && rawShift && isSprinting) {
      sprintBrokenUntilShiftUp = true;
    }

    isSprinting =
      rawShift &&
      !sprintBrokenUntilShiftUp &&
      !crouched &&
      !prone &&
      grounded &&
      !onLadder &&
      hasMove &&
      !isSniperScopedOrAiming;
    if (isSprinting) {
      input.clearAds();
      combat.setTestAimHeld(false);
      if (isSniperWeapon) combat.awmScope.cancelAutoRescope();
    }

    const isReloading = st.reloadEndsAt > nowMs;
    const effectiveAds = (combat.getTestAimHeld() || (activeInput && input.isAdsActive())) && !isReloading && !isSprinting;

    curFlags =
      (crouched ? FLAG.CROUCH : 0) |
      (prone ? FLAG.PRONE : 0) |
      (effectiveAds ? FLAG.ADS : 0) |
      (isSprinting ? FLAG.SPRINT : 0) |
      (!grounded ? FLAG.AIR : 0) |
      (input.fireHeld ? FLAG.FIRING : 0) |
      (isReloading ? FLAG.RELOADING : 0);

    if (grounded) lastGroundedAt = nowMs;
    if (jumpHit && !consumedJumpForStand && !prone) {
      jumpBufferedUntil = nowMs + JUMP_BUFFER_MS;
    }
    if (
      !prone &&
      nowMs <= jumpBufferedUntil &&
      (grounded || nowMs <= lastGroundedAt + COYOTE_TIME_MS) &&
      nowMs >= nextJumpAllowedAt
    ) {
      vy = 7.5;
      grounded = false;
      jumpBufferedUntil = 0;
      nextJumpAllowedAt = nowMs + JUMP_COOLDOWN_MS;
    }

    const speed = BASE_MOVE_SPEED * getMoveSpeedMultiplier(curFlags, combat.activeWeapon().cfg);
    let targetVx = 0, targetVz = 0;
    if (hasMove) {
      const l = Math.hypot(f, s) || 1;
      const sn = Math.sin(yaw), cs = Math.cos(yaw);
      targetVx = ((-sn * f + cs * s) / l) * speed;
      targetVz = ((-cs * f - sn * s) / l) * speed;
    }
    const accelFactor = grounded ? Math.min(1, 22 * dtFixed) : 0.25 * Math.min(1, 10 * dtFixed);
    velX = lerp(velX, targetVx, accelFactor);
    velZ = lerp(velZ, targetVz, accelFactor);

    P.x += velX * dtFixed;
    P.z += velZ * dtFixed;
    const activeCollision = sceneMgr.getActiveCollision();
    if (activeCollision) {
      const mState = { x: P.x, y: P.y, z: P.z, vy, grounded, onLadder };
      activeCollision.stepPlayerMovement(
        mState,
        {
          moveForward: f,
          jumpHeld: activeInput && !chatOpen && input.isDown("jump"),
          crouched,
          prone,
          radius: 0.45,
        },
        dtFixed,
      );
      P.set(mState.x, mState.y, mState.z);
      vy = mState.vy;
      grounded = mState.grounded;
      onLadder = mState.onLadder;
    } else {
      vy -= 22 * dtFixed;
      P.y += vy * dtFixed;
      if (P.y <= 0) {
        P.y = 0;
        vy = 0;
        grounded = true;
      } else {
        grounded = false;
      }
      for (const c of cols) {
        const dx = P.x - Math.max(c.x0, Math.min(P.x, c.x1));
        const dz = P.z - Math.max(c.z0, Math.min(P.z, c.z1));
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.2025 && P.y < c.y1) {
          const d = Math.sqrt(d2) || 0.001;
          P.x += (dx / d) * (0.45 - d);
          P.z += (dz / d) * (0.45 - d);
        }
      }
      P.x = Math.max(-48, Math.min(48, P.x));
      P.z = Math.max(-48, Math.min(48, P.z));
    }

    if (hasMove && grounded) {
      bob += speed * dtFixed;
      const stepIdx = Math.floor(bob / 1.55);
      if (stepIdx !== lastStepIdx) {
        lastStepIdx = stepIdx;
        if (activeState === "play") {
          const militaryData = sceneMgr.getMilitaryData();
          let surface = "concrete";
          if (onLadder || P.y > 2.5) surface = "metal";
          else if (sceneMgr.getActiveMapId() === "harbor") surface = "puddle";
          else if (militaryData && militaryData.samplePuddle && militaryData.samplePuddle(P.x, P.z) > 0.35) {
            surface = "puddle";
          }
          snd.footstep(surface);
        }
      }
    }

    const targetEye = prone ? EYE_PRONE : crouched ? EYE_CROUCH : EYE_STAND;
    eyeHeight += (targetEye - eyeHeight) * Math.min(1, (prone ? 14 : 18) * dtFixed);
  }

  const lookProxy = {
    get yaw() { return yaw; },
    set yaw(v) { yaw = v; },
    get pitch() { return pitch; },
    set pitch(v) { pitch = v; },
  };

  function updateGameplay(dt) {
    const nowMs = performance.now();
    const canAct = engineMode === "solo" || (meAlive && activeState === "play");
    const activeSlot = combat.getActiveSlot();
    const isM416Active = SLOT_TO_WEAPON_ID[activeSlot] === "m416";
    const isSniperActive = SLOT_TO_WEAPON_ID[activeSlot] === "sniper";
    const sCfg = settings ? settings.get() : { sens: 1, adsSens: 0.58, invertY: false, adsMode: "toggle", fov: 75 };
    const chatOpen = hudUi.isChatOpen();
    const activeControl = hudUi.isControlActive();
    const scopeOut = combat.getScopeOut();

    if (activeControl && !chatOpen) {
      const { dx, dy } = input.consumeMouseDelta();
      const zoomSensMult = isSniperActive && scopeOut.zoom > 1.02 ? scopeOut.sensMultiplier : lerp(1.0, sCfg.adsSens, vmAnim.getAds());
      const sens = 0.0022 * sCfg.sens * zoomSensMult;
      yaw -= dx * sens;
      const ySign = sCfg.invertY ? -1 : 1;
      const pitchBeforeMouse = pitch;
      pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * sens * ySign));
      const mousePitchDelta = pitch - pitchBeforeMouse;
      if (isM416Active && mousePitchDelta < 0) {
        combat.m416Recoil.absorbPlayerPull(-mousePitchDelta * RAD2DEG);
      }
    }

    if (canAct && activeControl && !chatOpen) {
      if (input.wasHit("slot1")) combat.switchWeapon(1);
      else if (input.wasHit("slot2")) combat.switchWeapon(2);
      else if (input.wasHit("slot3")) combat.switchWeapon(3);
      else if (input.wasHit("switchPrev")) combat.switchWeapon(combat.getPrevSlot());

      const wDir = input.consumeWheel();
      if (wDir !== 0) {
        const nextIdx = (WEAPON_SLOTS.indexOf(combat.getActiveSlot()) + (wDir > 0 ? 1 : -1) + WEAPON_SLOTS.length) % WEAPON_SLOTS.length;
        combat.switchWeapon(WEAPON_SLOTS[nextIdx]);
      }

      if (input.wasHit("reload")) combat.reload();
      if (input.wasHit("laser")) { laserOn = !laserOn; snd.click(1800); }

      const activeCfgAfterSwitch = combat.activeWeapon().cfg;
      const activeStAfterSwitch = combat.activeWeapon().st;
      if (activeCfgAfterSwitch.id === "sniper") {
        const canScope = !isSprinting && activeStAfterSwitch.reloadEndsAt <= nowMs && activeStAfterSwitch.mag > 0;
        const rmbClicked = input.consumeAdsJustPressed();
        if (sCfg.adsMode === "hold") {
          const wantHold = Boolean(input.adsHeld && canScope);
          if (wantHold !== combat.awmScope.getState().scoped) {
            combat.awmScope.setScopedState(wantHold, 1);
            combat.emitScopeAudioCue(wantHold ? 1 : 0, "sniper");
          }
        } else if (rmbClicked) {
          const zRes = combat.awmScope.toggleDoubleZoom(nowMs / 1000, canScope);
          if (zRes.changed) combat.emitScopeAudioCue(zRes.level, "sniper");
          input.adsToggled = combat.awmScope.getState().scoped;
          input.adsHeld = input.adsToggled;
        }
        if (input.wasHit("zeroUp")) {
          combat.awmScope.cycleZero(1);
          snd.click(1450);
        }
        if (input.wasHit("zeroDown")) {
          combat.awmScope.cycleZero(-1);
          snd.click(1250);
        }
      } else {
        input.consumeAdsJustPressed();
      }

      if (engineMode === "lan" && input.wasHit("chat")) hudUi.openChat();
    }

    if (engineMode === "lan" && activeState === "play" && meAlive) {
      syncLanProtectionState(
        nowMs,
        lanProtUntil > nowMs,
        nowMs < lanProtIFramesUntil,
        lanProtUntil > nowMs && lanProtUntil - nowMs <= getSpawnRuleForMode(currentMode).expiringWindowMs,
      );
      meInvuln = meProtState.active;
    }

    if ((engineMode === "lan" || engineMode === "bots") && activeState === "play" && activeControl && !chatOpen) {
      const showSb = input.isDown("score");
      $("scoreboard").style.display = showSb ? "block" : "none";
      if (showSb) hudUi.renderScoreboardTable();
    } else {
      $("scoreboard").style.display = "none";
    }

    physicsAccum = Math.min(0.1, physicsAccum + dt);
    while (physicsAccum >= FIXED_DT) {
      stepPhysicsFixed(FIXED_DT, nowMs);
      physicsAccum -= FIXED_DT;
    }

    if (!meAlive && (engineMode === "lan" || engineMode === "bots") && activeState === "play") {
      deathTimeSec += dt;
      respawnMs = Math.max(0, respawnMs - dt * 1000);
      eyeHeight += (0.38 - eyeHeight) * Math.min(1, 9 * dt);
      if (deathInfo && deathInfo.killerPos) {
        const kp = deathInfo.killerPos;
        const kdx = kp.x - P.x;
        const kdz = kp.z - P.z;
        const kHoriz = Math.hypot(kdx, kdz);
        if (kHoriz > 0.25) {
          const aimYaw = Math.atan2(-kdx, -kdz);
          const aimPitch = Math.max(-0.9, Math.min(0.9, Math.atan2((kp.y + 1.1) - (P.y + eyeHeight), kHoriz)));
          let dYaw = ((aimYaw - yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
          if (dYaw < -Math.PI) dYaw += Math.PI * 2;
          const kRot = Math.min(1, 6.5 * dt);
          yaw += dYaw * kRot;
          pitch += (aimPitch - pitch) * kRot;
        }
      }
    }

    combat.stepWeaponUpdate(dt, nowMs, canAct, activeControl, chatOpen, isSprinting, crouched, grounded, velX, velZ, lookProxy, prone);

    const curW = combat.activeWeapon();
    const mvRatio = Math.hypot(velX, velZ) > 0.25 ? 1 : 0;
    const hideSniperModel = curW.cfg.scopeOverlay && combat.getScopeOut().hideWeaponModel;
    gun.visible = canAct && !hideSniperModel;
    const { armsRoot: activeArmsRoot } = assetLoader.getArms();
    if (activeArmsRoot) activeArmsRoot.visible = canAct && !hideSniperModel;

    const sk = combat.getShake() * 0.05;
    cam.position.set(
      P.x + rnd(-sk, sk),
      P.y + eyeHeight + (canAct && mvRatio && grounded ? Math.sin(bob * 2) * 0.035 * (1 - 0.7 * vmAnim.getAds()) : 0),
      P.z,
    );
    cam.rotation.set(pitch + combat.getKick() + rnd(-sk, sk), yaw, 0);
    vmAnim.gunAnim(dt, canAct ? mvRatio : 0);

    if (engineMode === "lan" && canAct && activeState === "play" && !awaitingInitialSpawnSnap) {
      if (curFlags !== lastSentFlags || nowMs - lastInputSentAt >= 50) {
        sendLanState(nowMs, mvRatio);
      }
    }

    if (engineMode === "bots" && activeState === "play" && activeBotMatch) {
      const nextProt = activeBotMatch.syncHumanState(
        {
          pos: { x: P.x, y: P.y, z: P.z },
          yaw,
          pitch,
          flags: curFlags,
          activeWeaponId: curW.cfg.id,
        },
        nowMs,
      );
      if (prevProtActive && !nextProt.active && meAlive) snd.shieldFade();
      prevProtActive = nextProt.active;
      meProtState = nextProt;
      meInvuln = nextProt.active;

      const botSnap = activeBotMatch.step(dt, nowMs);
      if (botSnap && !botSnap.ended) {
        timeLeftSec = botSnap.timeLeftSec;
        teamScores = botSnap.teamScores;
        lastPlayers = botSnap.players;
        const meEntry = lastPlayers.find((p) => p.id === "human-local");
        if (meEntry) {
          hp = meEntry.hp;
          meAlive = meEntry.alive;
          if (!meEntry.alive) respawnMs = meEntry.respawnMs;
        }
        for (const p of lastPlayers) {
          if (p.id === "human-local") continue;
          let av = remoteMgr.remotePlayers.get(p.id);
          if (!av) av = remoteMgr.createRemoteAvatar(p);
          av.snapshots.length = 0;
          av.snapshots.push({
            t: botSnap.t,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            pitch: p.pitch,
            mv: p.mv || 0,
            flags: p.flags || 0,
            weaponId: p.weaponId || "m416",
            reloading: Boolean(p.reloading),
            hp: p.hp,
            alive: p.alive,
            invulnerable: p.invulnerable,
            iFrames: Boolean(p.iFrames),
            protectExpiring: Boolean(p.protectExpiring),
          });
        }
      }
    }

    if (engineMode === "solo" && activeState === "play") combat.stepSoloDrones(dt);

    hudUi.stepTransientFeedback(dt);
    hudUi.stepShieldVisuals(nowMs);
    sceneMgr.updateCanvasPostGrade(sceneMgr.getGt());
    if (meAlive && hp <= 30 && activeState === "play") {
      nextHeartbeatAt -= dt;
      if (nextHeartbeatAt <= 0) {
        const distress = Math.max(0, Math.min(1, (32 - hp) / 22));
        snd.heartbeat(0.45 + 0.55 * distress);
        nextHeartbeatAt = 0.98 - 0.34 * distress;
      }
    } else {
      nextHeartbeatAt = 0.15;
    }

    hudUi.updateRadarAndCrosshair(nowMs);
    if (nowMs - lastHudSyncMs >= 100) {
      lastHudSyncMs = nowMs;
      hudUi.hud();
    }
  }

  function renderFrame() {
    const hasDynamicCasters = combat.hasDrones() || remoteMgr.remotePlayers.size > 0;
    if (sceneMgr.consumeShadowUpdate(hasDynamicCasters)) {
      R.shadowMap.needsUpdate = true;
    }
    cam.layers.set(0);
    R.clear();
    R.render(S, cam);
    let totalCalls = R.info && R.info.render ? R.info.render.calls : 0;
    let totalTris = R.info && R.info.render ? R.info.render.triangles : 0;
    if (engineMode !== "idle") {
      const bg = S.background;
      S.background = null;
      R.clearDepth();
      vmCam.layers.set(VIEW_LAYER);
      R.render(S, vmCam);
      if (R.info && R.info.render) {
        totalCalls += R.info.render.calls;
        totalTris += R.info.render.triangles;
      }
      S.background = bg;
    }
    hudUi.samplePerfStats(totalCalls, totalTris);
  }

  function loop() {
    requestAnimationFrame(loop);
    if (sceneMgr.isSuspended() || (engineMode === "solo" && activeState === "over")) return;
    const rawDt = freezeVfxClock ? 0 : clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    if (!freezeVfxClock) {
      if (activeState === "play") updateGameplay(dt);
      else if (engineMode === "idle") sceneMgr.updateLobbyCamera(Math.min(rawDt, 0.25));
      if (engineMode === "lan" || engineMode === "bots") remoteMgr.updateRemotePlayers(dt);
      sceneMgr.updateWeatherAndRain(dt);
      ballisticsVfx.update(dt, cam);
    }
    cam.updateMatrixWorld(true);
    vmCam.position.copy(cam.position);
    vmCam.quaternion.copy(cam.quaternion);
    vmCam.updateMatrixWorld(true);

    const showLaser = laserOn && engineMode !== "idle" && meAlive && SLOT_TO_WEAPON_ID[combat.getActiveSlot()] === "m416";
    laserBeam.visible = showLaser;
    assetLoader.getNodes().laserLens.visible = showLaser;
    if (showLaser) {
      getViewmodelWorldPoint(laserOrigin, _lp);
      _ld.set(0, 0, -1).transformDirection(gun.matrixWorld);
      _ls.copy(_lp).addScaledVector(_ld, -0.9);
      let hit = null;
      const activeCollision = sceneMgr.getActiveCollision();
      if (activeCollision) {
        const wh = activeCollision.raycastShot(_ls.x, _ls.y, _ls.z, _ld.x, _ld.y, _ld.z, 81);
        if (wh) {
          _laserEnd.set(wh.x, wh.y, wh.z);
          hit = { distance: wh.dist, point: _laserEnd };
        }
      } else {
        laserRay.set(_ls, _ld);
        laserRay.far = 81;
        const targets = ground ? [ground, ...solid] : solid;
        hit = laserRay.intersectObjects(targets, false)[0] || null;
      }
      const end = hit ? hit.point : _laserEnd.copy(_lp).addScaledVector(_ld, 80);
      const bp = laserBeam.geometry.attributes.position;
      laserBeam.visible = !(hit && hit.distance < 0.9);
      bp.setXYZ(0, _lp.x, _lp.y, _lp.z);
      bp.setXYZ(1, end.x, end.y, end.z);
      bp.needsUpdate = true;
      laserDot.visible = Boolean(hit);
      if (hit) {
        laserDot.position.copy(hit.point).addScaledVector(_ld, -0.02);
        laserDot.scale.setScalar(0.05 + hit.distance * 0.004);
      }
    } else {
      laserDot.visible = false;
    }
    renderFrame();
  }

  function startRenderLoop() {
    if (loopStarted) return;
    loopStarted = true;
    clock.getDelta();
    requestAnimationFrame(loop);
  }

  // ---------- Match Lifecycle ----------
  function startLanMatch(room, initialSnapshot) {
    initAudio();
    syncRoomRoster(room);
    const targetMap = normalizeMapId(room && room.map ? room.map : "military");
    if (!sceneMgr.activateSyncIfCached(targetMap).ok) sceneMgr.ensureMapActive(targetMap);

    combat.clearAllDrones();
    remoteMgr.clearRemotePlayers();
    weaponAudio.clearScheduledTimers();
    ballisticsVfx.clear();
    muzzleFlashRig.setWarmupVisible(false);
    combat.resetVisualStateOnMatchStart();

    engineMode = "lan";
    activeState = "play";
    activeBotMatch = null;
    currentMode = room.mode;
    killLimit = room.killLimit;
    deathInfo = null;
    deathTimeSec = 0;
    respawnMs = 0;
    const initRule = getSpawnRuleForMode(room.mode);
    respawnTotalMs = initRule.respawnDelayMs;
    hp = 100;
    meAlive = true;
    awaitingInitialSpawnSnap = true;
    lanProtStartedAt = 0;
    lanProtIFramesUntil = 0;
    lanProtUntil = 0;
    lanProtTotalMs = initRule.protectMs;
    prevProtActive = false;
    meProtState = { active: false, iFrames: false, spawnProtected: false, expiring: false, remainingMs: 0, totalMs: initRule.protectMs, progress: 0 };
    sceneMgr.setLobbyOrbitLocked(false);

    const baseFov = settings ? settings.get().fov : 75;
    if (Math.abs(cam.fov - baseFov) > 0.05) {
      cam.fov = baseFov;
      cam.updateProjectionMatrix();
    }
    combat.setActiveSlot(1);
    combat.setPrevSlot(2);
    combat.resetAllWeapons();
    assetLoader.applyViewmodelWeapon("m416");
    crouched = false;
    prone = false;
    grounded = true;
    onLadder = false;
    eyeHeight = EYE_STAND;
    velX = velZ = vy = 0;
    bob = 0;
    isSprinting = false;
    lastSentFlags = 0;
    vmAnim.resetAnimState();
    hudUi.setChatOpen(false);
    input.reset();
    $("hudChatInput").style.display = "none";
    $("sniperScope").style.display = "none";
    $("hud").style.display = "block";
    $("pauseOverlay").style.display = "none";

    if (initialSnapshot) {
      const unpacked = unpackSnapshot(initialSnapshot, rosterNames);
      const meSnap = unpacked && Array.isArray(unpacked.players)
        ? unpacked.players.find((p) => p.id === net.playerId)
        : null;
      if (meSnap) {
        awaitingInitialSpawnSnap = false;
        P.set(meSnap.x, meSnap.y, meSnap.z);
        yaw = meSnap.yaw;
        pitch = 0;
        meTeam = meSnap.team || "FFA";
        meAlive = meSnap.alive;
        meInvuln = meSnap.invulnerable;
        syncLanProtectionState(performance.now(), meSnap.invulnerable, meSnap.iFrames, meSnap.protectExpiring);
      }
      if (unpacked) applySnapshot(unpacked);
    }
    combat.armFreshFireGate();
    vmAnim.gunAnim(0, 0);
    hudUi.hud();
    input.tryLock();
    setTimeout(() => {
      if (engineMode === "lan" && activeState === "play" && !hudUi.isControlActive() && !hudUi.isChatOpen()) {
        hudUi.onPointerLockFailed();
      }
    }, 90);
  }

  function startBotMatch(botConfig = {}) {
    const targetMap = normalizeMapId(botConfig.mapId || sceneMgr.getActiveMapId() || "military");
    if (!sceneMgr.activateSyncIfCached(targetMap).ok) sceneMgr.ensureMapActive(targetMap);
    initAudio();
    remoteMgr.clearRemotePlayers();
    combat.clearAllDrones();
    weaponAudio.clearScheduledTimers();
    ballisticsVfx.clear();
    muzzleFlashRig.setWarmupVisible(false);
    combat.resetVisualStateOnMatchStart();

    const arena = buildBotArenaForMap(targetMap);
    const localNick = sanitizeText(
      (() => { try { return localStorage.getItem("fpsNick"); } catch { return ""; } })(),
      "Bạn",
      16,
    );
    activeBotMatch = createBotMatchController({
      arena,
      config: { ...botConfig, mapId: targetMap },
      weaponsApi: {
        BASE_MOVE_SPEED,
        FLAG,
        WEAPONS,
        computeWeaponDamage,
        computeWeaponSpread,
        createDefaultWeaponsState,
        getMoveSpeedMultiplier,
        getReloadDurationMs,
        resolveWeaponConfig,
      },
      humanId: "human-local",
      humanName: localNick,
      nowFn: () => performance.now(),
      callbacks: {
        onEventFire: (ev) => {
          if (ev.playerId !== "human-local") combat.handleRemoteFireVisuals(ev);
        },
        onEventHit: (ev) => handleUnifiedHitEvent(ev, "human-local"),
        onEventKill: (ev) => handleUnifiedKillEvent(ev, "human-local"),
        onEventRespawn: (ev) => {
          if (ev.playerId === "human-local") {
            handleUnifiedRespawnEvent(ev, "human-local");
          }
        },
        onEventReload: (ev) => {
          const av = remoteMgr.remotePlayers.get(ev.playerId);
          if (av) {
            av.reloadDurMs = ev.dur || 2000;
            av.reloadEndsAt = performance.now() + av.reloadDurMs;
          }
        },
        onEventSwitchWeapon: (ev) => {
          const av = remoteMgr.remotePlayers.get(ev.playerId);
          if (av) {
            av.weaponId = ev.weaponId || "m416";
            av.weaponLockUntil = performance.now() + 260;
            av.reloadEndsAt = 0;
            remoteMgr.syncRemoteWeaponVisibility(av);
          }
        },
        onMatchEnd: (res) => {
          activeState = "over";
          if (document.pointerLockElement === R.domElement) document.exitPointerLock();
          if (typeof onBotMatchEnd === "function") onBotMatchEnd(res, botConfig);
        },
      },
    });

    const snap0 = activeBotMatch.buildSnapshot(performance.now());
    engineMode = "bots";
    activeState = "play";
    currentMode = activeBotMatch.config.mode;
    killLimit = activeBotMatch.config.killLimit;
    timeLeftSec = snap0.timeLeftSec;
    teamScores = snap0.teamScores;
    lastPlayers = snap0.players;
    meTeam = currentMode === "TDM" ? "A" : "FFA";
    sceneMgr.setLobbyOrbitLocked(false);

    const baseFov = settings ? settings.get().fov : 75;
    if (Math.abs(cam.fov - baseFov) > 0.05) {
      cam.fov = baseFov;
      cam.updateProjectionMatrix();
    }
    combat.setActiveSlot(1);
    combat.setPrevSlot(2);
    assetLoader.applyViewmodelWeapon("m416");
    hudUi.setChatOpen(false);
    input.reset();
    $("hudChatInput").style.display = "none";
    $("pauseOverlay").style.display = "none";
    $("hud").style.display = "block";

    const humanState = activeBotMatch.getHuman();
    handleUnifiedRespawnEvent(
      {
        playerId: "human-local",
        pos: { x: humanState.x, y: humanState.y, z: humanState.z },
        yaw: humanState.yaw,
        invulnerableMs: activeBotMatch.modeRule.protectMs,
        iFramesMs: activeBotMatch.modeRule.iFramesMs,
        reason: "normal",
      },
      "human-local",
    );
    for (const p of snap0.players) {
      if (p.id === "human-local") continue;
      const av = remoteMgr.createRemoteAvatar(p);
      av.snapshots.push({
        t: snap0.t,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        mv: p.mv || 0,
        flags: p.flags || 0,
        weaponId: p.weaponId || "m416",
        reloading: false,
        hp: p.hp,
        alive: p.alive,
        invulnerable: p.invulnerable,
        iFrames: Boolean(p.iFrames),
        protectExpiring: Boolean(p.protectExpiring),
      });
    }
    vmAnim.resetAnimState();
    vmAnim.gunAnim(0, 0);
    hudUi.hud();
    hudUi.stepShieldVisuals(performance.now());
    input.tryLock();
    setTimeout(() => {
      if (engineMode === "bots" && activeState === "play" && !hudUi.isControlActive() && !hudUi.isChatOpen()) {
        hudUi.onPointerLockFailed();
      }
    }, 90);
  }

  function startSolo(mapId = sceneMgr.getActiveMapId() || sceneMgr.getInitialDefaultMap()) {
    const targetMap = normalizeMapId(mapId);
    if (!sceneMgr.activateSyncIfCached(targetMap).ok) sceneMgr.ensureMapActive(targetMap);
    initAudio();
    remoteMgr.clearRemotePlayers();
    combat.clearAllDrones();
    weaponAudio.clearScheduledTimers();
    ballisticsVfx.clear();
    muzzleFlashRig.setWarmupVisible(false);
    combat.resetVisualStateOnMatchStart();

    engineMode = "solo";
    activeState = "play";
    hp = 100;
    combat.resetSoloStats();
    meAlive = true;
    meInvuln = false;
    sceneMgr.setLobbyOrbitLocked(false);

    const baseFov = settings ? settings.get().fov : 75;
    if (Math.abs(cam.fov - baseFov) > 0.05) {
      cam.fov = baseFov;
      cam.updateProjectionMatrix();
    }
    combat.setActiveSlot(1);
    combat.setPrevSlot(2);
    combat.resetAllWeapons();
    assetLoader.applyViewmodelWeapon("m416");
    if (targetMap === "military") {
      P.set(0, 0, -40);
      yaw = Math.PI;
    } else {
      P.set(0, 0, 0);
      yaw = 0;
    }
    pitch = vy = velX = velZ = 0;
    bob = 0;
    crouched = false;
    prone = false;
    grounded = true;
    onLadder = false;
    eyeHeight = EYE_STAND;
    isSprinting = false;
    vmAnim.resetAnimState();
    hudUi.setChatOpen(false);
    input.reset();
    $("sniperScope").style.display = "none";
    $("hud").style.display = "block";
    $("pauseOverlay").style.display = "none";
    vmAnim.gunAnim(0, 0);
    hudUi.hud();
    input.tryLock();
  }

  function stopEngine() {
    activeState = "menu";
    engineMode = "idle";
    activeBotMatch = null;
    awaitingInitialSpawnSnap = false;
    deathInfo = null;
    deathTimeSec = 0;
    lanProtUntil = 0;
    lanProtIFramesUntil = 0;
    prevProtActive = false;
    meInvuln = false;
    meProtState = { active: false, iFrames: false, spawnProtected: false, expiring: false, remainingMs: 0, totalMs: SPAWN_RULES.TDM.protectMs, progress: 0 };
    isSprinting = false;
    crouched = false;
    prone = false;
    lastSentFlags = 0;
    hudUi.setChatOpen(false);
    hudUi.setTestLocked(false);
    input.setTextFocusBlocked(false);
    input.reset();
    $("hud").style.display = "none";
    $("sniperScope").style.display = "none";
    $("scoreboard").style.display = "none";
    $("pauseOverlay").style.display = "none";
    $("hudChatInput").style.display = "none";
    const sVig = $("shieldVignette");
    if (sVig) sVig.style.opacity = "0";
    const sBar = $("spawnProtectBar");
    if (sBar) sBar.style.display = "none";
    sceneMgr.updateCanvasPostGrade(sceneMgr.getGt());
    if (document.pointerLockElement === R.domElement) document.exitPointerLock();
    remoteMgr.clearRemotePlayers();
    combat.clearAllDrones();
    weaponAudio.clearScheduledTimers();
    ballisticsVfx.clear();
    muzzleFlashRig.setWarmupVisible(false);
    combat.resetOnStop();
    vmAnim.resetAnimState();
    sceneMgr.setLobbyOrbitLocked(false);
    sceneMgr.applyLobbyCameraImmediate(sceneMgr.getActiveMapId());
  }

  async function bootstrapInitialScene(defaultMapId = sceneMgr.getInitialDefaultMap()) {
    const target = normalizeMapId(defaultMapId);
    const mapLabel = target === "harbor" ? "Bến Cảng Mưa" : "Khu Quân Sự Cũ";
    const tracker = createLoadingTracker((st) => {
      sceneMgr.emitLoading({
        visible: true,
        mode: "startup",
        title: "Đang khởi tạo chiến trường 3D",
        percent: st.percent,
        label: st.label,
        detail: st.detail,
      });
    });

    tracker.reset("Đang chuẩn bị hệ thống đồ họa WebGL...", `Bản đồ mặc định: ${mapLabel}`);
    await yieldToUI();

    try {
      const mapStage = tracker.subProgress(4, 44, `Đang dựng bản đồ ${mapLabel}...`);
      await sceneMgr.buildMapAssetsAsync(target, mapStage);

      const modelStage = tracker.subProgress(44, 70, "Đang nạp mô hình vũ khí & nhân vật...");
      await assetLoader.loadAllSharedModelsAsync(modelStage);

      tracker.report(72, "Đang chuẩn bị bộ đệm âm thanh...", "Tạo sẵn buffer tiếng súng & vang môi trường");
      await precomputeAudioBuffersAsync();
      await yieldToUI();

      sceneMgr.activateCachedMap(target);
      const gpuStage = tracker.subProgress(74, 98, "Đang nạp VRAM & biên dịch Shader...");
      await sceneMgr.warmupGpuForMap(target, { includeShared: true, onProgress: gpuStage });

      tracker.report(100, "Sẵn sàng chiến đấu!", `Đã tối ưu ${mapLabel} & 3 vũ khí`);
      await yieldToUI();
    } catch (err) {
      console.error("Startup bootstrap encountered an error, applying fallback:", err);
      if (target === "military" && !sceneMgr.getMilitaryData()) {
        try {
          await sceneMgr.buildMapAssetsAsync("harbor");
          sceneMgr.activateCachedMap("harbor");
        } catch (fbErr) {
          console.error("Fallback harbor build also failed:", fbErr);
        }
      }
    } finally {
      isBootstrapped = true;
      sceneMgr.setSuspended(false);
      startRenderLoop();
      sceneMgr.emitLoading({ visible: false, done: true, mode: "startup", percent: 100 });
      window.__fpsReady = true;
    }
  }

  const readyPromise = bootstrapInitialScene(sceneMgr.getInitialDefaultMap());

  return {
    readyPromise,
    prepareMap: (id, opts) => sceneMgr.prepareMap(id, opts),
    isMapCached: (id) => sceneMgr.isMapCached(id),
    isMapActiveAndReady: (id) => sceneMgr.isMapActiveAndReady(id),
    startLanMatch,
    startBotMatch,
    startSolo,
    stopEngine,
    applySnapshot,
    syncRoomRoster,
    shoot: () => combat.shoot(),
    reload: () => combat.reload(),
    switchWeapon: (slot) => combat.switchWeapon(slot),
    gunAnim: (dt, mv) => vmAnim.gunAnim(dt, mv),
    renderFrame,
    onPointerLockChanged: (locked) => hudUi.onPointerLockChanged(locked),
    onPointerUnlocked: () => hudUi.onPointerUnlocked(),
    onPointerLockFailed: () => hudUi.onPointerLockFailed(),
    getState: () => ({
      engineMode,
      activeState,
      P,
      isBootstrapped,
      getLoadingStats: () => sceneMgr.getLoadingStats(isBootstrapped),
      getYaw: () => yaw,
      getPitch: () => pitch,
      getM416RecoilState: () => combat.getM416RecoilState(),
      getAwmScopeState: () => combat.getAwmScopeState(),
      setPose: (nx, ny, nz, nyaw, npitch) => {
        if (engineMode === "idle") sceneMgr.setLobbyOrbitLocked(true);
        combat.resetOnSetPose();
        P.set(nx, ny, nz);
        yaw = nyaw;
        pitch = npitch;
        cam.position.set(nx, ny + eyeHeight, nz);
        cam.rotation.set(npitch, nyaw, 0);
        cam.updateMatrixWorld(true);
        vmCam.position.copy(cam.position);
        vmCam.quaternion.copy(cam.quaternion);
        vmCam.updateMatrixWorld(true);
        const mil = sceneMgr.getMilitaryData();
        if (sceneMgr.getActiveMapId() === "military" && mil && mil.updateAtmosphere) {
          mil.updateAtmosphere(sceneMgr.getGt(), cam.position, sceneMgr.getActiveQuality().preset);
        }
        sceneMgr.markShadowDirty();
      },
      getGraphicsQuality: () => sceneMgr.getGraphicsQuality(),
      setGraphicsQuality: (choice, opts = {}) => sceneMgr.setGraphicsQuality(choice, opts),
      waitForQualityApply: () => sceneMgr.waitForQualityApply(),
      setLobbyViewState: (viewName) => sceneMgr.setLobbyViewState(viewName),
      getLobbyViewState: () => sceneMgr.getLobbyViewState(),
      getPerfStats: () => hudUi.getPerfStats(),
      getWeaponAudioStats: () => weaponAudio.getStats(),
      getVfxStats: () => combat.getVfxStats(),
      stepVfx: (dt = 0.016) => {
        ballisticsVfx.update(dt, cam);
        muzzleFlashRig.update(dt);
      },
      setLoopPaused: (paused) => {
        freezeVfxClock = Boolean(paused);
        if (!paused) clock.getDelta();
      },
      triggerRemoteFireTest: (ev) => combat.handleRemoteFireVisuals(ev),
      getViewmodelState: () => {
        const { armsCtrl: curArmsCtrl, armsRoot: curArmsRoot } = assetLoader.getArms();
        let skinningEnabled = false;
        if (curArmsRoot) {
          curArmsRoot.traverse((o) => {
            if (o.isSkinnedMesh && o.material && o.material.skinning) skinningEnabled = true;
          });
        }
        return {
          vmFov: vmCam.fov,
          vmNear: vmCam.near,
          worldFov: cam.fov,
          armsReady: Boolean(curArmsCtrl && curArmsCtrl.ready),
          armsVisible: Boolean(curArmsRoot && curArmsRoot.visible),
          skinningEnabled,
          gunPos: { x: gun.position.x, y: gun.position.y, z: gun.position.z },
          gunRot: { x: gun.rotation.x, y: gun.rotation.y, z: gun.rotation.z },
        };
      },
      setTestCombat: (opts = {}) => {
        if (typeof opts.locked === "boolean") {
          hudUi.setTestLocked(opts.locked);
          input.active = opts.locked;
        }
        combat.setTestCombat(opts);
        if (typeof opts.prone === "boolean") {
          prone = opts.prone;
          if (prone) crouched = false;
          input.setProne(prone);
          eyeHeight = prone ? EYE_PRONE : crouched ? EYE_CROUCH : EYE_STAND;
        }
        if (typeof opts.crouched === "boolean") {
          crouched = opts.crouched;
          if (crouched) {
            prone = false;
            input.setProne(false);
          }
          eyeHeight = prone ? EYE_PRONE : crouched ? EYE_CROUCH : EYE_STAND;
        }
        if (typeof opts.hp === "number" && Number.isFinite(opts.hp)) {
          hp = Math.max(1, Math.min(100, opts.hp));
          hudUi.hud();
          sceneMgr.updateCanvasPostGrade(sceneMgr.getGt());
        }
        if (opts.adsSteps) for (let i = 0; i < opts.adsSteps; i++) vmAnim.gunAnim(0.02, 0);
      },
      damageSolo: (amount) => combat.hurtSolo(amount),
      getRemotePlayers: () => remoteMgr.remotePlayers,
      getWeapons: () => ({
        activeSlot: combat.getActiveSlot(),
        activeWeaponId: SLOT_TO_WEAPON_ID[combat.getActiveSlot()],
        weapons: combat.getWeapons(),
      }),
      getTeamMaterials: () => assetLoader.teamAccentMats,
      getSoldierBodyMaterials: () => assetLoader.soldierBodyMats,
      getIffState: () => ({
        enemyColor: settings && settings.get ? settings.get().enemyHighlightColor : "red",
        rimStrength: settings && settings.get ? settings.get().enemyRimStrength : "strong",
        mapId: sceneMgr.getActiveMapId(),
        enemyUniforms: assetLoader.enemyIffUniforms,
      }),
      getMapInfo: () => sceneMgr.getMapInfo(onLadder),
      getMe: () => ({
        meAlive,
        meTeam,
        meInvuln,
        meProtState,
        deathInfo,
        respawnMs,
        hp,
        ammo: combat.activeWeapon().st.mag,
        reloading: combat.activeWeapon().st.reloadEndsAt > performance.now(),
        crouched,
        prone,
        grounded,
        onLadder,
        isSprinting,
        ads: vmAnim.getAds(),
        flags: curFlags,
        eyeHeight,
      }),
      getBotMatch: () => activeBotMatch,
    }),
  };
}
