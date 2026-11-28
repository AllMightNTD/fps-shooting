/**
 * Multi-zone player hitboxes (Stand / Crouch / Prone), zone priority (head > body > limb),
 * and hitscan + AWM projectile ray tracing. Shared cleanly by Server & Browser Bot AI.
 */

import {
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_PRONE,
  EYE_HEIGHT_STAND,
  SOLDIER_SCALE_XZ,
  SOLDIER_SCALE_Y,
  rayIntersectsOBB,
  raycastArenaDistance,
} from "./spawn_rules.js";

const FLAG_CROUCH = 1 << 0;
const FLAG_PRONE = 1 << 6;

export {
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_PRONE,
  EYE_HEIGHT_STAND,
  SOLDIER_SCALE_XZ,
  SOLDIER_SCALE_Y,
};

const ZONE_PRIORITY = Object.freeze({ head: 3, body: 2, limb: 1 });

export function getEyeHeight(flags = 0) {
  if (flags & FLAG_PRONE) return EYE_HEIGHT_PRONE;
  if (flags & FLAG_CROUCH) return EYE_HEIGHT_CROUCH;
  return EYE_HEIGHT_STAND;
}

export function forwardFromYawPitch(yaw = 0, pitch = 0) {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const p = Number.isFinite(pitch) ? pitch : 0;
  const cp = Math.cos(p);
  return {
    x: -cp * Math.sin(y),
    y: Math.sin(p),
    z: -cp * Math.cos(y),
  };
}

export function buildPlayerHitboxes(pose) {
  const x = pose.x || 0;
  const y = pose.y || 0;
  const z = pose.z || 0;
  const yaw = Number.isFinite(pose.yaw) ? pose.yaw : 0;
  const flags = pose.flags || 0;

  if (flags & FLAG_PRONE) {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    return {
      head: { cx: x + fx * 0.63, cy: y + 0.39, cz: z + fz * 0.63, r: 0.195 },
      boxes: [
        { part: "body", obb: { cx: x, cy: y + 0.26, cz: z, hx: 0.28, hy: 0.22, hz: 0.48, yaw } },
        {
          part: "limb",
          obb: { cx: x - fx * 0.75, cy: y + 0.22, cz: z - fz * 0.75, hx: 0.25, hy: 0.20, hz: 0.41, yaw },
        },
      ],
    };
  }

  if (flags & FLAG_CROUCH) {
    return {
      head: { cx: x, cy: y + 1.18, cz: z, r: 0.20 },
      boxes: [
        { part: "body", obb: { cx: x, cy: y + 0.77, cz: z, hx: 0.28, hy: 0.25, hz: 0.21, yaw } },
        { part: "limb", obb: { cx: x, cy: y + 0.26, cz: z, hx: 0.25, hy: 0.26, hz: 0.21, yaw } },
      ],
    };
  }

  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const armOffset = 0.335;
  return {
    head: { cx: x, cy: y + 1.77, cz: z, r: 0.20 },
    boxes: [
      { part: "body", obb: { cx: x, cy: y + 1.26, cz: z, hx: 0.28, hy: 0.33, hz: 0.19, yaw } },
      { part: "limb", obb: { cx: x, cy: y + 0.47, cz: z, hx: 0.23, hy: 0.47, hz: 0.17, yaw } },
      {
        part: "limb",
        obb: { cx: x - armOffset * cs, cy: y + 1.28, cz: z + armOffset * sn, hx: 0.095, hy: 0.27, hz: 0.13, yaw },
      },
      {
        part: "limb",
        obb: { cx: x + armOffset * cs, cy: y + 1.28, cz: z - armOffset * sn, hx: 0.095, hy: 0.27, hz: 0.13, yaw },
      },
    ],
  };
}

export function rayIntersectsSphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist = 200) {
  const dirLen = Math.hypot(dx, dy, dz);
  if (!(dirLen > 1e-6) || !Number.isFinite(dirLen) || !(r > 0) || !(maxDist >= 0)) return null;
  const nx = dx / dirLen;
  const ny = dy / dirLen;
  const nz = dz / dirLen;
  const ocx = ox - cx;
  const ocy = oy - cy;
  const ocz = oz - cz;
  const b = ocx * nx + ocy * ny + ocz * nz;
  const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const t1 = -b + sqrtD;
  if (t1 < 0) return null;
  const t = Math.max(0, -b - sqrtD);
  return t <= maxDist ? t : null;
}

export function raycastPlayerHitboxes(ox, oy, oz, dx, dy, dz, maxDist, pose) {
  if (!pose || pose.alive === false) return null;
  const { head, boxes } = buildPlayerHitboxes(pose);
  let bestPart = null;
  let bestDist = Infinity;

  const consider = (part, t) => {
    if (t === null || t > maxDist) return;
    if (!bestPart) {
      bestPart = part;
      bestDist = t;
      return;
    }
    const curPrio = ZONE_PRIORITY[bestPart];
    const nextPrio = ZONE_PRIORITY[part];
    if (nextPrio > curPrio || (nextPrio === curPrio && t < bestDist)) {
      bestPart = part;
      bestDist = t;
    }
  };

  consider("head", rayIntersectsSphere(ox, oy, oz, dx, dy, dz, head.cx, head.cy, head.cz, head.r, maxDist));
  for (let i = 0; i < boxes.length; i++) {
    consider(boxes[i].part, rayIntersectsOBB(ox, oy, oz, dx, dy, dz, boxes[i].obb, maxDist));
  }
  return bestPart ? { dist: bestDist, part: bestPart } : null;
}

