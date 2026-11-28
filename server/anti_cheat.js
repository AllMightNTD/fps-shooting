/**
 * Server-side zero-trust shot origin & aim direction validation plus decaying
 * multi-layer anti-cheat score tracker.
 */

import { forwardFromYawPitch } from "./hitreg.js";
import { hasLineOfSight } from "./spawn.js";
import { FLAG, computeWeaponSpread } from "./weapons.js";

export const ANTI_CHEAT_WEIGHTS = Object.freeze({
  LEGACY_HIT_SPOOF: 15,
  ORIGIN_TAMPER: 20,
  AIM_DIR_TAMPER: 25,
  RAPID_FIRE: 10,
  SPEED_TAMPER: 10,
});

export const ANTI_CHEAT_WARN_THRESHOLD = 40;
export const ANTI_CHEAT_KICK_THRESHOLD = 100;
export const DECAY_PER_10S = 5;

function finiteVec3(v) {
  return (
    v &&
    typeof v === "object" &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

/**
 * Validate client-supplied shot origin against authoritative eye coordinates and wall LoS.
 */
export function validateShotOrigin(authEye, clientOrigin, arena) {
  const safeEye = {
    x: Number.isFinite(authEye?.x) ? authEye.x : 0,
    y: Number.isFinite(authEye?.y) ? authEye.y : 1.7,
    z: Number.isFinite(authEye?.z) ? authEye.z : 0,
  };
  if (clientOrigin === null || clientOrigin === undefined) {
    return { origin: safeEye, tampered: false, reason: null };
  }
  if (!finiteVec3(clientOrigin)) {
    return { origin: safeEye, tampered: true, reason: "NON_FINITE_ORIGIN" };
  }
  const horiz = Math.hypot(clientOrigin.x - safeEye.x, clientOrigin.z - safeEye.z);
  const vert = Math.abs(clientOrigin.y - safeEye.y);
  if (horiz > 0.75 || vert > 0.55) {
    return { origin: safeEye, tampered: true, reason: "ORIGIN_OFFSET_EXCEEDED" };
  }
  if (
    arena &&
    !hasLineOfSight(safeEye.x, safeEye.y, safeEye.z, clientOrigin.x, clientOrigin.y, clientOrigin.z, arena)
  ) {
    return { origin: safeEye, tampered: true, reason: "ORIGIN_THROUGH_WALL" };
  }
  return {
    origin: { x: clientOrigin.x, y: clientOrigin.y, z: clientOrigin.z },
    tampered: false,
    reason: null,
  };
}

/**
 * Validate client-supplied shot direction against authoritative yaw/pitch and spread+recoil cone.
 */
export function validateShotDirection(authYaw, authPitch, clientDir, weaponCfg, flags = 0) {
  const authDir = forwardFromYawPitch(authYaw, authPitch);
  const spread = computeWeaponSpread(weaponCfg, flags);
  let effectiveSpread = spread;
  if (weaponCfg && weaponCfg.scopeOverlay && (flags & FLAG.ADS)) {
    effectiveSpread = flags & FLAG.AIR ? 0.095 : 0.065;
  }
  const maxAngleRad = effectiveSpread * 2.5 + 0.085;

  if (clientDir === null || clientDir === undefined) {
    return { dir: authDir, tampered: false, angleDiffRad: 0, maxAngleRad };
  }
  if (!finiteVec3(clientDir)) {
    return { dir: authDir, tampered: true, angleDiffRad: Math.PI, maxAngleRad };
  }
  const len = Math.hypot(clientDir.x, clientDir.y, clientDir.z);
  if (!(len > 1e-6)) {
    return { dir: authDir, tampered: true, angleDiffRad: Math.PI, maxAngleRad };
  }
  const ndx = clientDir.x / len;
  const ndy = clientDir.y / len;
  const ndz = clientDir.z / len;
  const dot = Math.max(-1, Math.min(1, ndx * authDir.x + ndy * authDir.y + ndz * authDir.z));
  const angleDiffRad = Math.acos(dot);
  if (angleDiffRad > maxAngleRad) {
    return { dir: authDir, tampered: true, angleDiffRad, maxAngleRad };
  }
  return {
    dir: { x: ndx, y: ndy, z: ndz },
    tampered: false,
    angleDiffRad,
    maxAngleRad,
  };
}

/**
 * Tracks per-player violation scores with gradual clean-play decay and warn/kick thresholds.
 */
export class AntiCheatTracker {
  constructor() {
    this.records = new Map();
  }

  _decay(rec, now) {
    if (!Number.isFinite(now) || now <= rec.lastUpdatedAt) return;
    const elapsedMs = now - rec.lastUpdatedAt;
    if (elapsedMs < 5000) return;
    const decay = (elapsedMs / 10_000) * DECAY_PER_10S;
    rec.score = Math.max(0, rec.score - decay);
    rec.lastUpdatedAt = now;
    if (rec.score < ANTI_CHEAT_WARN_THRESHOLD * 0.5) {
      rec.warned = false;
    }
  }

  getScore(playerId, now) {
    const rec = this.records.get(playerId);
    if (!rec) return 0;
    if (Number.isFinite(now)) this._decay(rec, now);
    return Math.round(rec.score * 100) / 100;
  }

  recordViolation(playerId, code, now) {
    const rec = this.records.get(playerId) || {
      score: 0,
      lastUpdatedAt: Number.isFinite(now) ? now : 0,
      warned: false,
    };
    if (!this.records.has(playerId)) this.records.set(playerId, rec);
    if (Number.isFinite(now)) this._decay(rec, now);

    const weight = ANTI_CHEAT_WEIGHTS[code];
    if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(now)) {
      return {
        score: Math.round(rec.score * 100) / 100,
        action: "none",
        code: String(code || "UNKNOWN"),
      };
    }

    rec.score += weight;
    rec.lastUpdatedAt = now;

    let action = "none";
    if (rec.score >= ANTI_CHEAT_KICK_THRESHOLD) {
      action = "kick";
    } else if (rec.score >= ANTI_CHEAT_WARN_THRESHOLD && !rec.warned) {
      rec.warned = true;
      action = "warn";
    }
    return {
      score: Math.round(rec.score * 100) / 100,
      action,
      code,
    };
  }

  clear(playerId) {
    if (playerId) this.records.delete(playerId);
  }

  reset() {
    this.records.clear();
  }
}
