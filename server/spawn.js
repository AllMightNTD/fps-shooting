/**
 * Arena loader and spawn entrypoints for Harbor & Military 5v5.
 * Pure collision, LoS, and smart spawn scoring live in ./spawn_rules.js (shared with Browser).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARENA_BOUND,
  clampAndResolvePlayerPos,
  generateSpawnPoints,
  hasLineOfSight,
  isPointClear,
  pickSmartFfaSpawn,
  pickSmartTeamSpawn,
  rayIntersectsAABB,
  rayIntersectsOBB,
  raycastArenaDistance,
} from "./spawn_rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAP_SEED = 11042026;
export {
  ARENA_BOUND,
  clampAndResolvePlayerPos,
  generateSpawnPoints,
  hasLineOfSight,
  isPointClear,
  rayIntersectsAABB,
  rayIntersectsOBB,
  raycastArenaDistance,
};

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
 * Deterministic 31-bit Park-Miller PRNG matching public/js/harbor_map.js container layout.
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

export function pickTeamSpawn(arena, team, players, excludeId = null, now = 0, tracker = null) {
  return pickSmartTeamSpawn(arena, team, players, excludeId, now, tracker);
}

export function pickFfaSpawn(arena, players, excludeId = null, now = 0, tracker = null, playerState = null) {
  return pickSmartFfaSpawn(arena, players, excludeId, now, tracker, playerState);
}
