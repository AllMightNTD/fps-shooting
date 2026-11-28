/**
 * Pure shared rules for Spawn Selection (TDM 3-tier + Dynamic Spawn Flip, FFA Golden-Distance LoS),
 * Invulnerability Frames (post-spawn grace + Lag-Comp epoch guard),
 * Spawn Protection (blinking state + early cancel on fire / radius / sustained ADS),
 * and browser-safe arena collision & LoS raycasting.
 *
 * Dependency-free ES module: runs identically in Browser ESM and Node.js tests.
 */

const FLAG_ADS = 1 << 1;
const FLAG_CROUCH = 1 << 0;
const FLAG_PRONE = 1 << 6;

export const ARENA_BOUND = 48.0;
// Synchronized Heroic FPS soldier proportion (1A): ~1.92m tall x ~0.83m broad shoulders
export const SOLDIER_SCALE_XZ = 1.15;
export const SOLDIER_SCALE_Y = 1.09;
export const PLAYER_RADIUS = 0.50;
export const EYE_HEIGHT_STAND = 1.84;
export const EYE_HEIGHT_CROUCH = 1.18;
export const EYE_HEIGHT_PRONE = 0.45;
export const COLLIDER_HEIGHT_STAND = 1.94;
export const COLLIDER_HEIGHT_CROUCH = 1.33;
export const COLLIDER_HEIGHT_PRONE = 0.63;
export const STAND_UP_CLEARANCE = 1.98;
export const CROUCH_UP_CLEARANCE = 1.38;

export const SPAWN_RULES = Object.freeze({
  TDM: Object.freeze({
    respawnDelayMs: 3500,
    iFramesMs: 400,
    protectMs: 3000,
    expiringWindowMs: 750,
    maxRadiusM: 9.0,
    adsCancelMs: 600,
    spawnFlipCooldownMs: 8000,
    spawnCooldownMs: 1500,
  }),
  FFA: Object.freeze({
    respawnDelayMs: 2000,
    iFramesMs: 400,
    protectMs: 2000,
    expiringWindowMs: 650,
    maxRadiusM: 6.0,
    adsCancelMs: 600,
    spawnFlipCooldownMs: 0,
    spawnCooldownMs: 4000,
  }),
});

export function getSpawnRuleForMode(mode = "TDM") {
  return mode === "FFA" ? SPAWN_RULES.FFA : SPAWN_RULES.TDM;
}

export function getEyeHeightForFlags(flags = 0) {
  if (flags & FLAG_PRONE) return EYE_HEIGHT_PRONE;
  if (flags & FLAG_CROUCH) return EYE_HEIGHT_CROUCH;
  return EYE_HEIGHT_STAND;
}

const GRID_CELL_SIZE = 8.0;
const _arenaGridCache = new WeakMap();

function buildArenaGrid(boxes, obbs) {
  const cellBoxes = new Map();
  const cellObbs = new Map();
  const inv = 1 / GRID_CELL_SIZE;
  const pushCell = (map, gx, gz, idx) => {
    const k = (gx + 512) * 1024 + (gz + 512);
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push(idx);
  };

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const gx0 = Math.floor((b.x0 - 1.0) * inv);
    const gx1 = Math.floor((b.x1 + 1.0) * inv);
    const gz0 = Math.floor((b.z0 - 1.0) * inv);
    const gz1 = Math.floor((b.z1 + 1.0) * inv);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) pushCell(cellBoxes, gx, gz, i);
    }
  }
  for (let i = 0; i < obbs.length; i++) {
    const o = obbs[i];
    const rad = Math.hypot(o.hx, o.hz) + 1.0;
    const gx0 = Math.floor((o.cx - rad) * inv);
    const gx1 = Math.floor((o.cx + rad) * inv);
    const gz0 = Math.floor((o.cz - rad) * inv);
    const gz1 = Math.floor((o.cz + rad) * inv);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz1 >= gz; gz++) pushCell(cellObbs, gx, gz, i);
    }
  }
  return {
    boxes,
    obbs,
    cellBoxes,
    cellObbs,
    seenBoxes: new Int32Array(boxes.length),
    seenObbs: new Int32Array(obbs.length),
    stamp: 0,
  };
}

