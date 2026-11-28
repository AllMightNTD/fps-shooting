/**
 * Scene Lifecycle, Graphics Quality Tiering, Multi-Map Cache, GPU Warmup & Weather.
 */

export function createSceneManager({
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
  getDroneProtos,
  getGameState,
  onHarborReady,
}) {
  const Vec = THREE.Vector3;
  const rnd = (a, b) => a + Math.random() * (b - a);

  let initialDefaultMap = "military";
  try {
    if (new URLSearchParams(location.search).get("map") === "harbor") initialDefaultMap = "harbor";
  } catch {}

  let activeMapId = initialDefaultMap;
  let currentActiveMapId = null;
  let harborData = null;
  let militaryData = null;
  let militaryBuildPromise = null;
  let activeCollision = null;
  let activeEnvMap = null;
  const uploadedTextures = new Set();
  const warmedMaps = new Set();
  let sharedGpuWarmed = false;
  let suspendRenderLoop = true;
  let lastWarmupStats = null;

  let activeQuality = initialQuality;
  let gt = 0;
  let ltn = rnd(8, 16);
  let lt = 0;
  let nextBirdAt = rnd(7, 15);

  let shadowDirty = Boolean(activeQuality.preset.shadowsEnabled);
  let forceEmptyShadowClear = !activeQuality.preset.shadowsEnabled;
  let shadowFrameTick = 0;
  let lastCanvasFilter = "";
  let qualityApplySeq = 0;
  let desiredQualityChoice = activeQuality.choice;
  let pendingQualityApply = false;
  let suppressSettingsQualitySync = false;
  let activeQualityApplyPromise = Promise.resolve(activeQuality);

  let lobbyViewMode = "home";
  let lobbyOrbitAngle = 0.45;
  let lobbyOrbitManualLock = false;
  const lobbyCamCurrentPos = new Vec(-18.5, 6.4, -31.5);
  const lobbyCamCurrentTarget = new Vec(0, 1.8, -2);
  let lobbyCamCurrentFov = 66;
  let lobbyShadowLastAngle = -999;

  function emitQualityStatus(pending, resolved) {
    if (typeof onQualityStatusChange !== "function") return;
    try {
      onQualityStatusChange({ pending: Boolean(pending), resolved });
    } catch (err) {
      console.warn("onQualityStatusChange callback error:", err);
    }
  }

  function updateCanvasPostGrade(nowSec = gt) {
    const { activeState, meAlive, hp } = getGameState();
    const inPlayLowHp = activeState === "play" && meAlive && hp < 35;
    const lowHpFactor = inPlayLowHp ? Math.max(0, Math.min(1, (35 - hp) / 25)) : 0;

    let nextFilter = "";
    if (lowHpFactor > 0.05 && activeQuality.preset.lowHpBlurEnabled) {
      const sat = (1.0 - 0.48 * lowHpFactor).toFixed(2);
      nextFilter = `saturate(${sat}) blur(${(lowHpFactor * 1.1).toFixed(2)}px)`;
    }

    if (nextFilter !== lastCanvasFilter) {
      lastCanvasFilter = nextFilter;
      R.domElement.style.filter = nextFilter;
    }

    const lowOv = $("lowHpOverlay");
    if (lowOv) {
      if (lowHpFactor > 0.01) {
        const pulse = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(nowSec * (4.2 + lowHpFactor * 2.6)), 3);
        lowOv.style.opacity = (lowHpFactor * pulse).toFixed(3);
      } else if (lowOv.style.opacity !== "0") {
        lowOv.style.opacity = "0";
      }
    }
  }

  function applyGraphicsQualityNow(choiceOverride = null) {
    const reqChoice = choiceOverride !== null
      ? choiceOverride
      : (settings && settings.get ? settings.get().graphicsQuality : "auto");
    activeQuality = resolveQualityPreset(reqChoice, detectedQualityTier);
    desiredQualityChoice = activeQuality.choice;
    const p = activeQuality.preset;

    const effPr = computeEffectivePixelRatio(p, devicePixelRatio);
    if (Math.abs(R.getPixelRatio() - effPr) > 0.001) {
      R.setPixelRatio(effPr);
      R.setSize(innerWidth, innerHeight);
    }

    const targetFar = activeMapId === "military" ? p.cameraFar : Math.max(200, p.cameraFar);
    if (cam.far !== targetFar) {
      cam.far = targetFar;
      cam.updateProjectionMatrix();
    }

    applyMoonShadowPreset(p, false);
    ballisticsVfx.applyQualityPreset(p);
    if (assetLoader && typeof assetLoader.applySoldierTextureAnisotropy === "function") {
      assetLoader.applySoldierTextureAnisotropy(R, p.maxAnisotropy);
    }
    if (militaryData && militaryData.applyQualityPreset) {
      militaryData.applyQualityPreset(p, cam.position);
      if (activeMapId === "military" && S.fog) {
        S.fog.density = militaryData.fogDensity;
      }
    }

    const vig = $("vignette");
    if (vig) vig.style.opacity = activeMapId === "military" && p.vignetteEnabled ? "1" : "0";
    updateCanvasPostGrade(gt);

    shadowDirty = Boolean(p.shadowsEnabled);
    forceEmptyShadowClear = !p.shadowsEnabled;
    shadowFrameTick = 0;
    return activeQuality;
  }

  function scheduleGraphicsQualityApply(choice) {
    const safeChoice = normalizeQualityChoice(choice);
    const seq = ++qualityApplySeq;
    desiredQualityChoice = safeChoice;
    pendingQualityApply = true;
    emitQualityStatus(true, resolveQualityPreset(safeChoice, detectedQualityTier));

    const prom = (async () => {
      await yieldToUI();
      if (seq !== qualityApplySeq) return activeQuality;
      const res = applyGraphicsQualityNow(safeChoice);
      if (seq === qualityApplySeq) {
        pendingQualityApply = false;
        emitQualityStatus(false, res);
      }
      return res;
    })();
    activeQualityApplyPromise = prom;
    return prom;
  }

  if (settings && typeof settings.onChange === "function") {
    settings.onChange((st) => {
      if (suppressSettingsQualitySync) return;
      if (st && st.graphicsQuality !== desiredQualityChoice) {
        scheduleGraphicsQualityApply(st.graphicsQuality);
      }
    });
  }

  function applySceneEnvMap(targetEnv, isMilitary = false) {
    activeEnvMap = targetEnv;
    S.environment = targetEnv || null;
    const { dMat } = getDroneProtos();
    if (dMat && dMat.envMap !== targetEnv) {
      dMat.envMap = targetEnv;
      dMat.needsUpdate = true;
    }
    const { armsRoot: curArmsEnv } = assetLoader.getArms();
    const { m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto } = assetLoader.getPrototypes();
    for (const root of [gun, curArmsEnv, m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto]) {
      if (!root) continue;
      root.traverse((o) => {
        if (o.isMesh && o.material && "envMap" in o.material && o.name !== "reticle_group") {
          const envChanged = o.material.envMap !== targetEnv;
          if (envChanged) {
            o.material.envMap = targetEnv;
            o.material.needsUpdate = true;
          }
          const mName = o.material.name || "";
          if (mName.includes("GunMetal") || mName.includes("Slide") || mName.includes("ScopePBR")) {
            o.material.envMapIntensity = isMilitary ? 1.18 : 1.05;
          }
        }
      });
    }
    if (isMilitary) {
      vmKey.color.setHex(0xffe9c4);
      vmKey.intensity = 0.82;
      vmFill.color.setHex(0x88aacb);
      vmFill.intensity = 0.20;
      vmRim.color.setHex(0xffce84);
      vmRim.intensity = 0.42;
    } else {
      vmKey.color.setHex(0xbcd0ea);
      vmKey.intensity = 0.42;
      vmFill.color.setHex(0xffb36a);
      vmFill.intensity = 0.14;
      vmRim.color.setHex(0xffc27a);
      vmRim.intensity = 0.26;
    }
    if (assetLoader && typeof assetLoader.applySoldierEnvMap === "function") {
      assetLoader.applySoldierEnvMap(targetEnv);
    }
    remoteMgr.applyEnvMap(targetEnv);
  }

  function isMapCached(mapId) {
    const target = normalizeMapId(mapId);
    return target === "harbor" ? Boolean(harborData) : Boolean(militaryData);
  }

  function getCachedMapData(mapId) {
    const target = normalizeMapId(mapId);
    return target === "harbor" ? harborData : militaryData;
  }

  function computeLobbyOrbitSpec(targetMapId, viewMode, angle) {
    const isMil = targetMapId !== "harbor";
    if (viewMode === "practice") {
      return {
        radius: isMil ? 26.5 : 22.0,
        height: isMil ? 8.2 : 6.4,
        targetX: 0,
        targetY: isMil ? 1.5 : 1.5,
        targetZ: isMil ? -2.0 : 0,
        fov: 64,
        angle: angle + 0.25,
      };
    }
    if (viewMode === "survival") {
      return {
        radius: isMil ? 24.5 : 21.0,
        height: isMil ? 9.0 : 6.8,
        targetX: 0,
        targetY: isMil ? 1.4 : 1.5,
        targetZ: isMil ? -2.0 : 0,
        fov: 61,
        angle,
      };
    }
    if (viewMode === "bot") {
      return {
        radius: isMil ? 23.5 : 20.5,
        height: isMil ? 5.6 : 4.8,
        targetX: 0,
        targetY: isMil ? 1.9 : 1.7,
        targetZ: isMil ? -2.5 : 0,
        fov: 62,
        angle: angle - 0.45,
      };
    }
    if (viewMode === "lan") {
      return {
        radius: isMil ? 27.5 : 22.5,
        height: isMil ? 4.8 : 4.2,
        targetX: 0,
        targetY: isMil ? 2.1 : 1.9,
        targetZ: isMil ? -3.0 : 0,
        fov: 68,
        angle: angle + 0.55,
      };
    }
    return {
      radius: isMil ? 30.0 : 23.0,
      height: isMil ? 6.6 : 5.4,
      targetX: 0,
      targetY: isMil ? 2.0 : 1.8,
      targetZ: isMil ? -2.0 : 0,
      fov: 66,
      angle,
    };
  }

  function applyLobbyCameraImmediate(targetMapId) {
    const spec = computeLobbyOrbitSpec(targetMapId, lobbyViewMode, lobbyOrbitAngle);
    lobbyCamCurrentPos.set(
      Math.cos(spec.angle) * spec.radius,
      spec.height,
      Math.sin(spec.angle) * spec.radius + spec.targetZ,
    );
    lobbyCamCurrentTarget.set(spec.targetX, spec.targetY, spec.targetZ);
    lobbyCamCurrentFov = spec.fov;
    cam.position.copy(lobbyCamCurrentPos);
    cam.lookAt(lobbyCamCurrentTarget);
    if (Math.abs(cam.fov - lobbyCamCurrentFov) > 0.05) {
      cam.fov = lobbyCamCurrentFov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    vmCam.position.copy(cam.position);
    vmCam.quaternion.copy(cam.quaternion);
    vmCam.updateMatrixWorld(true);
  }

  function updateLobbyCamera(dt) {
    const { engineMode } = getGameState();
    if (engineMode !== "idle" || lobbyOrbitManualLock) return;
    lobbyOrbitAngle = (lobbyOrbitAngle + dt * 0.068) % (Math.PI * 2);
    const spec = computeLobbyOrbitSpec(activeMapId, lobbyViewMode, lobbyOrbitAngle);
    const k = dt > 0 ? 1 - Math.exp(-3.4 * dt) : 1;
    const goalX = Math.cos(spec.angle) * spec.radius;
    const goalY = spec.height + Math.sin(lobbyOrbitAngle * 2.0) * 0.45;
    const goalZ = Math.sin(spec.angle) * spec.radius + spec.targetZ;

    lobbyCamCurrentPos.x += (goalX - lobbyCamCurrentPos.x) * k;
    lobbyCamCurrentPos.y += (goalY - lobbyCamCurrentPos.y) * k;
    lobbyCamCurrentPos.z += (goalZ - lobbyCamCurrentPos.z) * k;
    lobbyCamCurrentTarget.x += (spec.targetX - lobbyCamCurrentTarget.x) * k;
    lobbyCamCurrentTarget.y += (spec.targetY - lobbyCamCurrentTarget.y) * k;
    lobbyCamCurrentTarget.z += (spec.targetZ - lobbyCamCurrentTarget.z) * k;
    lobbyCamCurrentFov += (spec.fov - lobbyCamCurrentFov) * k;

    cam.position.copy(lobbyCamCurrentPos);
    cam.lookAt(lobbyCamCurrentTarget);
    if (Math.abs(cam.fov - lobbyCamCurrentFov) > 0.05) {
      cam.fov = lobbyCamCurrentFov;
      cam.updateProjectionMatrix();
    }
    if (activeQuality.preset.shadowsEnabled && Math.abs(lobbyOrbitAngle - lobbyShadowLastAngle) > 0.14) {
      lobbyShadowLastAngle = lobbyOrbitAngle;
      shadowDirty = true;
    }
  }

  function setLobbyBackdropCamera(targetMapId) {
    if (getGameState().engineMode !== "idle") return;
    lobbyOrbitManualLock = false;
    lobbyShadowLastAngle = -999;
    applyLobbyCameraImmediate(targetMapId);
  }

  function activateCachedMap(mapId) {
    const target = normalizeMapId(mapId);
    ballisticsVfx.clear();
    if (target === "harbor") {
      if (!harborData) return false;
      activeMapId = "harbor";
      currentActiveMapId = "harbor";
      activeCollision = null;
      harborGroup.visible = true;
      hemi.visible = moon.visible = warmFill.visible = true;
      if (militaryData && militaryData.group) militaryData.group.visible = false;
      R.outputEncoding = THREE.LinearEncoding;
      R.toneMappingExposure = 1.08;
      const vig = $("vignette");
      if (vig) vig.style.opacity = "0";
      cam.far = Math.max(200, activeQuality.preset.cameraFar);
      cam.updateProjectionMatrix();
      S.background = new THREE.Color(0x050a11);
      S.fog = new THREE.FogExp2(0x050a11, 0.025);
      applySceneEnvMap(harborData.envMap, false);
      if (assetLoader && typeof assetLoader.applyIffSettings === "function") {
        assetLoader.applyIffSettings({ mapId: "harbor" });
      }
      applyMoonShadowPreset(activeQuality.preset, false);
      setLobbyBackdropCamera("harbor");
      updateCanvasPostGrade(gt);
      audioEngine.syncAmbientAudio();
      shadowDirty = Boolean(activeQuality.preset.shadowsEnabled);
      forceEmptyShadowClear = !activeQuality.preset.shadowsEnabled;
      return true;
    }

    if (!militaryData) return false;
    activeMapId = "military";
    currentActiveMapId = "military";
    harborGroup.visible = false;
    hemi.visible = moon.visible = warmFill.visible = false;
    militaryData.group.visible = true;
    activeCollision = militaryData.collision;
    R.outputEncoding = THREE.sRGBEncoding || THREE.LinearEncoding;
    R.toneMappingExposure = 0.86;
    setLobbyBackdropCamera("military");
    militaryData.applyQualityPreset(activeQuality.preset, cam.position);
    const vig = $("vignette");
    if (vig) vig.style.opacity = activeQuality.preset.vignetteEnabled ? "1" : "0";
    cam.far = activeQuality.preset.cameraFar;
    cam.updateProjectionMatrix();
    S.background = new THREE.Color(militaryData.fogColor);
    S.fog = new THREE.FogExp2(militaryData.fogColor, militaryData.fogDensity);
    applySceneEnvMap(militaryData.envMap, true);
    if (assetLoader && typeof assetLoader.applyIffSettings === "function") {
      assetLoader.applyIffSettings({ mapId: "military" });
    }
    if (militaryData.updateAtmosphere) {
      militaryData.updateAtmosphere(gt, cam.position, activeQuality.preset);
    }
    updateCanvasPostGrade(gt);
    audioEngine.syncAmbientAudio();
    shadowDirty = Boolean(activeQuality.preset.shadowsEnabled);
    forceEmptyShadowClear = !activeQuality.preset.shadowsEnabled;
    window.__militaryMapLoaded = true;
    return true;
  }

  async function buildMapAssetsAsync(mapId, onProgress = null) {
    const target = normalizeMapId(mapId);
    if (target === "harbor") {
      const d = await buildHarborSceneAsync(onProgress);
      harborData = d;
      if (onHarborReady) onHarborReady(d);
      return d;
    }
    if (militaryData) return militaryData;
    if (!militaryBuildPromise) {
      militaryBuildPromise = militaryLoader
        .buildMilitaryScene({
          scene: S,
          envMapTargetList: [],
          initialPreset: activeQuality.preset,
          onProgress,
          yieldFn: yieldToUI,
          deferActivate: true,
        })
        .then((res) => {
          militaryData = res;
          window.__militaryMapLoaded = true;
          return res;
        })
        .catch((err) => {
          console.error("Failed to build military map:", err);
          militaryBuildPromise = null;
          throw err;
        });
    }
    return militaryBuildPromise;
  }

  function createWarmupDroneGroup() {
    const g = new THREE.Group();
    const { dMat, droneBodyGeo, droneEyeGeo, droneEyeMat, droneRingGeo } = getDroneProtos();
    const mat = dMat.clone();
    const body = new THREE.Mesh(droneBodyGeo, mat);
    body.scale.y = 0.6;
    body.castShadow = true;
    const eye = new THREE.Mesh(droneEyeGeo, droneEyeMat);
    eye.position.z = 0.42;
    const ring = new THREE.Mesh(droneRingGeo, dMat);
    ring.rotation.x = Math.PI / 2;
    g.add(body, eye, ring);
    return {
      group: g,
      dispose() {
        S.remove(g);
        mat.dispose();
      },
    };
  }

  function createWarmupSoldierGroup() {
    const container = new THREE.Group();
    // Warmup enemy & protected variants so shared `soldier_iff_pbr_v1` shader program compiles upfront
    const rig = remoteMgr.buildSoldierVisual("B", "__warmup__", "enemy");
    container.add(rig.root);

    const muzFlash = new THREE.Mesh(remoteMuzFlashGeo, remoteMuzFlashMat);
    muzFlash.position.set(0.11, 1.3, -0.78);
    container.add(muzFlash);

    const avDummy = { rig, weaponId: "m416" };
    remoteMgr.attachWeaponToRig(avDummy);
    if (avDummy.m416Mesh) avDummy.m416Mesh.visible = true;
    if (avDummy.pistolMesh) avDummy.pistolMesh.visible = true;
    if (avDummy.awmMesh) avDummy.awmMesh.visible = true;

    return {
      group: container,
      dispose() {
        S.remove(container);
      },
    };
  }

  async function warmupGpuForMap(mapId, { includeShared = false, onProgress = null, isStale = null } = {}) {
    const target = normalizeMapId(mapId);
    const mapData = getCachedMapData(target);
    if (!mapData) return null;

    const emit = (frac, detail = "") => {
      if (typeof onProgress === "function") onProgress(frac, detail);
    };

    const tStart = performance.now();
    const prevSuspend = suspendRenderLoop;
    suspendRenderLoop = true;

    emit(0.04, "Tải texture lên bộ nhớ GPU (VRAM)...");
    const textureRoots = [mapData.group, mapData.extraTextures];
    if (includeShared || !sharedGpuWarmed) {
      const { armsRoot: curArmsTex } = assetLoader.getArms();
      const { m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto } = assetLoader.getPrototypes();
      textureRoots.push(
        gun,
        curArmsTex,
        m416WorldProto,
        pistolWorldProto,
        awmWorldProto,
        soldierProto,
        glowTex,
        ballisticsVfx.extraTextures,
      );
    }
    const textures = collectSceneTextures(textureRoots);
    const texResult = await warmupTexturesChunked({
      renderer: R,
      textures,
      batchSize: 3,
      yieldFn: yieldToUI,
      uploadedSet: uploadedTextures,
      onProgress: (f, info) => {
        emit(0.05 + f * 0.40, `Tải VRAM (${info.uploaded}/${info.total} texture)...`);
      },
    });
    await yieldToUI();

    const prevMapId = currentActiveMapId;
    const prevHarborVis = harborGroup.visible;
    const prevMilVis = militaryData && militaryData.group ? militaryData.group.visible : false;
    const prevHemiVis = hemi.visible;
    const prevMoonVis = moon.visible;
    const prevWarmVis = warmFill.visible;
    const prevEncoding = R.outputEncoding;
    const prevExposure = R.toneMappingExposure;
    const prevBg = S.background;
    const prevFog = S.fog;
    const prevEnv = activeEnvMap;

    const prevGunVis = gun.visible;
    const { armsRoot: curArmsPrev } = assetLoader.getArms();
    const prevArmsVis = curArmsPrev ? curArmsPrev.visible : false;
    const prevFlashInt = flashL.intensity;
    const prevLaserVis = laserBeam.visible;
    const prevDotVis = laserDot.visible;
    const prevCamPos = cam.position.clone();
    const prevCamRot = cam.rotation.clone();

    let warmupDrone = null;
    let warmupSoldier = null;
    let worldCompileMode = "noop";
    let vmCompileMode = "noop";
    let militaryWarmupActive = false;
    let harborWarmupActive = false;
    let vfxWarmupActive = false;

    try {
      if (target === "military") {
        harborGroup.visible = false;
        hemi.visible = moon.visible = warmFill.visible = false;
        mapData.group.visible = true;
        R.outputEncoding = THREE.sRGBEncoding || THREE.LinearEncoding;
        R.toneMappingExposure = 0.86;
        S.background = new THREE.Color(mapData.fogColor);
        S.fog = new THREE.FogExp2(mapData.fogColor, mapData.fogDensity);
        applySceneEnvMap(mapData.envMap, true);
        cam.position.set(0, EYE_STAND, -40);
        cam.rotation.set(0, Math.PI, 0);
        if (mapData.updateAtmosphere) mapData.updateAtmosphere(gt, cam.position, activeQuality.preset);
        if (mapData.setWarmupPassActive) {
          mapData.setWarmupPassActive(true, activeQuality.preset, cam.position);
          militaryWarmupActive = true;
        }
      } else {
        if (militaryData && militaryData.group) militaryData.group.visible = false;
        harborGroup.visible = true;
        hemi.visible = moon.visible = warmFill.visible = true;
        R.outputEncoding = THREE.LinearEncoding;
        R.toneMappingExposure = 1.08;
        S.background = new THREE.Color(0x050a11);
        S.fog = new THREE.FogExp2(0x050a11, 0.025);
        applySceneEnvMap(mapData.envMap, false);
        cam.position.set(0, EYE_STAND, 0);
        cam.rotation.set(0, 0, 0);
        applyMoonShadowPreset(activeQuality.preset, true);
        harborWarmupActive = true;
      }
      cam.updateMatrixWorld(true);
      vmCam.position.copy(cam.position);
      vmCam.quaternion.copy(cam.quaternion);
      vmCam.updateMatrixWorld(true);

      const fwdZ = target === "military" ? 7.5 : -7.5;
      warmupDrone = createWarmupDroneGroup();
      warmupDrone.group.position.set(0, 2.2, cam.position.z + fwdZ);
      S.add(warmupDrone.group);

      if (includeShared || !sharedGpuWarmed) {
        warmupSoldier = createWarmupSoldierGroup();
        warmupSoldier.group.position.set(2.2, 0, cam.position.z + fwdZ);
        S.add(warmupSoldier.group);
      }

      laserBeam.visible = true;
      laserDot.visible = true;
      laserDot.position.set(0, 1.7, cam.position.z + fwdZ);
      ballisticsVfx.setWarmupPassActive(true, cam.position, target === "military" ? 1 : -1);
      vfxWarmupActive = true;

      emit(0.52, "Biên dịch Shader bản đồ, VFX & Drone...");
      cam.layers.set(0);
      worldCompileMode = await compileScenePass({ renderer: R, scene: S, camera: cam });
      await yieldToUI();

      if (includeShared || !sharedGpuWarmed) {
        gun.visible = true;
        const { armsRoot: curArmsWarm } = assetLoader.getArms();
        if (curArmsWarm) curArmsWarm.visible = true;
        muzzleFlashRig.setWarmupVisible(true);
        flashL.intensity = 6;
        vmAnim.gunAnim(0, 0);
        vmCam.layers.set(VIEW_LAYER);

        const weaponWarmPasses = [
          { id: "m416", pct: 0.64, msg: "Biên dịch Shader M416, tay cầm & chớp lửa..." },
          { id: "pistol", pct: 0.74, msg: "Biên dịch Shader Glock-17 & chớp lửa..." },
          { id: "sniper", pct: 0.84, msg: "Biên dịch Shader AWM Sniper..." },
        ];
        const { m416ViewGroup, pistolViewGroup, sniperViewGroup } = assetLoader.viewGroups;
        for (const wp of weaponWarmPasses) {
          emit(wp.pct, wp.msg);
          m416ViewGroup.visible = wp.id === "m416";
          pistolViewGroup.visible = wp.id === "pistol";
          sniperViewGroup.visible = wp.id === "sniper";
          vmCompileMode = await compileScenePass({ renderer: R, scene: S, camera: vmCam });
          await yieldToUI();
        }
        m416ViewGroup.visible = true;
        pistolViewGroup.visible = true;
        sniperViewGroup.visible = true;
      }

      emit(0.92, "Render nháp 1 khung hình làm nóng GPU...");
      R.shadowMap.needsUpdate = true;
      cam.layers.set(0);
      R.clear();
      R.render(S, cam);

      const savedBgForVm = S.background;
      S.background = null;
      R.clearDepth();
      vmCam.layers.set(VIEW_LAYER);
      R.render(S, vmCam);
      S.background = savedBgForVm;

      if (militaryWarmupActive && mapData.setWarmupPassActive) {
        mapData.setWarmupPassActive(false, activeQuality.preset, cam.position);
        militaryWarmupActive = false;
      }
      if (harborWarmupActive) {
        applyMoonShadowPreset(activeQuality.preset, false);
        harborWarmupActive = false;
      }
      if (!activeQuality.preset.shadowsEnabled) {
        R.shadowMap.needsUpdate = true;
        cam.layers.set(0);
        R.clear();
        R.render(S, cam);
      }

      await yieldToUI();
      warmedMaps.add(target);
      if (includeShared) sharedGpuWarmed = true;
    } finally {
      if (militaryWarmupActive && mapData.setWarmupPassActive) {
        mapData.setWarmupPassActive(false, activeQuality.preset, cam.position);
      }
      if (harborWarmupActive) {
        applyMoonShadowPreset(activeQuality.preset, false);
      }
      if (warmupDrone) warmupDrone.dispose();
      if (warmupSoldier) warmupSoldier.dispose();
      if (vfxWarmupActive) ballisticsVfx.setWarmupPassActive(false);

      assetLoader.applyViewmodelWeapon(SLOT_TO_WEAPON_ID[getGameState().activeSlot] || "m416");
      gun.visible = prevGunVis;
      const { armsRoot: curArmsAfter } = assetLoader.getArms();
      if (curArmsAfter) curArmsAfter.visible = prevArmsVis;
      muzzleFlashRig.setWarmupVisible(false);
      flashL.intensity = prevFlashInt;
      laserBeam.visible = prevLaserVis;
      laserDot.visible = prevDotVis;

      const superseded = typeof isStale === "function" && isStale();
      if (superseded && prevMapId && prevMapId !== target) {
        harborGroup.visible = prevHarborVis;
        if (militaryData && militaryData.group) militaryData.group.visible = prevMilVis;
        hemi.visible = prevHemiVis;
        moon.visible = prevMoonVis;
        warmFill.visible = prevWarmVis;
        R.outputEncoding = prevEncoding;
        R.toneMappingExposure = prevExposure;
        S.background = prevBg;
        S.fog = prevFog;
        if (prevEnv) applySceneEnvMap(prevEnv, prevMapId === "military");
        cam.position.copy(prevCamPos);
        cam.rotation.copy(prevCamRot);
        cam.updateMatrixWorld(true);
        vmCam.position.copy(cam.position);
        vmCam.quaternion.copy(cam.quaternion);
        vmCam.updateMatrixWorld(true);
      }

      shadowDirty = false;
      forceEmptyShadowClear = false;
      suspendRenderLoop = prevSuspend;
    }

    lastWarmupStats = {
      mapId: target,
      texturesUploaded: texResult.uploaded,
      texturesSkipped: texResult.skipped,
      texturesFailed: texResult.failed,
      worldCompileMode,
      vmCompileMode,
      elapsedMs: Math.round(performance.now() - tStart),
    };
    emit(1.0, "Hoàn tất làm nóng GPU");
    return lastWarmupStats;
  }

  const mapGuard = createMapSwitchGuard({
    isMapReady: (id) => isMapCached(id) && warmedMaps.has(id),
    getActiveMapId: () => currentActiveMapId,
    activateCached: (id) => activateCachedMap(id),
    buildAndWarmup: async (id, opts) => {
      const report = typeof opts.onProgress === "function" ? opts.onProgress : null;
      await buildMapAssetsAsync(id, (f, detail) => {
        if (report) report(f * 0.65, detail);
      });
      await warmupGpuForMap(id, {
        includeShared: !sharedGpuWarmed,
        isStale: opts.isStale,
        onProgress: (f, detail) => {
          if (report) report(0.65 + f * 0.35, detail);
        },
      });
    },
  });

  function emitLoading(payload) {
    if (typeof onLoadingUpdate === "function") {
      try {
        onLoadingUpdate(payload);
      } catch (err) {
        console.warn("onLoadingUpdate callback error:", err);
      }
    }
  }

  async function prepareMap(mapId, { showOverlay = true } = {}) {
    const target = normalizeMapId(mapId);
    const t0 = performance.now();

    const syncRes = mapGuard.activateSyncIfCached(target);
    if (syncRes.ok) {
      return { ...syncRes, sync: true, elapsedMs: 0 };
    }

    const mapLabel = target === "harbor" ? "Bến Cảng Mưa" : "Khu Quân Sự Cũ";
    const tracker = createLoadingTracker((st) => {
      if (showOverlay) {
        emitLoading({
          visible: true,
          mode: "map-switch",
          title: `Đang tải bản đồ ${mapLabel}...`,
          percent: st.percent,
          label: st.label,
          detail: st.detail,
        });
      }
    });
    tracker.reset(`Đang chuyển sang ${mapLabel}...`, "Chuẩn bị tài nguyên bản đồ");
    await yieldToUI();

    try {
      const res = await mapGuard.ensureMapReady(target, {
        onProgress: tracker.subProgress(5, 98, `Đang nạp ${mapLabel}...`),
      });
      tracker.report(100, `Đã sẵn sàng: ${mapLabel}`, "");
      await yieldToUI();
      return { ...res, elapsedMs: Math.round(performance.now() - t0) };
    } finally {
      if (showOverlay && !mapGuard.isBusy()) {
        emitLoading({ visible: false, done: true, mode: "map-switch", percent: 100 });
      }
    }
  }

  function ensureMapActive(mapId = "military") {
    const target = normalizeMapId(mapId);
    const syncRes = mapGuard.activateSyncIfCached(target);
    if (syncRes.ok) return Promise.resolve(getCachedMapData(target));
    return prepareMap(target, { showOverlay: true }).then(() => getCachedMapData(target));
  }

  function updateWeatherAndRain(dt) {
    gt += dt;
    const { engineMode, activeState, P } = getGameState();
    const { snd, hasAudioContext, updateAmbientWind } = audioEngine;
    if (activeMapId !== "harbor") {
      if (militaryData && militaryData.updateAtmosphere) {
        if (militaryData.updateAtmosphere(gt, cam.position, activeQuality.preset)) {
          shadowDirty = true;
        }
      }
      updateAmbientWind(gt);
      if (activeState === "play" && hasAudioContext()) {
        nextBirdAt -= dt;
        if (nextBirdAt <= 0) {
          nextBirdAt = rnd(10, 22);
          snd.distantBird();
        }
      }
      return;
    }

    if (harborData) {
      const rx = engineMode === "idle" ? cam.position.x : P.x;
      const rz = engineMode === "idle" ? cam.position.z : P.z;
      harborData.updateRain(dt, gt, rx, rz);
    }

    ltn -= dt;
    if (ltn <= 0) {
      ltn = rnd(12, 26);
      lt = 0.4;
      setTimeout(() => snd.thunder(), rnd(500, 2200));
    }
    lt = Math.max(0, lt - dt);
    const b = lt > 0.28 || (lt < 0.2 && lt > 0.1) ? 1 : lt > 0 ? 0.3 : 0;
    hemi.intensity = 0.28 + b * 2.0;
    moon.intensity = 0.38 + b * 1.7;
    S.fog.color.setRGB(0.020 + b * 0.24, 0.039 + b * 0.27, 0.067 + b * 0.33);
    S.background.copy(S.fog.color);
  }

  return {
    getInitialDefaultMap: () => initialDefaultMap,
    getActiveMapId: () => activeMapId,
    getCurrentActiveMapId: () => currentActiveMapId,
    getActiveCollision: () => activeCollision,
    getActiveEnvMap: () => activeEnvMap,
    getHarborData: () => harborData,
    getMilitaryData: () => militaryData,
    getActiveQuality: () => activeQuality,
    getGt: () => gt,
    isSuspended: () => suspendRenderLoop,
    setSuspended: (v) => { suspendRenderLoop = Boolean(v); },
    markShadowDirty: () => { shadowDirty = true; },
    consumeShadowUpdate(hasDynamicCasters) {
      if (activeQuality.preset.shadowsEnabled) {
        shadowFrameTick++;
        if (shadowDirty || (hasDynamicCasters && shadowFrameTick >= activeQuality.preset.shadowUpdateInterval)) {
          shadowDirty = false;
          shadowFrameTick = 0;
          return true;
        }
        return false;
      }
      if (forceEmptyShadowClear) {
        forceEmptyShadowClear = false;
        return true;
      }
      return false;
    },
    isMapCached,
    getCachedMapData,
    isMapActiveAndReady: (mapId) => mapGuard.isActiveAndReady(mapId),
    activateSyncIfCached: (mapId) => mapGuard.activateSyncIfCached(mapId),
    buildMapAssetsAsync,
    activateCachedMap,
    warmupGpuForMap,
    prepareMap,
    ensureMapActive,
    emitLoading,
    updateCanvasPostGrade,
    updateWeatherAndRain,
    applyLobbyCameraImmediate,
    updateLobbyCamera,
    setLobbyOrbitLocked: (v) => { lobbyOrbitManualLock = Boolean(v); },
    setLobbyViewState: (viewName) => {
      if (
        viewName === "practice" ||
        viewName === "survival" ||
        viewName === "bot" ||
        viewName === "lan" ||
        viewName === "home"
      ) {
        lobbyViewMode = viewName;
      }
    },
    getLobbyViewState: () => ({
      viewMode: lobbyViewMode,
      orbitAngle: lobbyOrbitAngle,
      camPos: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
      camFov: +cam.fov.toFixed(2),
    }),
    getLoadingStats: (isBootstrapped) => ({
      isBootstrapped,
      currentActiveMapId,
      cachedMaps: [
        ...(militaryData ? ["military"] : []),
        ...(harborData ? ["harbor"] : []),
      ],
      warmedMaps: Array.from(warmedMaps),
      uploadedTextureCount: uploadedTextures.size,
      sharedGpuWarmed,
      lastWarmupStats,
    }),
    getGraphicsQuality: () => ({
      choice: activeQuality.choice,
      desiredChoice: desiredQualityChoice,
      pendingApply: pendingQualityApply,
      detectedTier: activeQuality.detectedTier,
      effectiveTier: activeQuality.effectiveTier,
      preset: activeQuality.preset,
      hwInfo,
      pixelRatio: R.getPixelRatio(),
      cameraFar: cam.far,
      shadowMapEnabled: Boolean(activeQuality.preset.shadowsEnabled),
      rendererShadowMapEnabled: R.shadowMap.enabled,
      rendererShadowMapType: R.shadowMap.type,
      mapQualityStats: militaryData && militaryData.getQualityStats ? militaryData.getQualityStats() : null,
    }),
    setGraphicsQuality: (choice, opts = {}) => {
      const safeChoice = normalizeQualityChoice(choice);
      if (opts && opts.sync) {
        qualityApplySeq++;
        desiredQualityChoice = safeChoice;
        pendingQualityApply = false;
        if (settings && typeof settings.update === "function" && settings.get().graphicsQuality !== safeChoice) {
          suppressSettingsQualitySync = true;
          try {
            settings.update({ graphicsQuality: safeChoice });
          } finally {
            suppressSettingsQualitySync = false;
          }
        }
        const res = applyGraphicsQualityNow(safeChoice);
        emitQualityStatus(false, res);
        activeQualityApplyPromise = Promise.resolve(res);
        return res;
      }
      if (settings && typeof settings.update === "function" && settings.get().graphicsQuality !== safeChoice) {
        suppressSettingsQualitySync = true;
        try {
          settings.update({ graphicsQuality: safeChoice });
        } finally {
          suppressSettingsQualitySync = false;
        }
      }
      return scheduleGraphicsQualityApply(safeChoice);
    },
    waitForQualityApply: () => activeQualityApplyPromise,
    getMapInfo: (onLadder) => ({
      mapId: activeMapId,
      currentActiveMapId,
      ready: isMapCached(activeMapId),
      warmed: warmedMaps.has(activeMapId),
      onLadder,
      bounds: activeCollision ? activeCollision.bounds : { minX: -48, maxX: 48, minZ: -48, maxZ: 48 },
      raycastShot: activeCollision ? activeCollision.raycastShot : null,
    }),
  };
}
