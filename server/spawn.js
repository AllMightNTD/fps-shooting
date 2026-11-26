/**
 * Deterministic arena boxes/OBBs/ladders and spawn point selection for Harbor & Military 5v5.
 * Used for collision clamping, line-of-sight wall checks, TDM bases, and FFA safe spawns.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLAG } from "./weapons.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAP_SEED = 11042026;
export const ARENA_BOUND = 48.0;

let cachedMilitaryArena = null;

export function loadMilitaryArena(collidersPath = null) {
  if (!collidersPath && cachedMilitaryArena) return cachedMilitaryArena;
  const resolved =
    collidersPath || path.resolve(__dirname, "..", "shared", "maps", "military_colliders.json");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const arena = {
    mapId: "military",
    bounds: raw.bounds || { minX: -35, maxX: 35, minZ: -45, maxZ: 45, wallHeight: 3.5 },
    boxes: Array.isArray(raw.boxes) ? raw.boxes : [],
    obbs: Array.isArray(raw.obbs) ? raw.obbs : [],
    walkableSlabs: Array.isArray(raw.walkableSlabs) ? raw.walkableSlabs : [],
    ladders: Array.isArray(raw.ladders) ? raw.ladders : [],
    spawns: raw.spawns || { A: [], B: [], FFA: [] },
  };
  if (!collidersPath) cachedMilitaryArena = arena;
  return arena;
}

/**
 * Deterministic 31-bit Park-Miller PRNG matching public/js/game.js container layout.
 */
export function buildHarborMap(seedInit = MAP_SEED) {
  let s = seedInit;
  const msr = () => (s = (s * 16807) % 2147483647) / 2147483647;

  const containers = [];
  const boxes = [];

  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      if ((gx === 0 && gz === 0) || msr() < 0.42) continue;
      const x = gx * 13 + (msr() - 0.5) * 3;
      const z = gz * 13 + (msr() - 0.5) * 3;
      const rot = msr() < 0.5;
      const matIdx = (msr() * 6) | 0;
      const stacked = msr() < 0.3;
      const hx = rot ? 1.22 : 3.05;
      const hz = rot ? 3.05 : 1.22;

      containers.push({ x, z, rot, matIdx, stacked, hx, hz });
      boxes.push({
        x0: x - hx,
        x1: x + hx,
        y0: 0,
        y1: stacked ? 5.2 : 2.6,
        z0: z - hz,
        z1: z + hz,
      });
    }
  }

  const walls = [
    [0, -52, 100, 1],
    [0, 52, 100, 1],
    [-52, 0, 1, 100],
    [52, 0, 1, 100],
  ];
  for (const [x, z, w, d] of walls) {
    boxes.push({
      x0: x - w * 0.5,
      x1: x + w * 0.5,
      y0: 0,
      y1: 10,
      z0: z - d * 0.5,
      z1: z + d * 0.5,
    });
  }

  return { containers, boxes };
}

export function isPointClear(x, z, boxes, margin = 0.9) {
  if (Math.abs(x) > ARENA_BOUND - margin || Math.abs(z) > ARENA_BOUND - margin) return false;
  for (const b of boxes) {
    if (b.y1 >= 9) continue;
    if (x >= b.x0 - margin && x <= b.x1 + margin && z >= b.z0 - margin && z <= b.z1 + margin) {
      return false;
    }
  }
  return true;
}

export function clampAndResolvePlayerPos(pos, arenaOrBoxes, radius = 0.45, flags = 0) {
  const isArr = Array.isArray(arenaOrBoxes);
  const boxes = isArr ? arenaOrBoxes : (arenaOrBoxes && arenaOrBoxes.boxes) || [];
  const obbs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.obbs) || [];
  const slabs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.walkableSlabs) || [];
  const ladders = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.ladders) || [];
  const bounds = isArr || !arenaOrBoxes?.bounds
    ? { minX: -ARENA_BOUND, maxX: ARENA_BOUND, minZ: -ARENA_BOUND, maxZ: ARENA_BOUND }
    : arenaOrBoxes.bounds;

  let x = Math.max(bounds.minX + radius, Math.min(bounds.maxX - radius, pos.x));
  let z = Math.max(bounds.minZ + radius, Math.min(bounds.maxZ - radius, pos.z));
  let y = Math.max(0, Math.min(8, pos.y));

  // Clamp elevation cleanly if arena defines walkable slabs & ladders
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

  const pHeight = flags & FLAG.CROUCH ? 1.22 : 1.78;
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