function getArenaSpatialGrid(arenaOrBoxes, boxes, obbs) {
  if (!arenaOrBoxes || typeof arenaOrBoxes !== "object" || Array.isArray(arenaOrBoxes)) return null;
  if (boxes.length + obbs.length <= 14) return null;
  let g = _arenaGridCache.get(arenaOrBoxes);
  if (!g || g.boxes !== boxes || g.obbs !== obbs) {
    g = buildArenaGrid(boxes, obbs);
    _arenaGridCache.set(arenaOrBoxes, g);
  }
  return g;
}

/**
 * Check whether an (x, z) ground coordinate is clear of solid map geometry.
 */
export function isPointClear(x, z, arenaOrBoxes, margin = 0.9) {
  const isArr = Array.isArray(arenaOrBoxes);
  const boxes = isArr ? arenaOrBoxes : (arenaOrBoxes && arenaOrBoxes.boxes) || [];
  const obbs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.obbs) || [];
  const bounds =
    isArr || !arenaOrBoxes?.bounds
      ? { minX: -ARENA_BOUND, maxX: ARENA_BOUND, minZ: -ARENA_BOUND, maxZ: ARENA_BOUND }
      : arenaOrBoxes.bounds;

  if (
    x < bounds.minX + margin ||
    x > bounds.maxX - margin ||
    z < bounds.minZ + margin ||
    z > bounds.maxZ - margin
  ) {
    return false;
  }

  for (const b of boxes) {
    if (b.bulletOnly) continue;
    if (isArr && b.y1 >= 9) continue;
    const by0 = b.y0 ?? 0;
    if (by0 >= 2.2 || b.y1 <= 0.36) continue;
    if (x >= b.x0 - margin && x <= b.x1 + margin && z >= b.z0 - margin && z <= b.z1 + margin) {
      return false;
    }
  }

  for (const o of obbs) {
    if (o.bulletOnly) continue;
    if (o.cy - o.hy >= 2.2 || o.cy + o.hy <= 0.36) continue;
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    const rx = x - o.cx;
    const rz = z - o.cz;
    const lx = rx * c - rz * s;
    const lz = rx * s + rz * c;
    if (Math.abs(lx) <= o.hx + margin && Math.abs(lz) <= o.hz + margin) {
      return false;
    }
  }
  return true;
}

/**
 * Clamp and horizontally resolve a player position against arena bounds, boxes, OBBs, slabs & ladders.
 */
export function clampAndResolvePlayerPos(pos, arenaOrBoxes, radius = PLAYER_RADIUS, flags = 0) {
  const isArr = Array.isArray(arenaOrBoxes);
  const boxes = isArr ? arenaOrBoxes : (arenaOrBoxes && arenaOrBoxes.boxes) || [];
  const obbs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.obbs) || [];
  const slabs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.walkableSlabs) || [];
  const ladders = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.ladders) || [];
  const bounds =
    isArr || !arenaOrBoxes?.bounds
      ? { minX: -ARENA_BOUND, maxX: ARENA_BOUND, minZ: -ARENA_BOUND, maxZ: ARENA_BOUND }
      : arenaOrBoxes.bounds;

  let x = Math.max(bounds.minX + radius, Math.min(bounds.maxX - radius, pos.x));
  let z = Math.max(bounds.minZ + radius, Math.min(bounds.maxZ - radius, pos.z));
  let y = Math.max(0, Math.min(8, pos.y));

  if (slabs.length || ladders.length) {
    let supportY = 0;
    for (const s of slabs) {
      if (x >= s.x0 - 0.3 && x <= s.x1 + 0.3 && z >= s.z0 - 0.3 && z <= s.z1 + 0.3 && y >= s.y1 - 0.5) {
        if (s.y1 > supportY) supportY = s.y1;
      }
    }
    const nearLadder = ladders.some(
      (l) => Math.hypot(x - l.x, z - l.z) <= (l.radius || 0.75) + 0.4 && y <= l.maxY + 0.35,
    );
    if (!nearLadder && y > supportY + 2.2) {
      y = supportY + 2.2;
    }
    if (y < supportY) y = supportY;
  }

  const pHeight = flags & FLAG_PRONE
    ? COLLIDER_HEIGHT_PRONE
    : flags & FLAG_CROUCH
      ? COLLIDER_HEIGHT_CROUCH
      : COLLIDER_HEIGHT_STAND;
  const minFootClear = y + 0.36;
  const maxHeadY = y + pHeight;

  for (let pass = 0; pass < 2; pass++) {
    for (const b of boxes) {
      if (b.bulletOnly) continue;
      if (isArr && b.y1 >= 9) continue;
      const by0 = b.y0 ?? 0;
      if (maxHeadY <= by0 + 0.04 || minFootClear >= b.y1) continue;
      const cx = Math.max(b.x0, Math.min(x, b.x1));
      const cz = Math.max(b.z0, Math.min(z, b.z1));
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        const d = Math.sqrt(d2) || 0.001;
        x += (dx / d) * (radius - d);
        z += (dz / d) * (radius - d);
      }
    }

    for (const o of obbs) {
      if (o.bulletOnly) continue;
      if (maxHeadY <= o.cy - o.hy + 0.04 || minFootClear >= o.cy + o.hy) continue;
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      const rx = x - o.cx;
      const rz = z - o.cz;
      const lx = rx * c - rz * s;
      const lz = rx * s + rz * c;
      const clx = Math.max(-o.hx, Math.min(lx, o.hx));
      const clz = Math.max(-o.hz, Math.min(lz, o.hz));
      const dx = lx - clx;
      const dz = lz - clz;
      const d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        const d = Math.sqrt(d2) || 0.001;
        const pushL = radius - d;
        const plx = (dx / d) * pushL;
        const plz = (dz / d) * pushL;
        x += plx * c + plz * s;
        z += -plx * s + plz * c;
      }
    }
  }

  return {
    x: Math.max(bounds.minX + radius, Math.min(bounds.maxX - radius, x)),
    y,
    z: Math.max(bounds.minZ + radius, Math.min(bounds.maxZ - radius, z)),
  };
}

