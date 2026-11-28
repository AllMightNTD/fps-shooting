/**
 * Combat System: Weapons, Firing, M416 Recoil, AWM Ballistic Scope & Projectiles, Solo Drones.
 */

import { ALLY_IFF_META, getEnemyHighlightPreset } from "/js/iff_system.js";

export function createCombatSystem({
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
  getGround,
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
  INTERP_DELAY_MS = 100,
  flushStateBeforeFire = null,
  onBotFire = null,
  onSoloDefeated,
  $,
  getPlayState,
  onSoloGameOver,
  rnd,
  vpAspectGetter,
}) {
  const Vec = THREE.Vector3;
  const lerp = THREE.MathUtils.lerp;

  const ray = new THREE.Raycaster();
  const lr = new THREE.Raycaster();
  const _remoteRay = new THREE.Raycaster();
  const _worldHitNorm = new Vec();
  const _worldNormalMat = new THREE.Matrix3();

  // Reusable scratch vectors (zero-GC hot paths)
  const _muzFrom = new Vec();
  const _launchDir = new Vec();
  const _rightAxis = new Vec();
  const _fallbackEnd = new Vec();
  const _awmPrevPos = new Vec();
  const _awmSeg = new Vec();
  const _remFrom = new Vec();
  const _remDir = new Vec();
  const _remMuzTmp = new Vec();
  const _remFallbackEnd = new Vec();
  const _droneSeeDir = new Vec();
  const _droneTo = new Vec();
  const _droneDir = new Vec();
  const _droneFwd = new Vec();
  const _droneSide = new Vec();
  const _droneAim = new Vec();
  const _droneErr = new Vec();
  const _droneBodies = [];
  const _entityTargets = [];

  const m416Recoil = createRecoilController(M416_RECOIL_PROFILE);
  const awmScope = createScopeController(AWM_SCOPE_PROFILE);

  let m416WasFiring = false;
  let scopeOut = awmScope.tick({ dt: 0, nowSec: 0 });
  let prevScopeSwayX = 0;
  let prevScopeSwayY = 0;
  const awmProjectiles = [];

  let weapons = {};
  let activeSlot = 1;
  let prevSlot = 2;

  let recoil = 0;
  let kick = 0;
  let flash = 0;
  let flashDur = 0.048;
  let flashPeak = 7.4;
  let localShotSeq = 0;
  let shake = 0;
  let testAimHeld = false;
  let testHoldBreath = false;
  let requireFreshFireAfterRespawn = false;

  // Shared drone geometries/material (avoid Wave-1 allocation & GPU leaks)
  const drones = [];
  let soloScore = 0;
  let soloWave = 0;
  let soloWaveCd = 0;
  const dMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.8, roughness: 0.35 });
  const droneEyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  const droneBodyGeo = new THREE.SphereGeometry(0.5, 16, 12);
  const droneEyeGeo = new THREE.SphereGeometry(0.14, 10, 8);
  const droneRingGeo = new THREE.TorusGeometry(0.72, 0.04, 6, 20);

  function nextMagazineSeed() {
    return (((Math.random() * 0x7fffffff) | 0) || 1337);
  }

  function emitScopeAudioCue(level, weaponId = "sniper") {
    audioEngine.snd.scopeClick(level);
    if (getPlayState().engineMode === "lan") {
      net.send(MSG.SCOPE, { level, weapon: weaponId });
    }
  }

  function resetAllWeapons() {
    weapons = {};
    for (const slot of WEAPON_SLOTS) {
      const wid = SLOT_TO_WEAPON_ID[slot];
      const cfg = WEAPONS[wid];
      weapons[wid] = {
        id: wid,
        slot,
        mag: cfg.magSize,
        nextFireAt: 0,
        equipEndsAt: 0,
        reloadStartAt: 0,
        reloadEndsAt: 0,
        reloadDuration: cfg.reloadTime,
        isTactical: false,
      };
    }
    m416WasFiring = false;
    m416Recoil.resetAll(nextMagazineSeed());
    awmScope.resetAll();
    scopeOut = awmScope.tick({ dt: 0, nowSec: 0 });
    prevScopeSwayX = prevScopeSwayY = 0;
    awmProjectiles.length = 0;
  }
  resetAllWeapons();

  function activeWeapon() {
    const wid = SLOT_TO_WEAPON_ID[activeSlot] || "m416";
    return { cfg: WEAPONS[wid], st: weapons[wid] };
  }

  function burst(pt, n, spd) {
    ballisticsVfx.spawnBurstSparks(pt, n, spd);
  }

  function tracer(a, b, col = 0xffe4a8) {
    ballisticsVfx.spawnTracer(a, b, {
      speed: 250,
      length: 4.8,
      width: 1.05,
      opacity: 0.86,
      fadeNearEnd: 0.45,
      colorHex: col,
    });
  }

  function disposeDroneEntity(d) {
    S.remove(d.g);
    if (d.body && d.body.material && d.body.material !== dMat) {
      d.body.material.dispose();
    }
  }

  function clearAllDrones() {
    drones.splice(0).forEach(disposeDroneEntity);
  }

  function spawnDrone() {
    const g = new THREE.Group();
    const m = dMat.clone();
    const body = new THREE.Mesh(droneBodyGeo, m);
    body.scale.y = 0.6;
    body.castShadow = true;
    const eye = new THREE.Mesh(droneEyeGeo, droneEyeMat);
    eye.position.z = 0.42;
    const ring = new THREE.Mesh(droneRingGeo, dMat);
    ring.rotation.x = Math.PI / 2;
    g.add(body, eye, ring);
    const a = rnd(0, 6.28);
    const activeMapId = sceneMgr.getActiveMapId();
    const spawnRad = activeMapId === "military" ? 24 : 42;
    const patBound = activeMapId === "military" ? 26 : 35;
    g.position.set(Math.cos(a) * spawnRad, 6.5, Math.sin(a) * spawnRad);
    S.add(g);
    const d = {
      g,
      body,
      ring,
      hp: 3,
      st: "patrol",
      tgt: new Vec(rnd(-patBound, patBound), 6.5, rnd(-patBound, patBound)),
      cd: rnd(1, 2),
      los: false,
      losT: 0,
      hitT: 0,
      sd: Math.random() < 0.5 ? 1 : -1,
    };
    body.userData.drone = d;
    drones.push(d);
  }

  function canSee(a, b) {
    _droneSeeDir.copy(b).sub(a);
    const L = _droneSeeDir.length();
    if (L < 1e-4) return true;
    _droneSeeDir.divideScalar(L);
    const activeCollision = sceneMgr.getActiveCollision();
    if (activeCollision) {
      return !activeCollision.raycastShot(a.x, a.y, a.z, _droneSeeDir.x, _droneSeeDir.y, _droneSeeDir.z, L - 0.05);
    }
    lr.set(a, _droneSeeDir);
    lr.far = L;
    return lr.intersectObjects(solid, false).length === 0;
  }

  function hurtSolo(n) {
    const ps = getPlayState();
    if (ps.engineMode !== "solo" || ps.activeState !== "play" || !ps.meAlive) return;
    const dmg = Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
    const nextHp = Math.max(0, ps.hp - dmg);
    ps.setHp(nextHp);
    hudUi.triggerDamageVignette();
    shake = 0.25;
    audioEngine.snd.hurt();
    hudUi.hud();
    sceneMgr.updateCanvasPostGrade(sceneMgr.getGt());
    if (nextHp <= 0) {
      testAimHeld = false;
      onSoloGameOver();
      audioEngine.snd.deathImpact();
      audioEngine.weaponAudio.clearScheduledTimers();
      if (typeof onSoloDefeated === "function") {
        onSoloDefeated({ score: soloScore, wave: soloWave, mapId: sceneMgr.getActiveMapId() });
      } else {
        $("pauseTitle").textContent = "Bạn đã bị hạ (Offline)";
        $("pauseSub").textContent = `Điểm: ${soloScore} — Trụ được ${soloWave} đợt.`;
        $("btnPauseResume").textContent = "Chơi lại";
        $("pauseOverlay").style.display = "grid";
      }
    }
  }

  function updDrone(d, dt) {
    const g = d.g;
    const e = cam.position;
    _droneTo.copy(e).sub(g.position);
    const dist = _droneTo.length();
    d.ring.rotation.z += dt * 18;
    d.hitT = Math.max(0, d.hitT - dt);
    d.body.material.emissive.setHex(d.hitT > 0 ? 0xffffff : 0);
    d.losT -= dt;
    if (d.losT <= 0) {
      d.losT = 0.3;
      d.los = dist < 32 && canSee(g.position, e);
    }
    if (d.st === "patrol" && d.los && dist < 26) d.st = "chase";
    else if (d.st === "chase") {
      if (d.los && dist < 14) d.st = "attack";
      else if (dist > 38) d.st = "patrol";
    } else if (d.st === "attack" && (!d.los || dist > 18)) {
      d.st = "chase";
    }

    let alt = 6.5;
    let sp = 3;
    _droneDir.set(0, 0, 0);
    if (d.st === "patrol") {
      _droneDir.copy(d.tgt).sub(g.position).setY(0);
      if (_droneDir.length() < 2) d.tgt.set(rnd(-35, 35), 6.5, rnd(-35, 35));
    } else if (d.st === "chase") {
      alt = 4;
      sp = 6.5;
      _droneDir.copy(_droneTo).setY(0);
    } else {
      alt = 2.3;
      sp = 3.5;
      _droneFwd.copy(_droneTo).setY(0).normalize();
      _droneSide.set(-_droneFwd.z, 0, _droneFwd.x).multiplyScalar(d.sd * 1.2);
      _droneDir.copy(_droneFwd).multiplyScalar(dist > 9 ? 1 : -1).add(_droneSide);
      d.cd -= dt;
      if (d.cd <= 0) {
        d.cd = rnd(1, 1.7);
        audioEngine.snd.laser();
        const miss = Math.random() < 0.4;
        _droneErr.set(rnd(-1, 1), rnd(-1, 0.3), rnd(-1, 1)).multiplyScalar(miss ? 1.8 : 0);
        _droneAim.copy(e).add(_droneErr);
        tracer(g.position, _droneAim, 0xff3a2a);
        if (!miss) hurtSolo(9);
      }
    }
    _droneDir.setY(0).normalize();
    g.position.addScaledVector(_droneDir, sp * dt);
    g.position.y += (alt + Math.sin(performance.now() / 400 + d.sd) * 0.3 - g.position.y) * Math.min(1, 2 * dt);
    g.lookAt(e.x, g.position.y, e.z);
  }

  function stepSoloDrones(dt) {
    if (drones.length === 0) {
      soloWaveCd -= dt;
      if (soloWaveCd <= 0) {
        soloWave++;
        for (let i = 0; i < 2 + soloWave; i++) spawnDrone();
        soloWaveCd = 3;
        hudUi.hud();
      }
    }
    for (let i = drones.length - 1; i >= 0; i--) {
      if (drones[i]) updDrone(drones[i], dt);
    }
  }

  function switchWeapon(targetSlot) {
    const ps = getPlayState();
    if (ps.activeState !== "play" || ((ps.engineMode === "lan" || ps.engineMode === "bots") && !ps.meAlive)) return false;
    const wid = SLOT_TO_WEAPON_ID[targetSlot];
    if (!wid || !WEAPONS[wid] || targetSlot === activeSlot) return false;

    const cur = activeWeapon().st;
    cur.reloadEndsAt = 0;
    cur.reloadStartAt = 0;
    audioEngine.weaponAudio.stopReload();
    input.clearAds();
    testAimHeld = false;
    vmAnim.setAdsZero();
    awmScope.cancelAutoRescope();
    scopeOut = awmScope.tick({ dt: 0, nowSec: performance.now() / 1000 });
    prevScopeSwayX = prevScopeSwayY = 0;

    prevSlot = activeSlot;
    activeSlot = targetSlot;
    const nextCfg = WEAPONS[wid];
    if (weapons[wid]) {
      weapons[wid].equipEndsAt = performance.now() + (nextCfg.equipTimeMs || 0);
    }
    m416WasFiring = false;
    m416Recoil.resetAll();
    vmAnim.onWeaponSwitched(wid);
    vmAnim.gunAnim(0, 0);
    audioEngine.snd.click(740);
    if (ps.engineMode === "lan") {
      net.send(MSG.SWITCH_WEAPON, { slot: targetSlot });
    }
    hudUi.hud();
    return true;
  }

  function reload() {
    const ps = getPlayState();
    if (ps.activeState !== "play" || ((ps.engineMode === "lan" || ps.engineMode === "bots") && !ps.meAlive)) return false;
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();
    if (st.reloadEndsAt > nowMs || st.mag >= cfg.magSize) return false;

    const dur = getReloadDurationMs(cfg, st.mag);
    st.isTactical = st.mag > 0;
    st.reloadStartAt = nowMs;
    st.reloadDuration = dur;
    st.reloadEndsAt = nowMs + dur;
    vmAnim.onReloadStarted();
    if (cfg.id === "m416" && m416WasFiring) {
      m416WasFiring = false;
      m416Recoil.onTriggerReleased();
    }
    if (cfg.id === "sniper") {
      awmScope.cancelAutoRescope();
    }

    input.clearAds();
    testAimHeld = false;
    audioEngine.snd.reload(cfg.id, st.isTactical);
    if (ps.engineMode === "lan") net.send(MSG.RELOAD, {});
    hudUi.hud();
    return true;
  }

  function raycastWorldWithSurface(origin, dir, maxDist = 140) {
    const activeCollision = sceneMgr.getActiveCollision();
    const militaryData = sceneMgr.getMilitaryData();
    const activeMapId = sceneMgr.getActiveMapId();

    if (activeCollision) {
      const wh = activeCollision.raycastShot(
        origin.x,
        origin.y,
        origin.z,
        dir.x,
        dir.y,
        dir.z,
        maxDist,
      );
      if (!wh) return null;
      const surface = resolveSurfaceType({
        tag: wh.tag || "",
        x: wh.x,
        z: wh.z,
        samplePuddle: militaryData && militaryData.samplePuddle ? militaryData.samplePuddle : null,
        sampleDirt: militaryData && militaryData.sampleDirt ? militaryData.sampleDirt : null,
      });
      return {
        distance: wh.dist,
        point: new Vec(wh.x, wh.y, wh.z),
        normal: new Vec(
          Number.isFinite(wh.nx) ? wh.nx : -dir.x,
          Number.isFinite(wh.ny) ? wh.ny : -dir.y,
          Number.isFinite(wh.nz) ? wh.nz : -dir.z,
        ).normalize(),
        surface,
        tag: wh.tag || "",
      };
    }

    _remoteRay.set(origin, dir);
    _remoteRay.far = maxDist;
    const ground = getGround();
    const targets = ground ? [ground, ...solid] : solid;
    const hit = _remoteRay.intersectObjects(targets, false)[0] || null;
    if (!hit) return null;
    if (hit.face && hit.object) {
      _worldNormalMat.getNormalMatrix(hit.object.matrixWorld);
      _worldHitNorm.copy(hit.face.normal).applyMatrix3(_worldNormalMat).normalize();
      if (_worldHitNorm.dot(dir) > 0) _worldHitNorm.negate();
    } else {
      _worldHitNorm.copy(dir).negate();
    }
    const objSurf = (hit.object && hit.object.userData && hit.object.userData.surface) || "";
    const surface = resolveSurfaceType({
      objectSurface: hit.object === ground ? "ground" : objSurf,
      x: hit.point.x,
      z: hit.point.z,
      samplePuddle: activeMapId === "harbor" ? sampleHarborPuddle : null,
    });
    return {
      distance: hit.distance,
      point: hit.point.clone(),
      normal: _worldHitNorm.clone(),
      surface,
      tag: objSurf,
    };
  }

  function gatherEnemyTargets() {
    const { engineMode } = getPlayState();
    if (engineMode === "solo") {
      _droneBodies.length = 0;
      for (let i = 0; i < drones.length; i++) _droneBodies.push(drones[i].body);
      return _droneBodies;
    }
    if (engineMode === "lan") {
      return remoteMgr.gatherEnemyHitMeshes(_entityTargets);
    }
    _entityTargets.length = 0;
    return _entityTargets;
  }

  function applyShotImpact({ hitEntity, hitWorld, dir, shotSeed, weaponId }) {
    const { engineMode } = getPlayState();
    if (engineMode === "lan") {
      // Server computes hit detection authoritatively in Match.handleFire; client only renders local surface impacts
      if (!hitEntity && hitWorld) {
        const imp = ballisticsVfx.spawnSurfaceImpact({
          point: hitWorld.point,
          normal: hitWorld.normal,
          incomingDir: dir,
          surface: hitWorld.surface,
          seed: shotSeed,
          weaponId,
        });
        audioEngine.snd.surfaceImpact(imp.surface, hitWorld.point, imp.ricochet);
      }
      return;
    }

    if (hitEntity) {
      const d = hitEntity.object.userData.drone;
      if (d) {
        d.hp -= weaponId === "sniper" ? 3 : 1;
        d.hitT = 0.08;
        hudUi.setHitmarker(weaponId === "sniper");
        audioEngine.snd.hit();
        burst(hitEntity.point, 12, 3.6);
        audioEngine.snd.surfaceImpact("metal", hitEntity.point, false);
        if (d.st === "patrol") d.st = "chase";
        if (d.hp <= 0) {
          burst(d.g.position, 45, 6);
          audioEngine.snd.boom();
          disposeDroneEntity(d);
          drones.splice(drones.indexOf(d), 1);
          soloScore += 100;
          hudUi.hud();
        }
      }
    } else if (hitWorld) {
      const imp = ballisticsVfx.spawnSurfaceImpact({
        point: hitWorld.point,
        normal: hitWorld.normal,
        incomingDir: dir,
        surface: hitWorld.surface,
        seed: shotSeed,
        weaponId,
      });
      audioEngine.snd.surfaceImpact(imp.surface, hitWorld.point, imp.ricochet);
    }
  }

  function stepAwmProjectiles(dt) {
    if (!(dt > 0) || awmProjectiles.length === 0) return;
    const targets = gatherEnemyTargets();
    const subStep = 0.004;
    for (let i = awmProjectiles.length - 1; i >= 0; i--) {
      const p = awmProjectiles[i];
      let rem = Math.min(dt, 0.05);
      let done = false;
      while (rem > 1e-6 && !done) {
        const h = Math.min(subStep, rem);
        rem -= h;
        _awmPrevPos.copy(p.pos);
        stepBallisticStep(p.pos, p.vel, h, AWM_SCOPE_PROFILE);
        _awmSeg.copy(p.pos).sub(_awmPrevPos);
        const segLen = _awmSeg.length();
        if (segLen <= 1e-6) continue;
        p.traveled += segLen;
        _awmSeg.multiplyScalar(1 / segLen);
        ray.set(_awmPrevPos, _awmSeg);
        ray.far = segLen;
        const entityHit = targets.length ? ray.intersectObjects(targets, false)[0] : null;
        const worldHit = raycastWorldWithSurface(_awmPrevPos, _awmSeg, segLen);
        let hitEntity = null;
        let hitWorld = null;
        if (entityHit && (!worldHit || entityHit.distance <= worldHit.distance)) {
          hitEntity = entityHit;
        } else if (worldHit) {
          hitWorld = worldHit;
        }
        if (hitEntity || hitWorld) {
          applyShotImpact({ hitEntity, hitWorld, dir: _awmSeg, shotSeed: p.seed, weaponId: p.weaponId });
          done = true;
        } else if (p.traveled >= p.maxRange || p.pos.y < -12) {
          done = true;
        }
      }
      if (done) awmProjectiles.splice(i, 1);
    }
  }

  function buildLanFirePayload(weaponId, originVec, dirVec, shotSeed) {
    const ps = getPlayState();
    return {
      weapon: weaponId,
      flags: ps.curFlags,
      origin: { x: originVec.x, y: originVec.y, z: originVec.z },
      dir: { x: dirVec.x, y: dirVec.y, z: dirVec.z },
      yaw: +ps.yaw.toFixed(4),
      pitch: +(ps.pitch + kick).toFixed(4),
      clientTime: Math.round(Date.now() + (net.clockOffsetMs || 0) - INTERP_DELAY_MS),
      seed: shotSeed,
      seq: localShotSeq,
    };
  }

  function shoot() {
    const ps = getPlayState();
    if (ps.activeState !== "play" || ((ps.engineMode === "lan" || ps.engineMode === "bots") && !ps.meAlive)) return false;
    if (requireFreshFireAfterRespawn && !input.fireJustPressed) {
      if (!input.fireHeld) requireFreshFireAfterRespawn = false;
      else return false;
    }
    requireFreshFireAfterRespawn = false;
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();

    if (st.reloadEndsAt > nowMs || nowMs < (st.equipEndsAt || 0) || ps.isSprinting) return false;
    if (st.mag <= 0) {
      if (cfg.id === "m416" && m416WasFiring) {
        m416WasFiring = false;
        m416Recoil.onTriggerReleased();
      }
      audioEngine.snd.dryClick(cfg.id);
      reload();
      return false;
    }
    if (nowMs < st.nextFireAt) return false;

    st.mag--;
    st.nextFireAt = nowMs + cfg.fireInterval;
    localShotSeq++;
    const shotSeed = (Math.random() * 999999) | 0;

    recoil = cfg.recoil || 0.07;
    const adsNow = vmAnim.getAds();
    if (cfg.id === "m416") {
      m416Recoil.onShotFired(
        nowMs / 1000,
        computeRecoilModifiers({ crouched: ps.crouched, prone: ps.prone, ads: adsNow > 0.5, grounded: ps.grounded }),
      );
      m416WasFiring = true;
    } else {
      kick += lerp(cfg.kickHip || 0.014, cfg.kickAds || 0.009, adsNow);
    }
    flashDur = cfg.id === "sniper" ? 0.058 : cfg.id === "pistol" ? 0.038 : 0.048;
    flashPeak = cfg.id === "sniper" ? 3.4 : cfg.id === "pistol" ? 2.0 : 2.6;
    flash = flashDur;
    flashL.intensity = flashPeak;
    shake = Math.min(0.24, shake + (cfg.id === "sniper" ? 0.14 : cfg.id === "pistol" ? 0.045 : 0.055) * (1 - 0.35 * adsNow));

    muzzleFlashRig.trigger(cfg.id);
    vmAnim.onShotFired(cfg.id, st.mag > 0, nowMs);
    if (cfg.id === "sniper") {
      awmScope.onShotFired(nowMs / 1000);
      if (st.mag <= 0) awmScope.cancelAutoRescope();
      input.adsToggled = false;
      input.adsHeld = false;
      testAimHeld = false;
    }
    if (cfg.id === "sniper") audioEngine.snd.sniperShot();
    else if (cfg.id === "pistol") audioEngine.snd.pistolShot();
    else audioEngine.snd.shot();
    if (cfg.id !== "sniper" || st.mag > 0) {
      const militaryData = sceneMgr.getMilitaryData();
      const underWater =
        sceneMgr.getActiveMapId() === "harbor" ||
        Boolean(militaryData && militaryData.samplePuddle && militaryData.samplePuddle(ps.P.x, ps.P.z) > 0.35);
      audioEngine.snd.shell(underWater, cfg.id);
    }
    hudUi.hud();

    const spread =
      cfg.id === "sniper" && scopeOut.adsT >= 0.5
        ? scopeOut.scopedSpread
        : computeWeaponSpread(cfg, ps.curFlags);
    cam.rotation.set(ps.pitch + kick, ps.yaw, 0);
    cam.updateMatrixWorld(true);
    ray.far = cfg.maxRange || 140;
    ray.setFromCamera({ x: rnd(-spread, spread), y: rnd(-spread, spread) }, cam);

    getViewmodelWorldPoint(muz, _muzFrom);
    if (cfg.id === "sniper") {
      const zeroRad = (scopeOut.zeroAngleDeg || 0) * DEG2RAD;
      _launchDir.copy(ray.ray.direction);
      if (zeroRad > 0) {
        _rightAxis.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
        _launchDir.applyAxisAngle(_rightAxis, zeroRad).normalize();
      }
      const predHit = raycastWorldWithSurface(ray.ray.origin, _launchDir, cfg.maxRange || 180);
      const end = predHit ? predHit.point : _fallbackEnd.copy(ray.ray.origin).addScaledVector(_launchDir, cfg.maxRange || 180);
      ballisticsVfx.spawnMuzzleSmokeAndSparks(_muzFrom, _launchDir, cfg.id);
      if (shouldSpawnTracer({ weaponId: cfg.id, shotIndex: localShotSeq, magRemaining: st.mag, isRemote: false })) {
        ballisticsVfx.spawnTracer(_muzFrom, end, {
          speed: 420,
          length: 8.5,
          width: 1.25,
          opacity: 0.94,
          fadeNearEnd: 1.4,
          colorHex: 0xfff5d4,
        });
      }
      if (ps.engineMode === "lan") {
        if (typeof flushStateBeforeFire === "function") flushStateBeforeFire();
        net.send(MSG.FIRE, buildLanFirePayload(cfg.id, ray.ray.origin, _launchDir, shotSeed));
      } else if (ps.engineMode === "bots" && typeof onBotFire === "function") {
        const botShotRes = onBotFire(cfg.id, ray.ray.origin, _launchDir, shotSeed);
        if (!botShotRes || !botShotRes.hit) {
          awmProjectiles.push({
            pos: ray.ray.origin.clone(),
            vel: _launchDir.clone().multiplyScalar(AWM_SCOPE_PROFILE.muzzleVelocity),
            traveled: 0,
            maxRange: cfg.maxRange || 180,
            seed: shotSeed,
            weaponId: "sniper",
          });
          stepAwmProjectiles(0.012);
        }
        if (st.mag === 0) reload();
        return true;
      }
      awmProjectiles.push({
        pos: ray.ray.origin.clone(),
        vel: _launchDir.clone().multiplyScalar(AWM_SCOPE_PROFILE.muzzleVelocity),
        traveled: 0,
        maxRange: cfg.maxRange || 180,
        seed: shotSeed,
        weaponId: "sniper",
      });
      stepAwmProjectiles(0.012);
      if (st.mag === 0) reload();
      return true;
    }

    const candidates = gatherEnemyTargets();
    const entityHit = candidates.length ? ray.intersectObjects(candidates, false)[0] : null;
    const worldHit = raycastWorldWithSurface(ray.ray.origin, ray.ray.direction, ray.far);

    let hitEntity = null;
    let hitWorld = null;
    if (entityHit && (!worldHit || entityHit.distance <= worldHit.distance)) {
      hitEntity = entityHit;
    } else if (worldHit) {
      hitWorld = worldHit;
    }

    const end = hitEntity
      ? hitEntity.point
      : hitWorld
        ? hitWorld.point
        : ray.ray.at(cfg.maxRange || 110, _fallbackEnd);

    ballisticsVfx.spawnMuzzleSmokeAndSparks(_muzFrom, ray.ray.direction, cfg.id);

    if (shouldSpawnTracer({ weaponId: cfg.id, shotIndex: localShotSeq, magRemaining: st.mag, isRemote: false })) {
      ballisticsVfx.spawnTracer(_muzFrom, end, {
        speed: cfg.id === "pistol" ? 260 : 320,
        length: cfg.id === "pistol" ? 4.4 : 6.0,
        width: cfg.id === "pistol" ? 0.85 : 1.0,
        opacity: 0.82,
        fadeNearEnd: 1.85,
        colorHex: 0xffe4a8,
      });
    }

    if (ps.engineMode === "lan") {
      if (typeof flushStateBeforeFire === "function") flushStateBeforeFire();
      net.send(MSG.FIRE, buildLanFirePayload(cfg.id, ray.ray.origin, ray.ray.direction, shotSeed));
    } else if (ps.engineMode === "bots" && typeof onBotFire === "function") {
      const botShotRes = onBotFire(cfg.id, ray.ray.origin, ray.ray.direction, shotSeed);
      if ((!botShotRes || !botShotRes.hit) && hitWorld) {
        applyShotImpact({
          hitEntity: null,
          hitWorld,
          dir: ray.ray.direction,
          shotSeed,
          weaponId: cfg.id,
        });
      }
      if (st.mag === 0) reload();
      return true;
    }
    applyShotImpact({
      hitEntity,
      hitWorld,
      dir: ray.ray.direction,
      shotSeed,
      weaponId: cfg.id,
    });

    if (st.mag === 0) reload();
    return true;
  }

  function handleRemoteFireVisuals(ev) {
    if (!ev || !ev.origin || !ev.dir) return null;
    const weaponId = ev.weapon && WEAPONS[ev.weapon] ? ev.weapon : "m416";
    const maxRange = (WEAPONS[weaponId] && WEAPONS[weaponId].maxRange) || 140;
    const seed = Number.isInteger(ev.seed) ? ev.seed : ((Math.random() * 999999) | 0);
    const av = ev.playerId ? remoteMgr.remotePlayers.get(ev.playerId) : null;
    let shotIdx = 1;
    if (av) {
      av.flashTimer = weaponId === "sniper" ? 0.062 : weaponId === "pistol" ? 0.042 : 0.055;
      av.muzFlash.rotation.z = rnd(0, Math.PI * 2);
      av.radarBlipUntil = performance.now() + 2000;
      av.shotSeq = (av.shotSeq || 0) + 1;
      shotIdx = av.shotSeq;
    }

    _remFrom.set(ev.origin.x, ev.origin.y, ev.origin.z);
    _remDir.set(ev.dir.x, ev.dir.y, ev.dir.z);
    if (_remDir.lengthSq() < 1e-6) _remDir.set(0, 0, -1);
    _remDir.normalize();

    let muzzleV = _remFrom;
    if (av && av.muzNode) {
      av.muzNode.getWorldPosition(_remMuzTmp);
      if (_remMuzTmp.distanceToSquared(_remFrom) < 9.0) muzzleV = _remMuzTmp;
    }

    const worldHit = raycastWorldWithSurface(_remFrom, _remDir, maxRange);
    const endV = worldHit ? worldHit.point : _remFallbackEnd.copy(_remFrom).addScaledVector(_remDir, Math.min(maxRange, 95));

    ballisticsVfx.spawnMuzzleSmokeAndSparks(muzzleV, _remDir, weaponId);
    if (shouldSpawnTracer({ weaponId, shotIndex: shotIdx, isRemote: true })) {
      const isAllyShot = Boolean(av && av.relation === "ally");
      const enemyColorId = settings && settings.get ? settings.get().enemyHighlightColor : "red";
      const enemyTracerHex = getEnemyHighlightPreset(enemyColorId).tracerHex;
      const tracerColor =
        weaponId === "sniper"
          ? isAllyShot
            ? 0xdcf2ff
            : 0xffd2b8
          : isAllyShot
            ? ALLY_IFF_META.tracerHex
            : enemyTracerHex;
      ballisticsVfx.spawnTracer(muzzleV, endV, {
        speed: weaponId === "sniper" ? 410 : weaponId === "pistol" ? 260 : 310,
        length: weaponId === "sniper" ? 8.2 : weaponId === "pistol" ? 4.4 : 6.0,
        width: weaponId === "sniper" ? 1.2 : 1.0,
        opacity: weaponId === "sniper" ? 0.92 : 0.78,
        fadeNearEnd: 0.45,
        colorHex: tracerColor,
      });
    }

    let impactRes = null;
    if (worldHit) {
      impactRes = ballisticsVfx.spawnSurfaceImpact({
        point: worldHit.point,
        normal: worldHit.normal,
        incomingDir: _remDir,
        surface: worldHit.surface,
        seed,
        weaponId,
      });
      audioEngine.snd.surfaceImpact(impactRes.surface, worldHit.point, impactRes.ricochet);
    }

    const spatial = audioEngine.computeSpatialAudio(_remFrom);
    audioEngine.snd.remoteShot(spatial.dist, spatial.pan, weaponId);

    const whiz = computeBulletWhizBy(_remFrom, endV, cam.position, audioEngine.getCameraRight());
    if (whiz) {
      audioEngine.snd.whizBy(whiz.closeness, whiz.pan);
    }
    return { worldHit, impactRes, whiz };
  }

  function stepWeaponUpdate(dt, nowMs, canAct, activeControl, chatOpen, isSprinting, crouched, grounded, velX, velZ, lookState, prone = false) {
    const isM416Active = SLOT_TO_WEAPON_ID[activeSlot] === "m416";
    const sCfg = settings ? settings.get() : { sens: 1, adsSens: 0.58, invertY: false, adsMode: "toggle", fov: 75 };

    if (canAct && activeControl && !chatOpen) {
      const { cfg, st } = activeWeapon();
      const wantsFire = cfg.auto ? input.fireHeld : input.fireJustPressed;
      if (input.fireJustPressed) requireFreshFireAfterRespawn = false;
      if (!input.fireHeld) requireFreshFireAfterRespawn = false;
      if (wantsFire && !isSprinting && st.reloadEndsAt <= nowMs) {
        shoot();
      } else if (isM416Active && m416WasFiring && (!wantsFire || isSprinting)) {
        m416WasFiring = false;
        m416Recoil.onTriggerReleased();
      }
    } else if (m416WasFiring) {
      m416WasFiring = false;
      m416Recoil.onTriggerReleased();
    }

    input.endFrame();

    if (isM416Active) {
      const recoilDeltaDeg = m416Recoil.tick(nowMs / 1000, dt);
      if (recoilDeltaDeg.x !== 0 || recoilDeltaDeg.y !== 0) {
        lookState.pitch = Math.max(-1.45, Math.min(1.45, lookState.pitch + recoilDeltaDeg.y * DEG2RAD));
        lookState.yaw -= recoilDeltaDeg.x * DEG2RAD;
      }
    }

    stepAwmProjectiles(dt);

    const curW = activeWeapon();
    if (curW.cfg.id === "sniper") {
      const holdBreath =
        canAct &&
        activeControl &&
        !chatOpen &&
        !isSprinting &&
        (testHoldBreath || input.isDown("sprint")) &&
        scopeOut.adsT >= 0.7;
      scopeOut = awmScope.tick({
        dt,
        nowSec: nowMs / 1000,
        adsActive: canAct && !isSprinting && curW.st.reloadEndsAt <= nowMs,
        holdBreath,
        stance: prone ? STANCE.PRONE : crouched ? STANCE.CROUCH : STANCE.STAND,
        horizSpeed: Math.hypot(velX, velZ),
        grounded,
        baseVFovDeg: sCfg.fov || 75,
        aspect: vpAspectGetter(),
      });
      if (scopeOut.autoRescopedLevel > 0) {
        input.adsToggled = true;
        input.adsHeld = true;
        emitScopeAudioCue(scopeOut.autoRescopedLevel, "sniper");
      }
      const dSwayX = scopeOut.sway.x - prevScopeSwayX;
      const dSwayY = scopeOut.sway.y - prevScopeSwayY;
      prevScopeSwayX = scopeOut.sway.x;
      prevScopeSwayY = scopeOut.sway.y;
      if (dSwayX !== 0 || dSwayY !== 0) {
        lookState.yaw += dSwayX * DEG2RAD;
        lookState.pitch = Math.max(-1.45, Math.min(1.45, lookState.pitch + dSwayY * DEG2RAD));
      }
    } else if (prevScopeSwayX !== 0 || prevScopeSwayY !== 0) {
      prevScopeSwayX = 0;
      prevScopeSwayY = 0;
    }

    recoil *= 1 - 12 * dt;
    kick = Math.max(0, kick - dt * 0.12);
    flash = Math.max(0, flash - dt);
    muzzleFlashRig.update(dt);
    flashL.intensity = flash > 0 ? Math.pow(Math.max(0, flash / Math.max(0.01, flashDur)), 1.4) * flashPeak : 0;
    shake = Math.max(0, shake - dt);
  }

  return {
    getDroneProtos: () => ({ dMat, droneEyeMat, droneBodyGeo, droneEyeGeo, droneRingGeo }),
    hasDrones: () => drones.length > 0,
    clearAllDrones,
    stepSoloDrones,
    hurtSolo,
    resetAllWeapons,
    activeWeapon,
    switchWeapon,
    reload,
    shoot,
    spawnHitSparks: (pt, colorHex = 0xffb85c) => {
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)) {
        burst(new Vec(pt.x, pt.y, pt.z), 10, 3.2, colorHex);
      }
    },
    armFreshFireGate: () => {
      requireFreshFireAfterRespawn = Boolean(input && input.fireHeld);
    },
    stepWeaponUpdate,
    handleRemoteFireVisuals,
    emitScopeAudioCue,
    nextMagazineSeed,
    m416Recoil,
    awmScope,
    getScopeOut: () => scopeOut,
    setScopeOut: (v) => { scopeOut = v; },
    getWeapons: () => weapons,
    getActiveSlot: () => activeSlot,
    setActiveSlot: (s) => { activeSlot = s; },
    getPrevSlot: () => prevSlot,
    setPrevSlot: (s) => { prevSlot = s; },
    getRecoil: () => recoil,
    getKick: () => kick,
    getShake: () => shake,
    getSoloStats: () => ({ soloScore, soloWave }),
    resetSoloStats: () => { soloScore = 0; soloWave = 0; soloWaveCd = 1.0; },
    triggerHurtShake: () => { shake = 0.25; },
    resetOnSetPose: () => {
      m416WasFiring = false;
      m416Recoil.resetAll(nextMagazineSeed());
      awmScope.resetAll();
      scopeOut = awmScope.tick({ dt: 0, nowSec: 0 });
      prevScopeSwayX = prevScopeSwayY = 0;
      awmProjectiles.length = 0;
    },
    getTestAimHeld: () => testAimHeld,
    setTestAimHeld: (v) => { testAimHeld = Boolean(v); },
    getM416WasFiring: () => m416WasFiring,
    setM416WasFiring: (v) => { m416WasFiring = Boolean(v); },
    resetVisualStateOnMatchStart: () => {
      flash = 0;
      flashL.intensity = 0;
      localShotSeq = 0;
      testAimHeld = false;
    },
    resetOnStop: () => {
      flash = 0;
      flashL.intensity = 0;
      localShotSeq = 0;
      m416WasFiring = false;
      m416Recoil.resetAll(nextMagazineSeed());
      awmScope.resetAll();
      scopeOut = awmScope.tick({ dt: 0, nowSec: 0 });
      prevScopeSwayX = prevScopeSwayY = 0;
      awmProjectiles.length = 0;
      testHoldBreath = false;
      testAimHeld = false;
    },
    syncMagazineResetOnReloadComplete(nowMs) {
      const { cfg, st } = activeWeapon();
      if (st.reloadEndsAt > 0 && nowMs >= st.reloadEndsAt) {
        st.mag = cfg.magSize;
        st.reloadEndsAt = 0;
        if (cfg.id === "m416") m416Recoil.resetMagazine(nextMagazineSeed());
        hudUi.hud();
      }
    },
    applyAmmoMsg(msg) {
      if (msg.weapons && typeof msg.weapons === "object") {
        for (const [wid, val] of Object.entries(msg.weapons)) {
          if (weapons[wid] && Number.isFinite(val)) weapons[wid].mag = val;
        }
      }
      if (msg.activeWeaponId && WEAPONS[msg.activeWeaponId]) {
        const targetSlot = WEAPONS[msg.activeWeaponId].slot;
        if (targetSlot !== activeSlot) {
          activeSlot = targetSlot;
          assetLoader.applyViewmodelWeapon(msg.activeWeaponId);
        }
      }
      if (msg.id && weapons[msg.id] && Number.isFinite(msg.mag)) {
        weapons[msg.id].mag = msg.mag;
        if (msg.reloadingMs > 0) {
          const dur = weapons[msg.id].reloadDuration || WEAPONS[msg.id].reloadTime;
          weapons[msg.id].reloadStartAt = performance.now() - Math.max(0, dur - msg.reloadingMs);
          weapons[msg.id].reloadEndsAt = performance.now() + msg.reloadingMs;
        } else {
          weapons[msg.id].reloadEndsAt = 0;
        }
        if (Number.isFinite(msg.equipMs) && msg.equipMs > 0) {
          const nowMs = performance.now();
          const serverEquipEnd = nowMs + msg.equipMs;
          const curEquipEnd = weapons[msg.id].equipEndsAt || 0;
          weapons[msg.id].equipEndsAt =
            curEquipEnd > nowMs ? Math.min(curEquipEnd, serverEquipEnd) : serverEquipEnd;
        } else if (msg.equipMs === 0) {
          weapons[msg.id].equipEndsAt = 0;
        }
      }
    },
    getM416RecoilState: () => m416Recoil.getState(),
    getAwmScopeState: () => ({
      ...awmScope.getState(),
      lastOut: scopeOut,
      projectileCount: awmProjectiles.length,
    }),
    getVfxStats: () => ({
      ...ballisticsVfx.getStats(),
      muzzleFlashVisible: Boolean(muzzleFlashRig.mesh.visible),
      flashLightIntensity: flashL.intensity,
      flashLightVisible: Boolean(flashL.visible),
      localShotSeq,
    }),
    setTestCombat: (opts = {}) => {
      if (typeof opts.fireHeld === "boolean") input.fireHeld = opts.fireHeld;
      if (Number.isInteger(opts.recoilSeed)) {
        m416WasFiring = false;
        m416Recoil.resetAll(opts.recoilSeed);
      }
      if (typeof opts.aimHeld === "boolean") {
        testAimHeld = opts.aimHeld;
        if (SLOT_TO_WEAPON_ID[activeSlot] === "sniper") {
          awmScope.setScopedState(opts.aimHeld, opts.scopeLevel || 1);
          input.adsToggled = opts.aimHeld;
          input.adsHeld = opts.aimHeld;
        }
      }
      if (Number.isInteger(opts.scopeLevel) && SLOT_TO_WEAPON_ID[activeSlot] === "sniper") {
        awmScope.setScopedState(opts.scopeLevel > 0, Math.max(1, opts.scopeLevel));
        input.adsToggled = opts.scopeLevel > 0;
        input.adsHeld = opts.scopeLevel > 0;
      }
      if (typeof opts.holdBreath === "boolean") testHoldBreath = opts.holdBreath;
      if (Number.isInteger(opts.cycleZeroDir)) awmScope.cycleZero(opts.cycleZeroDir);
    },
  };
}
