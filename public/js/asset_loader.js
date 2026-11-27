/**
 * PBR GLTF/GLB Asset Loader, Material Hydration, Socket Hierarchy & Team Materials.
 */

import { buildSocketPose, createSkinnedArmsController } from "/js/arm_rig.js";

export function createAssetLoader({
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
  getActiveEnvMap,
  getActiveSlot,
  onWeaponsUpgraded,
  onSoldiersUpgraded,
  onGunAnimZero,
}) {
  const Vec = THREE.Vector3;

  const m416MuzAnchorPos = new Vec(0, 0.02, -0.615);
  const pistolMuzAnchorPos = new Vec(0, 0.0495, -0.172);
  const awmMuzAnchorPos = new Vec(0, 0.02, -0.802);
  let awmOpticY = 0.0947;

  let boltVis = new THREE.Object3D();
  let trig = new THREE.Group();
  let ch = new THREE.Group();
  let reticle = new THREE.Object3D();
  let laserLens = new THREE.Object3D();
  let mag = new THREE.Group();
  let pistolSlideNode = new THREE.Object3D();
  let pistolTriggerNode = new THREE.Object3D();
  let pistolMagNode = new THREE.Object3D();
  let awmBoltPivot = new THREE.Object3D();
  let awmMagGroup = new THREE.Object3D();
  let awmTriggerNode = new THREE.Object3D();

  let m416WorldProto = null;
  let pistolWorldProto = null;
  let awmWorldProto = null;
  let soldierProto = null;
  let armsCtrl = null;
  let armsRoot = null;
  let sharedModelsLoaded = false;

  const m416ViewGroup = new THREE.Group();
  const pistolViewGroup = new THREE.Group();
  const pistolPivot = new THREE.Group();
  pistolViewGroup.add(pistolPivot);
  pistolViewGroup.traverse((o) => o.layers.set(VIEW_LAYER));
  pistolViewGroup.visible = false;

  const sniperViewGroup = new THREE.Group();
  function makeSocketNode(name, pos, distal, palmNormal, isRightHand) {
    const pose = buildSocketPose(pos, distal, palmNormal, isRightHand, THREE);
    const node = new THREE.Object3D();
    node.name = name;
    node.position.copy(pose.p);
    node.quaternion.copy(pose.q);
    return node;
  }

  const sniperSockHandguard = makeSocketNode(
    "socket_handguard",
    [-0.028, -0.044, -0.275],
    [-0.20, -0.18, -0.963],
    [0.64, 0.77, -0.04],
    false,
  );
  const sniperSockGrip = makeSocketNode(
    "socket_grip",
    [0.036, -0.062, 0.065],
    [0.14, -0.06, -0.988],
    [-0.95, 0.14, 0.28],
    true,
  );
  const sniperSockMag = makeSocketNode(
    "socket_mag",
    [-0.038, -0.080, -0.090],
    [0.36, -0.16, -0.919],
    [0.88, 0.28, 0.38],
    false,
  );
  const sniperSockBolt = makeSocketNode(
    "socket_charging",
    [0.0604, -0.019, 0.018],
    [0.12, 0.16, -0.98],
    [-0.88, -0.42, 0.22],
    true,
  );
  sniperViewGroup.add(sniperSockHandguard, sniperSockGrip, sniperSockMag, sniperSockBolt);
  sniperViewGroup.traverse((o) => o.layers.set(VIEW_LAYER));
  sniperViewGroup.visible = false;

  // Fallback attachment sockets before async GLB models finish parsing
  const weaponSockets = {
    m416: {
      handguard: makeSocketNode("socket_handguard", [-0.031, -0.033, -0.252], [-0.22, -0.20, -0.954], [0.64, 0.77, -0.04], false),
      grip: makeSocketNode("socket_grip", [0.024, -0.058, 0.082], [0.18, -0.04, -0.983], [-0.96, 0.08, 0.26], true),
      mag: makeSocketNode("socket_mag", [-0.036, -0.130, -0.070], [0.36, -0.16, -0.919], [0.90, 0.28, 0.33], false),
      bolt: makeSocketNode("socket_charging", [-0.026, 0.035, 0.130], [0.68, 0.08, -0.73], [0.24, -0.94, 0.23], false),
    },
    pistol: {
      handguard: makeSocketNode("socket_handguard", [-0.024, -0.038, 0.024], [-0.16, -0.12, -0.980], [0.90, 0.34, 0.27], false),
      grip: makeSocketNode("socket_grip", [0.020, -0.036, 0.056], [0.16, -0.04, -0.986], [-0.96, 0.08, 0.26], true),
      mag: makeSocketNode("socket_mag", [-0.014, -0.072, 0.040], [0.54, -0.18, -0.82], [0.78, 0.32, 0.54], false),
      bolt: makeSocketNode("socket_slide", [-0.015, 0.048, 0.022], [0.66, 0.06, -0.75], [0.35, -0.90, 0.26], false),
    },
    sniper: {
      handguard: sniperSockHandguard,
      grip: sniperSockGrip,
      mag: sniperSockMag,
      bolt: sniperSockBolt,
    },
  };
  m416ViewGroup.add(weaponSockets.m416.handguard, weaponSockets.m416.grip, weaponSockets.m416.mag, weaponSockets.m416.bolt);
  pistolPivot.add(weaponSockets.pistol.handguard, weaponSockets.pistol.grip, weaponSockets.pistol.mag, weaponSockets.pistol.bolt);
  gun.add(m416ViewGroup, pistolViewGroup, sniperViewGroup);

  const teamAccentMats = {};
  function initTeamMaterials(templateMat) {
    const emissiveLevels = { A: 0.48, B: 0.50, FFA: 0.16 };
    for (const key of ["A", "B", "FFA"]) {
      const m = templateMat
        ? templateMat.clone()
        : new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.14 });
      m.name = `TeamColor_${key}`;
      m.color.setHex(TEAM_META[key].colorNum);
      m.emissive.setHex(TEAM_META[key].colorNum);
      m.emissiveIntensity = emissiveLevels[key];
      teamAccentMats[key] = m;
    }
  }
  initTeamMaterials(null);

  function decodeBase64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function hydratePbrMaterial(src, objName = "", envScale = 1.45, isSkinned = false) {
    const phys = (src.userData && src.userData.pbrPhysical) || {};
    const activeEnvMap = getActiveEnvMap();
    if (phys.unlit) {
      const col = src.emissive && src.emissive.getHex() ? src.emissive : src.color;
      const isOverlayReticle = objName === "reticle_group";
      return new THREE.MeshBasicMaterial({
        name: src.name || objName || "",
        color: col,
        side: src.side,
        fog: false,
        toneMapped: false,
        depthWrite: !isOverlayReticle,
        skinning: Boolean(src.skinning || isSkinned),
      });
    }
    const isGlass = phys.transmission > 0 || src.transparent;
    const isHoloLens = objName === "holo_lens";
    const isSkin = src.name === "Arms_WetSkin" || src.name === "Soldier_Skin";
    const isGlove =
      src.name === "Arms_TacticalGlove" ||
      src.name === "Arms_SkinnedGlove" ||
      src.name === "material" ||
      src.name === "Soldier_Glove" ||
      objName.toLowerCase().includes("armmesh");
    const mat = new THREE.MeshPhysicalMaterial({
      name: src.name || objName || "",
      color: src.color,
      map: src.map || null,
      aoMap: src.aoMap || null,
      aoMapIntensity: src.aoMap ? (isSkinned ? 0.95 : 0.85) : (src.aoMapIntensity ?? 0.42),
      metalness: src.metalness,
      roughness: src.roughness,
      roughnessMap: src.roughnessMap || null,
      metalnessMap: src.metalnessMap || null,
      normalMap: src.normalMap || null,
      normalScale: src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1),
      envMap: activeEnvMap,
      envMapIntensity: isHoloLens ? 0.5 : isGlass ? 1.8 : isSkin ? 0.42 : isGlove ? 0.36 : envScale,
      clearcoat: src.name === "AWM_RiflePBR" ? 0.04 : (phys.clearcoat || 0),
      clearcoatRoughness: phys.clearcoatRoughness || 0,
      transparent: isGlass,
      opacity: isHoloLens ? 0.1 : isGlass ? 0.26 : 1,
      depthWrite: !isGlass,
      side: src.side,
      skinning: Boolean(src.skinning || isSkinned),
    });
    if (phys.sheenColor !== undefined) mat.sheen = new THREE.Color(phys.sheenColor);
    if (objName === "watch_dial" && src.map) {
      mat.emissiveMap = src.map;
      mat.emissive = new THREE.Color(0x88ffcc);
      mat.emissiveIntensity = 0.45;
    }
    return mat;
  }

  function applyViewmodelWeapon(weaponId) {
    m416ViewGroup.visible = weaponId === "m416";
    pistolViewGroup.visible = weaponId === "pistol";
    sniperViewGroup.visible = weaponId === "sniper";
    if (weaponId === "pistol") {
      muz.position.copy(pistolMuzAnchorPos);
      muzzleFlashRig.mesh.position.copy(pistolMuzAnchorPos);
      flashL.position.set(pistolMuzAnchorPos.x, pistolMuzAnchorPos.y, pistolMuzAnchorPos.z - 0.04);
    } else if (weaponId === "sniper") {
      muz.position.copy(awmMuzAnchorPos);
      muzzleFlashRig.mesh.position.copy(awmMuzAnchorPos);
      flashL.position.set(awmMuzAnchorPos.x, awmMuzAnchorPos.y, awmMuzAnchorPos.z - 0.09);
    } else {
      muz.position.copy(m416MuzAnchorPos);
      muzzleFlashRig.mesh.position.copy(m416MuzAnchorPos);
      flashL.position.set(m416MuzAnchorPos.x, m416MuzAnchorPos.y, m416MuzAnchorPos.z - 0.07);
    }
  }

  function loadModelAssetAsync(key, glbPath) {
    return new Promise((resolve, reject) => {
      if (typeof THREE.GLTFLoader !== "function") {
        reject(new Error(`THREE.GLTFLoader unavailable for ${key}`));
        return;
      }
      const loader = new THREE.GLTFLoader();
      const b64 = window.FPS_MODELS && window.FPS_MODELS[key];
      if (b64) {
        try {
          loader.parse(decodeBase64ToArrayBuffer(b64), "", resolve, reject);
        } catch (err) {
          reject(err);
        }
        return;
      }
      loader.load(glbPath, resolve, undefined, reject);
    });
  }

  function mountM416Gltf(gltf) {
    const root = gltf.scene;
    const matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (!matCache.has(obj.material)) matCache.set(obj.material, hydratePbrMaterial(obj.material, obj.name, 1.05));
      obj.material = matCache.get(obj.material);
      if (obj.name === "holo_lens") obj.renderOrder = 5;
      if (obj.name === "reticle_group") obj.renderOrder = 10;
    });
    m416WorldProto = root.clone();
    boltVis = root.getObjectByName("bolt_vis") || boltVis;
    trig = root.getObjectByName("trigger_group") || trig;
    ch = root.getObjectByName("charging_handle") || ch;
    reticle = root.getObjectByName("reticle_group") || reticle;
    laserLens = root.getObjectByName("laser_lens") || laserLens;
    mag = root.getObjectByName("mag_group") || mag;
    weaponSockets.m416.handguard = root.getObjectByName("socket_handguard") || weaponSockets.m416.handguard;
    weaponSockets.m416.grip = root.getObjectByName("socket_grip") || weaponSockets.m416.grip;
    weaponSockets.m416.mag = root.getObjectByName("socket_mag") || weaponSockets.m416.mag;
    weaponSockets.m416.bolt = root.getObjectByName("socket_charging") || weaponSockets.m416.bolt;
    const muzNode = root.getObjectByName("muzzle_anchor");
    const lasNode = root.getObjectByName("laser_origin");
    if (muzNode) m416MuzAnchorPos.copy(muzNode.position);
    if (lasNode) laserOrigin.position.copy(lasNode.position);
    m416ViewGroup.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[getActiveSlot()] || "m416");
    if (onWeaponsUpgraded) onWeaponsUpgraded();
    if (onGunAnimZero) onGunAnimZero();
    window.__m416Loaded = true;
  }

  function mountPistolGltf(gltf) {
    const root = gltf.scene;
    const matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.88));
      obj.material = matCache.get(ck);
    });
    pistolWorldProto = root.clone();
    pistolSlideNode = root.getObjectByName("pistol_slide") || pistolSlideNode;
    pistolTriggerNode = root.getObjectByName("pistol_trigger") || pistolTriggerNode;
    pistolMagNode = root.getObjectByName("pistol_mag") || pistolMagNode;
    weaponSockets.pistol.handguard = root.getObjectByName("socket_handguard") || weaponSockets.pistol.handguard;
    weaponSockets.pistol.grip = root.getObjectByName("socket_grip") || weaponSockets.pistol.grip;
    weaponSockets.pistol.mag = root.getObjectByName("socket_mag") || weaponSockets.pistol.mag;
    weaponSockets.pistol.bolt = root.getObjectByName("socket_slide") || weaponSockets.pistol.bolt;
    const pMuz = root.getObjectByName("pistol_muzzle");
    if (pMuz) pistolMuzAnchorPos.copy(pMuz.position);
    pistolPivot.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[getActiveSlot()] || "m416");
    if (onWeaponsUpgraded) onWeaponsUpgraded();
    if (onGunAnimZero) onGunAnimZero();
    window.__pistolLoaded = true;
  }

  function mountAwmGltf(gltf) {
    const root = gltf.scene;
    const matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.96));
      obj.material = matCache.get(ck);
    });
    awmWorldProto = root.clone();
    awmBoltPivot = root.getObjectByName("awm_bolt_pivot") || awmBoltPivot;
    awmMagGroup = root.getObjectByName("awm_mag_group") || awmMagGroup;
    awmTriggerNode = root.getObjectByName("trigger") || awmTriggerNode;
    weaponSockets.sniper.handguard = root.getObjectByName("socket_handguard") || weaponSockets.sniper.handguard;
    weaponSockets.sniper.grip = root.getObjectByName("socket_grip") || weaponSockets.sniper.grip;
    weaponSockets.sniper.mag = root.getObjectByName("socket_mag") || weaponSockets.sniper.mag;
    weaponSockets.sniper.bolt =
      root.getObjectByName("socket_bolt_right") ||
      root.getObjectByName("socket_charging") ||
      weaponSockets.sniper.bolt;
    const aMuz = root.getObjectByName("muzzle_anchor");
    if (aMuz) awmMuzAnchorPos.copy(aMuz.position);
    const aEye = root.getObjectByName("scope_eye");
    if (aEye) awmOpticY = aEye.position.y;
    sniperViewGroup.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[getActiveSlot()] || "m416");
    if (onWeaponsUpgraded) onWeaponsUpgraded();
    if (onGunAnimZero) onGunAnimZero();
    window.__awmLoaded = true;
  }

  function mountFpsArmsGltf(gltf) {
    const root = gltf.scene;
    const matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (obj.isSkinnedMesh) obj.frustumCulled = false;
      if (obj.geometry && !obj.geometry.attributes.uv2 && obj.geometry.attributes.uv) {
        obj.geometry.setAttribute("uv2", obj.geometry.attributes.uv);
      }
      const ck = `${obj.material.uuid}:${obj.isSkinnedMesh ? 1 : 0}`;
      if (!matCache.has(ck)) {
        matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.85, Boolean(obj.isSkinnedMesh)));
      }
      obj.material = matCache.get(ck);
    });
    const ctrl = createSkinnedArmsController(root, THREE);
    if (!ctrl || !ctrl.ready) {
      armsCtrl = null;
      armsRoot = null;
      window.__armsLoaded = false;
      console.warn("fps_arms asset missing required skinned rig bones; rebuild with python -m model.build");
      return;
    }
    armsRoot = root;
    armsCtrl = ctrl;
    vmCam.add(root);
    if (onGunAnimZero) onGunAnimZero();
    window.__armsLoaded = true;
  }

  function mountSoldierGltf(gltf) {
    const root = gltf.scene;
    const matCache = new Map();
    let teamTemplate = null;
    root.traverse((obj) => {
      obj.layers.set(0);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (obj.material && (obj.material.name === "TeamColor" || obj.material.name === "Soldier_TeamAccent")) {
        teamTemplate = obj.material;
      }
      if (!matCache.has(obj.material)) matCache.set(obj.material, hydratePbrMaterial(obj.material, obj.name, 1.1));
      obj.material = matCache.get(obj.material);
    });
    if (teamTemplate) initTeamMaterials(hydratePbrMaterial(teamTemplate, "TeamColor", 1.1));
    soldierProto = root;
    if (onSoldiersUpgraded) onSoldiersUpgraded();
    window.__soldierLoaded = true;
  }

  async function loadAllSharedModelsAsync(onProgress = null) {
    if (sharedModelsLoaded) return;
    const specs = [
      { key: "m416", path: "/model/dist/m416.glb", label: "M416 Tactical", mount: mountM416Gltf },
      { key: "pistol", path: "/model/dist/pistol.glb", label: "Glock-17", mount: mountPistolGltf },
      { key: "awm", path: "/model/dist/awm.glb", label: "AWM Sniper", mount: mountAwmGltf },
      { key: "fps_arms", path: "/model/dist/fps_arms.glb", label: "Tay nhân vật FPP", mount: mountFpsArmsGltf },
      { key: "soldier", path: "/model/dist/soldier.glb", label: "Chiến binh LAN", mount: mountSoldierGltf },
    ];
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      if (typeof onProgress === "function") {
        onProgress(i / specs.length, `Nạp mô hình (${i + 1}/${specs.length}): ${sp.label}...`);
      }
      await yieldToUI();
      try {
        const gltf = await loadModelAssetAsync(sp.key, sp.path);
        sp.mount(gltf);
      } catch (err) {
        console.error(`Failed to load model ${sp.key}:`, err);
      }
      await yieldToUI();
    }
    sharedModelsLoaded = true;
    if (typeof onProgress === "function") onProgress(1, "Đã nạp toàn bộ mô hình 3D");
  }

  return {
    teamAccentMats,
    weaponSockets,
    viewGroups: { m416ViewGroup, pistolViewGroup, pistolPivot, sniperViewGroup },
    applyViewmodelWeapon,
    loadAllSharedModelsAsync,
    getPrototypes: () => ({ m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto }),
    getArms: () => ({ armsCtrl, armsRoot }),
    getNodes: () => ({
      boltVis,
      trig,
      ch,
      reticle,
      laserLens,
      mag,
      pistolSlideNode,
      pistolTriggerNode,
      pistolMagNode,
      awmBoltPivot,
      awmMagGroup,
      awmTriggerNode,
    }),
    getMuzzleAnchors: () => ({
      m416MuzAnchorPos,
      pistolMuzAnchorPos,
      awmMuzAnchorPos,
      awmOpticY,
    }),
  };
}