export function rayIntersectsAABB(ox, oy, oz, dx, dy, dz, box, maxDist = 200) {
  let tmin = 0.0;
  let tmax = maxDist;
  const axes = [
    [ox, dx, box.x0, box.x1],
    [oy, dy, box.y0, box.y1],
    [oz, dz, box.z0, box.z1],
  ];
  for (const [o, d, b0, b1] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < b0 || o > b1) return null;
      continue;
    }
    let t1 = (b0 - o) / d;
    let t2 = (b1 - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin <= tmax && tmin >= 0 ? tmin : null;
}

export function rayIntersectsOBB(ox, oy, oz, dx, dy, dz, obb, maxDist = 200) {
  const c = Math.cos(obb.yaw);
  const s = Math.sin(obb.yaw);
  const rx = ox - obb.cx;
  const ry = oy - obb.cy;
  const rz = oz - obb.cz;
  return rayIntersectsAABB(
    rx * c - rz * s,
    ry,
    rx * s + rz * c,
    dx * c - dz * s,
    dy,
    dx * s + dz * c,
    { x0: -obb.hx, x1: obb.hx, y0: -obb.hy, y1: obb.hy, z0: -obb.hz, z1: obb.hz },
    maxDist,
  );
}

export function raycastArenaDistance(ox, oy, oz, dx, dy, dz, maxDist, arenaOrBoxes) {
  if (!Number.isFinite(maxDist) || maxDist <= 0) return null;
  const isArr = Array.isArray(arenaOrBoxes);
  const boxes = isArr ? arenaOrBoxes : (arenaOrBoxes && arenaOrBoxes.boxes) || [];
  const obbs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.obbs) || [];
  let bestT = Infinity;

  const grid = getArenaSpatialGrid(arenaOrBoxes, boxes, obbs);
  if (!grid || maxDist > 160) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.moveOnly) continue;
      const t = rayIntersectsAABB(ox, oy, oz, dx, dy, dz, b, maxDist);
      if (t !== null && t < bestT) bestT = t;
    }
    for (let i = 0; i < obbs.length; i++) {
      const o = obbs[i];
      if (o.moveOnly) continue;
      const t = rayIntersectsOBB(ox, oy, oz, dx, dy, dz, o, maxDist);
      if (t !== null && t < bestT) bestT = t;
    }
    return bestT <= maxDist ? { dist: bestT } : null;
  }

  // Zero-GC 2D DDA grid traversal with early-exit at closest hit distance
  const stamp = ++grid.stamp;
  const seenB = grid.seenBoxes;
  const seenO = grid.seenObbs;
  const cellSize = GRID_CELL_SIZE;
  const inv = 1 / cellSize;
  let gx = Math.floor(ox * inv);
  let gz = Math.floor(oz * inv);
  const stepX = dx > 1e-8 ? 1 : dx < -1e-8 ? -1 : 0;
  const stepZ = dz > 1e-8 ? 1 : dz < -1e-8 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? cellSize / Math.abs(dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? cellSize / Math.abs(dz) : Infinity;
  let tMaxX =
    stepX > 0
      ? ((gx + 1) * cellSize - ox) / dx
      : stepX < 0
        ? (gx * cellSize - ox) / dx
        : Infinity;
  let tMaxZ =
    stepZ > 0
      ? ((gz + 1) * cellSize - oz) / dz
      : stepZ < 0
        ? (gz * cellSize - oz) / dz
        : Infinity;

  let tCur = 0;
  const limitSteps = Math.ceil((maxDist * inv) * 2.2) + 4;
  for (let step = 0; step < limitSteps; step++) {
    const k = (gx + 512) * 1024 + (gz + 512);
    const bList = grid.cellBoxes.get(k);
    if (bList) {
      for (let i = 0; i < bList.length; i++) {
        const bi = bList[i];
        if (seenB[bi] === stamp) continue;
        seenB[bi] = stamp;
        const b = boxes[bi];
        if (b.moveOnly) continue;
        const t = rayIntersectsAABB(ox, oy, oz, dx, dy, dz, b, maxDist);
        if (t !== null && t < bestT) bestT = t;
      }
    }
    const oList = grid.cellObbs.get(k);
    if (oList) {
      for (let i = 0; i < oList.length; i++) {
        const oi = oList[i];
        if (seenO[oi] === stamp) continue;
        seenO[oi] = stamp;
        const o = obbs[oi];
        if (o.moveOnly) continue;
        const t = rayIntersectsOBB(ox, oy, oz, dx, dy, dz, o, maxDist);
        if (t !== null && t < bestT) bestT = t;
      }
    }

    const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
    if (tNext > maxDist || tNext > bestT) break;
    if (tMaxX < tMaxZ) {
      tCur = tMaxX;
      tMaxX += tDeltaX;
      gx += stepX;
    } else {
      tCur = tMaxZ;
      tMaxZ += tDeltaZ;
      gz += stepZ;
    }
    if (tCur > maxDist) break;
  }

  return bestT <= maxDist ? { dist: bestT } : null;
}

