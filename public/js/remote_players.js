/**
 * Remote LAN Player Avatars, 100ms Snapshot Interpolation, Competitive IFF (Package A)
 * & Smart Friendly World-Space Markers (PUBG Crosshair Fade + Valorant Geometric Fresnel).
 * Supports both legacy procedural soldier rigs and Mixamo/AccuRIG SkinnedMesh AnimationMixer rigs.
 */

import {
  ALLY_IFF_META,
  computeFriendlyMarkerLayout,
  getEnemyHighlightPreset,
  resolvePlayerRelation,
} from "./iff_system.js";
import { SOLDIER_SCALE_XZ, SOLDIER_SCALE_Y, computeProtectionBlinkState } from "./spawn_rules.js";
import {
  CROUCH_DIR_KEYS,
  SOLDIER_BONE_ALIASES,
  SOLDIER_CLIP_KEYS,
  cloneSkinnedHierarchy,
  computeCrouchDirectionalWeights,
  findSoldierClip,
  hasSkinnedMesh,
  resolveRigBone,
  selectSoldierAnimState,
  stepNormalizedActionWeights,
} from "./skinned_clone.js";

export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function createRemotePlayersManager({
  THREE,
  scene,
  net,
  TEAM_META,
  FLAG,
  INTERP_DELAY_MS,
  remoteMuzFlashGeo,
  remoteMuzFlashMat,
  getPrototypes,
  getTeamAccentMats,
  getSoldierBodyMats = () => null,
  getIffState = () => ({ enemyColor: "red", rimStrength: "strong" }),
  getMatchMeta,
  getCamera = () => null,
  getActiveCollision = () => null,
  getSolidMeshes = () => [],
  getLocalAds = () => 0,
}) {
  const remotePlayers = new Map();
  const _muzWorldPos = new THREE.Vector3();
  const _markerWorldPos = new THREE.Vector3();
  const _markerNdc = new THREE.Vector3();
  const _losDir = new THREE.Vector3();
  const _losRay = typeof THREE.Raycaster === "function" ? new THREE.Raycaster() : null;
  const _zeroVec = new THREE.Vector3(0, 0, 0);
  const _rhWorld = new THREE.Vector3();
  const _lhWorld = new THREE.Vector3();
  const _handDir = new THREE.Vector3();
  const _charFwd = new THREE.Vector3();
  const _charUp = new THREE.Vector3();
  const _aimDir = new THREE.Vector3();
  const _poseScratch = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    mv: 0,
    flags: 0,
    weaponId: "m416",
    reloading: false,
    hp: 100,
    alive: true,
    invulnerable: false,
    iFrames: false,
    protectExpiring: false,
  };
  const _contQuat = typeof THREE.Quaternion === "function" ? new THREE.Quaternion() : null;
  const _parentQuat = typeof THREE.Quaternion === "function" ? new THREE.Quaternion() : null;
  const _desiredWorldQuat = typeof THREE.Quaternion === "function" ? new THREE.Quaternion() : null;
  const _lookMat = typeof THREE.Matrix4 === "function" ? new THREE.Matrix4() : null;
  const _hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const _headHitGeo = new THREE.SphereGeometry(0.155, 8, 6);
  const _torsoHitGeo = new THREE.BoxGeometry(0.36, 0.44, 0.24);
  const _hipsHitGeo = new THREE.BoxGeometry(0.34, 0.24, 0.22);
  const _thighHitGeo = new THREE.BoxGeometry(0.16, 0.42, 0.16);
  const _calfHitGeo = new THREE.BoxGeometry(0.14, 0.42, 0.16);

  function resolveRelationForTeam(team) {
    const meta = (typeof getMatchMeta === "function" && getMatchMeta()) || {};
    return resolvePlayerRelation({
      currentMode: meta.currentMode || "TDM",
      meTeam: meta.meTeam || "A",
      targetTeam: team,
    });
  }

  function resolveAccentMaterial(team, relation) {
    const mats = getTeamAccentMats() || {};
    if (mats[relation]) return mats[relation];
    const tKey = team === "A" || team === "B" ? team : "FFA";
    return mats[tKey] || mats.A || mats.FFA || null;
  }

  function resolveShieldColorHex(relation) {
    if (relation === "ally") return ALLY_IFF_META.shieldHex;
    const iff = (typeof getIffState === "function" && getIffState()) || {};
    return getEnemyHighlightPreset(iff.enemyColor).shieldHex;
  }

  function applyRigRelation(rig, team, relation) {
    if (!rig) return;
    const bodyMats = typeof getSoldierBodyMats === "function" ? getSoldierBodyMats() : null;
    const accMat = resolveAccentMaterial(team, relation);
    // 3B: Blue LED patches on Allies only; completely hidden on real SWAT Enemies for an ultra-clean Valorant silhouette
    const showTeamPatches = rig.isFallback ? true : relation === "ally";

    if (Array.isArray(rig.bodyMeshes) && bodyMats && bodyMats[relation]) {
      const targetBodyMat = bodyMats[relation];
      for (let i = 0; i < rig.bodyMeshes.length; i++) {
        rig.bodyMeshes[i].material = targetBodyMat;
      }
    }
    if (Array.isArray(rig.teamPatchMeshes)) {
      for (let i = 0; i < rig.teamPatchMeshes.length; i++) {
        const pm = rig.teamPatchMeshes[i];
        if (accMat) pm.material = accMat;
        pm.visible = showTeamPatches;
      }
    }
  }

  function addBoneHitbox(parent, name, geo, pos, part, playerId, hitMeshes) {
    if (!parent) return;
    const mesh = new THREE.Mesh(geo, _hitboxMat);
    mesh.name = name;
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.userData.hitTarget = { id: playerId, part };
    parent.add(mesh);
    hitMeshes.push(mesh);
  }

  function buildSkinnedHitboxes(root, playerId) {
    const hitMeshes = [];
    const headBone = resolveRigBone(root, SOLDIER_BONE_ALIASES.head);
    const spineBone = resolveRigBone(root, SOLDIER_BONE_ALIASES.spine);
    const hipsBone = resolveRigBone(root, SOLDIER_BONE_ALIASES.hips);
    const lUpLeg = resolveRigBone(root, SOLDIER_BONE_ALIASES.leftUpLeg);
    const lLeg = resolveRigBone(root, SOLDIER_BONE_ALIASES.leftLeg);
    const rUpLeg = resolveRigBone(root, SOLDIER_BONE_ALIASES.rightUpLeg);
    const rLeg = resolveRigBone(root, SOLDIER_BONE_ALIASES.rightLeg);

    addBoneHitbox(headBone, "hitbox_head", _headHitGeo, [0, 0.14, 0], "head", playerId, hitMeshes);
    addBoneHitbox(spineBone, "hitbox_torso", _torsoHitGeo, [0, 0.08, 0], "body", playerId, hitMeshes);
    addBoneHitbox(hipsBone, "hitbox_hips", _hipsHitGeo, [0, 0, 0], "body", playerId, hitMeshes);
    addBoneHitbox(lUpLeg, "hitbox_thigh_l", _thighHitGeo, [0, 0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(lLeg, "hitbox_calf_l", _calfHitGeo, [0, 0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(rUpLeg, "hitbox_thigh_r", _thighHitGeo, [0, 0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(rLeg, "hitbox_calf_r", _calfHitGeo, [0, 0.2, 0], "limb", playerId, hitMeshes);

    if (hitMeshes.length === 0) {
      addBoneHitbox(root, "hitbox_fallback_body", _torsoHitGeo, [0, 1.0, 0], "body", playerId, hitMeshes);
      addBoneHitbox(root, "hitbox_fallback_head", _headHitGeo, [0, 1.63, 0], "head", playerId, hitMeshes);
    }
    return { hitMeshes, headBone, spineBone };
  }

  const CROUCH_DIR_SET = new Set(CROUCH_DIR_KEYS);

  function buildSoldierActions(mixer, animations) {
    const actions = {};
    if (!mixer || !Array.isArray(animations) || !animations.length) return actions;
    const seenClips = new Set();
    for (const key of SOLDIER_CLIP_KEYS) {
      const clip = findSoldierClip(animations, key);
      if (!clip || seenClips.has(clip)) continue;
      seenClips.add(clip);
      const act = mixer.clipAction(clip);
      if (key === "jump") {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      } else {
        act.setLoop(THREE.LoopRepeat, Infinity);
      }
      act.setEffectiveWeight(0);
      actions[key] = act;
    }
    return actions;
  }

  function tagHitMeshes(root, playerId) {
    const hitMeshes = [];
    const headNode = root.getObjectByName("head_group");
    const legL = root.getObjectByName("leg_left");
    const legR = root.getObjectByName("leg_right");
    const headSet = new Set();
    const legSet = new Set();
    if (headNode) headNode.traverse((o) => headSet.add(o));
    if (legL) legL.traverse((o) => legSet.add(o));
    if (legR) legR.traverse((o) => legSet.add(o));

    root.traverse((o) => {
      if (!o.isMesh) return;
      const part = headSet.has(o) ? "head" : legSet.has(o) ? "limb" : "body";
      o.userData.hitTarget = { id: playerId, part };
      hitMeshes.push(o);
    });
    return hitMeshes;
  }

  function buildSoldierVisual(team, playerId, relationOverride = null) {
    const relation = relationOverride || resolveRelationForTeam(team);
    const { soldierProto, soldierAnimations } = getPrototypes();

    if (!soldierProto) {
      const root = new THREE.Group();
      if (root.scale && typeof root.scale.set === "function") {
        root.scale.set(SOLDIER_SCALE_XZ, SOLDIER_SCALE_Y, SOLDIER_SCALE_XZ);
      }
      const uni = new THREE.MeshStandardMaterial({ color: 0x323b42, roughness: 0.75 });
      const acc = resolveAccentMaterial(team, relation);
      const upper = new THREE.Group();
      upper.position.set(0, 0.96, 0);
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.5, 0.22), uni);
      torso.position.set(0, 0.25, 0);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.24), acc);
      strip.position.set(0, 0.36, 0);
      const headGroup = new THREE.Group();
      headGroup.name = "head_group";
      headGroup.position.set(0, 0.5, 0);
      const helm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), acc);
      helm.position.set(0, 0.14, 0);
      headGroup.add(helm);
      const weaponMount = new THREE.Object3D();
      weaponMount.position.set(0.105, 0.31, -0.305);
      upper.add(torso, strip, headGroup, weaponMount);

      const legL = new THREE.Group();
      legL.name = "leg_left";
      legL.position.set(-0.105, 0.86, 0);
      const mL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.84, 0.14), uni);
      mL.position.set(0, -0.43, 0);
      legL.add(mL);
      const legR = legL.clone();
      legR.name = "leg_right";
      legR.position.x = 0.105;
      root.add(upper, legL, legR);
      return {
        root,
        upper,
        headGroup,
        legL,
        legR,
        weaponMount,
        bodyMeshes: [],
        teamPatchMeshes: [strip, helm],
        hitMeshes: tagHitMeshes(root, playerId),
        isFallback: true,
      };
    }

    const isSkinned = hasSkinnedMesh(soldierProto);
    const root = isSkinned ? cloneSkinnedHierarchy(soldierProto, THREE) : soldierProto.clone();
    if (root.scale && typeof root.scale.set === "function") {
      root.scale.set(SOLDIER_SCALE_XZ, SOLDIER_SCALE_Y, SOLDIER_SCALE_XZ);
    }
    const bodyMeshes = [];
    const teamPatchMeshes = [];
    root.traverse((o) => {
      o.layers.set(0);
      if (o.isSkinnedMesh) o.frustumCulled = false;
      if (!o.isMesh) return;
      const isTeamPatch =
        o.name.includes("team") ||
        Boolean(o.material && (o.material.name === "TeamColor" || o.material.name === "Soldier_TeamAccent"));
      if (isTeamPatch) {
        teamPatchMeshes.push(o);
      } else if (o.isSkinnedMesh) {
        bodyMeshes.push(o);
      }
    });

    if (isSkinned) {
      const mixer = new THREE.AnimationMixer(root);
      const actions = buildSoldierActions(mixer, soldierAnimations);
      const actionKeys = Object.keys(actions);
      const initialKey = actions.idle ? "idle" : actionKeys[0] || "";
      const initialAct = initialKey ? actions[initialKey] : null;
      const actionWeights = {};
      const targetWeights = {};
      for (const k of actionKeys) {
        const w = k === initialKey ? 1 : 0;
        actionWeights[k] = w;
        targetWeights[k] = w;
        actions[k].setEffectiveWeight(w);
      }
      if (initialAct) {
        initialAct.enabled = true;
        initialAct.play();
      }
      const { hitMeshes, headBone, spineBone } = buildSkinnedHitboxes(root, playerId);
      const hipsBone = resolveRigBone(root, SOLDIER_BONE_ALIASES.hips);
      const weaponMount = resolveRigBone(root, SOLDIER_BONE_ALIASES.rightHand);
      const leftHandBone = resolveRigBone(root, SOLDIER_BONE_ALIASES.leftHand);
      const rig = {
        root,
        isSkinned: true,
        isFallback: false,
        mixer,
        actions,
        actionKeys,
        actionWeights,
        targetWeights,
        hasDirectionalCrouch: CROUCH_DIR_KEYS.every((k) => Boolean(actions[k])),
        activeAction: initialAct,
        activeState: initialKey,
        lastBlendDur: 0.11,
        hipsBone,
        headBone,
        spineBone,
        weaponMount,
        leftHandBone,
        bodyMeshes,
        teamPatchMeshes,
        hitMeshes,
      };
      applyRigRelation(rig, team, relation);
      return rig;
    }

    const rig = {
      root,
      upper: root.getObjectByName("upper_body") || root,
      headGroup: root.getObjectByName("head_group"),
      armsGroup: root.getObjectByName("arms_group"),
      legL: root.getObjectByName("leg_left"),
      legR: root.getObjectByName("leg_right"),
      weaponMount: root.getObjectByName("weapon_mount"),
      bodyMeshes,
      teamPatchMeshes,
      hitMeshes: tagHitMeshes(root, playerId),
      isFallback: false,
    };
    applyRigRelation(rig, team, relation);
    return rig;
  }

  function updateNameplateSprite(sp, name, hpVal, { compact = false, distM = 0 } = {}) {
    const hpBucket = Math.max(0, Math.min(100, Math.round((hpVal || 0) / 2) * 2));
    const distTag = compact ? Math.max(1, Math.round(distM || 0)) : 0;
    const key = compact ? `C:${distTag}` : `F:${name}:${hpBucket}`;
    if (sp.userData.lastKey === key) return;
    sp.userData.lastKey = key;
    const c = sp.userData.canvas;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);

    const drawChevron = (cx, topY, halfW, h) => {
      if (typeof g.beginPath === "function") {
        g.beginPath();
        g.moveTo(cx - halfW, topY);
        g.lineTo(cx + halfW, topY);
        g.lineTo(cx, topY + h);
        g.closePath();
        g.fillStyle = ALLY_IFF_META.markerHex;
        g.fill();
        g.lineWidth = 2.5;
        g.strokeStyle = "rgba(4, 10, 18, 0.9)";
        g.stroke();
      } else {
        g.fillStyle = ALLY_IFF_META.markerHex;
        g.fillRect(cx - halfW, topY, halfW * 2, h);
      }
    };

    if (compact) {
      // Compact PUBG/Valorant wall-through ally indicator: crisp larger cyan chevron + meters
      drawChevron(128, 18, 22, 24);
      g.font = "bold 24px sans-serif";
      g.textAlign = "center";
      if (typeof g.strokeText === "function") {
        g.lineWidth = 5;
        g.strokeStyle = "rgba(4, 10, 18, 0.94)";
        g.strokeText(`${distTag}m`, 128, 70);
      }
      g.fillStyle = "#e6f7ff";
      g.fillText(`${distTag}m`, 128, 70);
    } else {
      // Clean full direct-LoS indicator: crisp name + slim HP bar + chevron (no bulky dark box)
      g.font = "bold 24px sans-serif";
      g.textAlign = "center";
      if (typeof g.strokeText === "function") {
        g.lineWidth = 5;
        g.strokeStyle = "rgba(4, 10, 18, 0.94)";
        g.strokeText(name, 128, 26);
      }
      g.fillStyle = "#eef8ff";
      g.fillText(name, 128, 26);

      g.fillStyle = "rgba(4, 10, 18, 0.80)";
      g.fillRect(58, 34, 140, 8);
      g.fillStyle = hpVal > 35 ? ALLY_IFF_META.markerHex : "#ff5245";
      g.fillRect(60, 36, Math.max(0, Math.min(1, (hpVal || 0) / 100)) * 136, 4);

      drawChevron(128, 50, 16, 15);
    }
    sp.userData.tex.needsUpdate = true;
  }

  function makeNameplateSprite(name, hpVal) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 80;
    const t = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: t,
        transparent: true,
        opacity: 0.94,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    sp.renderOrder = 12;
    sp.scale.set(1.26, 0.39, 1);
    sp.position.set(0, 2.26, 0);
    sp.userData = { canvas: c, tex: t, lastKey: "" };
    updateNameplateSprite(sp, name, hpVal, { compact: false, distM: 10 });
    return sp;
  }

  function syncRemoteWeaponVisibility(av) {
    const wid = av.weaponId || "m416";
    if (av.m416Mesh) av.m416Mesh.visible = wid !== "pistol" && wid !== "sniper";
    if (av.pistolMesh) av.pistolMesh.visible = wid === "pistol";
    if (av.awmMesh) av.awmMesh.visible = wid === "sniper";
    av.muzNode =
      wid === "pistol"
        ? av.pistolMuzNode || av.m416MuzNode
        : wid === "sniper"
          ? av.awmMuzNode || av.m416MuzNode
          : av.m416MuzNode;
  }

  function attachWeaponToRig(av) {
    if (!av.rig.weaponMount) return;
    const { m416WorldProto, pistolWorldProto, awmWorldProto } = getPrototypes();
    if (!av.m416Mesh && m416WorldProto) {
      const w = m416WorldProto.clone();
      w.traverse((o) => {
        o.layers.set(0);
        if (o.name === "reticle_group") o.visible = false;
      });
      w.scale.setScalar(1.06);
      av.rig.weaponMount.add(w);
      av.m416Mesh = w;
      av.m416MuzNode = w.getObjectByName("muzzle_anchor") || null;
    }
    if (!av.pistolMesh && pistolWorldProto) {
      const pw = pistolWorldProto.clone();
      pw.traverse((o) => o.layers.set(0));
      pw.scale.setScalar(1.16);
      pw.position.set(0.0, -0.015, 0.13);
      av.rig.weaponMount.add(pw);
      av.pistolMesh = pw;
      av.pistolMuzNode = pw.getObjectByName("pistol_muzzle") || null;
    }
    if (!av.awmMesh && awmWorldProto) {
      const aw = awmWorldProto.clone();
      aw.traverse((o) => o.layers.set(0));
      aw.scale.setScalar(1.02);
      aw.position.set(0.0, -0.006, 0.04);
      av.rig.weaponMount.add(aw);
      av.awmMesh = aw;
      av.awmMuzNode = aw.getObjectByName("muzzle_anchor") || null;
    }
    av.weaponAttached = Boolean(av.m416Mesh || av.pistolMesh || av.awmMesh);
    syncRemoteWeaponVisibility(av);
  }

  function createRemoteAvatar(p) {
    const container = new THREE.Group();
    const relation = resolveRelationForTeam(p.team);
    const rig = buildSoldierVisual(p.team, p.id, relation);
    container.add(rig.root);

    const muzFlash = new THREE.Mesh(remoteMuzFlashGeo, remoteMuzFlashMat);
    muzFlash.visible = false;
    container.add(muzFlash);

    const nameplate = makeNameplateSprite(p.name, p.hp);
    nameplate.visible = relation === "ally";
    container.add(nameplate);
    scene.add(container);

    const av = {
      id: p.id,
      name: p.name,
      team: p.team,
      relation,
      container,
      rig,
      hitMeshes: rig.hitMeshes,
      shieldDome: null,
      shieldBaseRing: null,
      shieldHitFlash: 0,
      shieldBlinkActive: false,
      muzFlash,
      muzNode: null,
      m416Mesh: null,
      pistolMesh: null,
      awmMesh: null,
      m416MuzNode: null,
      pistolMuzNode: null,
      awmMuzNode: null,
      weaponAttached: false,
      nameplate,
      snapshots: [],
      yaw: p.yaw || 0,
      walkPhase: 0,
      flashTimer: 0,
      shotSeq: 0,
      alive: p.alive,
      deathTime: 0,
      weaponId: p.weaponId || "m416",
      reloadEndsAt: 0,
      reloadDurMs: 0,
      radarBlipUntil: 0,
      crouchK: 0,
      proneK: 0,
      gaitYawOffset: 0,
      localVelFwd: 0,
      localVelRight: 0,
      hasLocalVel: false,
      prevWorldX: p.x || 0,
      prevWorldZ: p.z || 0,
      markerOccluded: false,
      nextLosCheckMs: 0,
    };
    attachWeaponToRig(av);
    remotePlayers.set(p.id, av);
    return av;
  }

  function applyAvatarRelation(av, relation) {
    if (!av) return;
    av.relation = relation;
    applyRigRelation(av.rig, av.team, relation);
    if (relation !== "ally") {
      av.nameplate.visible = false;
    }
  }

  function syncAllRelations() {
    for (const av of remotePlayers.values()) {
      const nextRel = resolveRelationForTeam(av.team);
      applyAvatarRelation(av, nextRel);
    }
  }

  function swapAvatarRig(av, team) {
    av.team = team;
    const relation = resolveRelationForTeam(team);
    av.relation = relation;
    av.container.remove(av.rig.root);
    av.rig = buildSoldierVisual(team, av.id, relation);
    av.hitMeshes = av.rig.hitMeshes;
    av.weaponAttached = false;
    av.muzNode = av.m416Mesh = av.pistolMesh = av.awmMesh = av.m416MuzNode = av.pistolMuzNode = av.awmMuzNode = null;
    av.container.add(av.rig.root);
    attachWeaponToRig(av);
    applyAvatarRelation(av, relation);
  }

  function upgradeRemoteSoldiers() {
    const { soldierProto } = getPrototypes();
    if (!soldierProto) return;
    const protoIsSkinned = hasSkinnedMesh(soldierProto);
    for (const av of remotePlayers.values()) {
      if (av.rig.isFallback || Boolean(av.rig.isSkinned) !== protoIsSkinned) {
        swapAvatarRig(av, av.team);
      }
    }
  }

  function upgradeRemoteWeapons() {
    for (const av of remotePlayers.values()) attachWeaponToRig(av);
  }

  function removeRemotePlayer(id) {
    const av = remotePlayers.get(id);
    if (!av) return;
    scene.remove(av.container);
    remotePlayers.delete(id);
  }

  function clearRemotePlayers() {
    for (const av of remotePlayers.values()) scene.remove(av.container);
    remotePlayers.clear();
  }

  function applyEnvMap(targetEnv) {
    for (const av of remotePlayers.values()) {
      av.container.traverse((o) => {
        if (o.isMesh && o.material && "envMap" in o.material && o.material.envMap !== targetEnv) {
          o.material.envMap = targetEnv;
          o.material.needsUpdate = true;
        }
      });
    }
  }

  function gatherEnemyHitMeshes(outArr = []) {
    outArr.length = 0;
    const { currentMode, meTeam } = getMatchMeta();
    for (const av of remotePlayers.values()) {
      if (!av.alive) continue;
      if (currentMode === "TDM" && av.team === meTeam) continue;
      for (let i = 0; i < av.hitMeshes.length; i++) outArr.push(av.hitMeshes[i]);
    }
    return outArr;
  }

  function updateRemotePlayers(dt) {
    const nowMs = performance.now();
    const renderTime = Date.now() + net.clockOffsetMs - INTERP_DELAY_MS;
    const { currentMode, meTeam } = getMatchMeta();
    const camObjForDist = typeof getCamera === "function" ? getCamera() : null;

    for (const av of remotePlayers.values()) {
      const snaps = av.snapshots;
      if (!snaps.length) continue;
      while (snaps.length >= 2 && snaps[1].t <= renderTime) snaps.shift();
      let pose = snaps[0];
      if (snaps.length >= 2 && snaps[1].t > snaps[0].t) {
        const alpha = Math.max(0, Math.min(1, (renderTime - snaps[0].t) / (snaps[1].t - snaps[0].t)));
        _poseScratch.x = THREE.MathUtils.lerp(snaps[0].x, snaps[1].x, alpha);
        _poseScratch.y = THREE.MathUtils.lerp(snaps[0].y, snaps[1].y, alpha);
        _poseScratch.z = THREE.MathUtils.lerp(snaps[0].z, snaps[1].z, alpha);
        _poseScratch.yaw = lerpAngle(snaps[0].yaw, snaps[1].yaw, alpha);
        _poseScratch.pitch = THREE.MathUtils.lerp(snaps[0].pitch, snaps[1].pitch, alpha);
        _poseScratch.mv = THREE.MathUtils.lerp(snaps[0].mv, snaps[1].mv, alpha);
        _poseScratch.flags = snaps[1].flags || 0;
        _poseScratch.weaponId = snaps[1].weaponId || av.weaponId;
        _poseScratch.reloading = Boolean(snaps[1].reloading);
        _poseScratch.hp = snaps[1].hp;
        _poseScratch.alive = snaps[1].alive;
        _poseScratch.invulnerable = snaps[1].invulnerable;
        _poseScratch.iFrames = snaps[1].iFrames;
        _poseScratch.protectExpiring = snaps[1].protectExpiring;
        pose = _poseScratch;
      }

      if (av.alive !== pose.alive) {
        if (av.alive && !pose.alive) {
          av.deathTime = 0;
          av.reloadEndsAt = 0;
        }
        av.localVelFwd = 0;
        av.localVelRight = 0;
        av.hasLocalVel = false;
        av.gaitYawOffset = 0;
      }
      if (pose.weaponId && pose.weaponId !== av.weaponId && nowMs >= (av.weaponLockUntil || 0)) {
        av.weaponId = pose.weaponId;
        av.reloadEndsAt = 0;
        syncRemoteWeaponVisibility(av);
      }
      if (!pose.reloading && av.reloadEndsAt > nowMs + 250) {
        av.reloadEndsAt = 0;
      }
      const stepWorldDx = pose.x - (av.prevWorldX !== undefined ? av.prevWorldX : pose.x);
      const stepWorldDz = pose.z - (av.prevWorldZ !== undefined ? av.prevWorldZ : pose.z);
      av.prevWorldX = pose.x;
      av.prevWorldZ = pose.z;

      av.alive = pose.alive;
      av.flags = pose.flags || 0;
      av.yaw = pose.yaw;
      av.container.position.set(pose.x, pose.y, pose.z);
      av.container.rotation.y = pose.yaw;

      const expectedRelation = resolvePlayerRelation({ currentMode, meTeam, targetTeam: av.team });
      if (av.relation !== expectedRelation) {
        applyAvatarRelation(av, expectedRelation);
      }

      if (!pose.alive) {
        av.deathTime += dt;
        av.container.visible = av.deathTime < 2.2;
        const drop = Math.min(1, av.deathTime * 4.5);
        av.rig.root.rotation.x = -drop * Math.PI * 0.48;
        av.rig.root.position.y = drop * 0.16;
        av.shieldHitFlash = 0;
        av.shieldBlinkActive = false;
        av.nameplate.visible = false;
        continue;
      }

      av.container.visible = true;
      av.rig.root.rotation.x = 0;
      const isProne = Boolean(FLAG.PRONE && (pose.flags & FLAG.PRONE));
      const targetCrouch = !isProne && (pose.flags & FLAG.CROUCH) ? 1 : 0;
      av.crouchK += (targetCrouch - av.crouchK) * Math.min(1, 14 * dt);
      av.proneK = (av.proneK || 0) + ((isProne ? 1 : 0) - (av.proneK || 0)) * Math.min(1, 12 * dt);

      if (av.shieldHitFlash > 0) av.shieldHitFlash = Math.max(0, av.shieldHitFlash - dt);
      const isProt = Boolean(pose.invulnerable || pose.iFrames);
      const blink = computeProtectionBlinkState(nowMs / 1000, {
        active: isProt,
        iFrames: Boolean(pose.iFrames),
        expiring: Boolean(pose.protectExpiring),
        hitFlash: av.shieldHitFlash,
      });

      // CS2-style Spawn Protection: blink the operator body directly while keeping their Ally/Enemy uniform tint!
      const isProtectedBlink = (isProt || av.shieldHitFlash > 0) && blink.blinkOn;
      av.shieldBlinkActive = Boolean(isProt || av.shieldHitFlash > 0);
      const bodyMats = typeof getSoldierBodyMats === "function" ? getSoldierBodyMats() : null;
      if (av.rig && Array.isArray(av.rig.bodyMeshes) && av.rig.bodyMeshes.length && bodyMats) {
        const protMat =
          av.relation === "ally"
            ? bodyMats.protectedAlly || bodyMats.protected
            : bodyMats.protectedEnemy || bodyMats.protected;
        const targetMat = isProtectedBlink && protMat ? protMat : bodyMats[av.relation] || null;
        if (targetMat && av.rig.bodyMeshes[0].material !== targetMat) {
          for (let i = 0; i < av.rig.bodyMeshes.length; i++) {
            av.rig.bodyMeshes[i].material = targetMat;
          }
        }
        if (camObjForDist && camObjForDist.position) {
          const cdx = pose.x - camObjForDist.position.x;
          const cdz = pose.z - camObjForDist.position.z;
          const nearShadow = cdx * cdx + cdz * cdz <= 784;
          for (let i = 0; i < av.rig.bodyMeshes.length; i++) {
            if (av.rig.bodyMeshes[i].castShadow !== nearShadow) {
              av.rig.bodyMeshes[i].castShadow = nearShadow;
            }
          }
        }
      }

      const targetPlateY = isProne ? 0.96 : targetCrouch ? 1.70 : 2.24;
      av.nameplate.position.y += (targetPlateY - av.nameplate.position.y) * Math.min(1, 12 * dt);

      // Show smart wall-through markers ONLY on teammates in TDM (hide on all enemies & FFA)
      if (av.relation === "ally") {
        const camObj = typeof getCamera === "function" ? getCamera() : null;
        if (camObj && camObj.position && typeof _markerNdc.project === "function") {
          const anchorY = isProne ? 0.46 : targetCrouch ? 1.14 : 1.66;
          _markerWorldPos.set(pose.x, pose.y + av.nameplate.position.y, pose.z);
          const dx = pose.x - camObj.position.x;
          const dy = pose.y + anchorY - camObj.position.y;
          const dz = pose.z - camObj.position.z;
          const dist = Math.hypot(dx, dy, dz);

          // 10 Hz throttled LoS check per ally (zero-GC) to switch full vs compact wall-through chevron
          if (nowMs >= (av.nextLosCheckMs || 0)) {
            av.nextLosCheckMs = nowMs + 100;
            let occluded = false;
            if (dist > 0.6) {
              const invD = 1 / dist;
              const col = typeof getActiveCollision === "function" ? getActiveCollision() : null;
              if (col && typeof col.raycastShot === "function") {
                const hit = col.raycastShot(
                  camObj.position.x,
                  camObj.position.y,
                  camObj.position.z,
                  dx * invD,
                  dy * invD,
                  dz * invD,
                  dist - 0.35,
                );
                occluded = Boolean(hit);
              } else if (_losRay) {
                const solids = typeof getSolidMeshes === "function" ? getSolidMeshes() : [];
                if (solids && solids.length) {
                  _losDir.set(dx * invD, dy * invD, dz * invD);
                  _losRay.set(camObj.position, _losDir);
                  _losRay.far = Math.max(0.1, dist - 0.35);
                  occluded = _losRay.intersectObjects(solids, false).length > 0;
                }
              }
            }
            av.markerOccluded = occluded;
          }

          _markerNdc.copy(_markerWorldPos).project(camObj);
          const behindCamera = _markerNdc.z > 1.0;
          const ndcDist = Math.hypot(_markerNdc.x, _markerNdc.y);
          const adsVal = typeof getLocalAds === "function" ? getLocalAds() : 0;
          const layout = computeFriendlyMarkerLayout({
            dist,
            occluded: Boolean(av.markerOccluded),
            ndcDist,
            ads: adsVal,
            behindCamera,
          });
          av.nameplate.visible = layout.visible;
          if (layout.visible) {
            if (av.nameplate.material) av.nameplate.material.opacity = layout.opacity;
            av.nameplate.scale.set(1.26 * layout.scale, 0.39 * layout.scale, 1);
            updateNameplateSprite(av.nameplate, av.name, pose.hp, {
              compact: layout.compact,
              distM: dist,
            });
          }
        } else {
          av.nameplate.visible = true;
          updateNameplateSprite(av.nameplate, av.name, pose.hp, { compact: false, distM: 10 });
        }
      } else {
        av.nameplate.visible = false;
      }

      if (av.rig.isSkinned) {
        const rig = av.rig;

        // Smooth local horizontal velocity in avatar yaw space (anti-jitter on 20Hz snapshots & bots)
        const snY = Math.sin(pose.yaw);
        const csY = Math.cos(pose.yaw);
        const rawHorizStep = Math.hypot(stepWorldDx, stepWorldDz);
        const isTeleportStep = rawHorizStep > 1.5;
        const horizStep = isTeleportStep ? 0 : rawHorizStep;
        const fwdStep = isTeleportStep ? 0 : -snY * stepWorldDx - csY * stepWorldDz;
        const rightStep = isTeleportStep ? 0 : csY * stepWorldDx - snY * stepWorldDz;

        if (isTeleportStep) {
          av.localVelFwd = 0;
          av.localVelRight = 0;
          av.hasLocalVel = false;
          av.gaitYawOffset = 0;
        } else if (dt > 1e-4 && horizStep > 1e-4) {
          const instFwd = fwdStep / dt;
          const instRight = rightStep / dt;
          if (!av.hasLocalVel) {
            av.localVelFwd = instFwd;
            av.localVelRight = instRight;
            av.hasLocalVel = true;
          } else {
            const kVel = 1 - Math.exp(-dt * 16);
            av.localVelFwd += (instFwd - av.localVelFwd) * kVel;
            av.localVelRight += (instRight - av.localVelRight) * kVel;
          }
        } else if (pose.mv <= 0.08) {
          const kDecay = Math.exp(-dt * 18);
          av.localVelFwd *= kDecay;
          av.localVelRight *= kDecay;
          if (Math.hypot(av.localVelFwd, av.localVelRight) < 0.05) {
            av.localVelFwd = 0;
            av.localVelRight = 0;
            av.hasLocalVel = false;
          }
        }

        const desiredState = selectSoldierAnimState({
          alive: pose.alive,
          mv: pose.mv,
          flags: pose.flags,
          FLAG,
          fwdVel: av.localVelFwd,
          rightVel: av.localVelRight,
          hasDirectionalCrouch: rig.hasDirectionalCrouch,
        });
        const isDirectionalCrouchMove = Boolean(rig.hasDirectionalCrouch && CROUCH_DIR_SET.has(desiredState));
        const hasDedicatedCrouch = Boolean(rig.actions.crouch || rig.hasDirectionalCrouch);
        const hasDedicatedProne = Boolean(rig.actions.prone || rig.actions.prone_move);
        if (isProne && !hasDedicatedProne) {
          rig.root.rotation.x = -av.proneK * Math.PI * 0.44;
          rig.root.position.y = av.proneK * 0.22;
        } else {
          rig.root.position.y = hasDedicatedCrouch || isProne ? 0 : -0.44 * av.crouchK;
        }

        if (rig.mixer && rig.actionKeys && rig.actionKeys.length) {
          const prevState = rig.activeState;
          const targetWeights = rig.targetWeights;
          for (let i = 0; i < rig.actionKeys.length; i++) {
            targetWeights[rig.actionKeys[i]] = 0;
          }

          if (isDirectionalCrouchMove) {
            const cw = computeCrouchDirectionalWeights(av.localVelFwd, av.localVelRight);
            targetWeights.crouch_forward = cw.crouch_forward;
            targetWeights.crouch_backward = cw.crouch_backward;
            targetWeights.crouch_left = cw.crouch_left;
            targetWeights.crouch_right = cw.crouch_right;
          } else {
            const singleKey = rig.actions[desiredState]
              ? desiredState
              : desiredState === "crouch_move" && rig.actions.crouch
                ? "crouch"
                : desiredState === "prone_move" && rig.actions.prone
                  ? "prone"
                  : rig.actions.idle
                    ? "idle"
                    : rig.actionKeys[0];
            if (singleKey) targetWeights[singleKey] = 1;
          }

          const isJumpTransition = prevState === "jump" || desiredState === "jump";
          const isCrouchDirPivot = CROUCH_DIR_SET.has(prevState) && isDirectionalCrouchMove;
          const blendDur = isJumpTransition ? 0.07 : isCrouchDirPivot ? 0.085 : 0.11;

          // Capture normalized cycle phase from lead running crouch clip so newly blended crouch clips lock stride phase
          let leadCrouchPhase = null;
          if (isDirectionalCrouchMove) {
            let bestW = 0;
            for (let i = 0; i < CROUCH_DIR_KEYS.length; i++) {
              const ck = CROUCH_DIR_KEYS[i];
              const act = rig.actions[ck];
              const curW = rig.actionWeights[ck] || 0;
              const running = act && (typeof act.isRunning === "function" ? act.isRunning() : Boolean(act.playing));
              if (running && curW > bestW && act.clip && act.clip.duration > 0) {
                bestW = curW;
                leadCrouchPhase = (((act.time || 0) / act.clip.duration) % 1 + 1) % 1;
              }
            }
          }

          stepNormalizedActionWeights(rig.actionWeights, targetWeights, rig.actionKeys, dt, blendDur);

          const rawSpeedMps = dt > 1e-4 && horizStep > 1e-4 ? horizStep / dt : 0;
          const smoothedSpeedMps = Math.hypot(av.localVelFwd, av.localVelRight);
          const effSpeedMps = rawSpeedMps > 0.25 ? rawSpeedMps : smoothedSpeedMps;
          const mvNorm = effSpeedMps > 0.25 ? Math.max(0.25, Math.min(1.5, effSpeedMps / 5.5)) : pose.mv;
          const isBackpedal = !isDirectionalCrouchMove && effSpeedMps > 0.25 && av.localVelFwd < -0.25 * effSpeedMps;

          // Standing run uses 1 forward clip -> keep gentle pelvis alignment; 4-way crouch uses native clips (no extra yaw twist)
          let targetGaitYaw = 0;
          if (desiredState === "run" || (desiredState === "crouch_move" && !rig.hasDirectionalCrouch)) {
            if (effSpeedMps > 0.25) {
              const localStrafeRatio = Math.atan2(av.localVelRight, Math.abs(av.localVelFwd) + 1e-4);
              targetGaitYaw = Math.max(-0.34, Math.min(0.34, (isBackpedal ? -localStrafeRatio : localStrafeRatio) * 0.65));
            }
          }
          av.gaitYawOffset = (av.gaitYawOffset || 0) + (targetGaitYaw - (av.gaitYawOffset || 0)) * Math.min(1, 12 * dt);

          const dirSign = isBackpedal ? -0.88 : 1.0;
          const runScale = Math.max(0.95, Math.min(2.35, mvNorm * 2.05)) * dirSign;
          const crouchSpeedRef = effSpeedMps > 0.25 ? effSpeedMps : pose.mv * 3.19;
          const dirCrouchScale = Math.max(0.72, Math.min(1.48, crouchSpeedRef / 2.75));
          const legacyCrouchScale = Math.max(0.85, Math.min(1.9, mvNorm * 1.9)) * dirSign;
          const proneMoveScale = Math.max(0.85, Math.min(1.55, (mvNorm || 0.55) / 0.45)) * dirSign;

          for (let i = 0; i < rig.actionKeys.length; i++) {
            const key = rig.actionKeys[i];
            const act = rig.actions[key];
            if (!act) continue;
            const w = rig.actionWeights[key] || 0;
            const isRunning = typeof act.isRunning === "function" ? act.isRunning() : Boolean(act.playing);
            if (w > 0) {
              act.enabled = true;
              if (!isRunning || (key === "jump" && prevState !== "jump" && desiredState === "jump")) {
                if (key === "jump") {
                  act.reset();
                } else if (CROUCH_DIR_SET.has(key) && leadCrouchPhase !== null && act.clip && act.clip.duration > 0) {
                  act.time = leadCrouchPhase * act.clip.duration;
                }
                act.play();
              }
              act.setEffectiveWeight(w);
              if (key === "run") act.setEffectiveTimeScale(runScale);
              else if (CROUCH_DIR_SET.has(key)) act.setEffectiveTimeScale(dirCrouchScale);
              else if (key === "crouch_move") act.setEffectiveTimeScale(legacyCrouchScale);
              else if (key === "prone_move") act.setEffectiveTimeScale(proneMoveScale);
              else act.setEffectiveTimeScale(1.0);
            } else {
              act.setEffectiveWeight(0);
              if (isRunning && typeof act.stop === "function") act.stop();
            }
          }

          rig.activeState = desiredState;
          rig.activeAction = rig.actions[desiredState] || rig.activeAction;
          rig.lastBlendDur = blendDur;
          rig.mixer.update(dt);
        }

        // Apply subtle pelvis directional alignment & counter-rotate spine so chest/rifle stays aimed at opponent
        if (Math.abs(av.gaitYawOffset || 0) > 0.002) {
          rig.root.rotation.y = av.gaitYawOffset;
          if (rig.spineBone) rig.spineBone.rotation.y -= av.gaitYawOffset * 0.85;
        } else {
          rig.root.rotation.y = 0;
        }

        const pitchScale = isProne ? 0.3 : 1.0;
        if (rig.spineBone) rig.spineBone.rotation.x += pose.pitch * 0.28 * pitchScale;
        if (rig.headBone) rig.headBone.rotation.x += pose.pitch * 0.52 * pitchScale;

        // Align weaponMount toward LeftHand blended with soldier forward (-Z) to keep weapon upright & shoulder-tucked
        if (
          rig.weaponMount &&
          rig.weaponMount.parent &&
          _contQuat &&
          _parentQuat &&
          _desiredWorldQuat &&
          _lookMat &&
          typeof rig.weaponMount.getWorldPosition === "function" &&
          typeof rig.weaponMount.parent.getWorldQuaternion === "function"
        ) {
          // Targeted ancestor-only matrix refresh avoids traversing all 41 bones/meshes every frame
          if (typeof rig.weaponMount.parent.updateWorldMatrix === "function") {
            rig.weaponMount.parent.updateWorldMatrix(true, false);
          } else {
            av.container.updateMatrixWorld(true);
          }
          _contQuat.copy(av.container.quaternion);
          _charFwd.set(0, Math.sin(pose.pitch) * (isProne ? 0.2 : 0.65), -1).normalize().applyQuaternion(_contQuat);
          _charUp.set(0, 1, 0).applyQuaternion(_contQuat);

          let hasHandAim = false;
          if (rig.leftHandBone && typeof rig.leftHandBone.getWorldPosition === "function") {
            if (typeof rig.leftHandBone.updateWorldMatrix === "function") {
              rig.leftHandBone.updateWorldMatrix(true, false);
            }
            rig.weaponMount.getWorldPosition(_rhWorld);
            rig.leftHandBone.getWorldPosition(_lhWorld);
            _handDir.subVectors(_lhWorld, _rhWorld);
            if (_handDir.lengthSq() > 1e-4) {
              _handDir.normalize();
              hasHandAim = true;
            }
          }

          if (hasHandAim) {
            const isCrouchState =
              desiredState === "crouch" || desiredState === "crouch_move" || CROUCH_DIR_SET.has(desiredState);
            const handWeight =
              desiredState === "prone"
                ? 0.25
                : desiredState === "prone_move"
                  ? 0.1
                  : isCrouchState
                    ? 0.85
                    : desiredState === "run"
                      ? 0.82
                      : 0.88;
            _aimDir.copy(_charFwd).multiplyScalar(1 - handWeight).addScaledVector(_handDir, handWeight);
          } else {
            _aimDir.copy(_charFwd);
          }

          if (desiredState === "jump") {
            _aimDir.y = Math.max(-0.35, Math.min(0.16, _aimDir.y));
          } else if (isProne) {
            _aimDir.y = Math.max(-0.18, Math.min(0.12, _aimDir.y));
          }
          if (_aimDir.lengthSq() > 1e-5) {
            _aimDir.normalize();
            _lookMat.lookAt(_zeroVec, _aimDir, _charUp);
            _desiredWorldQuat.setFromRotationMatrix(_lookMat);
            rig.weaponMount.parent.getWorldQuaternion(_parentQuat);
            rig.weaponMount.quaternion.copy(_parentQuat).invert().multiply(_desiredWorldQuat);
            rig.weaponMount.updateMatrixWorld(true);
          }
        }
      } else {
        if (av.proneK > 0.02) {
          av.rig.root.rotation.x = -av.proneK * Math.PI * 0.44;
          av.rig.root.position.y = av.proneK * 0.22;
        } else {
          av.rig.root.position.y = -0.44 * av.crouchK;
        }
        if (av.rig.upper && !av.rig.isFallback) {
          av.rig.upper.rotation.x = pose.pitch * 0.45 + 0.18 * av.crouchK;
        }
        if (av.rig.headGroup) av.rig.headGroup.rotation.x = pose.pitch * 0.55;

        if (av.rig.armsGroup) {
          if (av.reloadEndsAt > nowMs && av.reloadDurMs > 0) {
            const pRel = Math.max(0, Math.min(1, 1 - (av.reloadEndsAt - nowMs) / av.reloadDurMs));
            av.rig.armsGroup.rotation.x = Math.sin(pRel * Math.PI) * 0.38;
            av.rig.armsGroup.rotation.z = -Math.sin(pRel * Math.PI) * 0.28;
          } else {
            av.rig.armsGroup.rotation.x *= 0.8;
            av.rig.armsGroup.rotation.z *= 0.8;
          }
        }

        if (pose.mv > 0.05) {
          av.walkPhase += dt * (6 + pose.mv * 4.5);
          const swing = Math.sin(av.walkPhase) * 0.55 * Math.min(1.2, pose.mv);
          if (av.rig.legL) av.rig.legL.rotation.x = swing;
          if (av.rig.legR) av.rig.legR.rotation.x = -swing;
        } else {
          if (av.rig.legL) av.rig.legL.rotation.x *= 0.85;
          if (av.rig.legR) av.rig.legR.rotation.x *= 0.85;
        }
        if (av.rig.legL) av.rig.legL.position.y = 0.86 - 0.14 * av.crouchK;
        if (av.rig.legR) av.rig.legR.position.y = 0.86 - 0.14 * av.crouchK;
      }

      if (av.flashTimer > 0) {
        av.flashTimer -= dt;
        if (av.muzNode) {
          av.muzNode.getWorldPosition(_muzWorldPos);
          av.container.worldToLocal(_muzWorldPos);
          av.muzFlash.position.copy(_muzWorldPos);
        } else {
          av.muzFlash.position.set(0.11, 1.3, -0.78);
        }
        av.muzFlash.visible = av.flashTimer > 0;
        if (av.muzFlash.visible) {
          const k = Math.max(0.25, av.flashTimer / 0.055);
          av.muzFlash.scale.setScalar(
            (av.weaponId === "sniper" ? 1.35 : av.weaponId === "pistol" ? 0.65 : 1.0) * (0.7 + 0.45 * k),
          );
        }
      } else {
        av.muzFlash.visible = false;
      }
    }
  }

  return {
    remotePlayers,
    buildSoldierVisual,
    attachWeaponToRig,
    syncRemoteWeaponVisibility,
    createRemoteAvatar,
    applyAvatarRelation,
    syncAllRelations,
    swapAvatarRig,
    upgradeRemoteSoldiers,
    upgradeRemoteWeapons,
    removeRemotePlayer,
    clearRemotePlayers,
    applyEnvMap,
    gatherEnemyHitMeshes,
    triggerShieldHitFlash: (id) => {
      const av = remotePlayers.get(id);
      if (av) av.shieldHitFlash = 0.24;
    },
    updateRemotePlayers,
  };
}

