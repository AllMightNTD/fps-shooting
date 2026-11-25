/**
 * Deterministic Rainy Harbor arena boxes (MAP_SEED = 11042026) and spawn point selection.
 * Used for collision clamping, line-of-sight wall checks, TDM bases, and FFA safe spawns.
 */

export const MAP_SEED = 11042026;
export const ARENA_BOUND = 48.0;

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

export function clampAndResolvePlayerPos(pos, boxes, radius = 0.45) {
  let x = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, pos.x));
  let z = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, pos.z));
  const y = Math.max(0, Math.min(8, pos.y));

  for (const b of boxes) {
    if (b.y1 >= 9 || y >= b.y1) continue;
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

  return {
    x: Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, x)),
    y,
    z: Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, z)),
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

export function hasLineOfSight(ax, ay, az, bx, by, bz, boxes) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-5) return true;
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  for (const b of boxes) {
    const t = rayIntersectsAABB(ax, ay, az, nx, ny, nz, b, dist);
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
      if (hasLineOfSight(enemy.x, enemy.y + 1.65, enemy.z, cand.x, 1.55, cand.z, arena.boxes)) {
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