export function hasLineOfSight(ax, ay, az, bx, by, bz, arenaOrBoxes) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-5) return true;
  const hit = raycastArenaDistance(ax, ay, az, dx / dist, dy / dist, dz / dist, dist, arenaOrBoxes);
  return !hit || hit.dist >= dist - 0.05;
}

/**
 * Deterministic spawn layout for Harbor container arena (8 TDM per team, 18 FFA points).
 */
export function generateSpawnPoints(boxes) {
  const rawA = [
    [-22, -45, 0],
    [-10, -46, 0],
    [4, -45, 0],
    [18, -46, 0],
    [-33, -43, -0.35],
    [33, -43, 0.35],
    [-42, -38, -0.55],
    [42, -38, 0.55],
  ];
  const rawB = [
    [-22, 45, Math.PI],
    [-10, 46, Math.PI],
    [4, 45, Math.PI],
    [18, 46, Math.PI],
    [-33, 43, Math.PI + 0.35],
    [33, 43, Math.PI - 0.35],
    [-42, 38, Math.PI + 0.55],
    [42, 38, Math.PI - 0.55],
  ];
  const rawFfa = [
    ...rawA,
    ...rawB,
    [-45, -20, -Math.PI * 0.5],
    [-45, 20, -Math.PI * 0.5],
    [45, -20, Math.PI * 0.5],
    [45, 20, Math.PI * 0.5],
    [-7, 0, 0],
    [7, 0, Math.PI],
  ];

  const nudgeClear = ([x, z, yaw]) => {
    if (isPointClear(x, z, boxes, 0.9)) return { x, y: 0, z, yaw };
    for (let r = 1.5; r <= 7.5; r += 1.5) {
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const nz = z + Math.sin(ang) * r;
        if (isPointClear(nx, nz, boxes, 0.9)) return { x: nx, y: 0, z: nz, yaw };
      }
    }
    return { x: 0, y: 0, z: 0, yaw };
  };

  return {
    A: rawA.map(nudgeClear),
    B: rawB.map(nudgeClear),
    FFA: rawFfa.map(nudgeClear),
  };
}