function normalizeOriginAndDir(origin, dir) {
  if (!origin || !dir) return null;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;
  if (
    !Number.isFinite(ox) ||
    !Number.isFinite(oy) ||
    !Number.isFinite(oz) ||
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    !Number.isFinite(dz)
  ) {
    return null;
  }
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-6)) return null;
  return { ox, oy, oz, dx: dx / len, dy: dy / len, dz: dz / len };
}

function findClosestTargetHit(ox, oy, oz, dx, dy, dz, maxDist, shooterId, targets) {
  let best = null;
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    if (!tgt || tgt.id === shooterId || tgt.alive === false) continue;
    const hit = raycastPlayerHitboxes(ox, oy, oz, dx, dy, dz, maxDist, tgt);
    if (hit && (!best || hit.dist < best.dist)) {
      best = {
        targetId: tgt.id,
        part: hit.part,
        dist: hit.dist,
      };
    }
  }
  return best;
}

export function resolveAuthoritativeShot({
  shooterId,
  weaponCfg,
  origin,
  dir,
  arena,
  targets = [],
}) {
  const norm = normalizeOriginAndDir(origin, dir);
  if (!norm || !weaponCfg) return { hit: false, wallDist: 0 };

  const { ox, oy, oz, dx, dy, dz } = norm;
  const maxRange = Number.isFinite(weaponCfg.maxRange) ? weaponCfg.maxRange : 120;
  const ballistics = weaponCfg.ballistics;

  if (ballistics && ballistics.mode === "projectile") {
    const muzzleV = ballistics.muzzleVelocity || 910;
    const gravity = Number.isFinite(ballistics.gravity) ? ballistics.gravity : 9.81;
    const dragK = Number.isFinite(ballistics.dragK) ? ballistics.dragK : 0.00015;
    const subStep = 0.004;
    let px = ox;
    let py = oy;
    let pz = oz;
    let vx = dx * muzzleV;
    let vy = dy * muzzleV;
    let vz = dz * muzzleV;
    let traveled = 0;

    for (let step = 0; step < 120 && traveled < maxRange; step++) {
      const speed = Math.hypot(vx, vy, vz);
      const drag = -dragK * speed;
      vx += drag * vx * subStep;
      vy += (-gravity + drag * vy) * subStep;
      vz += drag * vz * subStep;
      const nx = px + vx * subStep;
      const ny = py + vy * subStep;
      const nz = pz + vz * subStep;
      const sx = nx - px;
      const sy = ny - py;
      const sz = nz - pz;
      const segLen = Math.hypot(sx, sy, sz);
      if (!(segLen > 1e-6)) break;

      const sdx = sx / segLen;
      const sdy = sy / segLen;
      const sdz = sz / segLen;
      const remain = Math.min(segLen, maxRange - traveled);
      const wallHit = raycastArenaDistance(px, py, pz, sdx, sdy, sdz, remain, arena);
      const limit = wallHit ? wallHit.dist : remain;
      const targetHit = findClosestTargetHit(px, py, pz, sdx, sdy, sdz, limit, shooterId, targets);
      if (targetHit) {
        const lookaheadWall = raycastArenaDistance(px, py, pz, sdx, sdy, sdz, targetHit.dist + 1.2, arena);
        const lookaheadLimit = lookaheadWall ? lookaheadWall.dist : targetHit.dist + 1.2;
        const targetPose = targets.find((t) => t.id === targetHit.targetId);
        const refined = targetPose
          ? raycastPlayerHitboxes(px, py, pz, sdx, sdy, sdz, lookaheadLimit, targetPose) || targetHit
          : targetHit;
        const totalDist = traveled + refined.dist;
        return {
          hit: true,
          targetId: targetHit.targetId,
          part: refined.part,
          dist: totalDist,
          hitPoint: {
            x: px + sdx * refined.dist,
            y: py + sdy * refined.dist,
            z: pz + sdz * refined.dist,
          },
          wallDist: traveled + Math.max(limit, refined.dist),
        };
      }
      if (wallHit) {
        return { hit: false, wallDist: traveled + wallHit.dist };
      }
      px = nx;
      py = ny;
      pz = nz;
      traveled += segLen;
      if (py < -12) break;
    }
    return { hit: false, wallDist: Math.min(traveled, maxRange) };
  }

  const wallHit = raycastArenaDistance(ox, oy, oz, dx, dy, dz, maxRange, arena);
  const wallDist = wallHit ? wallHit.dist : maxRange;
  const targetHit = findClosestTargetHit(ox, oy, oz, dx, dy, dz, wallDist, shooterId, targets);
  if (!targetHit) {
    return { hit: false, wallDist };
  }
  return {
    hit: true,
    targetId: targetHit.targetId,
    part: targetHit.part,
    dist: targetHit.dist,
    hitPoint: {
      x: ox + dx * targetHit.dist,
      y: oy + dy * targetHit.dist,
      z: oz + dz * targetHit.dist,
    },
    wallDist,
  };
}
