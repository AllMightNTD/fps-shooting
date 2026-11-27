/**
 * M416 Recoil System (Pattern + Seeded Noise + SmoothDamp Spring + Pull Absorption + Partial Recovery).
 * Units: degrees for all recoil angles; positive pitch kicks upward ("ngẩng lên").
 * Dependency-free ES module shared by client engine and Node AAA unit tests.
 */

export const M416_RECOIL_PROFILE = Object.freeze({
  fireRateRPM: 700,
  magazineSize: 30,
  verticalByShot: Object.freeze([
    Object.freeze({ t: 0, v: 0.34 }),
    Object.freeze({ t: 3, v: 0.42 }),
    Object.freeze({ t: 10, v: 0.38 }),
    Object.freeze({ t: 20, v: 0.34 }),
    Object.freeze({ t: 29, v: 0.30 }),
  ]),
  horizontalMax: 0.18,
  horizontalPatternWeight: 0.6,
  horizontalWaveFreq: 0.55,
  kickSmoothTime: 0.045,
  patternResetTime: 0.30,
  recoveryDelay: 0.12,
  recoverySpeed: 6,
  recoverFraction: 0.35,
  get shotInterval() {
    return 60 / this.fireRateRPM;
  },
});

/**
 * Evaluate a Unity-style AnimationCurve with clamped finite-difference Hermite tangents.
 * @param {Array<{t: number, v: number}>} keys
 * @param {number} x
 * @returns {number}
 */
export function evalAnimationCurve(keys, x) {
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  const val = Number.isFinite(x) ? x : keys[0].t;
  if (keys.length === 1 || val <= keys[0].t) return keys[0].v;
  const lastIdx = keys.length - 1;
  if (val >= keys[lastIdx].t) return keys[lastIdx].v;

  let i = 0;
  while (i < lastIdx - 1 && val > keys[i + 1].t) i++;

  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = k1.t - k0.t;
  if (!(span > 0)) return k0.v;

  const slopeAt = (idx) => {
    if (idx <= 0) return (keys[1].v - keys[0].v) / Math.max(1e-6, keys[1].t - keys[0].t);
    if (idx >= lastIdx) return (keys[lastIdx].v - keys[lastIdx - 1].v) / Math.max(1e-6, keys[lastIdx].t - keys[lastIdx - 1].t);
    return (keys[idx + 1].v - keys[idx - 1].v) / Math.max(1e-6, keys[idx + 1].t - keys[idx - 1].t);
  };

  const m0 = slopeAt(i);
  const m1 = slopeAt(i + 1);
  const t = (val - k0.t) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * k0.v + h10 * span * m0 + h01 * k1.v + h11 * span * m1;
}

/**
 * Order-independent deterministic hash in [-1, 1] matching C# unchecked uint mix (0x5bd1e995).
 * @param {number} seed
 * @param {number} shotIndex
 * @returns {number}
 */
export function hashShotRand(seed, shotIndex) {
  const s = Number.isFinite(seed) ? seed | 0 : 0;
  const i = Number.isFinite(shotIndex) ? shotIndex | 0 : 0;
  let h = (Math.imul(s, 73856093) ^ Math.imul(i, 19349663)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h & 0xffff) / 32767.5 - 1;
}

/**
 * Critically damped spring matching Unity Mathf.SmoothDamp (mutates velRef[key]).
 */
export function smoothDampScalar(current, target, velRef, key, smoothTime, dt) {
  if (!(dt > 0) || !Number.isFinite(dt)) return current;
  const st = Math.max(0.0001, Number.isFinite(smoothTime) ? smoothTime : 0.045);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const vel = Number.isFinite(velRef[key]) ? velRef[key] : 0;
  const temp = (vel + omega * change) * dt;
  velRef[key] = (vel - omega * temp) * exp;
  let output = target + (change + temp) * exp;

  // Prevent overshoot past target
  if ((target - current > 0) === (output > target)) {
    output = target;
    velRef[key] = 0;
  }
  return output;
}

/**
 * Compute posture & aiming recoil multipliers for M416.
 * @param {{ crouched?: boolean, ads?: boolean, grounded?: boolean }} opts
 * @returns {{ vertical: number, horizontal: number }}
 */