export function activateSpawnProtection(player, mode, spawnPos, now) {
  if (!player) return null;
  const rule = getSpawnRuleForMode(mode);
  const safeNow = Number.isFinite(now) ? now : 0;
  player.spawnEpoch = (player.spawnEpoch || 0) + 1;
  player.spawnedAt = safeNow;
  player.iFramesUntil = safeNow + rule.iFramesMs;
  player.invulnerableUntil = safeNow + rule.protectMs;
  player.spawnOrigin = {
    x: spawnPos && Number.isFinite(spawnPos.x) ? spawnPos.x : player.x || 0,
    y: spawnPos && Number.isFinite(spawnPos.y) ? spawnPos.y : player.y || 0,
    z: spawnPos && Number.isFinite(spawnPos.z) ? spawnPos.z : player.z || 0,
  };
  player.adsProtectStartAt = 0;
  return evaluateProtectionTick(player, mode, safeNow);
}

export function cancelProtectionOnFire(player) {
  if (!player) return;
  player.iFramesUntil = 0;
  player.invulnerableUntil = 0;
  player.adsProtectStartAt = 0;
}

export function isPlayerProtected(player, now) {
  if (!player || !player.alive) return false;
  const until = Math.max(player.invulnerableUntil || 0, player.iFramesUntil || 0);
  return now < until;
}

export function evaluateProtectionTick(player, mode, now) {
  const rule = getSpawnRuleForMode(mode);
  if (!player || !player.alive) {
    if (player) {
      player.iFramesUntil = 0;
      player.invulnerableUntil = 0;
      player.adsProtectStartAt = 0;
    }
    return {
      active: false,
      iFrames: false,
      spawnProtected: false,
      expiring: false,
      remainingMs: 0,
      totalMs: rule.protectMs,
      progress: 0,
    };
  }

  const inIFrames = now < (player.iFramesUntil || 0);
  let softUntil = player.invulnerableUntil || 0;

  if (now < softUntil && !inIFrames) {
    const origin = player.spawnOrigin;
    if (origin) {
      const distMoved = Math.hypot((player.x || 0) - origin.x, (player.z || 0) - origin.z);
      if (distMoved > rule.maxRadiusM) {
        softUntil = 0;
        player.invulnerableUntil = 0;
      }
    }
    if (softUntil > now) {
      const isAiming = Boolean((player.flags || 0) & FLAG_ADS) || Boolean(player.ads);
      if (isAiming) {
        if (!player.adsProtectStartAt) {
          player.adsProtectStartAt = now;
        } else if (now - player.adsProtectStartAt > rule.adsCancelMs) {
          softUntil = 0;
          player.invulnerableUntil = 0;
          player.adsProtectStartAt = 0;
        }
      } else {
        player.adsProtectStartAt = 0;
      }
    }
  }

  const effectiveUntil = Math.max(softUntil, player.iFramesUntil || 0);
  const remainingMs = Math.max(0, effectiveUntil - now);
  const active = remainingMs > 0;
  const expiring = active && remainingMs <= rule.expiringWindowMs;
  const progress = active ? Math.max(0, Math.min(1, remainingMs / Math.max(1, rule.protectMs))) : 0;

  return {
    active,
    iFrames: inIFrames,
    spawnProtected: active && !inIFrames,
    expiring,
    remainingMs,
    totalMs: rule.protectMs,
    progress,
  };
}

export function computeProtectionBlinkState(
  nowSec,
  { active = false, iFrames = false, expiring = false, hitFlash = 0 } = {},
) {
  if (!active && !(hitFlash > 0)) {
    return { blinkOn: false, intensity: 0, pulse01: 0, freqHz: 0 };
  }
  const freqHz = hitFlash > 0 ? 14.0 : iFrames ? 12.0 : expiring ? 10.0 : 4.5;
  const wave = Math.sin(nowSec * Math.PI * 2 * freqHz);
  const pulse01 = 0.5 + 0.5 * wave;
  const threshold = hitFlash > 0 ? -0.9 : iFrames ? -0.55 : expiring ? -0.05 : -0.15;
  const blinkOn = active || hitFlash > 0 ? wave > threshold : false;
  const intensity = hitFlash > 0 ? 1.0 : iFrames ? 0.65 + 0.35 * pulse01 : expiring ? 0.35 + 0.65 * pulse01 : 0.32 + 0.58 * pulse01;
  return { blinkOn, intensity, pulse01, freqHz };
}

