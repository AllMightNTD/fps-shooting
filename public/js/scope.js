/**
 * AWM Scope / Double-Zoom / Scope Blur / Sway & Hold-Breath / Ballistic Drop + Zeroing System.
 * Dependency-free ES module shared by Three.js client and Node AAA tests.
 * Units: degrees for angles (positive pitch = upward, positive yaw = right); meters & seconds for physics.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

export const STANCE = Object.freeze({
  STAND: 0,
  CROUCH: 1,
  PRONE: 2,
});

export const AWM_SCOPE_PROFILE = Object.freeze({
  // Valorant Double Zoom (Unscoped -> 2.5x -> 5.0x -> Unscoped)
  baseHFov: 90,
  zoomLevels: Object.freeze([2.5, 5.0]),
  defaultZoomIndex: 0,
  zoomSwitchTime: 0.12,
  sensExponent: 1.0,

  // ADS transitions & scope reticle reveal
  adsTime: 0.32,
  exitTime: 0.18,
  overlayStart: 0.7,

  // CS:GO-style Scope Blur & Quickscope settle inaccuracy
  moveBlurSpeedRef: 3.4,
  quickscopeMaxSpread: 0.038,
  moveMaxSpread: 0.042,
  airMaxSpread: 0.055,
  settledSpread: 0.00018,

  // Sway & Hold Breath (Unity C# ScopeProfile)
  swayAmplitudeDeg: 0.1,
  breathFreq: 0.25,
  heartFreq: 1.1,
  stanceSway: Object.freeze([1.0, 0.6, 0.25]),
  movingSwayMult: 2.0,
  settleTime: 0.5,
  settleMultiplier: 3.0,

  holdMax: 3.5,
  holdSwayMult: 0.1,
  fatigueTime: 1.5,
  fatigueSwayMult: 2.0,
  breathRegenTime: 5.0,

  // Ballistics & Zeroing (drag + gravity)
  muzzleVelocity: 910,
  gravity: 9.81,
  dragK: 0.00015,
  zeroDistances: Object.freeze([100, 200, 300, 400, 500, 600, 700, 800]),
  defaultZeroIndex: 0,

  // Bolt-action cycle + Auto Re-scope
  boltCycleTime: 1.3,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function easeSmoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function smoothDampScalar(current, target, velObj, key, smoothTime, dt) {
  if (!(dt > 0) || !Number.isFinite(dt)) return current;
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const vel = Number.isFinite(velObj[key]) ? velObj[key] : 0;
  const temp = (vel + omega * change) * dt;
  velObj[key] = (vel - omega * temp) * exp;
  let output = target + (change + temp) * exp;
  if ((target - current > 0) === (output > target)) {
    output = target;
    velObj[key] = 0;
  }
  return output;
}

/**
 * Convert vertical FOV (deg) to horizontal FOV (deg) for aspect ratio.
 */
export function toHorizontalFov(vFovDeg, aspect = 16 / 9) {
  const safeVFov = clamp(Number.isFinite(vFovDeg) ? vFovDeg : 75, 5, 140);
  const safeAspect = clamp(Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9, 0.4, 4.0);
  return 2 * Math.atan(Math.tan(safeVFov * DEG2RAD * 0.5) * safeAspect) * RAD2DEG;
}

/**
 * Convert horizontal FOV (deg) to Three.js vertical FOV (deg).
 */
export function toVerticalFov(hFovDeg, aspect = 16 / 9) {
  const safeHFov = clamp(Number.isFinite(hFovDeg) ? hFovDeg : 90, 2, 160);
  const safeAspect = clamp(Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9, 0.4, 4.0);
  return 2 * Math.atan(Math.tan(safeHFov * DEG2RAD * 0.5) / safeAspect) * RAD2DEG;
}

/**
 * Simulate bullet vertical height y at horizontal distance d under gravity + quadratic drag (a = -k*v^2).
 */