export function hasLineOfSight(ax, ay, az, bx, by, bz, arenaOrBoxes) {
  const isArr = Array.isArray(arenaOrBoxes);
  const boxes = isArr ? arenaOrBoxes : (arenaOrBoxes && arenaOrBoxes.boxes) || [];
  const obbs = isArr ? [] : (arenaOrBoxes && arenaOrBoxes.obbs) || [];
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-5) return true;
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  for (const b of boxes) {
    if (b.moveOnly) continue;
    const t = rayIntersectsAABB(ax, ay, az, nx, ny, nz, b, dist);
    if (t !== null && t < dist - 0.05) return false;
  }
  for (const o of obbs) {
    if (o.moveOnly) continue;
    const t = rayIntersectsOBB(ax, ay, az, nx, ny, nz, o, dist);
    if (t !== null && t < dist - 0.05) return false;
  }
  return true;
}

export function generateSpawnPoints(boxes) {
  const rawA = [
    [-22, -45, 0],
    [-10, -46, 0],
    [4, -45, 0],
    [18, -46, 0],
    [-33, -43, -0.35],
    [33, -43, 0.35],
  ];
  const rawB = [
    [-22, 45, Math.PI],
    [-10, 46, Math.PI],
    [4, 45, Math.PI],
    [18, 46, Math.PI],
    [-33, 43, Math.PI + 0.35],
    [33, 43, Math.PI - 0.35],
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

/**
 * Select TDM spawn inside team's home base, maximizing separation from enemies.
 */
export function pickTeamSpawn(arena, team, players, excludeId = null) {
  const pool = arena.spawns[team === "B" ? "B" : "A"];
  let best = pool[0];
  let bestScore = -1;

  for (const cand of pool) {
    let minEnemyD2 = Infinity;
    let minAllyD2 = Infinity;
    for (const p of players.values()) {
      if (p.id === excludeId || !p.alive) continue;
      const d2 = (cand.x - p.x) ** 2 + (cand.z - p.z) ** 2;
      if (p.team === team) minAllyD2 = Math.min(minAllyD2, d2);
      else minEnemyD2 = Math.min(minEnemyD2, d2);
    }
    const spreadScore =
      (Number.isFinite(minEnemyD2) ? minEnemyD2 : 9000) +
      0.1 * (Number.isFinite(minAllyD2) ? Math.min(minAllyD2, 400) : 100);
    if (spreadScore > bestScore) {
      bestScore = spreadScore;
      best = cand;
    }
  }
  return { ...best };
}

/**
 * Select FFA spawn preferring points NOT visible by any alive enemy and farthest from all enemies.
 */
export function pickFfaSpawn(arena, players, excludeId = null) {
  const pool = arena.spawns.FFA;
  let best = pool[0];
  let bestScore = -Infinity;

  for (const cand of pool) {
    let hidden = true;
    let minEnemyD2 = Infinity;
    for (const enemy of players.values()) {
      if (enemy.id === excludeId || !enemy.alive) continue;
      const d2 = (cand.x - enemy.x) ** 2 + (cand.z - enemy.z) ** 2;
      minEnemyD2 = Math.min(minEnemyD2, d2);
      if (hasLineOfSight(enemy.x, enemy.y + 1.65, enemy.z, cand.x, 1.55, cand.z, arena)) {
        hidden = false;
      }
    }
    const distScore = Number.isFinite(minEnemyD2) ? minEnemyD2 : 5000;
    // Hidden from enemy line-of-sight takes top priority over raw distance
    const totalScore = (hidden ? 1_000_000 : 0) + distScore;
    if (totalScore > bestScore) {
      bestScore = totalScore;
      best = cand;
    }
  }
  return { ...best };
}