export function createSpawnTracker() {
  return {
    recentSpawns: new Map(),
    nextFlipAllowedAt: 0,
  };
}

function spawnKey(cand) {
  return `${Number(cand.x).toFixed(1)},${Number(cand.z).toFixed(1)}`;
}

function recordSpawnUsage(tracker, cand, now) {
  if (!tracker || !tracker.recentSpawns || !cand) return;
  tracker.recentSpawns.set(spawnKey(cand), now);
}

function iterPlayers(players) {
  if (!players) return [];
  if (typeof players.values === "function") return Array.from(players.values());
  if (Array.isArray(players)) return players;
  return [];
}

function scoreTeamCandidate(cand, team, arena, playerList, excludeId, now, tracker) {
  let minEnemyDist = Infinity;
  let minAllyDist = Infinity;
  let losExposedCount = 0;

  for (const p of playerList) {
    if (!p || p.id === excludeId || !p.alive) continue;
    const d = Math.hypot(cand.x - p.x, cand.z - p.z);
    if (p.team === team) {
      if (d < minAllyDist) minAllyDist = d;
    } else {
      if (d < minEnemyDist) minEnemyDist = d;
      const eyeY = (p.y || 0) + getEyeHeightForFlags(p.flags || 0);
      if (hasLineOfSight(p.x, eyeY, p.z, cand.x, (cand.y || 0) + 1.55, cand.z, arena)) {
        losExposedCount++;
      }
    }
  }

  const recentAt = tracker && tracker.recentSpawns ? tracker.recentSpawns.get(spawnKey(cand)) : undefined;
  const cooldownPenalty = recentAt !== undefined && now - recentAt < SPAWN_RULES.TDM.spawnCooldownMs ? 100_000 : 0;
  const overlapPenalty = minAllyDist < 2.2 ? 120_000 : minEnemyDist < 2.2 ? 250_000 : 0;
  const closeEnemyPenalty = Number.isFinite(minEnemyDist) && minEnemyDist < 14 ? 120_000 / Math.max(1, minEnemyDist) : 0;
  const losPenalty = losExposedCount * 500_000;
  const distBase = Number.isFinite(minEnemyDist) ? Math.min(minEnemyDist, 85) * 180 : 12_000;
  const allySpreadBonus = Number.isFinite(minAllyDist) ? Math.min(minAllyDist, 15) * 40 : 400;

  return {
    cand,
    score: distBase + allySpreadBonus - losPenalty - closeEnemyPenalty - overlapPenalty - cooldownPenalty,
    minEnemyDist,
    minAllyDist,
    losExposedCount,
  };
}

export function pickSmartTeamSpawn(arena, team, players, excludeId = null, now = 0, tracker = null) {
  const myTeam = team === "B" ? "B" : "A";
  const oppTeam = myTeam === "A" ? "B" : "A";
  const spawns = (arena && arena.spawns) || { A: [], B: [] };
  const homePool = Array.isArray(spawns[myTeam]) && spawns[myTeam].length ? spawns[myTeam] : [{ x: 0, y: 0, z: 0, yaw: 0 }];
  const oppPool = Array.isArray(spawns[oppTeam]) ? spawns[oppTeam] : [];
  const playerList = iterPlayers(players);

  const homeScored = homePool.map((cand) =>
    scoreTeamCandidate(cand, myTeam, arena, playerList, excludeId, now, tracker),
  );
  homeScored.sort((a, b) => b.score - a.score);
  const bestHome = homeScored[0];

  const baseCompromised =
    homeScored.some((s) => Number.isFinite(s.minEnemyDist) && s.minEnemyDist < 14) ||
    homeScored.every((s) => s.losExposedCount > 0);

  const canFlip =
    baseCompromised &&
    oppPool.length > 0 &&
    (!tracker || now >= (tracker.nextFlipAllowedAt || 0));

  if (canFlip) {
    const oppScored = oppPool.map((cand) =>
      scoreTeamCandidate(cand, myTeam, arena, playerList, excludeId, now, tracker),
    );
    oppScored.sort((a, b) => b.score - a.score);
    const bestOpp = oppScored[0];
    if (
      bestOpp &&
      bestOpp.losExposedCount === 0 &&
      (!Number.isFinite(bestOpp.minEnemyDist) || bestOpp.minEnemyDist >= 20) &&
      bestOpp.minAllyDist >= 1.5
    ) {
      if (tracker) {
        tracker.nextFlipAllowedAt = now + SPAWN_RULES.TDM.spawnFlipCooldownMs;
        recordSpawnUsage(tracker, bestOpp.cand, now);
      }
      return { ...bestOpp.cand, reason: "flip" };
    }
  }

  if (tracker) recordSpawnUsage(tracker, bestHome.cand, now);
  return { ...bestHome.cand, reason: "normal" };
}

