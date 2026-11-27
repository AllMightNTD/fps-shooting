/**
 * First-Person Viewmodel Procedural Animation, Socket IK Sampling & Scope Overlay Sync.
 */

export function createViewmodelAnimator({
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
  getStateRefs,
}) {
  const Vec = THREE.Vector3;
  const lerp = THREE.MathUtils.lerp;
  const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  const CH_REST_Z = 0.118;
  const MAG_REST = new Vec(0, -0.042, -0.064);
  const HIP_POS = new Vec(0.172, -0.156, -0.435);
  const ADS_POS = new Vec(0, -OPTIC_Y, -0.215);
  const PISTOL_HIP_POS = new Vec(0.125, -0.128, -0.315);
  const PISTOL_ADS_POS = new Vec(0, -0.0654, -0.280);
  const SNIPER_HIP_POS = new Vec(0.166, -0.140, -0.455);
  gun.position.copy(HIP_POS);

  const _vmInvQ = new THREE.Quaternion();
  const _sockHgP = new Vec(), _sockHgQ = new THREE.Quaternion();
  const _sockMagP = new Vec(), _sockMagQ = new THREE.Quaternion();
  const _sockBoltP = new Vec(), _sockBoltQ = new THREE.Quaternion();
  const _sockGripP = new Vec(), _sockGripQ = new THREE.Quaternion();
  const _sockRBoltP = new Vec(), _sockRBoltQ = new THREE.Quaternion();
  const _leftTargetP = new Vec(), _leftTargetQ = new THREE.Quaternion();
  const _rightTargetP = new Vec(), _rightTargetQ = new THREE.Quaternion();

  let lyaw = 0, lpit = 0, swx = 0, swy = 0, spr = 0;
  let bolt = 0, rlp = 0, ads = 0, trigPull = 0;
  let pistolSlideOffset = 0, pistolRecoilPitch = 0, pistolRecoilKickZ = 0, pistolTrigPull = 0;
  let awmBoltCycleStartAt = 0;

  const _uiCache = Object.create(null);

  function readSocketInVmCam(node, outPos, outQuat) {
    node.getWorldPosition(outPos);
    vmCam.worldToLocal(outPos);
    node.getWorldQuaternion(outQuat);
    outQuat.premultiply(_vmInvQ).normalize();
  }

  function sampleSniperLeftSocket(rl, socks) {
    readSocketInVmCam(socks.handguard, _sockHgP, _sockHgQ);
    if (rl <= 0.04 || rl >= 0.78) {
      if (rl >= 0.66 && rl < 0.78) {
        readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
        const k = smooth01((rl - 0.66) / 0.12);
        _leftTargetP.lerpVectors(_sockMagP, _sockHgP, k);
        _leftTargetQ.copy(_sockMagQ).slerp(_sockHgQ, k);
        return k < 0.5 ? "mag" : "support";
      }
      _leftTargetP.copy(_sockHgP);
      _leftTargetQ.copy(_sockHgQ);
      return "support";
    }
    readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
    if (rl <= 0.22) {
      const k = smooth01((rl - 0.04) / 0.18);
      _leftTargetP.lerpVectors(_sockHgP, _sockMagP, k);
      _leftTargetQ.copy(_sockHgQ).slerp(_sockMagQ, k);
      return k > 0.5 ? "mag" : "support";
    }
    _leftTargetP.copy(_sockMagP);
    _leftTargetQ.copy(_sockMagQ);
    return "mag";
  }

  function sampleLeftSocket(rl, isTactical, socks) {
    readSocketInVmCam(socks.handguard, _sockHgP, _sockHgQ);
    if (rl <= 0.03) {
      _leftTargetP.copy(_sockHgP);
      _leftTargetQ.copy(_sockHgQ);
      return "support";
    }

    readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
    if (rl <= 0.22) {
      const k = smooth01((rl - 0.03) / 0.19);
      _leftTargetP.lerpVectors(_sockHgP, _sockMagP, k);
      _leftTargetQ.copy(_sockHgQ).slerp(_sockMagQ, k);
      return k > 0.5 ? "mag" : "support";
    }
    if (rl <= 0.72) {
      _leftTargetP.copy(_sockMagP);
      _leftTargetQ.copy(_sockMagQ);
      return "mag";
    }
    if (isTactical) {
      const k = smooth01((rl - 0.72) / 0.26);
      _leftTargetP.lerpVectors(_sockMagP, _sockHgP, k);
      _leftTargetQ.copy(_sockMagQ).slerp(_sockHgQ, k);
      return k < 0.6 ? "mag" : "support";
    }

    readSocketInVmCam(socks.bolt, _sockBoltP, _sockBoltQ);
    if (rl <= 0.81) {
      const k = smooth01((rl - 0.72) / 0.09);
      _leftTargetP.lerpVectors(_sockMagP, _sockBoltP, k);
      _leftTargetQ.copy(_sockMagQ).slerp(_sockBoltQ, k);
      return k > 0.5 ? "bolt" : "mag";
    }
    if (rl <= 0.92) {
      _leftTargetP.copy(_sockBoltP);
      _leftTargetQ.copy(_sockBoltQ);
      return "bolt";
    }
    const kBack = smooth01((rl - 0.92) / 0.08);
    _leftTargetP.lerpVectors(_sockBoltP, _sockHgP, kBack);
    _leftTargetQ.copy(_sockBoltQ).slerp(_sockHgQ, kBack);
    return kBack < 0.4 ? "bolt" : "support";
  }

  function syncScopeAndReticleDom(scopedSniper, isSniperWeapon, isReloading, rl, mv, cfg, curFlags, scopeOut, recoil) {
    const scopeEl = $("sniperScope");
    const scopeDisplay = scopedSniper ? "block" : "none";
    if (_uiCache.scopeDisplay !== scopeDisplay) {
      _uiCache.scopeDisplay = scopeDisplay;
      scopeEl.style.display = scopeDisplay;
    }
    if (scopedSniper) {
      const ovAlpha = scopeOut.overlayAlpha.toFixed(3);
      if (_uiCache.scopeOpacity !== ovAlpha) {
        _uiCache.scopeOpacity = ovAlpha;
        scopeEl.style.opacity = ovAlpha;
      }
      const retWrap = $("scopeReticleWrap");
      if (retWrap) {
        const retFilter = scopeOut.blur01 > 0.04 ? `blur(${(scopeOut.blur01 * 3.8).toFixed(2)}px)` : "";
        const retOpacity = (1 - scopeOut.blur01 * 0.42).toFixed(3);
        if (_uiCache.retFilter !== retFilter) { _uiCache.retFilter = retFilter; retWrap.style.filter = retFilter; }
        if (_uiCache.retOpacity !== retOpacity) { _uiCache.retOpacity = retOpacity; retWrap.style.opacity = retOpacity; }
      }
      const zoomEl = $("scopeZoomBadge");
      if (zoomEl) {
        const zoomText = `${scopeOut.targetZoom.toFixed(1).replace(/\.0$/, "")}x`;
        if (_uiCache.zoomText !== zoomText) { _uiCache.zoomText = zoomText; zoomEl.textContent = zoomText; }
      }
      const zeroEl = $("scopeZeroBadge");
      if (zeroEl) {
        const zeroText = `ZERO ${scopeOut.zeroDistance}m [ / ]`;
        if (_uiCache.zeroText !== zeroText) { _uiCache.zeroText = zeroText; zeroEl.textContent = zeroText; }
      }
      const breathFill = $("scopeBreathFill");
      if (breathFill) {
        const bW = `${Math.round(scopeOut.breath01 * 100)}%`;
        const bColor = scopeOut.fatigued ? "#ef4444" : scopeOut.holding ? "#f0b429" : "#4ec3b0";
        if (_uiCache.bW !== bW) { _uiCache.bW = bW; breathFill.style.width = bW; }
        if (_uiCache.bColor !== bColor) { _uiCache.bColor = bColor; breathFill.style.backgroundColor = bColor; }
      }
    } else if (_uiCache.scopeOpacity !== "0") {
      _uiCache.scopeOpacity = "0";
      scopeEl.style.opacity = "0";
    }

    const crossOpacity = scopedSniper || (isSniperWeapon && ads > 0.35) ? 0 : Math.max(0, 1 - ads * 1.4);
    const crossOpStr = crossOpacity.toFixed(3);
    const spreadK = computeWeaponSpread(cfg, curFlags) / Math.max(0.001, cfg.baseSpread);
    const crossScale = `scale(${(1 + recoil * 4 + (mv && !ads ? 0.16 : 0) + (spreadK - 1) * 0.25).toFixed(3)})`;
    const crossEl = $("cross");
    if (_uiCache.crossOpStr !== crossOpStr) { _uiCache.crossOpStr = crossOpStr; crossEl.style.opacity = crossOpStr; }
    if (_uiCache.crossScale !== crossScale) { _uiCache.crossScale = crossScale; crossEl.style.transform = crossScale; }

    const relDisplay = isReloading ? "block" : "none";
    if (_uiCache.relDisplay !== relDisplay) {
      _uiCache.relDisplay = relDisplay;
      $("reloadRingWrap").style.display = relDisplay;
    }
    if (isReloading) {
      const dashOffset = (RING_CIRCUMFERENCE * (1 - rl)).toFixed(2);
      if (_uiCache.dashOffset !== dashOffset) {
        _uiCache.dashOffset = dashOffset;
        $("reloadArc").setAttribute("stroke-dashoffset", dashOffset);
      }
    }
  }

  function gunAnim(dt, mv) {
    const nowMs = performance.now();
    const {
      activeWeapon,
      weapons,
      isSprinting,
      engineMode,
      meAlive,
      curFlags,
      yaw,
      pitch,
      bob,
      recoil,
      gt,
      testAimHeld,
      scopeOut,
    } = getStateRefs();

    const { cfg, st } = activeWeapon();
    const isReloading = st.reloadEndsAt > nowMs;
    const rl = isReloading ? Math.max(0, Math.min(1, (nowMs - st.reloadStartAt) / (st.reloadDuration || cfg.reloadTime))) : 0;

    const isSniperWeapon = cfg.id === "sniper";
    const wantsAds = (testAimHeld || input.isAdsActive()) && !isReloading && !isSprinting;
    const baseFov = settings ? settings.get().fov : 75;
    if (isSniperWeapon) {
      ads = scopeOut.adsT;
      const targetCamFov = scopeOut.vFov || baseFov;
      if (Math.abs(cam.fov - targetCamFov) > 0.01 || dt === 0) {
        cam.fov = targetCamFov;
        cam.updateProjectionMatrix();
        vmCam.fov = lerp(VM_HIP_FOV, VM_ADS_FOV, scopeOut.e);
        vmCam.updateProjectionMatrix();
      }
    } else {
      const prevAds = ads;
      ads += ((wantsAds ? 1 : 0) - ads) * Math.min(1, 13 * dt);
      const targetAdsFov = cfg.adsFov || 55;
      if (Math.abs(ads - prevAds) > 1e-4 || dt === 0) {
        cam.fov = lerp(baseFov, targetAdsFov, ads);
        cam.updateProjectionMatrix();
        vmCam.fov = lerp(VM_HIP_FOV, VM_ADS_FOV, ads);
        vmCam.updateProjectionMatrix();
      }
    }

    const aliveSelf = engineMode === "solo" || meAlive;
    const scopedSniper = aliveSelf && cfg.scopeOverlay && isSniperWeapon && scopeOut.overlayAlpha > 0.02;
    syncScopeAndReticleDom(scopedSniper, isSniperWeapon, isReloading, rl, mv, cfg, curFlags, scopeOut, recoil);

    spr += ((isSprinting ? 1 : 0) - spr) * Math.min(1, 8 * dt);
    swx += (Math.max(-0.06, Math.min(0.06, (yaw - lyaw) * -2)) - swx) * Math.min(1, 12 * dt);
    swy += (Math.max(-0.05, Math.min(0.05, (pitch - lpit) * 2)) - swy) * Math.min(1, 12 * dt);
    lyaw = yaw;
    lpit = pitch;

    const isPistol = cfg.id === "pistol";
    const isSniper = cfg.id === "sniper";
    const tl = rl > 0 ? Math.min(1, rl / 0.1, (1 - rl) / 0.1) : 0;

    const {
      boltVis,
      trig,
      ch,
      mag,
      pistolSlideNode,
      pistolTriggerNode,
      pistolMagNode,
      awmBoltPivot,
      awmMagGroup,
    } = assetLoader.getNodes();
    const { pistolPivot } = assetLoader.viewGroups;
    const { awmOpticY } = assetLoader.getMuzzleAnchors();

    mag.position.copy(MAG_REST);
    mag.rotation.set(0, 0, 0);
    awmMagGroup.position.set(0, 0, 0);
    if (rl > 0.24 && rl < 0.72) {
      const magArc = Math.sin(((rl - 0.24) / 0.48) * Math.PI);
      if (cfg.id === "m416") {
        mag.position.set(-0.020 * magArc, MAG_REST.y - 0.116 * magArc, MAG_REST.z - 0.014 * magArc);
        mag.rotation.set(0.14 * magArc, 0, -0.08 * magArc);
      } else if (isSniper) {
        awmMagGroup.position.set(0, -11.5 * magArc, 2.0 * magArc);
      }
    }

    let awmCycleT = 0;
    if (isSniper) {
      if (isReloading && !st.isTactical && rl >= 0.72) {
        awmCycleT = smooth01((rl - 0.72) / 0.26);
      } else if (awmBoltCycleStartAt > 0 && !isReloading) {
        const dtShot = (nowMs - awmBoltCycleStartAt) / 920;
        if (dtShot >= 0 && dtShot < 1) {
          awmCycleT = dtShot;
        } else if (dtShot >= 1) {
          awmBoltCycleStartAt = 0;
        }
      }
    }
    if (awmCycleT > 0 && awmCycleT < 1) {
      let liftK = 0;
      let pullK = 0;
      if (awmCycleT < 0.18) {
        liftK = smooth01(awmCycleT / 0.18);
      } else if (awmCycleT < 0.50) {
        liftK = 1;
        pullK = smooth01((awmCycleT - 0.18) / 0.32);
      } else if (awmCycleT < 0.82) {
        liftK = 1;
        pullK = 1 - smooth01((awmCycleT - 0.50) / 0.32);
      } else {
        liftK = 1 - smooth01((awmCycleT - 0.82) / 0.18);
      }
      awmBoltPivot.rotation.z = -0.88 * liftK;
      awmBoltPivot.position.z = -23.12 - 11.0 * pullK;
    } else {
      awmBoltPivot.rotation.z = 0;
      awmBoltPivot.position.z = -23.12;
    }

    const decayRecoilP = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;
    const decayKickZ = dt > 0 ? 1 - Math.exp(-16 * dt) : 1;
    const decaySlide = dt > 0 ? 1 - Math.exp(-22 * dt) : 1;
    pistolRecoilPitch = lerp(pistolRecoilPitch, 0, decayRecoilP);
    pistolRecoilKickZ = lerp(pistolRecoilKickZ, 0, decayKickZ);

    let pistolMagDrop = 0;
    let pistolReloadTiltZ = 0;
    if (isPistol && rl > 0) {
      if (rl >= 0.16 && rl < 0.46) {
        const kDrop = smooth01((rl - 0.16) / 0.30);
        pistolMagDrop = kDrop * 0.14;
        pistolReloadTiltZ = kDrop * 0.26;
      } else if (rl >= 0.46 && rl < 0.74) {
        const kIns = smooth01((rl - 0.46) / 0.28);
        pistolMagDrop = (1 - kIns) * 0.14;
        pistolReloadTiltZ = (1 - kIns) * 0.26;
      }
    }
    pistolMagNode.position.set(0, -pistolMagDrop, pistolMagDrop * 0.32);

    const pistolEmptyLocked =
      weapons.pistol &&
      ((weapons.pistol.mag === 0 && !(isPistol && isReloading)) ||
        (isPistol && isReloading && !st.isTactical && rl < 0.88));
    const pistolRackPull =
      isPistol && isReloading && !st.isTactical && rl >= 0.83 && rl < 0.93
        ? smooth01((rl - 0.83) / 0.06) * 0.046
        : 0;
    const targetSlideZ = pistolRackPull > 0 ? pistolRackPull : pistolEmptyLocked ? 0.042 : 0;
    pistolSlideOffset = lerp(pistolSlideOffset, targetSlideZ, decaySlide);
    pistolSlideNode.position.z = pistolSlideOffset;
    pistolPivot.position.set(0, 0, pistolRecoilKickZ);
    pistolPivot.rotation.set(pistolRecoilPitch, 0, pistolReloadTiltZ);

    const pull = !st.isTactical && rl >= 0.83 && rl < 0.94 ? smooth01((rl - 0.83) / 0.07) : 0;
    ch.position.z = CH_REST_Z + pull * 0.055;
    if (rl > 0 && !isPistol) bolt = pull;
    if (!weaponAudio.hasBuffer(cfg.id, "reload")) {
      if (rlp < 0.28 && rl >= 0.28) snd.click(900);
      if (rlp < 0.68 && rl >= 0.68) snd.click(1400);
      if (!st.isTactical && rlp < 0.88 && rl >= 0.88) snd.click(620);
    }
    rlp = rl;
    if (rl <= 0) bolt = Math.max(0, bolt - dt * 16);
    boltVis.visible = bolt < 0.15;

    const firingVisual = (input.fireHeld || curFlags & FLAG.FIRING) && !isReloading && st.mag > 0;
    trigPull += ((firingVisual ? 1 : 0) - trigPull) * Math.min(1, 25 * dt);
    pistolTrigPull = lerp(pistolTrigPull, firingVisual && isPistol ? 0.42 : 0, dt > 0 ? 1 - Math.exp(-18 * dt) : 1);
    trig.rotation.x = trigPull * 0.3;
    pistolTriggerNode.rotation.x = -pistolTrigPull * 0.45;

    const hip = 1 - ads;
    const calm = 1 - 0.78 * ads;
    const bobK = mv * (1 - 0.88 * ads);
    const chW = !st.isTactical && rl > 0.74 && rl < 0.98 ? smooth01(Math.min((rl - 0.74) / 0.09, (0.98 - rl) / 0.08)) : 0;
    const baseHip = isPistol ? PISTOL_HIP_POS : isSniper ? SNIPER_HIP_POS : HIP_POS;
    const targetAdsX = isPistol ? PISTOL_ADS_POS.x : ADS_POS.x;
    const adsPosY = isPistol ? PISTOL_ADS_POS.y : isSniper ? -awmOpticY : ADS_POS.y;
    const adsPosZ = isPistol ? PISTOL_ADS_POS.z : isSniper ? -0.165 : ADS_POS.z;

    gun.position.set(
      lerp(baseHip.x, targetAdsX, ads) + (swx + Math.sin(bob) * 0.0055 * bobK) * calm - (isPistol ? 0.024 : 0.044) * tl,
      lerp(baseHip.y, adsPosY, ads) + (swy + Math.sin(bob * 2) * 0.007 * bobK) * calm - 0.055 * spr + 0.018 * tl + Math.sin(gt * 1.6) * 0.0016 * hip,
      lerp(baseHip.z, adsPosZ, ads) + recoil * (isPistol ? 0.35 : 0.95 - 0.65 * ads) + 0.028 * tl - (isPistol ? 0.022 : 0.042) * chW,
    );

    const hipPitch = (isPistol ? 0.028 : isSniper ? 0.032 : 0.036) * hip;
    const hipYaw = (isPistol ? 0.038 : isSniper ? 0.046 : 0.052) * hip;
    gun.rotation.set(
      hipPitch + (recoil * (isPistol ? 0.85 : 1.85) + swy * 1.8) * calm - 0.20 * spr + (isPistol ? 0.09 : 0.16) * tl,
      hipYaw + (0.48 * spr + swx * 1.8) * calm + (isPistol ? 0.12 : 0.20) * tl,
      swx * 1.2 * calm - (isPistol ? 0.10 : 0.24) * tl,
    );

    vmCam.position.copy(cam.position);
    vmCam.quaternion.copy(cam.quaternion);
    vmCam.updateMatrixWorld(true);
    _vmInvQ.copy(vmCam.quaternion).invert();

    const activeSocks = assetLoader.weaponSockets[cfg.id] || assetLoader.weaponSockets.m416;
    const leftAction = isSniper
      ? sampleSniperLeftSocket(rl, activeSocks)
      : sampleLeftSocket(rl, Boolean(st.isTactical), activeSocks);

    readSocketInVmCam(activeSocks.grip, _sockGripP, _sockGripQ);
    let rightAction = "grip";
    if (isSniper && awmCycleT > 0.02 && awmCycleT < 0.98) {
      readSocketInVmCam(activeSocks.bolt, _sockRBoltP, _sockRBoltQ);
      const reachK =
        awmCycleT < 0.15
          ? smooth01(awmCycleT / 0.15)
          : awmCycleT > 0.85
            ? 1 - smooth01((awmCycleT - 0.85) / 0.15)
            : 1;
      _rightTargetP.lerpVectors(_sockGripP, _sockRBoltP, reachK);
      _rightTargetQ.copy(_sockGripQ).slerp(_sockRBoltQ, reachK);
      rightAction = reachK > 0.4 ? "bolt" : "grip";
    } else {
      _rightTargetP.copy(_sockGripP);
      _rightTargetQ.copy(_sockGripQ);
    }

    const { armsCtrl, armsRoot } = assetLoader.getArms();
    if (armsCtrl) {
      const hideSniperVm = aliveSelf && cfg.scopeOverlay && scopeOut.hideWeaponModel;
      const canShowArms = (engineMode === "solo" || meAlive) && engineMode !== "idle" && !hideSniperVm;
      armsCtrl.update({
        weaponId: cfg.id,
        leftSocketPos: _leftTargetP,
        leftSocketQuat: _leftTargetQ,
        rightSocketPos: _rightTargetP,
        rightSocketQuat: _rightTargetQ,
        triggerPull: isPistol ? Math.min(1, pistolTrigPull / 0.42) : trigPull,
        ads,
        leftAction,
        rightAction,
        hideArms: !canShowArms,
      });
      if (armsRoot) armsRoot.updateMatrixWorld(true);
    }
  }

  function onShotFired(weaponId, hasAmmoLeft, nowMs) {
    bolt = 1;
    if (weaponId === "pistol") {
      pistolRecoilPitch = 0.22 * (1 - 0.45 * ads);
      pistolRecoilKickZ = 0.022 * (1 - 0.35 * ads);
      pistolSlideOffset = 0.044;
      pistolTrigPull = 0.42;
    } else if (weaponId === "sniper" && hasAmmoLeft) {
      awmBoltCycleStartAt = nowMs + 190;
    }
  }

  function onWeaponSwitched(weaponId) {
    ads = 0;
    rlp = 0;
    awmBoltCycleStartAt = 0;
    assetLoader.applyViewmodelWeapon(weaponId);
  }

  function onReloadStarted() {
    rlp = 0;
  }

  function resetAnimState() {
    ads = 0;
    bolt = 0;
    rlp = 0;
    trigPull = 0;
    pistolSlideOffset = 0;
    pistolRecoilPitch = 0;
    pistolRecoilKickZ = 0;
    pistolTrigPull = 0;
    awmBoltCycleStartAt = 0;
  }

  return {
    gunAnim,
    onShotFired,
    onWeaponSwitched,
    onReloadStarted,
    resetAnimState,
    getAds: () => ads,
    setAdsZero: () => { ads = 0; },
  };
}