export function computeRecoilModifiers({ crouched = false, ads = false, grounded = true } = {}) {
  let vertical = 1.0;
  let horizontal = 1.0;
  if (crouched) {
    vertical *= 0.85;
    horizontal *= 0.85;
  }
  if (ads) {
    vertical *= 0.85;
    horizontal *= 0.85;
  }
  if (grounded === false) {
    vertical *= 1.2;
    horizontal *= 1.2;
  }
  return { vertical, horizontal };
}

/**
 * Create a stateful M416 RecoilController instance.
 * @param {typeof M416_RECOIL_PROFILE} profile
 */
export function createRecoilController(profile = M416_RECOIL_PROFILE) {
  let shotIndex = 0;
  let lastShotTime = -999;
  let seed = 1337;
  let pitchDebt = 0;
  let recoveryBudget = 0;
  let firing = false;
  const applied = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  const vel = { x: 0, y: 0 };

  function resetMagazine(newSeed) {
    seed = Number.isFinite(newSeed) ? (newSeed | 0) : 1337;
    shotIndex = 0;
  }

  function resetAll(newSeed = seed) {
    resetMagazine(newSeed);
    lastShotTime = -999;
    pitchDebt = 0;
    recoveryBudget = 0;
    firing = false;
    applied.x = applied.y = 0;
    target.x = target.y = 0;
    vel.x = vel.y = 0;
  }

  function onShotFired(nowSec, mods = { vertical: 1, horizontal: 1 }) {
    const t = Number.isFinite(nowSec) ? nowSec : 0;
    if (t - lastShotTime > profile.patternResetTime) {
      shotIndex = 0;
    }

    const modV = mods && Number.isFinite(mods.vertical) ? Math.max(0, mods.vertical) : 1;
    const modH = mods && Number.isFinite(mods.horizontal) ? Math.max(0, mods.horizontal) : 1;
    const clampedIdx = Math.min(shotIndex, profile.magazineSize - 1);
    const v = evalAnimationCurve(profile.verticalByShot, clampedIdx) * modV;
    const w = profile.horizontalPatternWeight;
    const h =
      profile.horizontalMax *
      (w * Math.sin(profile.horizontalWaveFreq * shotIndex) + (1 - w) * hashShotRand(seed, shotIndex)) *
      modH;

    target.x += h;
    target.y += v;
    pitchDebt += v;
    recoveryBudget = 0;
    firing = true;
    lastShotTime = t;
    shotIndex++;
    return { yawDeg: h, pitchDeg: v, shotIndex };
  }

  function onTriggerReleased() {
    firing = false;
    recoveryBudget = pitchDebt * profile.recoverFraction;
  }

  function absorbPlayerPull(pitchDownDeg) {
    if (!Number.isFinite(pitchDownDeg) || pitchDownDeg <= 0) return 0;
    const absorbed = Math.min(pitchDownDeg, pitchDebt);
    pitchDebt -= absorbed;
    recoveryBudget = Math.min(recoveryBudget, pitchDebt * profile.recoverFraction);
    return absorbed;
  }

  function tick(nowSec, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return { x: 0, y: 0 };
    const t = Number.isFinite(nowSec) ? nowSec : 0;
    const safeDt = Math.min(dt, 0.1);

    if (!firing && recoveryBudget > 0 && t - lastShotTime > profile.recoveryDelay) {
      const step = Math.min(recoveryBudget, profile.recoverySpeed * safeDt);
      recoveryBudget -= step;
      pitchDebt = Math.max(0, pitchDebt - step);
      target.y -= step;
    }

    const nextX = smoothDampScalar(applied.x, target.x, vel, "x", profile.kickSmoothTime, safeDt);
    const nextY = smoothDampScalar(applied.y, target.y, vel, "y", profile.kickSmoothTime, safeDt);
    const dx = nextX - applied.x;
    const dy = nextY - applied.y;
    applied.x = nextX;
    applied.y = nextY;
    return { x: dx, y: dy };
  }

  function getState() {
    return {
      shotIndex,
      lastShotTime,
      seed,
      pitchDebt,
      recoveryBudget,
      firing,
      applied: { x: applied.x, y: applied.y },
      target: { x: target.x, y: target.y },
      vel: { x: vel.x, y: vel.y },
    };
  }

  return {
    resetMagazine,
    resetAll,
    onShotFired,
    onTriggerReleased,
    absorbPlayerPull,
    tick,
    getState,
  };
}