export function pickSmartFfaSpawn(
  arena,
  players,
  excludeId = null,
  now = 0,
  tracker = null,
  playerState = null,
) {
  const pool =
    arena && arena.spawns && Array.isArray(arena.spawns.FFA) && arena.spawns.FFA.length
      ? arena.spawns.FFA
      : [{ x: 0, y: 0, z: 0, yaw: 0 }];
  const playerList = iterPlayers(players);
  const lastDeath = playerState && playerState.lastDeathPos ? playerState.lastDeathPos : null;

  let best = pool[0];
  let bestScore = -Infinity;

  for (const cand of pool) {
    let minEnemyDist = Infinity;
    let losCount = 0;
    let aimConePenalty = 0;

    for (const enemy of playerList) {
      if (!enemy || enemy.id === excludeId || !enemy.alive) continue;
      const dx = cand.x - enemy.x;
      const dz = cand.z - enemy.z;
      const d = Math.hypot(dx, dz);
      if (d < minEnemyDist) minEnemyDist = d;

      const eyeY = (enemy.y || 0) + getEyeHeightForFlags(enemy.flags || 0);
      if (hasLineOfSight(enemy.x, eyeY, enemy.z, cand.x, (cand.y || 0) + 1.55, cand.z, arena)) {
        losCount++;
      }

      if (d > 0.5 && d < 28 && Number.isFinite(enemy.yaw)) {
        const fx = -Math.sin(enemy.yaw);
        const fz = -Math.cos(enemy.yaw);
        const dot = (dx * fx + dz * fz) / d;
        if (dot > 0.65) {
          aimConePenalty += 70_000 * ((dot - 0.65) / 0.35);
        }
      }
    }

    const hiddenScore = losCount === 0 ? 1_000_000 : -losCount * 250_000;

    let distScore = 40_000;
    if (Number.isFinite(minEnemyDist)) {
      if (minEnemyDist < 2.5) {
        distScore = -600_000;
      } else if (minEnemyDist < 10.0) {
        distScore = -450_000 - (10.0 - minEnemyDist) * 30_000;
      } else if (minEnemyDist < 18.0) {
        distScore = ((minEnemyDist - 10.0) / 8.0) * 40_000;
      } else if (minEnemyDist <= 42.0) {
        distScore = 40_000;
      } else {
        distScore = Math.max(10_000, 40_000 - (minEnemyDist - 42.0) * 550);
      }
    }

    let deathPenalty = 0;
    if (lastDeath && Number.isFinite(lastDeath.x) && Number.isFinite(lastDeath.z)) {
      const deathDist = Math.hypot(cand.x - lastDeath.x, cand.z - lastDeath.z);
      if (deathDist < 12.0) {
        deathPenalty = 120_000 * (1 - deathDist / 12.0);
      }
    }

    const recentAt = tracker && tracker.recentSpawns ? tracker.recentSpawns.get(spawnKey(cand)) : undefined;
    const cooldownPenalty = recentAt !== undefined && now - recentAt < SPAWN_RULES.FFA.spawnCooldownMs ? 150_000 : 0;

    const totalScore = hiddenScore + distScore - aimConePenalty - deathPenalty - cooldownPenalty;
    if (totalScore > bestScore) {
      bestScore = totalScore;
      best = cand;
    }
  }

  if (tracker) recordSpawnUsage(tracker, best, now);
  return { ...best, reason: "normal" };
}
