/**
 * Remote LAN Player Avatars, 100ms Snapshot Interpolation & Team Nameplates.
 * Supports both legacy procedural soldier rigs and Mixamo/AccuRIG SkinnedMesh AnimationMixer rigs.
 */

import {
  SOLDIER_BONE_ALIASES,
  cloneSkinnedHierarchy,
  findSoldierClip,
  hasSkinnedMesh,
  resolveRigBone,
  selectSoldierAnimState,
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
  getMatchMeta,
}) {
  const remotePlayers = new Map();
  const _muzWorldPos = new THREE.Vector3();
  const _hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const _headHitGeo = new THREE.SphereGeometry(0.155, 8, 6);
  const _torsoHitGeo = new THREE.BoxGeometry(0.36, 0.44, 0.24);
  const _hipsHitGeo = new THREE.BoxGeometry(0.34, 0.24, 0.22);
  const _thighHitGeo = new THREE.BoxGeometry(0.16, 0.42, 0.16);
  const _calfHitGeo = new THREE.BoxGeometry(0.14, 0.42, 0.16);

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

    addBoneHitbox(headBone, "hitbox_head", _headHitGeo, [0, 0.08, 0], "head", playerId, hitMeshes);
    addBoneHitbox(spineBone, "hitbox_torso", _torsoHitGeo, [0, 0.06, 0], "body", playerId, hitMeshes);
    addBoneHitbox(hipsBone, "hitbox_hips", _hipsHitGeo, [0, 0, 0], "body", playerId, hitMeshes);
    addBoneHitbox(lUpLeg, "hitbox_thigh_l", _thighHitGeo, [0, -0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(lLeg, "hitbox_calf_l", _calfHitGeo, [0, -0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(rUpLeg, "hitbox_thigh_r", _thighHitGeo, [0, -0.2, 0], "limb", playerId, hitMeshes);
    addBoneHitbox(rLeg, "hitbox_calf_r", _calfHitGeo, [0, -0.2, 0], "limb", playerId, hitMeshes);

    if (hitMeshes.length === 0) {
      addBoneHitbox(root, "hitbox_fallback_body", _torsoHitGeo, [0, 1.0, 0], "body", playerId, hitMeshes);
      addBoneHitbox(root, "hitbox_fallback_head", _headHitGeo, [0, 1.63, 0], "head", playerId, hitMeshes);
    }
    return { hitMeshes, headBone, spineBone };
  }

  function buildSoldierActions(mixer, animations) {
    const actions = {};
    if (!mixer || !Array.isArray(animations) || !animations.length) return actions;
    for (const key of ["idle", "run", "crouch", "jump"]) {
      const clip = findSoldierClip(animations, key);
      if (!clip) continue;
      const act = mixer.clipAction(clip);
      if (key === "jump") {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      } else {
        act.setLoop(THREE.LoopRepeat, Infinity);
      }
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

  function buildSoldierVisual(team, playerId) {
    const tKey = team === "A" || team === "B" ? team : "FFA";
    const teamAccentMats = getTeamAccentMats();
    const { soldierProto, soldierAnimations } = getPrototypes();

    if (!soldierProto) {
      const root = new THREE.Group();
      const uni = new THREE.MeshStandardMaterial({ color: 0x323b42, roughness: 0.75 });
      const acc = teamAccentMats[tKey];
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
      return { root, upper, headGroup, legL, legR, weaponMount, hitMeshes: tagHitMeshes(root, playerId), isFallback: true };
    }

    const isSkinned = hasSkinnedMesh(soldierProto);
    const root = isSkinned ? cloneSkinnedHierarchy(soldierProto, THREE) : soldierProto.clone();
    const accMat = teamAccentMats[tKey];
    root.traverse((o) => {
      o.layers.set(0);
      if (o.isSkinnedMesh) o.frustumCulled = false;
      if (
        o.isMesh &&
        (o.name.includes("team") || (o.material && (o.material.name === "TeamColor" || o.material.name === "Soldier_TeamAccent")))
      ) {
        o.material = accMat;
      }
    });

    if (isSkinned) {
      const mixer = new THREE.AnimationMixer(root);
      const actions = buildSoldierActions(mixer, soldierAnimations);
      const initialAct = actions.idle || Object.values(actions)[0] || null;
      if (initialAct) initialAct.play();
      const { hitMeshes, headBone, spineBone } = buildSkinnedHitboxes(root, playerId);
      const weaponMount = resolveRigBone(root, SOLDIER_BONE_ALIASES.rightHand);
      return {
        root,
        isSkinned: true,
        isFallback: false,
        mixer,
        actions,
        activeAction: initialAct,
        activeState: initialAct ? "idle" : "",
        headBone,
        spineBone,
        weaponMount,
        hitMeshes,
      };
    }

    return {
      root,
      upper: root.getObjectByName("upper_body") || root,
      headGroup: root.getObjectByName("head_group"),
      armsGroup: root.getObjectByName("arms_group"),
      legL: root.getObjectByName("leg_left"),
      legR: root.getObjectByName("leg_right"),
      weaponMount: root.getObjectByName("weapon_mount"),
      hitMeshes: tagHitMeshes(root, playerId),
      isFallback: false,
    };
  }

  function updateNameplateSprite(sp, name, team, hpVal) {
    const meta = TEAM_META[team] || TEAM_META.FFA;
    const key = `${name}:${meta.id}:${hpVal | 0}`;
    if (sp.userData.lastKey === key) return;
    sp.userData.lastKey = key;
    const c = sp.userData.canvas;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = "rgba(8, 14, 20, 0.78)";
    g.fillRect(22, 6, 212, 48);
    g.strokeStyle = meta.hex;
    g.lineWidth = 2.5;
    g.strokeRect(22, 6, 212, 48);
    g.fillStyle = meta.hex;
    g.font = "bold 19px sans-serif";
    g.textAlign = "center";
    g.fillText(`${meta.symbol} ${name}`, 128, 29);
    g.fillStyle = "#222a30";
    g.fillRect(46, 39, 164, 7);
    g.fillStyle = hpVal > 35 ? "#4ec3b0" : "#ff5245";
    g.fillRect(46, 39, Math.max(0, Math.min(1, hpVal / 100)) * 164, 7);
    sp.userData.tex.needsUpdate = true;
  }

  function makeNameplateSprite(name, team, hpVal) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const t = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: true }));
    sp.scale.set(1.38, 0.34, 1);
    sp.position.set(0, 2.08, 0);
    sp.userData = { canvas: c, tex: t, lastKey: "" };
    updateNameplateSprite(sp, name, team, hpVal);
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
    const rig = buildSoldierVisual(p.team, p.id);
    container.add(rig.root);

    const shieldDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 16, 12),
      new THREE.MeshBasicMaterial({
        color: TEAM_META[p.team]?.colorNum || 0x2f80ff,
        transparent: true,
        opacity: 0.16,
        wireframe: true,
      }),
    );
    shieldDome.position.set(0, 0.92, 0);
    container.add(shieldDome);

    const muzFlash = new THREE.Mesh(remoteMuzFlashGeo, remoteMuzFlashMat);
    muzFlash.visible = false;
    container.add(muzFlash);

    const nameplate = makeNameplateSprite(p.name, p.team, p.hp);
    container.add(nameplate);
    scene.add(container);

    const av = {
      id: p.id,
      name: p.name,
      team: p.team,
      container,
      rig,
      hitMeshes: rig.hitMeshes,
      shieldDome,
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
    };
    attachWeaponToRig(av);
    remotePlayers.set(p.id, av);
    return av;
  }

  function swapAvatarRig(av, team) {
    av.team = team;
    av.container.remove(av.rig.root);
    av.rig = buildSoldierVisual(team, av.id);
    av.hitMeshes = av.rig.hitMeshes;
    av.weaponAttached = false;
    av.muzNode = av.m416Mesh = av.pistolMesh = av.awmMesh = av.m416MuzNode = av.pistolMuzNode = av.awmMuzNode = null;
    av.container.add(av.rig.root);
    attachWeaponToRig(av);
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

    for (const av of remotePlayers.values()) {
      const snaps = av.snapshots;
      if (!snaps.length) continue;
      while (snaps.length >= 2 && snaps[1].t <= renderTime) snaps.shift();
      let pose = snaps[0];
      if (snaps.length >= 2 && snaps[1].t > snaps[0].t) {
        const alpha = Math.max(0, Math.min(1, (renderTime - snaps[0].t) / (snaps[1].t - snaps[0].t)));
        pose = {
          x: THREE.MathUtils.lerp(snaps[0].x, snaps[1].x, alpha),
          y: THREE.MathUtils.lerp(snaps[0].y, snaps[1].y, alpha),
          z: THREE.MathUtils.lerp(snaps[0].z, snaps[1].z, alpha),
          yaw: lerpAngle(snaps[0].yaw, snaps[1].yaw, alpha),
          pitch: THREE.MathUtils.lerp(snaps[0].pitch, snaps[1].pitch, alpha),
          mv: THREE.MathUtils.lerp(snaps[0].mv, snaps[1].mv, alpha),
          flags: snaps[1].flags || 0,
          weaponId: snaps[1].weaponId || av.weaponId,
          reloading: Boolean(snaps[1].reloading),
          hp: snaps[1].hp,
          alive: snaps[1].alive,
          invulnerable: snaps[1].invulnerable,
        };
      }

      if (av.alive && !pose.alive) {
        av.deathTime = 0;
        av.reloadEndsAt = 0;
      }
      if (pose.weaponId && pose.weaponId !== av.weaponId && nowMs >= (av.weaponLockUntil || 0)) {
        av.weaponId = pose.weaponId;
        av.reloadEndsAt = 0;
        syncRemoteWeaponVisibility(av);
      }
      if (!pose.reloading && av.reloadEndsAt > nowMs + 250) {
        av.reloadEndsAt = 0;
      }
      av.alive = pose.alive;
      av.flags = pose.flags || 0;
      av.container.position.set(pose.x, pose.y, pose.z);
      av.container.rotation.y = pose.yaw;

      if (!pose.alive) {
        av.deathTime += dt;
        av.container.visible = av.deathTime < 2.2;
        const drop = Math.min(1, av.deathTime * 4.5);
        av.rig.root.rotation.x = -drop * Math.PI * 0.48;
        av.rig.root.position.y = drop * 0.16;
        av.shieldDome.visible = false;
        av.nameplate.visible = false;
        continue;
      }

      av.container.visible = true;
      av.rig.root.rotation.x = 0;
      const targetCrouch = pose.flags & FLAG.CROUCH ? 1 : 0;
      av.crouchK += (targetCrouch - av.crouchK) * Math.min(1, 14 * dt);
      av.shieldDome.visible = Boolean(pose.invulnerable);
      updateNameplateSprite(av.nameplate, av.name, av.team, pose.hp);

      // Show nameplates only on teammates in TDM (hide enemies & FFA competitors)
      av.nameplate.visible = currentMode === "TDM" && av.team === meTeam;

      if (av.rig.isSkinned) {
        const rig = av.rig;
        const desiredState = selectSoldierAnimState({ alive: pose.alive, mv: pose.mv, flags: pose.flags, FLAG });
        const hasDedicatedCrouch = Boolean(rig.actions.crouch);
        rig.root.position.y = hasDedicatedCrouch ? 0 : -0.44 * av.crouchK;

        if (rig.mixer) {
          const nextAct = rig.actions[desiredState] || rig.actions.idle || Object.values(rig.actions)[0] || null;
          if (nextAct && nextAct !== rig.activeAction) {
            nextAct.reset();
            nextAct.setEffectiveWeight(1);
            nextAct.play();
            if (rig.activeAction) rig.activeAction.crossFadeTo(nextAct, 0.14, true);
            rig.activeAction = nextAct;
            rig.activeState = desiredState;
          }
          if (rig.activeAction && desiredState === "run") {
            rig.activeAction.setEffectiveTimeScale(Math.max(0.75, Math.min(1.45, pose.mv / 1.0)));
          } else if (rig.activeAction) {
            rig.activeAction.setEffectiveTimeScale(1.0);
          }
          rig.mixer.update(dt);
        }
        if (rig.spineBone) rig.spineBone.rotation.x += pose.pitch * 0.28;
        if (rig.headBone) rig.headBone.rotation.x += pose.pitch * 0.52;
      } else {
        av.rig.root.position.y = -0.44 * av.crouchK;
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
    swapAvatarRig,
    upgradeRemoteSoldiers,
    upgradeRemoteWeapons,
    removeRemotePlayer,
    clearRemotePlayers,
    applyEnvMap,
    gatherEnemyHitMeshes,
    updateRemotePlayers,
  };
}