export function simulateHeightAtDistance(angleRad, distanceM, profile = AWM_SCOPE_PROFILE) {
  const d = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : 100;
  let x = 0;
  let y = 0;
  let vx = profile.muzzleVelocity * Math.cos(angleRad);
  let vy = profile.muzzleVelocity * Math.sin(angleRad);
  const dt = 0.002;
  for (let i = 0; i < 6000 && x < d; i++) {
    const v = Math.hypot(vx, vy);
    vx += -profile.dragK * v * vx * dt;
    vy += (-profile.gravity - profile.dragK * v * vy) * dt;
    x += vx * dt;
    y += vy * dt;
    if (vx <= 1) break;
  }
  return y;
}

/**
 * Solve bore elevation angle (deg) via binary search so projectile crosses aim line at distanceM.
 */
export function solveZeroAngleDeg(distanceM, profile = AWM_SCOPE_PROFILE) {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  let lo = 0;
  let hi = 0.08;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (simulateHeightAtDistance(mid, distanceM, profile) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi) * RAD2DEG;
}

/**
 * Advance a ballistic projectile one step (meters/sec) under gravity + quadratic air drag.
 */
export function stepBallisticStep(pos, vel, dt, profile = AWM_SCOPE_PROFILE) {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const drag = -profile.dragK * speed;
  vel.x += drag * vel.x * dt;
  vel.y += (-profile.gravity + drag * vel.y) * dt;
  vel.z += drag * vel.z * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

/**
 * Create stateful AWM ScopeController supporting:
 * - Valorant Double Zoom (0 -> 1 -> 2 -> 0)
 * - Focal-length tan FOV + monitor-distance sensitivity scaling
 * - Movement/Quickscope Scope Blur & dynamic inaccuracy
 * - Breath/Heart Sway + Shift Hold Breath
 * - Bolt-action Auto Re-scope & Quick-switch cancel
 * - Ballistic Zeroing table
 */
export function createScopeController(profile = AWM_SCOPE_PROFILE) {
  const zoomLevels = Array.isArray(profile.zoomLevels) && profile.zoomLevels.length ? profile.zoomLevels : [2.5, 5.0];
  const zeroDistances =
    Array.isArray(profile.zeroDistances) && profile.zeroDistances.length ? profile.zeroDistances : [100, 200, 300];
  const zeroAngles = zeroDistances.map((d) => solveZeroAngleDeg(d, profile));

  let zoomIndex = clamp(profile.defaultZoomIndex || 0, 0, zoomLevels.length - 1);
  let zeroIndex = clamp(profile.defaultZeroIndex || 0, 0, zeroDistances.length - 1);
  let scoped = false; // Desired toggle state (false = hip, true = zoomLevels[zoomIndex])
  let pendingRescopeLevel = 0; // 1-based zoom level saved during bolt cycle
  let adsT = 0;
  let levelZoom = zoomLevels[zoomIndex];
  const levelVel = { z: 0 };
  let settleTimer = 0;
  let clockSec = 0;
  let breath = 1.0;
  let fatigue = 0;
  let boltEndSec = -999;

  function getActiveLevelNumber() {
    return scoped ? zoomIndex + 1 : 0;
  }

  /**
   * Valorant Double Zoom RMB click:
   * - If unscoped -> enter Zoom Level 1 (2.5x)
   * - If Zoom Level 1 -> enter Zoom Level 2 (5.0x)
   * - If at highest zoom level -> exit scope (0)
   * Note: blocked while bolt-cycling or reloading.
   */
  function toggleDoubleZoom(nowSec = 0, canScope = true) {
    if (!canScope || nowSec < boltEndSec) {
      return { changed: false, level: getActiveLevelNumber() };
    }
    pendingRescopeLevel = 0;
    if (!scoped) {
      scoped = true;
      zoomIndex = 0;
      levelZoom = zoomLevels[0];
      settleTimer = 0;
      return { changed: true, level: 1, zoom: zoomLevels[0] };
    }
    if (zoomIndex < zoomLevels.length - 1) {
      zoomIndex++;
      return { changed: true, level: zoomIndex + 1, zoom: zoomLevels[zoomIndex] };
    }
    scoped = false;
    zoomIndex = 0;
    return { changed: true, level: 0, zoom: 1 };
  }

  function setScopedState(enable, level1Based = 1) {
    if (!enable) {
      scoped = false;
      zoomIndex = 0;
      return;
    }
    scoped = true;
    zoomIndex = clamp((level1Based | 0) - 1, 0, zoomLevels.length - 1);
  }

  function cycleZoom(dir) {
    const step = Number.isFinite(dir) ? Math.trunc(dir) : 0;
    zoomIndex = clamp(zoomIndex + step, 0, zoomLevels.length - 1);
    return zoomIndex + 1;
  }

  function cycleZero(dir) {
    const step = Number.isFinite(dir) ? Math.trunc(dir) : 0;
    zeroIndex = clamp(zeroIndex + step, 0, zeroDistances.length - 1);
    return { index: zeroIndex, distance: zeroDistances[zeroIndex], angleDeg: zeroAngles[zeroIndex] };
  }

  function canFire(nowSec) {
    return !Number.isFinite(nowSec) || nowSec >= boltEndSec;
  }

  /**
   * Fired AWM: starts bolt cycle, un-scopes for bolt animation, saves Auto Re-scope target if previously scoped.
   */
  function onShotFired(nowSec) {
    const t = Number.isFinite(nowSec) ? nowSec : 0;
    const prevLevel = getActiveLevelNumber();
    boltEndSec = t + profile.boltCycleTime;
    settleTimer = 0;
    if (prevLevel > 0) {
      pendingRescopeLevel = prevLevel;
      scoped = false;
      adsT = Math.min(adsT, 0.35);
    }
    return { pendingRescopeLevel, boltEndSec };
  }

  /**
   * Quick-switch or Reload cancels Auto Re-scope cleanly and drops scope without sound.
   */
  function cancelAutoRescope() {
    pendingRescopeLevel = 0;
    scoped = false;
    zoomIndex = 0;
  }

  function resetAll() {
    scoped = false;
    pendingRescopeLevel = 0;
    zoomIndex = clamp(profile.defaultZoomIndex || 0, 0, zoomLevels.length - 1);
    adsT = 0;
    levelZoom = zoomLevels[zoomIndex];
    levelVel.z = 0;
    settleTimer = 0;
    breath = 1.0;
    fatigue = 0;
    boltEndSec = -999;
  }

  function tick({
    dt,
    nowSec = clockSec,
    adsActive = scoped,
    holdBreath = false,
    stance = STANCE.STAND,
    horizSpeed = 0,
    grounded = true,
    baseVFovDeg = 75,
    aspect = 16 / 9,
  }) {
    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    const tNow = Number.isFinite(nowSec) ? nowSec : clockSec;
    clockSec += safeDt;

    // Auto Re-scope after bolt cycle completes (unless cancelled by quick-switch / reload)
    let autoRescopedLevel = 0;
    if (pendingRescopeLevel > 0 && tNow >= boltEndSec) {
      zoomIndex = clamp(pendingRescopeLevel - 1, 0, zoomLevels.length - 1);
      scoped = true;
      levelZoom = zoomLevels[zoomIndex];
      settleTimer = 0;
      autoRescopedLevel = pendingRescopeLevel;
      pendingRescopeLevel = 0;
    }

    const wantAds = Boolean(adsActive && scoped);
    const rate = wantAds ? 1 / profile.adsTime : -1 / profile.exitTime;
    const prevAdsT = adsT;
    adsT = clamp(adsT + rate * safeDt, 0, 1);
    if (adsT >= 1) {
      settleTimer += safeDt;
    }
    if (adsT < 1 || (prevAdsT < 1 && adsT >= 1)) {
      settleTimer = 0;
    }
    const e = easeSmoothstep(adsT);

    // Log-interpolated zoom + focal-length tan FOV
    levelZoom = smoothDampScalar(levelZoom, zoomLevels[zoomIndex], levelVel, "z", profile.zoomSwitchTime, safeDt);
    const zoom = Math.exp(Math.log(Math.max(1, levelZoom)) * e);
    const baseHFov = toHorizontalFov(baseVFovDeg, aspect);
    const halfTan = Math.tan(baseHFov * DEG2RAD * 0.5) / Math.max(1, zoom);
    const hFov = 2 * Math.atan(halfTan) * RAD2DEG;
    const vFov = toVerticalFov(hFov, aspect);

    // Hold Breath (Shift while scoped & stationary/crouched)
    let holding = Boolean(holdBreath && adsT >= 0.99 && fatigue <= 0 && breath > 0);
    if (holding) {
      breath -= safeDt / profile.holdMax;
      if (breath <= 0) {
        breath = 0;
        fatigue = profile.fatigueTime;
        holding = false;
      }
    } else if (fatigue > 0) {
      fatigue = Math.max(0, fatigue - safeDt);
    } else {
      breath = Math.min(1, breath + safeDt / profile.breathRegenTime);
    }

    // Scope Blur & Spread (Movement speed + Quickscope settle delay + Airborne)
    const moveRatio = clamp(Math.max(0, Number(horizSpeed) || 0) / profile.moveBlurSpeedRef, 0, 1.35);
    const settleK = clamp(settleTimer / Math.max(0.01, profile.settleTime), 0, 1);
    const quickscopeBlur = adsT > 0.05 ? 1 - settleK : 1;
    const airBlur = grounded === false ? 1.0 : 0.0;
    const blur01 = clamp(Math.max(moveRatio, quickscopeBlur * 0.85, airBlur), 0, 1);

    let scopedSpread = profile.settledSpread;
    if (adsT >= 0.5) {
      scopedSpread =
        profile.settledSpread +
        moveRatio * profile.moveMaxSpread +
        quickscopeBlur * profile.quickscopeMaxSpread +
        (grounded === false ? profile.airMaxSpread : 0);
    }

    // Sway (Breath + Heartbeat + Stance + Move + Settle + HoldBreath)
    const sIdx = clamp(stance | 0, 0, profile.stanceSway.length - 1);
    let amp = profile.swayAmplitudeDeg * profile.stanceSway[sIdx] * e;
    if (moveRatio > 0.08) amp *= profile.movingSwayMult;
    if (holding) amp *= profile.holdSwayMult;
    if (fatigue > 0) amp *= profile.fatigueSwayMult;
    amp *= profile.settleMultiplier + (1 - profile.settleMultiplier) * settleK;

    const swayX =
      amp *
      (Math.sin(TWO_PI * profile.breathFreq * 1.5 * clockSec) +
        0.3 * Math.sin(TWO_PI * profile.heartFreq * clockSec + 1.7));
    const swayY =
      amp *
      (Math.sin(TWO_PI * profile.breathFreq * clockSec + 1.3) +
        0.2 * Math.sin(TWO_PI * profile.heartFreq * clockSec));

    const overlayAlpha = clamp((adsT - profile.overlayStart) / Math.max(0.01, 1 - profile.overlayStart), 0, 1);

    return {
      adsT,
      e,
      scoped,
      level: getActiveLevelNumber(),
      targetZoom: zoomLevels[zoomIndex],
      zoom,
      hFov,
      vFov,
      sensMultiplier: Math.pow(Math.max(1, zoom), -profile.sensExponent),
      overlayAlpha,
      hideWeaponModel: overlayAlpha > 0.5,
      blur01,
      scopedSpread,
      sway: { x: swayX, y: swayY },
      breath01: breath,
      holding,
      fatigued: fatigue > 0,
      zeroIndex,
      zeroDistance: zeroDistances[zeroIndex],
      zeroAngleDeg: zeroAngles[zeroIndex],
      autoRescopedLevel,
      pendingRescopeLevel,
      cyclingBolt: tNow < boltEndSec,
    };
  }

  return {
    toggleDoubleZoom,
    setScopedState,
    cycleZoom,
    cycleZero,
    canFire,
    onShotFired,
    cancelAutoRescope,
    resetAll,
    tick,
    getState: () => ({
      scoped,
      zoomIndex,
      level: getActiveLevelNumber(),
      targetZoom: zoomLevels[zoomIndex],
      adsT,
      levelZoom,
      settleTimer,
      breath,
      fatigue,
      pendingRescopeLevel,
      boltEndSec,
      zeroIndex,
      zeroDistance: zeroDistances[zeroIndex],
      zeroAngleDeg: zeroAngles[zeroIndex],
    }),
  };
}
