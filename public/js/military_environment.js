/**
 * Khu Quân Sự Cũ v5 — Procedural Alpine Environment & Sky System:
 * 1. Analytical Rayleigh + Mie Atmospheric Skybox GLSL + 2-Layer Volumetric Worley-Perlin Cumulus/Cirrus Clouds + PMREM IBL
 * 2. 3-Layer Sculpted Eroded Mountain Terrain (Ridged Multifractal + Drainage Gullies + Baked Horizon Sun Occlusion + Slope/Elevation PBR Splatting + Aerial Perspective)
 * 3. Seamless Perimeter Transition: Lush Near Conifer/Broadleaf Groves, ~420 Mountain-Slope Conifer Billboards, Mossy Boulders, Utility Poles + Catenary Cables, Outer Buffer Fencing, Low Valley Mist & Mountain-Pass God Rays
 *
 * Pure heightfield & scatter math exports run identically in Node.js (AAA unit tests) and browser WebGL.
 */

export const MILITARY_BOUNDS_DEFAULT = Object.freeze({
  minX: -35.0,
  maxX: 35.0,
  minZ: -45.0,
  maxZ: 45.0,
});

export const TERRAIN_RING_RADII = Object.freeze({
  innerWallMargin: 1.2,
  foothillStart: 36.2,
  midRangeStart: 122.0,
  midRangeEnd: 248.0,
  farAlpsStart: 236.0,
  farAlpsEnd: 372.0,
  skyRadius: 425.0,
});

export const MILITARY_FOG_HEX = 0xb8cad9;
export const MILITARY_SUN_FOG_HEX = 0xefe3cb;

// ---------- Deterministic Math & Noise Utilities (Node + Browser safe) ----------

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hash2(ix, iz, seed = 0) {
  let n = Math.imul(ix * 374761393 + iz * 668265263 + seed * 1442695041, 1274126177);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function valueNoise2(x, z, seed = 0) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

function fbm2(x, z, octaves = 4, seed = 0) {
  let px = x;
  let pz = z;
  let sum = 0;
  let amp = 0.52;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(px, pz, seed + i * 17);
    norm += amp;
    const nx = 0.8 * px + 0.6 * pz;
    const nz = -0.6 * px + 0.8 * pz;
    px = nx * 2.03 + 13.7;
    pz = nz * 2.03 - 9.4;
    amp *= 0.49;
  }
  return sum / Math.max(1e-6, norm);
}

// Musgrave Ridged Multifractal: creates crisp alpine ridge spines & recessed glacial V-valleys
function ridgedMultifractal(x, z, octaves = 4, seed = 71) {
  let px = x;
  let pz = z;
  let sum = 0;
  let amp = 0.56;
  let weight = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2(px, pz, seed + i * 29);
    let signal = 1.0 - Math.abs(n * 2.0 - 1.0);
    signal = signal * signal * weight;
    weight = clamp(signal * 1.85, 0.22, 1.0);
    sum += signal * amp;
    norm += amp;
    const nx = 0.78 * px - 0.62 * pz;
    const nz = 0.62 * px + 0.78 * pz;
    px = nx * 2.11 + 19.1;
    pz = nz * 2.11 + 7.3;
    amp *= 0.48;
  }
  return sum / Math.max(1e-6, norm);
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function gaussianAngle(ang, center, width) {
  const d = angleDiff(ang, center);
  return Math.exp(-(d * d) / Math.max(1e-4, width * width));
}

/**
 * Computes signed clearance distance outside the rectangular perimeter wall footprint.
 * Returns <= 0 inside the courtyard [-35..35, -45..45].
 */
export function distanceOutsideBase(x, z, bounds = MILITARY_BOUNDS_DEFAULT) {
  const dx = Math.max(0, Math.abs(x) - bounds.maxX);
  const dz = Math.max(0, Math.abs(z) - bounds.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Pure deterministic 3-layer alpine heightfield surrounding Khu Quân Sự Cũ:
 * - Strictly clamped to y = -0.04 inside & immediately beneath the perimeter walls (zero intrusion into gameplay)
 * - Layer 1 (dOut 1..78m): Rolling grassy foothills, right/left wooded ridges & scenic misty valley channels
 * - Layer 2 (r 115..250m): Sculpted eroded alpine mountain range with ridged spines, spurs & drainage gullies
 * - Layer 3 (r 236..375m): Towering distant alpine massif peaks visible through every mountain pass
 */
export function sampleMilitaryTerrainHeight(x, z, bounds = MILITARY_BOUNDS_DEFAULT) {
  const dOut = distanceOutsideBase(x, z, bounds);
  if (dOut <= TERRAIN_RING_RADII.innerWallMargin) {
    return -0.04;
  }

  const r = Math.hypot(x, z);
  const ang = Math.atan2(z, x); // 0=+X East, PI=-X West (sun), -PI/2=-Z North (Team A), +PI/2=+Z South (Team B)

  // Domain warp coordinates so ridges twist organically instead of grid-aligned waves
  const wx = x + (fbm2(x * 0.011 + 5.2, z * 0.011 - 3.8, 2, 13) - 0.5) * 32.0;
  const wz = z + (fbm2(x * 0.011 - 8.4, z * 0.011 + 6.1, 2, 31) - 0.5) * 32.0;

  // Scenic valley passes:
  // - Primary misty alpine pass behind the West-South-West wall (~ang = +2.82 and -2.92 -> West center open valley)
  // - Secondary scenic valley pass to East-North-East (~ang = -0.42) so Southwest overview also looks into layered peaks
  const westValleyPass = gaussianAngle(ang, Math.PI, 0.34);
  const eastValleyPass = gaussianAngle(ang, -0.35, 0.32);
  const southPass = gaussianAngle(ang, 1.48, 0.28);
  const valleyCarve = clamp(westValleyPass * 0.62 + eastValleyPass * 0.44 + southPass * 0.34, 0, 0.72);

  // Iconic foreground rolling hills right outside the perimeter (matches the grassy right-flank knoll & wooded left slope!)
  const nwKnoll = gaussianAngle(ang, -2.18, 0.48) * smoothstep(4.0, 26.0, dOut) * (1.0 - smoothstep(52.0, 95.0, dOut));
  const swWoodedHill = gaussianAngle(ang, 2.26, 0.44) * smoothstep(3.5, 24.0, dOut) * (1.0 - smoothstep(50.0, 92.0, dOut));
  const neHill = gaussianAngle(ang, -0.95, 0.46) * smoothstep(4.5, 28.0, dOut) * (1.0 - smoothstep(56.0, 102.0, dOut));
  const seHill = gaussianAngle(ang, 0.78, 0.46) * smoothstep(4.5, 28.0, dOut) * (1.0 - smoothstep(56.0, 102.0, dOut));

  const foothillBlend = smoothstep(TERRAIN_RING_RADII.innerWallMargin, 16.0, dOut);
  const rollingNoise = fbm2(wx * 0.022, wz * 0.022, 3, 41);
  const gentleBerms = (rollingNoise * 8.2 + nwKnoll * 11.5 + swWoodedHill * 10.2 + neHill * 9.6 + seHill * 9.0) * foothillBlend;
  // Keep outer perimeter road corridor gentle around valley passes
  const foothillH = gentleBerms * (1.0 - valleyCarve * 0.58) - valleyCarve * 1.4 * smoothstep(10.0, 48.0, dOut);

  // Layer 2: Eroded Mid-Range Mountain Massifs (r = 95..252m) — balanced height so sky & clouds fill upper ~38% of vista!
  const midRamp = smoothstep(80.0, 185.0, r);
  const midSpine = ridgedMultifractal(wx * 0.0095, wz * 0.0095, 4, 83);
  const midSecondary = ridgedMultifractal(wx * 0.020 + 14.0, wz * 0.020 - 11.0, 3, 127);

  // Sculpted alpine massifs framing the West sun valley (NW & SW) plus balanced 360° peaks
  const massifBoost =
    1.0 +
    gaussianAngle(ang, -2.42, 0.40) * 0.56 + // Dramatic NW eroded ridge (right massif in NE overview)
    gaussianAngle(ang, 2.46, 0.40) * 0.52 +  // Dramatic SW eroded ridge (left massif in NE overview)
    gaussianAngle(ang, -1.55, 0.36) * 0.30 + // North flank ridge
    gaussianAngle(ang, 0.55, 0.42) * 0.40 +  // SE massif
    gaussianAngle(ang, -0.82, 0.36) * 0.30;  // NE massif

  // Deep radial hydraulic erosion couloirs & diagonal rocky spurs carved into every mountain face
  const gullyPhase = ang * 26.0 + fbm2(x * 0.018, z * 0.018, 2, 191) * 5.8;
  const gullyCarve = Math.pow(0.5 + 0.5 * Math.sin(gullyPhase), 1.55) * (0.45 + 0.55 * midSecondary);
  const gullyDepth = gullyCarve * 8.2 * smoothstep(104.0, 168.0, r) * (1.0 - smoothstep(232.0, 285.0, r));

  const midBase = (13.0 + midSpine * 36.0 + midSecondary * 12.5) * massifBoost * (1.0 - valleyCarve * 0.62);
  const midH = Math.max(0, midBase - gullyDepth) * midRamp;

  // Layer 3: Distant Alpine Silhouette Peaks (r = 228..375m) — graceful layered peaks leaving wide dramatic sky above!
  const farRamp = smoothstep(220.0, 318.0, r);
  const farSpine = ridgedMultifractal(wx * 0.0068 + 41.0, wz * 0.0068 - 27.0, 4, 223);
  const farPeaks =
    (34.0 + farSpine * 48.0) *
    (0.84 +
      gaussianAngle(ang, Math.PI, 0.40) * 0.24 +      // Distant pale misty massif framed inside the West pass
      gaussianAngle(ang, -2.20, 0.34) * 0.36 +        // High NW alpine crest
      gaussianAngle(ang, 2.28, 0.34) * 0.34 +         // High SW alpine crest
      gaussianAngle(ang, -0.30, 0.38) * 0.26);        // Distant East backdrop
  const farH = farPeaks * farRamp;

  const combined = -0.04 + (foothillH + midH + farH) * smoothstep(TERRAIN_RING_RADII.innerWallMargin, 5.2, dOut);
  return combined;
}

/**
 * Finite-difference world surface normal & slope (0 = flat, 1 = vertical cliff) for terrain splatting and tree placement.
 */
export function sampleTerrainNormalAndSlope(x, z, eps = 1.6, bounds = MILITARY_BOUNDS_DEFAULT) {
  const hL = sampleMilitaryTerrainHeight(x - eps, z, bounds);
  const hR = sampleMilitaryTerrainHeight(x + eps, z, bounds);
  const hD = sampleMilitaryTerrainHeight(x, z - eps, bounds);
  const hU = sampleMilitaryTerrainHeight(x, z + eps, bounds);
  const dx = (hR - hL) / (2 * eps);
  const dz = (hU - hD) / (2 * eps);
  const len = Math.hypot(-dx, 1.0, -dz) || 1.0;
  const nx = -dx / len;
  const ny = 1.0 / len;
  const nz = -dz / len;
  return { nx, ny, nz, slope: clamp(1.0 - ny, 0, 1) };
}

/**
 * Fast heightfield horizon raymarch from (x, y, z) toward sunDir to bake realistic cast mountain shadows
 * into vertex attributes during Loading (0ms GPU runtime cost!).
 */
export function computeTerrainSunOcclusion(x, y, z, sunDir, bounds = MILITARY_BOUNDS_DEFAULT) {
  const horizLen = Math.hypot(sunDir.x, sunDir.z);
  if (horizLen < 1e-4) return 1.0;
  const r0 = Math.hypot(x, z);
  const maxSampleR = r0 <= 252 ? 255 : 388;
  const stepDistList = [10, 22, 38, 56];
  let maxBlock = 0;
  for (let i = 0; i < stepDistList.length; i++) {
    const d = stepDistList[i];
    const sx = x + sunDir.x * d;
    const sz = z + sunDir.z * d;
    if (Math.hypot(sx, sz) > maxSampleR) break;
    const rayY = y + sunDir.y * d;
    const terY = sampleMilitaryTerrainHeight(sx, sz, bounds);
    const excess = terY - rayY;
    if (excess > 0) {
      maxBlock = Math.max(maxBlock, clamp(excess / (7.5 + d * 0.10), 0, 1));
      if (maxBlock >= 0.98) break;
    }
  }
  return clamp(1.0 - maxBlock * 0.68, 0.32, 1.0);
}

/**
 * Generates deterministic placement lists for near perimeter forest, dense mountain-slope conifer carpet,
 * mossy boulders, perimeter utility poles and outer buffer fence posts — all strictly outside walls.
 */
export function generateMilitaryEnvironmentPlacements(bounds = MILITARY_BOUNDS_DEFAULT) {
  let s = 3344559;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  const broadleafList = [];
  const pineNearList = [];
  const deadList = [];
  const bushList = [];
  const slopeConiferList = [];
  const boulderList = [];

  // 1. Dense perimeter groves hugging all 4 sides & corners right behind concrete walls (r ~ 38..68m)
  const groves = [
    [-44, -44, 10, 10, 10],
    [-46, -16, 10, 14, 9],
    [-46, 18, 10, 14, 9],
    [-44, 46, 10, 10, 10],
    [-18, -54, 14, 8, 9],
    [18, -54, 14, 8, 9],
    [-18, 54, 14, 8, 9],
    [18, 54, 14, 8, 9],
    [45, -36, 10, 13, 10],
    [46, 0, 10, 15, 9],
    [45, 36, 10, 13, 10],
  ];

  const pushOutsideWall = (x, z, pad) => {
    let ox = x;
    let oz = z;
    if (Math.abs(ox) < bounds.maxX + pad && Math.abs(oz) < bounds.maxZ + pad) {
      if (Math.abs(ox) / bounds.maxX > Math.abs(oz) / bounds.maxZ) {
        ox = Math.sign(ox || 1) * (bounds.maxX + pad + rnd() * 3.5);
      } else {
        oz = Math.sign(oz || 1) * (bounds.maxZ + pad + rnd() * 3.5);
      }
    }
    return [ox, oz];
  };

  for (const [gx, gz, rx, rz, cnt] of groves) {
    for (let k = 0; k < cnt; k++) {
      const [x, z] = pushOutsideWall(gx + (rnd() - 0.5) * rx * 2, gz + (rnd() - 0.5) * rz * 2, 3.0);
      const y = sampleMilitaryTerrainHeight(x, z, bounds);
      const { slope } = sampleTerrainNormalAndSlope(x, z, 1.5, bounds);
      if (slope > 0.52) continue;
      const dist = Math.hypot(x, z);
      const pick = rnd();
      if (pick < 0.34) {
        broadleafList.push({
          x,
          y: y - 0.25,
          z,
          dist,
          trunkH: 2.8 + rnd() * 2.5,
          r: 2.3 + rnd() * 1.7,
          ry: rnd() * Math.PI * 2,
          tint: Math.floor(rnd() * 5),
        });
      } else if (pick < 0.90) {
        pineNearList.push({
          x,
          y: y - 0.35,
          z,
          dist,
          h: 9.5 + rnd() * 7.5,
          r: 2.35 + rnd() * 1.45,
          ry: rnd() * Math.PI * 2,
          tint: Math.floor(rnd() * 4),
        });
      } else {
        deadList.push({
          x,
          y: y - 0.25,
          z,
          dist,
          h: 6.2 + rnd() * 4.2,
          r: 1.5 + rnd() * 0.9,
          ry: rnd() * Math.PI * 2,
        });
      }
    }
    for (let b = 0; b < 3; b++) {
      const [bx, bz] = pushOutsideWall(gx * 0.92 + (rnd() - 0.5) * rx * 1.8, gz * 0.92 + (rnd() - 0.5) * rz * 1.8, 2.2);
      const by = sampleMilitaryTerrainHeight(bx, bz, bounds);
      bushList.push({
        x: bx,
        y: by - 0.12,
        z: bz,
        dist: Math.hypot(bx, bz),
        s: 1.35 + rnd() * 1.35,
        ry: rnd() * Math.PI * 2,
        tint: Math.floor(rnd() * 5),
      });
    }
  }

  // 2. Dense Alpine Foothill & Mountain-Slope Conifer Forest Carpet (r = 46..204m, ~680 multi-tree clusters!)
  // Naturally stops on steep rocky cliffs (slope > 0.46) and above alpine treeline (y > 36m)
  let attempts = 0;
  while (slopeConiferList.length < 680 && attempts < 3600) {
    attempts++;
    const ringBias = Math.pow(rnd(), 0.85);
    const rad = 48.0 + ringBias * 154.0;
    const ang = rnd() * Math.PI * 2;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const dOut = distanceOutsideBase(x, z, bounds);
    if (dOut < 5.5) continue;

    // Form lush continuous pine forest groves while preserving sunny grassy knoll clearings on select foothills
    const clumpField = fbm2(x * 0.028 + 7.1, z * 0.028 - 4.3, 2, 307);
    if (clumpField < 0.28 && rad < 105.0) continue;

    const y = sampleMilitaryTerrainHeight(x, z, bounds);
    if (y > 36.5) continue; // Above timberline -> bare craggy alpine rock
    const { slope } = sampleTerrainNormalAndSlope(x, z, 2.0, bounds);
    if (slope > 0.46) continue; // Steep rocky cliff -> exposed granite strata

    const treelineScale = 1.0 - smoothstep(22.0, 36.5, y) * 0.32;
    const h = (9.0 + rnd() * 6.5) * treelineScale;
    const w = (7.2 + rnd() * 4.2) * treelineScale; // Wide multi-tree spruce cluster card -> dense continuous alpine forest!
    slopeConiferList.push({
      x,
      y: y - 0.75,
      z,
      dist: Math.hypot(x, z),
      h,
      w,
      ry: rnd() * Math.PI * 2,
      tint: Math.floor(rnd() * 5),
    });
  }

  // 3. Mossy Granite Boulders on rolling foothills right behind walls (r = 42..108m)
  for (let i = 0; i < 46; i++) {
    const rad = 43.0 + rnd() * 62.0;
    const ang = (i / 46) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
    const [x, z] = pushOutsideWall(Math.cos(ang) * rad, Math.sin(ang) * rad, 4.5);
    const y = sampleMilitaryTerrainHeight(x, z, bounds);
    boulderList.push({
      x,
      y: y - 0.35,
      z,
      dist: Math.hypot(x, z),
      sx: 1.2 + rnd() * 2.6,
      sy: 0.7 + rnd() * 1.4,
      sz: 1.1 + rnd() * 2.4,
      rx: (rnd() - 0.5) * 0.4,
      ry: rnd() * Math.PI * 2,
      rz: (rnd() - 0.5) * 0.4,
      tint: Math.floor(rnd() * 4),
    });
  }

  // 4. Outer Perimeter Utility Power Poles following the dirt road embankment outside the wall
  const poleRingCoords = [
    [-41, -48], [-18, -51], [6, -51], [30, -50],
    [42, -32], [43, -8], [43, 16], [42, 40],
    [24, 51], [0, 51], [-24, 51],
    [-42, 34], [-43, 10], [-42, -16],
  ];
  const powerPoles = poleRingCoords.map(([x, z], idx) => {
    const next = poleRingCoords[(idx + 1) % poleRingCoords.length];
    const dirAng = Math.atan2(next[0] - x, next[1] - z);
    const y = sampleMilitaryTerrainHeight(x, z, bounds);
    return { x, y: y - 0.25, z, h: 7.4 + (idx % 3) * 0.45, ry: dirAng };
  });

  // 5. Outer Buffer Barbed-Wire / Chain-Link Perimeter Fence Posts outside the walls
  const outerFencePosts = [];
  const fenceChains = [
    [[-39.5, -49.5], [-12.0, -49.5], 6],
    [[12.0, -49.5], [39.5, -49.5], 6],
    [[-39.5, 49.5], [-12.0, 49.5], 6],
    [[12.0, 49.5], [39.5, 49.5], 6],
    [[39.5, -36.0], [39.5, 36.0], 9],
    [[-39.5, -36.0], [-39.5, 36.0], 9],
  ];
  for (const [[x0, z0], [x1, z1], steps] of fenceChains) {
    const ry = Math.atan2(x1 - x0, z1 - z0);
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = sampleMilitaryTerrainHeight(x, z, bounds);
      outerFencePosts.push({ x, y: y - 0.1, z, ry });
    }
  }

  broadleafList.sort((a, b) => a.dist - b.dist);
  pineNearList.sort((a, b) => a.dist - b.dist);
  slopeConiferList.sort((a, b) => a.dist - b.dist);
  boulderList.sort((a, b) => a.dist - b.dist);

  return {
    broadleafList,
    pineNearList,
    deadList,
    bushList,
    slopeConiferList,
    boulderList,
    powerPoles,
    outerFencePosts,
  };
}

// ---------- Procedural Seamless Textures (Browser Only) ----------

function periodicValueNoise(nx, ny, period, seedOff) {
  const x0 = Math.floor(nx);
  const y0 = Math.floor(ny);
  const fx = nx - x0;
  const fy = ny - y0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const h = (ix, iy) => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    return hash2(wx, wy, seedOff);
  };
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function periodicWorley(u, v, cells, seedOff) {
  const gx = u * cells;
  const gy = v * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let minD2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const jx = hash2(wx, wy, seedOff) * 0.86 + 0.07;
      const jy = hash2(wx, wy, seedOff + 97) * 0.86 + 0.07;
      const px = cx + jx - gx;
      const py = cy + jy - gy;
      const d2 = px * px + py * py;
      if (d2 < minD2) minD2 = d2;
    }
  }
  return clamp(1.0 - Math.sqrt(minD2) * 1.08, 0, 1);
}

async function buildCloudNoiseTextureAsync(THREE, yieldFn) {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    if (y > 0 && y % 64 === 0 && yieldFn) await yieldFn();
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = (y * size + x) * 4;
      // R: Billowy Worley-Perlin macro cumulus lobes (crisp puffy cauliflower silhouettes)
      const w1 = periodicWorley(u, v, 5, 19);
      const w2 = periodicWorley(u, v, 10, 43);
      const p1 = periodicValueNoise(u * 4, v * 4, 4, 71);
      const billow = clamp(w1 * 0.56 + w2 * 0.28 + p1 * 0.24, 0, 1);

      // G: Medium-high Worley edge erosion (carves crisp puffy detail around cloud rims)
      const e1 = periodicWorley(u, v, 12, 107);
      const e2 = periodicWorley(u, v, 24, 151);
      const erode = clamp(e1 * 0.62 + e2 * 0.38, 0, 1);

      // B: Macro sky coverage + dramatic clear blue sky pockets
      const cov1 = periodicValueNoise(u * 3, v * 3, 3, 211);
      const cov2 = periodicValueNoise(u * 6, v * 6, 6, 263);
      const cov = clamp(cov1 * 0.66 + cov2 * 0.34, 0, 1);

      // A: Wispy high-altitude cirrus streaks
      const cir1 = periodicValueNoise(u * 6, v * 16, 6, 317);
      const cir2 = periodicValueNoise(u * 14, v * 32, 14, 389);
      const cirrus = clamp(cir1 * 0.58 + cir2 * 0.42, 0, 1);

      data[idx] = Math.round(billow * 255);
      data[idx + 1] = Math.round(erode * 255);
      data[idx + 2] = Math.round(cov * 255);
      data[idx + 3] = Math.round(cirrus * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

async function buildTerrainDetailTexturesAsync(THREE, yieldFn) {
  const size = 256;
  const heightArr = new Float32Array(size * size);
  const strataArr = new Float32Array(size * size);
  const canopyArr = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    if (y > 0 && y % 64 === 0 && yieldFn) await yieldFn();
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const n1 = periodicValueNoise(u * 6, v * 6, 6, 401);
      const n2 = periodicValueNoise(u * 16, v * 16, 16, 463);
      const n3 = periodicValueNoise(u * 40, v * 40, 40, 521);
      const rockRidge = 1.0 - Math.abs(n2 * 2.0 - 1.0);
      // Diagonal rock strata & erosion fractures
      const strata = 0.5 + 0.5 * Math.sin((u * 3.0 + v * 7.0 + n1 * 1.45) * Math.PI * 2);
      heightArr[idx] = clamp(n1 * 0.30 + rockRidge * 0.38 + n3 * 0.22 + strata * 0.16, 0, 1);
      strataArr[idx] = clamp(strata * 0.65 + rockRidge * 0.35, 0, 1);
      // Canopy & alpine grass mottle
      const c1 = periodicWorley(u, v, 14, 607);
      const c2 = periodicValueNoise(u * 28, v * 28, 28, 661);
      canopyArr[idx] = clamp(c1 * 0.55 + c2 * 0.45, 0, 1);
    }
  }
  if (yieldFn) await yieldFn();

  const detailData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const idx = y * size + x;
      // Encode rock normal XY into RG, strata contrast into B, forest/grass mottle into A
      const dx = (heightArr[y * size + xp] - heightArr[y * size + xm]) * 2.6;
      const dy = (heightArr[yp * size + x] - heightArr[ym * size + x]) * 2.6;
      detailData[idx * 4] = clamp(Math.round((0.5 - dx * 0.42) * 255), 0, 255);
      detailData[idx * 4 + 1] = clamp(Math.round((0.5 - dy * 0.42) * 255), 0, 255);
      detailData[idx * 4 + 2] = clamp(Math.round(strataArr[idx] * 255), 0, 255);
      detailData[idx * 4 + 3] = clamp(Math.round(canopyArr[idx] * 255), 0, 255);
    }
  }

  const detailTex = new THREE.DataTexture(detailData, size, size, THREE.RGBAFormat);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.magFilter = THREE.LinearFilter;
  detailTex.minFilter = THREE.LinearMipmapLinearFilter;
  detailTex.generateMipmaps = true;
  detailTex.needsUpdate = true;
  return detailTex;
}

// ---------- Pillar 1: Analytical Atmospheric Skybox + Volumetric Cumulus/Cirrus + PMREM ----------

function createSkyShaderMaterial(THREE, cloudTex, sunDir) {
  const uniforms = {
    uSunDir: { value: sunDir.clone() },
    uCloudTex: { value: cloudTex },
    uTime: { value: 0.0 },
    uCloudDetail: { value: 1.0 },
    uCloudEnabled: { value: 1.0 },
  };

  // Infinite camera-centered skybox projection (z = w * 0.99999) -> NEVER clips at any cameraFar (Low/Med/High)!
  const vertexShader = `
    varying vec3 vWorldDir;
    void main() {
      vWorldDir = position;
      vec4 clipPos = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
      gl_Position = vec4(clipPos.xy, clipPos.w * 0.99999, clipPos.w);
    }
  `;

  const fragmentShader = `
    uniform vec3 uSunDir;
    uniform sampler2D uCloudTex;
    uniform float uTime;
    uniform float uCloudDetail;
    uniform float uCloudEnabled;
    varying vec3 vWorldDir;

    float sampleCumulus(vec2 p, vec2 drift, float detail) {
      vec4 macro = texture2D(uCloudTex, p * 0.32 + drift * 0.30);
      vec4 med = texture2D(uCloudTex, p * 0.78 + drift);
      // Big sculpted cumulus banks (~50% sky cover) with bold crisp clear-cobalt sky openings
      float coverage = macro.b * 0.56 + med.r * 0.68 - 0.43;
      float erode = (1.0 - med.g) * mix(0.12, 0.28, detail);
      float fine = detail > 0.45 ? (texture2D(uCloudTex, p * 1.95 - drift * 0.45).g - 0.5) * 0.17 * detail : 0.0;
      float crisp = detail > 0.75 ? (texture2D(uCloudTex, p * 3.65 + drift * 0.65).r - 0.5) * 0.09 : 0.0;
      return smoothstep(0.025, 0.22, coverage - erode + fine + crisp);
    }

    void main() {
      vec3 dir = normalize(vWorldDir);
      float elev = dir.y;
      float sunDot = max(0.0, dot(dir, uSunDir));

      // Below horizon ground bounce
      if (elev < -0.05) {
        vec3 groundCol = mix(vec3(0.30, 0.36, 0.42), vec3(0.10, 0.12, 0.14), smoothstep(-0.05, -0.42, elev));
        gl_FragColor = vec4(groundCol, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
        return;
      }

      // 1. Physically-inspired Rayleigh + Mie Atmospheric Scattering (Linear HDR)
      float tElev = clamp(elev, 0.0, 1.0);
      float horizonPow = pow(1.0 - tElev, 3.1);
      float midSkyPow = pow(1.0 - tElev, 1.38);

      vec3 zenithCol = vec3(0.016, 0.078, 0.235);   // Deep rich alpine cobalt overhead
      vec3 midSkyCol = vec3(0.088, 0.235, 0.462);   // Crisp alpine cerulean sky
      vec3 horizonCol = vec3(0.58, 0.70, 0.81);     // Luminous misty blue-white horizon
      vec3 sunHorizonTint = vec3(0.98, 0.92, 0.82); // Warm golden moisture scattering toward sun

      vec3 sky = mix(zenithCol, midSkyCol, midSkyPow);
      sky = mix(sky, horizonCol, horizonPow);

      // Mie forward scattering aureole + crisp solar disc
      float mieWide = pow(sunDot, 5.2) * 0.32;
      float mieTight = pow(sunDot, 38.0) * 0.66;
      float sunCorona = pow(sunDot, 280.0) * 1.55;
      float sunDisc = smoothstep(0.99938, 0.99978, sunDot) * 6.5;

      sky = mix(sky, sunHorizonTint, clamp(pow(sunDot, 2.2) * horizonPow * 0.56 + mieWide * 0.44, 0.0, 0.84));
      sky += vec3(1.0, 0.92, 0.76) * (mieWide * 0.38 + mieTight * 0.70);

      // 2. High-Altitude Cirrus Wisps + Volumetric-Lit Cumulus Cloud Deck (isotropic curved dome -> zero stretching!)
      float cloudSunOccl = 0.0;
      if (uCloudEnabled > 0.5 && elev > 0.005) {
        float horizonFade = smoothstep(0.015, 0.14, elev);
        vec2 drift = vec2(uTime * 0.0040, uTime * 0.0014);

        // Layer A: Delicate high wispy Cirrus streaks
        if (uCloudDetail > 0.65) {
          vec2 cirUv = dir.xz / (elev + 0.34) * vec2(0.24, 0.34) + drift * 0.25;
          float cirMask = texture2D(uCloudTex, cirUv).a;
          float cirVal = smoothstep(0.58, 0.86, cirMask) * horizonFade * (1.0 - smoothstep(0.75, 0.98, elev)) * 0.24;
          vec3 cirCol = mix(vec3(0.80, 0.86, 0.93), vec3(1.22, 1.16, 1.06), pow(sunDot, 2.4));
          sky = mix(sky, cirCol, cirVal);
        }

        // Layer B: Sculpted 3D-shaded Cumulus deck (higher dome offset 0.26 prevents low-elevation radial smear!)
        vec2 cloudP = dir.xz / (elev + 0.26) * 0.34;
        float density = sampleCumulus(cloudP, drift, uCloudDetail) * horizonFade;
        cloudSunOccl = density;

        if (density > 0.004) {
          // 2-step directional light march toward sun for dramatic bright billowing tops vs cool slate bellies
          vec2 sunPlane = normalize(uSunDir.xz + vec2(0.0001, 0.0)) * 0.072;
          float dSun1 = sampleCumulus(cloudP + sunPlane, drift, uCloudDetail * 0.65);
          float dSun2 = uCloudDetail > 0.35 ? sampleCumulus(cloudP + sunPlane * 2.5, drift, 0.25) : dSun1;
          float optDepth = (dSun1 * 0.60 + dSun2 * 0.40) * 2.05;
          float lightTrans = exp(-optDepth * 2.05);
          // Powder effect accentuates crisp billowing cauliflower edges
          float powder = mix(0.60, 1.08, 1.0 - exp(-density * 4.5));
          // Henyey-Greenstein forward scattering -> crisp glowing silver lining near sun
          float silverLining = pow(sunDot, 9.5) * (1.0 - density * 0.42) * 1.45 + pow(sunDot, 2.8) * 0.30;

          vec3 cloudLitCol = vec3(1.56, 1.50, 1.42) * (lightTrans * powder + silverLining * 0.60);
          vec3 cloudShadowCol = mix(vec3(0.14, 0.21, 0.31), vec3(0.34, 0.43, 0.54), clamp(elev * 1.0 + 0.16, 0.0, 1.0));
          vec3 cloudRgb = mix(cloudShadowCol, cloudLitCol, clamp(lightTrans * 0.88 + 0.12, 0.0, 1.0));
          // Blend distant clouds smoothly into atmospheric horizon haze
          cloudRgb = mix(horizonCol * 1.06, cloudRgb, smoothstep(0.015, 0.20, elev));

          float cloudAlpha = clamp(density * 0.97, 0.0, 0.98);
          sky = mix(sky, cloudRgb, cloudAlpha);
        }
      }

      // Crisp solar disc + corona softly attenuated when thick cumulus passes over it
      float sunThroughCloud = 1.0 - cloudSunOccl * 0.58;
      sky += vec3(1.0, 0.96, 0.86) * (sunCorona * sunThroughCloud + sunDisc * (0.48 + 0.52 * sunThroughCloud));

      gl_FragColor = vec4(sky, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  mat.customProgramCacheKey = () => "mil_sky_dome_main";
  return mat;
}

// Fast 128x64 equirectangular canvas sky matching our v5 alpine sky so Three.js r128 PMREMGenerator receives proper MeshBasicMaterial RGBE encoding!
function buildPmremSkyCanvasTexture(THREE, sunDir) {
  const w = 128;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let py = 0; py < h; py++) {
    const v = py / (h - 1);
    const phi = v * Math.PI;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    for (let px = 0; px < w; px++) {
      const u = px / w;
      const theta = u * Math.PI * 2;
      const dx = -Math.cos(theta) * sinP;
      const dy = cosP;
      const dz = Math.sin(theta) * sinP;
      const idx = (py * w + px) * 4;
      if (dy < -0.02) {
        const gFade = clamp((-dy - 0.02) * 3.0, 0, 1);
        d[idx] = Math.round(92 * (1 - gFade) + 42 * gFade);
        d[idx + 1] = Math.round(96 * (1 - gFade) + 46 * gFade);
        d[idx + 2] = Math.round(88 * (1 - gFade) + 38 * gFade);
        d[idx + 3] = 255;
        continue;
      }
      const sunDot = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);
      const mie = Math.pow(sunDot, 4.5) * 0.32 + Math.pow(sunDot, 32.0) * 0.65;
      const hMix = Math.pow(1 - clamp(dy, 0, 1), 2.5);
      const cld = smoothstep(0.46, 0.72, periodicValueNoise(u * 6, v * 4, 6, 43)) * smoothstep(0.05, 0.25, dy);
      let r = 0.20 + 0.56 * hMix + mie * 0.45;
      let g = 0.36 + 0.46 * hMix + mie * 0.36;
      let b = 0.58 + 0.29 * hMix + mie * 0.18;
      r = r * (1 - cld * 0.55) + (0.86 + mie * 0.18) * (cld * 0.55);
      g = g * (1 - cld * 0.55) + (0.88 + mie * 0.14) * (cld * 0.55);
      b = b * (1 - cld * 0.55) + (0.90 + mie * 0.08) * (cld * 0.55);
      d[idx] = clamp(Math.round(r * 255), 0, 255);
      d[idx + 1] = clamp(Math.round(g * 255), 0, 255);
      d[idx + 2] = clamp(Math.round(b * 255), 0, 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  return tex;
}

export async function buildMilitarySkySystemAsync(renderer, THREE, sunPos, yieldFn) {
  const sunDir = new THREE.Vector3(sunPos.x, sunPos.y, sunPos.z).normalize();
  const cloudNoiseTex = await buildCloudNoiseTextureAsync(THREE, yieldFn);
  if (yieldFn) await yieldFn();

  const skyMat = createSkyShaderMaterial(THREE, cloudNoiseTex, sunDir);
  // Radius 10 sphere placed at infinite depth (z = w * 0.99999) centered on camera rotation -> never clips!
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(10.0, 40, 22), skyMat);
  skyMesh.name = "military_sky_dome";
  skyMesh.frustumCulled = false;

  // Build matching PMREM environment map via standard MeshBasicMaterial (guarantees valid RGBE encoding in Three.js r128!)
  const es = new THREE.Scene();
  const pmremTex = buildPmremSkyCanvasTexture(THREE, sunDir);
  const pmremMat = new THREE.MeshBasicMaterial({ map: pmremTex, side: THREE.BackSide, toneMapped: false });
  const pmremSphere = new THREE.Mesh(new THREE.SphereGeometry(28, 28, 14), pmremMat);
  const sunBounce = new THREE.Mesh(
    new THREE.SphereGeometry(3.4, 12, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.15, 1.78, 1.35), toneMapped: false }),
  );
  sunBounce.position.copy(sunDir).multiplyScalar(24);
  es.add(pmremSphere, sunBounce);

  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(es, 0.032);
  pm.dispose();
  pmremSphere.geometry.dispose();
  pmremMat.dispose();
  pmremTex.dispose();
  sunBounce.geometry.dispose();
  sunBounce.material.dispose();

  if (yieldFn) await yieldFn();

  return {
    skyMesh,
    skyUniforms: skyMat.uniforms,
    envMap: rt.texture,
    cloudNoiseTex,
  };
}

// ---------- Pillar 1B: Mountain-Pass Crepuscular God Rays, Sun Corona & Airborne Dust ----------

export function buildMilitaryGodRaysAndDust(THREE, sunPos) {
  const sunDir = new THREE.Vector3(sunPos.x, sunPos.y, sunPos.z).normalize();

  // Merge 5 delicate, broad diagonal crepuscular sunbeams nestled over the misty West valley pass -> 1 draw call!
  const beamSpecs = [
    // [x, y, z, width, length, yawOffset, intensity]
    [-82, 26, -32, 24, 86, 0.14, 0.72],
    [-92, 29, -8, 28, 94, 0.04, 0.95],
    [-96, 30, 16, 26, 92, -0.08, 0.85],
    [-80, 24, 38, 22, 82, -0.18, 0.65],
    [-64, 24, 0, 20, 74, 0.25, 0.45],
  ];

  const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir);
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const rotY = new THREE.Quaternion();
  const upVec = new THREE.Vector3(0, 1, 0);
  const posList = [];
  const nrmList = [];
  const uvList = [];
  const intList = [];
  const idxList = [];
  let vBase = 0;

  for (const [bx, by, bz, bw, bl, yawOff, inten] of beamSpecs) {
    const plane = new THREE.PlaneGeometry(bw, bl, 1, 1);
    rotY.setFromAxisAngle(upVec, yawOff);
    tmpQ.copy(alignQ).multiply(rotY);
    tmpM.compose(new THREE.Vector3(bx, by, bz), tmpQ, new THREE.Vector3(1, 1, 1));
    plane.applyMatrix4(tmpM);

    const p = plane.attributes.position;
    const n = plane.attributes.normal;
    const u = plane.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      posList.push(p.getX(i), p.getY(i), p.getZ(i));
      nrmList.push(n.getX(i), n.getY(i), n.getZ(i));
      uvList.push(u.getX(i), u.getY(i));
      intList.push(inten);
    }
    const gi = plane.index.array;
    for (let k = 0; k < gi.length; k++) idxList.push(gi[k] + vBase);
    vBase += p.count;
    plane.dispose();
  }

  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute("position", new THREE.Float32BufferAttribute(posList, 3));
  beamGeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrmList, 3));
  beamGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvList, 2));
  beamGeo.setAttribute("aBeamInt", new THREE.Float32BufferAttribute(intList, 1));
  beamGeo.setIndex(idxList);

  const beamMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0.0 },
      uOpacity: { value: 0.15 },
    },
    vertexShader: `
      attribute float aBeamInt;
      varying vec2 vUv;
      varying float vInt;
      varying vec3 vRayNormal;
      varying vec3 vRayViewDir;
      void main() {
        vUv = uv;
        vInt = aBeamInt;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vRayNormal = normalize(normalMatrix * normal);
        vRayViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vInt;
      varying vec3 vRayNormal;
      varying vec3 vRayViewDir;
      void main() {
        float horiz = sin(vUv.x * 3.14159265);
        horiz = pow(max(0.0, horiz), 2.35);
        float vert = smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.54, 1.0, vUv.y));
        float stria = 0.68 + 0.32 * sin(vUv.x * 16.0 + uTime * 0.12) * cos(vUv.x * 8.0 - 0.5);
        float facing = pow(abs(dot(normalize(vRayNormal), normalize(vRayViewDir))), 1.35);
        float alpha = horiz * vert * stria * facing * vInt * uOpacity;
        vec3 col = mix(vec3(0.86, 0.90, 0.95), vec3(1.0, 0.94, 0.80), vUv.y);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  beamMat.customProgramCacheKey = () => "mil_godray_plane";

  const shaftGroup = new THREE.Mesh(beamGeo, beamMat);
  shaftGroup.name = "military_god_ray_shafts";
  shaftGroup.renderOrder = 5;
  shaftGroup.matrixAutoUpdate = false;
  shaftGroup.updateMatrix();

  const rayGroup = new THREE.Group();
  rayGroup.name = "military_god_rays";
  rayGroup.add(shaftGroup);

  // Subtle sun corona sprite positioned cleanly on sky dome along sunDir
  const flareCanvas = document.createElement("canvas");
  flareCanvas.width = flareCanvas.height = 128;
  const fg = flareCanvas.getContext("2d");
  const fGrad = fg.createRadialGradient(64, 64, 1, 64, 64, 62);
  fGrad.addColorStop(0.0, "rgba(255, 250, 234, 0.80)");
  fGrad.addColorStop(0.16, "rgba(255, 232, 186, 0.34)");
  fGrad.addColorStop(0.48, "rgba(255, 210, 152, 0.09)");
  fGrad.addColorStop(1.0, "rgba(255, 195, 130, 0.0)");
  fg.fillStyle = fGrad;
  fg.fillRect(0, 0, 128, 128);
  const flareTex = new THREE.CanvasTexture(flareCanvas);
  const sunFlare = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: flareTex,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }),
  );
  sunFlare.position.copy(sunDir).multiplyScalar(320);
  sunFlare.scale.set(40, 40, 1);
  sunFlare.name = "military_sun_flare";
  rayGroup.add(sunFlare);

  // Airborne wind-swept dust motes inside the base (140 particles)
  const N = 140;
  const posArr = new Float32Array(N * 3);
  const baseArr = new Float32Array(N * 3);
  let s = 918273;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const x = (rnd() - 0.5) * 64;
    const y = 0.35 + rnd() * 7.5;
    const z = (rnd() - 0.5) * 80;
    posArr[i * 3] = baseArr[i * 3] = x;
    posArr[i * 3 + 1] = baseArr[i * 3 + 1] = y;
    posArr[i * 3 + 2] = baseArr[i * 3 + 2] = z;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0xe0d2bc,
    size: 0.075,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  dustPoints.name = "military_dust_motes";

  return {
    rayGroup,
    shaftGroup,
    beamUniforms: beamMat.uniforms,
    sunFlare,
    flareTex,
    dustPoints,
    update(tSec) {
      beamMat.uniforms.uTime.value = tSec;
      if (!dustPoints.visible) return;
      const p = dustGeo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        const driftX = ((baseArr[i * 3] + tSec * 0.55 + 32) % 64 + 64) % 64 - 32;
        p[i * 3] = driftX + Math.sin(tSec * 0.65 + i) * 0.35;
        p[i * 3 + 1] = baseArr[i * 3 + 1] + Math.cos(tSec * 0.42 + i * 0.7) * 0.22;
      }
      dustGeo.attributes.position.needsUpdate = true;
    },
  };
}

// ---------- Pillar 2: 3-Layer Eroded Sculpted Mountain Basin + Slope/Altitude PBR Shader ----------

function buildPolarTerrainGeometry(THREE, radialStops, angSegs, bounds, sunDir, innerSquareBlend = false, skirtFirstRingDrop = 0) {
  const ringCount = radialStops.length;
  const cols = angSegs + 1;
  const vertCount = ringCount * cols;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const terrainData = new Float32Array(vertCount * 3); // (sunVis, gullyAO, slope)
  const indices = new Uint16Array((ringCount - 1) * angSegs * 6);

  const halfX = bounds.maxX - 0.8;
  const halfZ = bounds.maxZ - 0.8;

  for (let ri = 0; ri < ringCount; ri++) {
    const rTarget = radialStops[ri];
    // For the innermost rings, morph smoothly from the rectangular wall footprint into a circle so corners have zero gap!
    const rectFactor = innerSquareBlend ? 1.0 - smoothstep(0, 4, ri) : 0.0;
    const skirtDrop = ri === 0 ? skirtFirstRingDrop : 0.0;

    for (let ai = 0; ai < cols; ai++) {
      const aNorm = ai / angSegs;
      const ang = aNorm * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);

      // Ray-rectangle intersection at wall perimeter for seamless join under the concrete walls
      const scaleX = Math.abs(cs) > 1e-5 ? halfX / Math.abs(cs) : 1e6;
      const scaleZ = Math.abs(sn) > 1e-5 ? halfZ / Math.abs(sn) : 1e6;
      const rRect = Math.min(scaleX, scaleZ);
      const r = rRect * rectFactor + Math.max(rRect, rTarget) * (1.0 - rectFactor);

      const x = cs * r;
      const z = sn * r;
      const y = sampleMilitaryTerrainHeight(x, z, bounds) + skirtDrop;
      const { nx, ny, nz, slope } = sampleTerrainNormalAndSlope(x, z, r > 130 ? 3.2 : 1.8, bounds);

      // Compute local concavity / gully AO from 4-neighbor average height
      const e = r > 140 ? 6.5 : 3.5;
      const avgN =
        0.25 *
        (sampleMilitaryTerrainHeight(x + e, z, bounds) +
          sampleMilitaryTerrainHeight(x - e, z, bounds) +
          sampleMilitaryTerrainHeight(x, z + e, bounds) +
          sampleMilitaryTerrainHeight(x, z - e, bounds));
      const gullyAO = clamp(0.88 + (y - avgN) * 0.045, 0.46, 1.12);
      const sunVis = y > 0.3 ? computeTerrainSunOcclusion(x, y, z, sunDir, bounds) : 1.0;

      const vi = ri * cols + ai;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
      uvs[vi * 2] = x * 0.04;
      uvs[vi * 2 + 1] = z * 0.04;
      terrainData[vi * 3] = sunVis;
      terrainData[vi * 3 + 1] = gullyAO;
      terrainData[vi * 3 + 2] = slope;
    }
  }

  let ptr = 0;
  for (let ri = 0; ri < ringCount - 1; ri++) {
    for (let ai = 0; ai < angSegs; ai++) {
      const a = ri * cols + ai;
      const b = a + 1;
      const c = (ri + 1) * cols + ai;
      const d = c + 1;
      // Counter-clockwise upward-facing winding
      indices[ptr++] = a;
      indices[ptr++] = b;
      indices[ptr++] = c;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aTerrainData", new THREE.BufferAttribute(terrainData, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

export async function buildMilitaryTerrainSystemAsync(THREE, bounds, sunPos, fogUniforms, yieldFn) {
  const sunDir = new THREE.Vector3(sunPos.x, sunPos.y, sunPos.z).normalize();
  const detailTex = await buildTerrainDetailTexturesAsync(THREE, yieldFn);
  if (yieldFn) await yieldFn();

  // Ring 1 + Ring 2 unified seamless sculpted foothills & eroded mountain range (20 radial × 104 angular = 4,160 tris, 1 draw call!)
  const midRadialStops = [
    34.0, 38.5, 44.5, 52.0, 61.0, 71.5, 83.5, 97.0, 111.5, 126.5,
    141.5, 156.5, 171.5, 186.0, 200.0, 213.0, 225.0, 236.0, 245.0, 251.0, 256.0,
  ];
  const midGeo = buildPolarTerrainGeometry(THREE, midRadialStops, 104, bounds, sunDir, true, 0);
  if (yieldFn) await yieldFn();

  // Ring 3 distant alpine massif silhouettes (6 radial × 76 angular = 912 tris, 1 draw call; skirt drops -8m to avoid Z-fighting!)
  const farRadialStops = [245.0, 266.0, 290.0, 316.0, 342.0, 366.0, 388.0];
  const farGeo = buildPolarTerrainGeometry(THREE, farRadialStops, 76, bounds, sunDir, false, -8.0);
  if (yieldFn) await yieldFn();

  const toLinear = (hex) => {
    const c = new THREE.Color(hex);
    if (typeof c.convertSRGBToLinear === "function") c.convertSRGBToLinear();
    return c;
  };

  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uDetailTex: { value: detailTex },
      uFogHorizon: { value: toLinear(0x9eb6cb) },
      uFogFarPeak: { value: toLinear(0xc5d6e4) },
      uFogSunTint: { value: toLinear(0xf2e6d0) },
      uValleyMistCol: { value: toLinear(0xd6e2ea) },
      uMilPostGrade: fogUniforms.uMilPostGrade,
      uHazeScale: { value: 1.0 },
    },
    vertexShader: `
      attribute vec3 aTerrainData;
      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;
      varying vec3 vTerrainData;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNrm = normalize(mat3(modelMatrix) * normal);
        vTerrainData = aTerrainData;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform sampler2D uDetailTex;
      uniform vec3 uFogHorizon;
      uniform vec3 uFogFarPeak;
      uniform vec3 uFogSunTint;
      uniform vec3 uValleyMistCol;
      uniform float uMilPostGrade;
      uniform float uHazeScale;

      varying vec3 vWorldPos;
      varying vec3 vWorldNrm;
      varying vec3 vTerrainData;

      void main() {
        vec2 wpXZ = vWorldPos.xz;
        float elev = vWorldPos.y;
        // Tri-planar-like multi-scale rock strata (combines XZ + elevation Y so steep cliffs show crisp diagonal geological bands!)
        vec4 detMacro = texture2D(uDetailTex, wpXZ * 0.0115 + vec2(elev * 0.008, -elev * 0.006));
        vec4 detMicro = texture2D(uDetailTex, wpXZ * 0.048 + vec2(elev * 0.022, elev * 0.016));
        vec4 detFine = texture2D(uDetailTex, wpXZ * 0.145 - vec2(elev * 0.035, 0.44));

        // Analytical radial couloir / erosion rib contrast so even backlit slopes show crisp craggy alpine ravines!
        float angW = atan(wpXZ.y, wpXZ.x);
        float erodRib = sin(angW * 68.0 + detMacro.b * 5.2 + elev * 0.09) * 0.65 +
                        sin(angW * 124.0 - detMicro.b * 4.4 - elev * 0.14) * 0.35;
        float cragCrevice = smoothstep(-0.72, 0.72, erodRib);
        float strata = clamp(detMacro.b * 0.42 + detMicro.b * 0.34 + cragCrevice * 0.32, 0.0, 1.0);
        float mottle = detMacro.a * 0.50 + detMicro.a * 0.34 + detFine.a * 0.16;

        // Strong craggy normal perturbation so raking sunlight & sky fill carve dramatic sunlit spurs vs dark ravines!
        vec2 nOff = (detMicro.rg - 0.5) * 1.65 + (detFine.rg - 0.5) * 0.85 + vec2(erodRib * 0.48, (detMacro.r - 0.5) * 0.65);
        float baseSlope = clamp(1.0 - vWorldNrm.y, 0.0, 1.0);
        float rockMask = clamp(
          smoothstep(0.16, 0.35, baseSlope + (strata - 0.5) * 0.20) +
          smoothstep(22.0, 40.0, elev + (mottle - 0.5) * 12.0),
          0.0,
          1.0
        );
        float reliefAmp = mix(0.45, 1.45, rockMask);
        vec3 N = normalize(vWorldNrm + vec3(nOff.x * reliefAmp, 0.0, nOff.y * reliefAmp));

        // 1. Multi-biome slope & elevation material splatting (Linear RGB — deep craggy granite & lush pine valleys!)
        vec3 grassSun = vec3(0.098, 0.125, 0.045);
        vec3 grassOlive = vec3(0.046, 0.072, 0.028);
        vec3 earthDirt = vec3(0.112, 0.090, 0.058);
        vec3 meadowCol = mix(grassOlive, grassSun, smoothstep(0.28, 0.76, mottle));
        float wallEdgeDirt = (1.0 - smoothstep(38.0, 62.0, max(abs(wpXZ.x), abs(wpXZ.y) * 0.8))) * (0.45 + 0.55 * detMicro.b);
        meadowCol = mix(meadowCol, earthDirt, clamp(wallEdgeDirt * 0.52 + smoothstep(0.68, 0.88, detMacro.b) * 0.30, 0.0, 0.65));

        // Dark alpine pine forest floor understory (blends seamlessly beneath 680 pine clusters)
        vec3 forestDark = vec3(0.012, 0.032, 0.016);
        vec3 forestMid = vec3(0.032, 0.058, 0.026);
        vec3 forestCol = mix(forestDark, forestMid, mottle);
        float forestBelt = smoothstep(2.0, 10.0, elev) * (1.0 - smoothstep(23.0, 38.0, elev));
        vec3 vegCol = mix(meadowCol, forestCol, forestBelt * 0.86);

        // Craggy weathered dark slate/granite cliffs with dark crevices & weathered sunlit scree ribs
        vec3 rockCrevice = vec3(0.012, 0.017, 0.024);
        vec3 rockMid = vec3(0.052, 0.058, 0.064);
        vec3 rockRidge = vec3(0.145, 0.148, 0.144);
        vec3 rockCol = mix(rockCrevice, rockMid, smoothstep(0.16, 0.66, strata));
        rockCol = mix(rockCol, rockRidge, smoothstep(0.64, 0.92, strata) * 0.72 + smoothstep(30.0, 72.0, elev) * 0.32 * detMacro.b);

        vec3 albedo = mix(vegCol, rockCol, rockMask);

        // 2. Crisp Directional Sun + Grazing Rim Highlight on Eroded Spurs + Baked Horizon Shadow Occlusion + Alpine Sky Fill
        float sunVis = vTerrainData.x;
        float gullyAO = vTerrainData.y * mix(0.56, 1.18, cragCrevice);
        float ndl = max(0.0, dot(N, uSunDir));
        float direct = (pow(ndl, 0.88) * 0.92 + smoothstep(-0.24, 0.34, dot(N, uSunDir)) * 0.16) * sunVis;
        vec3 sunLight = vec3(2.55, 2.22, 1.76) * direct;
        vec3 skyFill = mix(vec3(0.055, 0.092, 0.155), vec3(0.165, 0.245, 0.375), N.y * 0.5 + 0.5) * gullyAO;
        vec3 lit = albedo * (sunLight + skyFill);

        // 3. Layered Atmospheric Perspective (Crisp dark near/mid crags -> cool alpine slate-blue mid -> pale misty far Alps!)
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 viewDir = -toCam / max(dist, 0.001);
        float sunScatter = pow(max(0.0, dot(viewDir, uSunDir)), 4.0);

        float distHaze = 1.0 - exp(-max(0.0, dist - 112.0) * 0.0029 * uHazeScale);
        float heightAtten = mix(1.0, 0.74, smoothstep(14.0, 82.0, elev));
        float aerialAmt = clamp(distHaze * heightAtten, 0.0, 0.74);

        vec3 aerialCol = mix(uFogHorizon, uFogFarPeak, smoothstep(175.0, 325.0, dist));
        aerialCol = mix(aerialCol, uFogSunTint, sunScatter * 0.32);
        lit = mix(lit, aerialCol, aerialAmt);

        // Luminous low valley mist pooling behind the base & inside deep mountain valley basins (elev < 20m)
        float valleyBand = exp(-max(0.0, elev - 0.5) * 0.082);
        float valleyDist = smoothstep(58.0, 155.0, dist) * (1.0 - smoothstep(265.0, 365.0, dist) * 0.35);
        float valleyMist = clamp(valleyBand * valleyDist * (0.42 + sunScatter * 0.38) * uHazeScale, 0.0, 0.68);
        vec3 mistCol = mix(uValleyMistCol, uFogSunTint, sunScatter * 0.42);
        lit = mix(lit, mistCol, valleyMist);

        if (uMilPostGrade > 0.5) {
          float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));
          lit = mix(vec3(lum), lit, 1.07);
          lit = max(vec3(0.0), (lit - 0.14) * 1.06 + 0.14);
        }

        gl_FragColor = vec4(lit, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }
    `,
    side: THREE.FrontSide,
    fog: false,
  });
  terrainMat.customProgramCacheKey = () => "mil_hfog_terrain";

  const midTerrainMesh = new THREE.Mesh(midGeo, terrainMat);
  midTerrainMesh.name = "military_sculpted_mountains";
  midTerrainMesh.matrixAutoUpdate = false;
  midTerrainMesh.updateMatrix();

  const farAlpsMesh = new THREE.Mesh(farGeo, terrainMat);
  farAlpsMesh.name = "military_far_alpine_peaks";
  farAlpsMesh.matrixAutoUpdate = false;
  farAlpsMesh.updateMatrix();

  return {
    midTerrainMesh,
    farAlpsMesh,
    terrainUniforms: terrainMat.uniforms,
    detailTex,
  };
}

// ---------- Pillar 3: Dense Foothill/Slope Forest & Natural Perimeter Transition ----------

function fixAlphaBleed(ctx, w, h, fillR, fillG, fillB) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] < 22) {
      d[i * 4] = fillR;
      d[i * 4 + 1] = fillG;
      d[i * 4 + 2] = fillB;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function mergeStaticParts(THREE, parts, withColor = false) {
  let totalV = 0;
  let totalI = 0;
  for (const g of parts) {
    totalV += g.attributes.position.count;
    totalI += g.index.count;
  }
  const pArr = new Float32Array(totalV * 3);
  const nArr = new Float32Array(totalV * 3);
  const uArr = new Float32Array(totalV * 2);
  const cArr = withColor ? new Float32Array(totalV * 3) : null;
  const iArr = new Uint16Array(totalI);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    pArr.set(g.attributes.position.array, vo * 3);
    nArr.set(g.attributes.normal.array, vo * 3);
    uArr.set(g.attributes.uv.array, vo * 2);
    if (withColor && g.attributes.color) cArr.set(g.attributes.color.array, vo * 3);
    const idx = g.index.array;
    for (let k = 0; k < idx.length; k++) iArr[io + k] = idx[k] + vo;
    vo += g.attributes.position.count;
    io += idx.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pArr, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nArr, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uArr, 2));
  if (withColor) out.setAttribute("color", new THREE.BufferAttribute(cArr, 3));
  out.setIndex(new THREE.BufferAttribute(iArr, 1));
  return out;
}

function buildBroadleafCardTex(THREE) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 256, 256);
  let ls = 882211;
  const lrnd = () => ((ls = (ls * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = "#3c3326";
  g.lineWidth = 3.2;
  for (let t = 0; t < 7; t++) {
    const ang = (t / 7) * Math.PI * 2 + (lrnd() - 0.5) * 0.4;
    g.beginPath();
    g.moveTo(128, 134);
    g.lineTo(128 + Math.cos(ang) * (54 + lrnd() * 38), 128 + Math.sin(ang) * (54 + lrnd() * 38));
    g.stroke();
  }
  const shades = ["#2d3922", "#374629", "#425130", "#4f5c35", "#5f6339", "#6c673d", "#24301c"];
  for (let k = 0; k < 250; k++) {
    const rDist = Math.pow(lrnd(), 0.62) * 96;
    const theta = lrnd() * Math.PI * 2;
    const lx = 128 + Math.cos(theta) * rDist;
    const ly = 128 + Math.sin(theta) * rDist;
    const wLeaf = 7.5 + lrnd() * 8.5;
    const hLeaf = 3.4 + lrnd() * 3.8;
    const rot = theta + (lrnd() - 0.5) * 1.4;
    const isOuterTop = ly < 118 && rDist > 34;
    const idx = isOuterTop ? Math.min(5, Math.floor(2 + lrnd() * 4)) : Math.floor(lrnd() * 5);
    g.save();
    g.translate(lx, ly);
    g.rotate(rot);
    g.fillStyle = shades[idx];
    g.beginPath();
    g.moveTo(-wLeaf, 0);
    g.quadraticCurveTo(0, -hLeaf * 1.35, wLeaf, 0);
    g.quadraticCurveTo(0, hLeaf * 1.35, -wLeaf, 0);
    g.fill();
    g.restore();
  }
  fixAlphaBleed(g, 256, 256, 56, 70, 42);
  const t = new THREE.CanvasTexture(c);
  if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
  return t;
}

function buildPineBoughCardTex(THREE) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 256, 256);
  let ps = 553319;
  const prnd = () => ((ps = (ps * 16807) % 2147483647) / 2147483647);
  const pineCols = ["#1b2b1a", "#233621", "#2c4128", "#364d2f", "#162415", "#435835"];
  // Dense overlapping evergreen conifer branch fan
  for (let b = 0; b < 11; b++) {
    const bAng = (b / 11) * Math.PI * 2 + (prnd() - 0.5) * 0.25;
    const bLen = 84 + prnd() * 32;
    g.strokeStyle = "#33291e";
    g.lineWidth = 3.0;
    g.beginPath();
    g.moveTo(128, 128);
    g.lineTo(128 + Math.cos(bAng) * bLen, 128 + Math.sin(bAng) * bLen);
    g.stroke();
    for (let n = 0; n < 44; n++) {
      const frac = 0.10 + (n / 44) * 0.90;
      const bx = 128 + Math.cos(bAng) * bLen * frac;
      const by = 128 + Math.sin(bAng) * bLen * frac;
      const side = n % 2 === 0 ? 1 : -1;
      const nAng = bAng + side * (0.45 + prnd() * 0.62);
      const nLen = (16 + prnd() * 16) * (1.2 - frac * 0.42);
      g.strokeStyle = pineCols[Math.floor(prnd() * pineCols.length)];
      g.lineWidth = 2.8 + prnd() * 1.8;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(nAng) * nLen, by + Math.sin(nAng) * nLen);
      g.stroke();
    }
  }
  fixAlphaBleed(g, 256, 256, 36, 52, 32);
  const t = new THREE.CanvasTexture(c);
  if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
  return t;
}

/**
 * Multi-tree alpine spruce/pine cluster silhouette texture for crossed-billboard slope forest (1 card = 3 staggered pines!).
 * Eliminates isolated single-cone look and doubles visual forest richness at 0 extra draw calls or triangles.
 */
function buildFullConiferBillboardTex(THREE) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 256, 256);
  let s = 771129;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  const darkShades = ["#121f13", "#182818", "#1f321e"];
  const midShades = ["#253a23", "#2d452a", "#354e2f"];
  const litShades = ["#3f5935", "#4a643c"];

  const drawSpruce = (cxCenter, baseY, topY, maxSpan) => {
    // Trunk
    g.fillStyle = "#2b221a";
    g.beginPath();
    g.moveTo(cxCenter - 5, baseY);
    g.lineTo(cxCenter + 5, baseY);
    g.lineTo(cxCenter + 2, topY + 26);
    g.lineTo(cxCenter - 2, topY + 26);
    g.closePath();
    g.fill();

    const height = baseY - topY;
    const tiers = 13;
    for (let tier = 0; tier < tiers; tier++) {
      const t = tier / (tiers - 1);
      const yBase = baseY - 12 - t * (height - 18);
      const halfSpan = (1.0 - Math.pow(t, 1.15)) * maxSpan + 6;
      const tufts = Math.max(4, Math.round((1.0 - t * 0.58) * 14));
      for (let k = 0; k < tufts; k++) {
        const u = tufts === 1 ? 0 : (k / (tufts - 1)) * 2 - 1;
        const droop = Math.abs(u) * (12 * (1 - t * 0.6));
        const cx = cxCenter + u * halfSpan + (rnd() - 0.5) * 9;
        const cy = yBase + droop + (rnd() - 0.5) * 6;
        const rx = (10 + rnd() * 10) * (1 - t * 0.40);
        const ry = (7 + rnd() * 7) * (1 - t * 0.36);
        const shadePick = t > 0.45 && rnd() > 0.55
          ? litShades[Math.floor(rnd() * litShades.length)]
          : (t > 0.18 && rnd() > 0.35 ? midShades[Math.floor(rnd() * midShades.length)] : darkShades[Math.floor(rnd() * darkShades.length)]);
        g.fillStyle = shadePick;
        g.beginPath();
        g.moveTo(cx - rx, cy + ry * 0.55);
        g.quadraticCurveTo(cx - rx * 0.35, cy - ry * 1.15, cx, cy - ry);
        g.quadraticCurveTo(cx + rx * 0.35, cy - ry * 1.15, cx + rx, cy + ry * 0.55);
        g.quadraticCurveTo(cx, cy + ry * 0.95, cx - rx, cy + ry * 0.55);
        g.fill();
      }
    }
    // Irregular natural spruce tip
    g.fillStyle = "#2d4429";
    g.beginPath();
    g.moveTo(cxCenter, topY);
    g.lineTo(cxCenter + 8, topY + 24);
    g.lineTo(cxCenter - 8, topY + 24);
    g.closePath();
    g.fill();
  };

  // Paint 3 organically staggered pines forming a rich miniature alpine grove per card!
  drawSpruce(72, 252, 62, 54);
  drawSpruce(184, 252, 74, 52);
  drawSpruce(128, 254, 14, 66);

  fixAlphaBleed(g, 256, 256, 28, 44, 26);
  const tex = new THREE.CanvasTexture(c);
  if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  return tex;
}

/**
 * Full-tree oak/broadleaf silhouette texture for distant broadleaf billboard LOD (>= 60m).
 */
function buildFullBroadleafBillboardTex(THREE) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 256, 256);
  let s = 612397;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  // Trunk & main fork
  g.fillStyle = "#3c3024";
  g.beginPath();
  g.moveTo(118, 254);
  g.lineTo(138, 254);
  g.lineTo(133, 140);
  g.lineTo(123, 140);
  g.closePath();
  g.fill();

  const cols = ["#2b3822", "#354428", "#435231", "#515e37", "#60683c", "#232e1b"];
  const lobes = [
    [128, 92, 68, 56],
    [82, 118, 48, 42],
    [172, 114, 48, 44],
    [128, 58, 50, 38],
  ];
  for (const [lx, ly, rx, ry] of lobes) {
    for (let k = 0; k < 44; k++) {
      const ang = rnd() * Math.PI * 2;
      const rad = Math.pow(rnd(), 0.55);
      const px = lx + Math.cos(ang) * rx * rad;
      const py = ly + Math.sin(ang) * ry * rad;
      const sz = 9 + rnd() * 14;
      const topBias = py < 105 ? Math.min(4, Math.floor(2 + rnd() * 3)) : Math.floor(rnd() * 4);
      g.fillStyle = cols[topBias];
      g.beginPath();
      g.arc(px, py, sz, 0, Math.PI * 2);
      g.fill();
    }
  }

  fixAlphaBleed(g, 256, 256, 54, 68, 42);
  const tex = new THREE.CanvasTexture(c);
  if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function makeCrossedFullTreeGeo(THREE, width = 1.0, height = 1.0, baseAo = 0.48) {
  const planes = [];
  for (let k = 0; k < 2; k++) {
    const p = new THREE.PlaneGeometry(width, height);
    p.rotateY(k * Math.PI * 0.5);
    p.translate(0, height * 0.5, 0);
    const cp = p.attributes.position;
    const cn = p.attributes.normal;
    const vc = new Float32Array(cp.count * 3);
    for (let vi = 0; vi < cp.count; vi++) {
      const vx = cp.getX(vi);
      const vy = cp.getY(vi);
      const vz = cp.getZ(vi);
      const tH = clamp(vy / Math.max(0.01, height), 0, 1);
      // Upward-biased spherical canopy normals eliminate harsh white/black X-plane shading seams!
      const nLen = Math.hypot(vx * 0.28, 1.0, vz * 0.28) || 1;
      cn.setXYZ(vi, (vx * 0.28) / nLen, 1.0 / nLen, (vz * 0.28) / nLen);
      const ao = baseAo + (0.94 - baseAo) * tH;
      vc[vi * 3] = ao * 0.94;
      vc[vi * 3 + 1] = ao;
      vc[vi * 3 + 2] = ao * 0.90;
    }
    p.setAttribute("color", new THREE.BufferAttribute(vc, 3));
    planes.push(p);
  }
  return mergeStaticParts(THREE, planes, true);
}

function buildValleyMistMesh(THREE, bounds, sunPos) {
  const sunDir = new THREE.Vector3(sunPos.x, sunPos.y, sunPos.z).normalize();
  const mistSpecs = [
    // Centered in the West alpine valley pass & nestled around perimeter mountain basins
    [-92, 6, -24, 96, 30, 0.25],
    [-108, 9, 4, 118, 36, 0.05],
    [-94, 7, 30, 96, 30, -0.22],
    [-68, 4, -52, 74, 22, 0.65],
    [-68, 4, 52, 74, 22, -0.65],
    [-15, 5, -92, 88, 26, 1.45],
    [32, 6, -98, 92, 26, 1.72],
    [-18, 5, 92, 88, 26, -1.48],
    [34, 6, 98, 92, 26, -1.72],
    [96, 7, -36, 96, 28, -2.85],
    [104, 8, 12, 106, 30, 3.05],
    [88, 6, 48, 86, 26, 2.65],
  ];

  const posArr = [];
  const uvArr = [];
  const idxArr = [];
  let vBase = 0;
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  for (const [mx, yOff, mz, mw, mh, yaw] of mistSpecs) {
    const baseH = sampleMilitaryTerrainHeight(mx, mz, bounds);
    const p = new THREE.PlaneGeometry(mw, mh);
    tmpQ.setFromAxisAngle(up, yaw + Math.PI * 0.5);
    tmpM.compose(new THREE.Vector3(mx, baseH + yOff + mh * 0.25, mz), tmpQ, new THREE.Vector3(1, 1, 1));
    p.applyMatrix4(tmpM);
    const pos = p.attributes.position;
    const uv = p.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      posArr.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvArr.push(uv.getX(i), uv.getY(i));
    }
    const gi = p.index.array;
    for (let k = 0; k < gi.length; k++) idxArr.push(gi[k] + vBase);
    vBase += pos.count;
    p.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvArr, 2));
  geo.setIndex(idxArr);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uTime: { value: 0.0 },
      uOpacity: { value: 0.26 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vec2 c = (vUv - 0.5) * 2.0;
        float radial = 1.0 - dot(c, c);
        if (radial <= 0.0) discard;
        float soft = pow(radial, 1.85);
        // Subtle drifting billowy wave in mist layer
        float wave = 0.80 + 0.20 * sin(vUv.x * 7.5 + uTime * 0.16) * cos(vUv.y * 5.0 - uTime * 0.10);
        vec3 viewDir = normalize(vWorldPos - cameraPosition);
        float sunScatter = pow(max(0.0, dot(viewDir, uSunDir)), 3.0);
        vec3 col = mix(vec3(0.68, 0.77, 0.85), vec3(0.95, 0.90, 0.80), sunScatter * 0.52);
        gl_FragColor = vec4(col, soft * wave * uOpacity);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  mat.customProgramCacheKey = () => "mil_valley_mist";

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "military_valley_mist";
  mesh.renderOrder = 3;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return { mesh, mistUniforms: mat.uniforms };
}

export async function buildMilitaryEnvironmentGroupAsync({
  THREE,
  layout,
  sunPos,
  envMap,
  fogUniforms,
  windUniform,
  windScaleUniform,
  applyMilitaryHeightFog,
  yieldFn,
}) {
  const bounds = layout.bounds || MILITARY_BOUNDS_DEFAULT;
  const bgGroup = new THREE.Group();
  bgGroup.name = "military_background_horizon";
  bgGroup.matrixAutoUpdate = false;

  // 1. Sculpted 3-Layer Eroded Mountain Terrain
  const terrainSys = await buildMilitaryTerrainSystemAsync(THREE, bounds, sunPos, fogUniforms, yieldFn);
  bgGroup.add(terrainSys.midTerrainMesh, terrainSys.farAlpsMesh);

  // 2. Deterministic placements across foothills, mountain slopes & outer transition
  const placements = generateMilitaryEnvironmentPlacements(bounds);
  const TREE_LOD_DIST = 60.0;
  const blNearList = placements.broadleafList.filter((t) => t.dist < TREE_LOD_DIST);
  const blFarList = placements.broadleafList.filter((t) => t.dist >= TREE_LOD_DIST);
  const pineNearList = placements.pineNearList.filter((t) => t.dist < TREE_LOD_DIST);
  const pineFarList = placements.pineNearList.filter((t) => t.dist >= TREE_LOD_DIST);

  // Merge far perimeter pines + 420 mountain-slope conifers into ONE unified 1-draw-call slope conifer forest!
  const allSlopeConifers = [
    ...pineFarList.map((p) => ({ x: p.x, y: p.y, z: p.z, dist: p.dist, h: p.h, w: p.r * 2.1, ry: p.ry, tint: p.tint })),
    ...placements.slopeConiferList,
  ];
  allSlopeConifers.sort((a, b) => a.dist - b.dist);

  // 3. Build Foliage Textures & Shared Material Factory
  const broadleafTex = buildBroadleafCardTex(THREE);
  if (yieldFn) await yieldFn();
  const pineBoughTex = buildPineBoughCardTex(THREE);
  if (yieldFn) await yieldFn();
  const fullConiferTex = buildFullConiferBillboardTex(THREE);
  const fullBroadleafTex = buildFullBroadleafBillboardTex(THREE);
  if (yieldFn) await yieldFn();

  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x3a2e22,
    roughness: 0.94,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.25,
  });
  applyMilitaryHeightFog(trunkMat, fogUniforms, null, "mil_hfog_std");

  const makeFoliageMat = (mapTex, alphaCut = 0.42) => {
    const m = new THREE.MeshStandardMaterial({
      map: mapTex,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
      envMap,
      envMapIntensity: 0.24,
      alphaTest: alphaCut,
      side: THREE.DoubleSide,
    });
    applyMilitaryHeightFog(
      m,
      fogUniforms,
      (shader) => {
        shader.uniforms.uWindTime = windUniform;
        shader.uniforms.uWindScale = windScaleUniform;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uWindTime;\nuniform float uWindScale;")
          .replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nfloat wAmp = max(0.0, transformed.y - 0.22) * 0.042 * uWindScale;\ntransformed.x += sin(uWindTime * 1.55 + transformed.y * 2.2 + transformed.z * 1.9) * wAmp;\ntransformed.z += cos(uWindTime * 1.18 + transformed.x * 2.1) * wAmp * 0.55;",
          );
        // Keep custom outward spherical foliage normal unflipped on DoubleSide cards & suppress plastic grazing GGX white glare on backlit pines!
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <normal_fragment_begin>",
            "#include <normal_fragment_begin>\nvec3 folWorldUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\nnormal = normalize(mix(normalize(vNormal), folWorldUp, 0.36));",
          )
          .replace(
            "#include <lights_fragment_end>",
            "#include <lights_fragment_end>\nreflectedLight.directSpecular *= 0.03;\nreflectedLight.indirectSpecular *= 0.08;",
          );
      },
      "mil_hfog_foliage",
    );
    return m;
  };

  const blCrownMat = makeFoliageMat(broadleafTex, 0.44);
  const pineCrownMat = makeFoliageMat(pineBoughTex, 0.42);
  const slopeConiferMat = makeFoliageMat(fullConiferTex, 0.40);
  const blFarBillboardMat = makeFoliageMat(fullBroadleafTex, 0.42);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  const envControls = {
    midTerrainMesh: terrainSys.midTerrainMesh,
    farRidge: terrainSys.farAlpsMesh,
    terrainUniforms: terrainSys.terrainUniforms,
    blTrunkInst: null,
    blCrownInst: null,
    blDists: blNearList.map((t) => t.dist),
    blFarLodInst: null,
    blFarDists: blFarList.map((t) => t.dist),
    pineTrunkInst: null,
    pineCrownInst: null,
    pineDists: pineNearList.map((t) => t.dist),
    slopeConiferInst: null,
    slopeConiferDists: allSlopeConifers.map((t) => t.dist),
    deadInst: null,
    bushInst: null,
    boulderInst: null,
    powerPoleInst: null,
    powerCableMesh: null,
    outerFenceInst: null,
    valleyMistMesh: null,
    mistUniforms: null,
    extraTextures: [terrainSys.detailTex, broadleafTex, pineBoughTex, fullConiferTex, fullBroadleafTex],
  };

  const blPalette = [0x96a178, 0x88946d, 0xa39c70, 0x7e8b66, 0x978d65];
  const pinePalette = [0x829975, 0x728a68, 0x8ca07d, 0x657d5d, 0x79916d];

  // ---- Species 1A: Near Broadleaf Oaks (< 60m full 3D leaf-card canopy, 18 lush cards = 36 tris) ----
  if (blNearList.length > 0) {
    const stem = new THREE.CylinderGeometry(0.14, 0.30, 1.0, 5);
    stem.translate(0, 0.50, 0);
    const b1 = new THREE.CylinderGeometry(0.06, 0.12, 0.55, 4);
    b1.rotateZ(0.62);
    b1.translate(-0.18, 0.92, 0.06);
    const b2 = new THREE.CylinderGeometry(0.06, 0.12, 0.55, 4);
    b2.rotateZ(-0.56);
    b2.rotateY(2.1);
    b2.translate(0.16, 0.94, -0.08);
    const blTrunkGeo = mergeStaticParts(THREE, [stem, b1, b2], false);
    const blTrunkInst = new THREE.InstancedMesh(blTrunkGeo, trunkMat, blNearList.length);
    blTrunkInst.castShadow = false;
    blTrunkInst.matrixAutoUpdate = false;

    const cards = [];
    let cs = 774411;
    const crnd = () => ((cs = (cs * 16807) % 2147483647) / 2147483647);
    const lobes = [[0, 0.95, 0, 1.0], [-0.46, 0.66, 0.28, 0.74], [0.46, 0.72, -0.26, 0.75]];
    for (let cIdx = 0; cIdx < 18; cIdx++) {
      const lobe = lobes[cIdx % lobes.length];
      const phi = Math.acos(1 - 2 * ((cIdx + 0.5) / 18));
      const theta = Math.PI * (1 + Math.sqrt(5)) * cIdx + crnd() * 0.45;
      const rad = (0.34 + crnd() * 0.66) * lobe[3];
      const ox = lobe[0] + Math.sin(phi) * Math.cos(theta) * rad;
      const oy = lobe[1] + Math.cos(phi) * rad * 0.78;
      const oz = lobe[2] + Math.sin(phi) * Math.sin(theta) * rad;
      const cardSz = 0.98 + crnd() * 0.44;
      const card = new THREE.PlaneGeometry(cardSz, cardSz);
      card.rotateX((crnd() - 0.5) * 1.45);
      card.rotateY(theta + (crnd() - 0.5) * 1.5);
      card.rotateZ((crnd() - 0.5) * 1.2);
      card.translate(ox, oy, oz);

      const cp = card.attributes.position;
      const cn = card.attributes.normal;
      const vc = new Float32Array(cp.count * 3);
      for (let vi = 0; vi < cp.count; vi++) {
        const vx = cp.getX(vi);
        const vy = cp.getY(vi) - 0.85;
        const vz = cp.getZ(vi);
        const distC = Math.hypot(vx, vy, vz);
        const len = distC || 1;
        const nx = (vx / len) * 0.82;
        const ny = (vy / len) * 0.68 + 0.38;
        const nz = (vz / len) * 0.82;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        cn.setXYZ(vi, nx / nLen, ny / nLen, nz / nLen);
        const aoRad = clamp((distC - 0.28) / 0.92, 0, 1);
        const aoH = clamp((cp.getY(vi) - 0.15) / 1.45, 0, 1);
        const ao = 0.48 + 0.34 * aoRad + 0.24 * aoH;
        vc[vi * 3] = ao;
        vc[vi * 3 + 1] = ao * (0.97 + 0.03 * aoH);
        vc[vi * 3 + 2] = ao * 0.92;
      }
      card.setAttribute("color", new THREE.BufferAttribute(vc, 3));
      cards.push(card);
    }
    const blCrownGeo = mergeStaticParts(THREE, cards, true);
    const blCrownInst = new THREE.InstancedMesh(blCrownGeo, blCrownMat, blNearList.length);
    blCrownInst.castShadow = false;
    blCrownInst.receiveShadow = false;
    blCrownInst.matrixAutoUpdate = false;

    blNearList.forEach((tr, idx) => {
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r * 0.55, tr.trunkH, tr.r * 0.55);
      dummy.updateMatrix();
      blTrunkInst.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(tr.x, tr.y + tr.trunkH * 0.82, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r, tr.r * (0.96 + (idx % 3) * 0.10), tr.r);
      dummy.updateMatrix();
      blCrownInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(blPalette[tr.tint]);
      blCrownInst.setColorAt(idx, col);
    });
    blTrunkInst.instanceMatrix.needsUpdate = true;
    blTrunkInst.updateMatrix();
    blCrownInst.instanceMatrix.needsUpdate = true;
    blCrownInst.updateMatrix();
    if (blCrownInst.instanceColor) blCrownInst.instanceColor.needsUpdate = true;
    bgGroup.add(blTrunkInst, blCrownInst);
    envControls.blTrunkInst = blTrunkInst;
    envControls.blCrownInst = blCrownInst;
  }

  // ---- Species 1B: Far Broadleaf Full-Tree Billboard LOD (>= 60m, 1 draw call, 4 tris/tree!) ----
  if (blFarList.length > 0) {
    const blLodGeo = makeCrossedFullTreeGeo(THREE, 1.0, 1.0, 0.54);
    const blFarLodInst = new THREE.InstancedMesh(blLodGeo, blFarBillboardMat, blFarList.length);
    blFarLodInst.castShadow = false;
    blFarLodInst.receiveShadow = false;
    blFarLodInst.matrixAutoUpdate = false;

    blFarList.forEach((tr, idx) => {
      const totalH = tr.trunkH + tr.r * 1.95;
      const totalW = tr.r * 2.55;
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(totalW, totalH, totalW);
      dummy.updateMatrix();
      blFarLodInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(blPalette[tr.tint]);
      blFarLodInst.setColorAt(idx, col);
    });
    blFarLodInst.instanceMatrix.needsUpdate = true;
    blFarLodInst.updateMatrix();
    if (blFarLodInst.instanceColor) blFarLodInst.instanceColor.needsUpdate = true;
    bgGroup.add(blFarLodInst);
    envControls.blFarLodInst = blFarLodInst;
  }

  // ---- Species 2A: Near Conifer / Alpine Spruce (< 60m lush spreading 3D whorls, 18 cards = 36 tris) ----
  if (pineNearList.length > 0) {
    const pStem = new THREE.CylinderGeometry(0.05, 0.24, 0.90, 5);
    pStem.translate(0, 0.45, 0);
    const pineTrunkInst = new THREE.InstancedMesh(pStem, trunkMat, pineNearList.length);
    pineTrunkInst.castShadow = false;
    pineTrunkInst.matrixAutoUpdate = false;

    const pCards = [];
    let ps = 661188;
    const prnd = () => ((ps = (ps * 16807) % 2147483647) / 2147483647);
    const tiers = [
      [0.22, 1.05, 4, 1.44],
      [0.44, 0.82, 4, 1.24],
      [0.65, 0.56, 3, 1.02],
      [0.83, 0.30, 2, 0.78],
      [0.95, 0.06, 1, 0.58],
    ];
    for (const [ty, rad, cnt, sz] of tiers) {
      for (let k = 0; k < cnt; k++) {
        const ang = (k / cnt) * Math.PI * 2 + ty * 4.5 + (prnd() - 0.5) * 0.32;
        const card = new THREE.PlaneGeometry(sz, sz * 1.06);
        card.rotateX(-0.62 + (prnd() - 0.5) * 0.28);
        card.rotateY(ang);
        card.translate(Math.cos(ang) * rad * 0.52, ty, Math.sin(ang) * rad * 0.52);
        const cp = card.attributes.position;
        const cn = card.attributes.normal;
        const vc = new Float32Array(cp.count * 3);
        for (let vi = 0; vi < cp.count; vi++) {
          const vx = cp.getX(vi);
          const vy = cp.getY(vi);
          const vz = cp.getZ(vi);
          const rHoriz = Math.hypot(vx, vz);
          const len = Math.hypot(vx, 0.55, vz) || 1;
          cn.setXYZ(vi, vx / len, 0.55 / len, vz / len);
          const ao = 0.45 + 0.30 * Math.min(1, rHoriz / (rad + 0.25)) + 0.30 * vy;
          vc[vi * 3] = ao * 0.94;
          vc[vi * 3 + 1] = ao;
          vc[vi * 3 + 2] = ao * 0.92;
        }
        card.setAttribute("color", new THREE.BufferAttribute(vc, 3));
        pCards.push(card);
      }
    }
    const pineCrownGeo = mergeStaticParts(THREE, pCards, true);
    const pineCrownInst = new THREE.InstancedMesh(pineCrownGeo, pineCrownMat, pineNearList.length);
    pineCrownInst.castShadow = false;
    pineCrownInst.receiveShadow = false;
    pineCrownInst.matrixAutoUpdate = false;

    pineNearList.forEach((tr, idx) => {
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r * 0.5, tr.h, tr.r * 0.5);
      dummy.updateMatrix();
      pineTrunkInst.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r, tr.h, tr.r);
      dummy.updateMatrix();
      pineCrownInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(pinePalette[tr.tint % pinePalette.length]);
      pineCrownInst.setColorAt(idx, col);
    });
    pineTrunkInst.instanceMatrix.needsUpdate = true;
    pineTrunkInst.updateMatrix();
    pineCrownInst.instanceMatrix.needsUpdate = true;
    pineCrownInst.updateMatrix();
    if (pineCrownInst.instanceColor) pineCrownInst.instanceColor.needsUpdate = true;
    bgGroup.add(pineTrunkInst, pineCrownInst);
    envControls.pineTrunkInst = pineTrunkInst;
    envControls.pineCrownInst = pineCrownInst;
  }

  // ---- Species 2B: Dense Foothill & Mountain-Slope Conifer Forest (~420+ trees in 1 single draw call!) ----
  if (allSlopeConifers.length > 0) {
    const slopeGeo = makeCrossedFullTreeGeo(THREE, 1.0, 1.0, 0.46);
    const slopeConiferInst = new THREE.InstancedMesh(slopeGeo, slopeConiferMat, allSlopeConifers.length);
    slopeConiferInst.castShadow = false;
    slopeConiferInst.receiveShadow = false;
    slopeConiferInst.matrixAutoUpdate = false;
    slopeConiferInst.name = "military_slope_conifer_forest";

    allSlopeConifers.forEach((tr, idx) => {
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.w, tr.h, tr.w);
      dummy.updateMatrix();
      slopeConiferInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(pinePalette[tr.tint % pinePalette.length]);
      slopeConiferInst.setColorAt(idx, col);
    });
    slopeConiferInst.instanceMatrix.needsUpdate = true;
    slopeConiferInst.updateMatrix();
    if (slopeConiferInst.instanceColor) slopeConiferInst.instanceColor.needsUpdate = true;
    bgGroup.add(slopeConiferInst);
    envControls.slopeConiferInst = slopeConiferInst;
  }

  // ---- Species 3: Dead Snag Trees + Lush Foothill Undergrowth Bushes ----
  if (placements.deadList.length > 0) {
    const dStem = new THREE.CylinderGeometry(0.08, 0.25, 0.85, 5);
    dStem.translate(0, 0.425, 0);
    const db1 = new THREE.CylinderGeometry(0.03, 0.09, 0.48, 4);
    db1.rotateZ(0.75);
    db1.translate(-0.18, 0.72, 0.04);
    const db2 = new THREE.CylinderGeometry(0.025, 0.08, 0.45, 4);
    db2.rotateZ(-0.68);
    db2.rotateY(1.4);
    db2.translate(0.16, 0.78, -0.06);
    const deadGeo = mergeStaticParts(THREE, [dStem, db1, db2], false);
    const deadMat = new THREE.MeshStandardMaterial({
      color: 0x5c5347,
      roughness: 0.95,
      metalness: 0.0,
      envMap,
      envMapIntensity: 0.25,
    });
    applyMilitaryHeightFog(deadMat, fogUniforms, null, "mil_hfog_std");
    const deadInst = new THREE.InstancedMesh(deadGeo, deadMat, placements.deadList.length);
    deadInst.castShadow = false;
    deadInst.matrixAutoUpdate = false;
    placements.deadList.forEach((tr, idx) => {
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r * 0.65, tr.h, tr.r * 0.65);
      dummy.updateMatrix();
      deadInst.setMatrixAt(idx, dummy.matrix);
    });
    deadInst.instanceMatrix.needsUpdate = true;
    deadInst.updateMatrix();
    bgGroup.add(deadInst);
    envControls.deadInst = deadInst;
  }

  if (placements.bushList.length > 0) {
    const bCards = [];
    let bs = 992233;
    const brnd = () => ((bs = (bs * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI * 2 + brnd() * 0.4;
      const rad = 0.22 + brnd() * 0.36;
      const c = new THREE.PlaneGeometry(0.80 + brnd() * 0.24, 0.74 + brnd() * 0.22);
      c.rotateX((brnd() - 0.5) * 1.1);
      c.rotateY(ang + (brnd() - 0.5) * 1.2);
      c.translate(Math.cos(ang) * rad, 0.36 + brnd() * 0.26, Math.sin(ang) * rad);
      const cp = c.attributes.position;
      const cn = c.attributes.normal;
      const vc = new Float32Array(cp.count * 3);
      for (let vi = 0; vi < cp.count; vi++) {
        const vy = cp.getY(vi);
        cn.setXYZ(vi, cp.getX(vi) * 0.45, 0.88, cp.getZ(vi) * 0.45);
        const ao = 0.42 + 0.56 * clamp(vy / 0.85, 0, 1);
        vc[vi * 3] = ao;
        vc[vi * 3 + 1] = ao * 0.96;
        vc[vi * 3 + 2] = ao * 0.88;
      }
      c.setAttribute("color", new THREE.BufferAttribute(vc, 3));
      bCards.push(c);
    }
    const bushGeo = mergeStaticParts(THREE, bCards, true);
    const bushInst = new THREE.InstancedMesh(bushGeo, blCrownMat, placements.bushList.length);
    bushInst.castShadow = false;
    bushInst.receiveShadow = false;
    bushInst.matrixAutoUpdate = false;
    const bushPal = [0x828c64, 0x748058, 0x928962, 0x677552, 0x857f59];
    placements.bushList.forEach((b, idx) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.ry, 0);
      dummy.scale.set(b.s * 1.15, b.s * 0.85, b.s * 1.15);
      dummy.updateMatrix();
      bushInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(bushPal[b.tint]);
      bushInst.setColorAt(idx, col);
    });
    bushInst.instanceMatrix.needsUpdate = true;
    bushInst.updateMatrix();
    if (bushInst.instanceColor) bushInst.instanceColor.needsUpdate = true;
    bgGroup.add(bushInst);
    envControls.bushInst = bushInst;
  }

  // ---- Perimeter Transition Props: Mossy Boulders, Utility Power Poles + Cables, Outer Fence & Valley Mist ----
  // 1. Weathered Hillside Boulders (1 draw call)
  if (placements.boulderList.length > 0) {
    const rockGeo = new THREE.IcosahedronGeometry(1.0, 0);
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const vx = rp.getX(i);
      const vy = rp.getY(i);
      const vz = rp.getZ(i);
      const k = 0.82 + 0.34 * Math.abs(Math.sin(vx * 3.1 + vy * 2.7 + vz * 4.3));
      rp.setXYZ(i, vx * k, vy * k * 0.85, vz * k);
    }
    rockGeo.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x6e726d,
      roughness: 0.94,
      metalness: 0.04,
      envMap,
      envMapIntensity: 0.36,
    });
    applyMilitaryHeightFog(rockMat, fogUniforms, null, "mil_hfog_std");
    const boulderInst = new THREE.InstancedMesh(rockGeo, rockMat, placements.boulderList.length);
    boulderInst.castShadow = false;
    boulderInst.receiveShadow = false;
    boulderInst.matrixAutoUpdate = false;
    boulderInst.name = "military_foothill_boulders";
    const rockPal = [0x656864, 0x585c57, 0x73736a, 0x4f554f];
    placements.boulderList.forEach((rk, idx) => {
      dummy.position.set(rk.x, rk.y, rk.z);
      dummy.rotation.set(rk.rx, rk.ry, rk.rz);
      dummy.scale.set(rk.sx, rk.sy, rk.sz);
      dummy.updateMatrix();
      boulderInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(rockPal[rk.tint]);
      boulderInst.setColorAt(idx, col);
    });
    boulderInst.instanceMatrix.needsUpdate = true;
    boulderInst.updateMatrix();
    if (boulderInst.instanceColor) boulderInst.instanceColor.needsUpdate = true;
    bgGroup.add(boulderInst);
    envControls.boulderInst = boulderInst;
  }

  // 2. Perimeter Utility Power Poles + Sagging Catenary Wires (2 draw calls)
  if (placements.powerPoles.length > 0) {
    const poleShaft = new THREE.CylinderGeometry(0.10, 0.16, 1.0, 6);
    poleShaft.translate(0, 0.50, 0);
    const crossArm = new THREE.BoxGeometry(1.75, 0.09, 0.10);
    crossArm.translate(0, 0.93, 0);
    const brace1 = new THREE.BoxGeometry(0.55, 0.04, 0.04);
    brace1.rotateZ(0.65);
    brace1.translate(-0.34, 0.84, 0);
    const brace2 = new THREE.BoxGeometry(0.55, 0.04, 0.04);
    brace2.rotateZ(-0.65);
    brace2.translate(0.34, 0.84, 0);
    const poleGeo = mergeStaticParts(THREE, [poleShaft, crossArm, brace1, brace2], false);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x4b4238,
      roughness: 0.92,
      metalness: 0.08,
      envMap,
      envMapIntensity: 0.32,
    });
    applyMilitaryHeightFog(poleMat, fogUniforms, null, "mil_hfog_std");

    const powerPoleInst = new THREE.InstancedMesh(poleGeo, poleMat, placements.powerPoles.length);
    powerPoleInst.castShadow = false;
    powerPoleInst.matrixAutoUpdate = false;
    powerPoleInst.name = "military_perimeter_power_poles";
    placements.powerPoles.forEach((pl, idx) => {
      dummy.position.set(pl.x, pl.y, pl.z);
      dummy.rotation.set(0, pl.ry, 0);
      dummy.scale.set(1.0, pl.h, 1.0);
      dummy.updateMatrix();
      powerPoleInst.setMatrixAt(idx, dummy.matrix);
    });
    powerPoleInst.instanceMatrix.needsUpdate = true;
    powerPoleInst.updateMatrix();
    bgGroup.add(powerPoleInst);
    envControls.powerPoleInst = powerPoleInst;

    // Dual sagging catenary power lines connecting poles
    const cablePts = [];
    const wireOffsets = [-0.72, 0.72];
    const segs = 6;
    for (let i = 0; i < placements.powerPoles.length; i++) {
      const a = placements.powerPoles[i];
      const b = placements.powerPoles[(i + 1) % placements.powerPoles.length];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 42) continue;
      const axCos = Math.cos(a.ry), axSin = Math.sin(a.ry);
      const bxCos = Math.cos(b.ry), bxSin = Math.sin(b.ry);
      for (const off of wireOffsets) {
        const x0 = a.x + axCos * off;
        const y0 = a.y + a.h * 0.93;
        const z0 = a.z - axSin * off;
        const x1 = b.x + bxCos * off;
        const y1 = b.y + b.h * 0.93;
        const z1 = b.z - bxSin * off;
        for (let k = 0; k < segs; k++) {
          const t0 = k / segs;
          const t1 = (k + 1) / segs;
          const sag0 = Math.sin(t0 * Math.PI) * 0.95;
          const sag1 = Math.sin(t1 * Math.PI) * 0.95;
          cablePts.push(
            x0 + (x1 - x0) * t0,
            y0 + (y1 - y0) * t0 - sag0,
            z0 + (z1 - z0) * t0,
            x0 + (x1 - x0) * t1,
            y0 + (y1 - y0) * t1 - sag1,
            z0 + (z1 - z0) * t1,
          );
        }
      }
    }
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute("position", new THREE.Float32BufferAttribute(cablePts, 3));
    const cableMat = new THREE.LineBasicMaterial({ color: 0x2a2d30, transparent: true, opacity: 0.72 });
    const powerCableMesh = new THREE.LineSegments(cableGeo, cableMat);
    powerCableMesh.name = "military_perimeter_power_cables";
    powerCableMesh.matrixAutoUpdate = false;
    powerCableMesh.updateMatrix();
    bgGroup.add(powerCableMesh);
    envControls.powerCableMesh = powerCableMesh;
  }

  // 3. Outer Buffer Barbed-Wire / Security Fence Posts outside walls (1 draw call)
  if (placements.outerFencePosts.length > 0) {
    const fPost = new THREE.BoxGeometry(0.08, 2.25, 0.08);
    fPost.translate(0, 1.125, 0);
    const fArm = new THREE.BoxGeometry(0.06, 0.55, 0.06);
    fArm.rotateZ(0.55);
    fArm.translate(0.14, 2.42, 0);
    const fRailTop = new THREE.BoxGeometry(0.04, 0.04, 4.4);
    fRailTop.translate(0, 2.15, 0);
    const fRailMid = new THREE.BoxGeometry(0.035, 0.035, 4.4);
    fRailMid.translate(0, 1.15, 0);
    const fGeo = mergeStaticParts(THREE, [fPost, fArm, fRailTop, fRailMid], false);
    const fMat = new THREE.MeshStandardMaterial({
      color: 0x52575a,
      roughness: 0.74,
      metalness: 0.52,
      envMap,
      envMapIntensity: 0.55,
    });
    applyMilitaryHeightFog(fMat, fogUniforms, null, "mil_hfog_std");
    const outerFenceInst = new THREE.InstancedMesh(fGeo, fMat, placements.outerFencePosts.length);
    outerFenceInst.castShadow = false;
    outerFenceInst.matrixAutoUpdate = false;
    outerFenceInst.name = "military_outer_buffer_fence";
    placements.outerFencePosts.forEach((fp, idx) => {
      dummy.position.set(fp.x, fp.y, fp.z);
      dummy.rotation.set(0, fp.ry, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      outerFenceInst.setMatrixAt(idx, dummy.matrix);
    });
    outerFenceInst.instanceMatrix.needsUpdate = true;
    outerFenceInst.updateMatrix();
    bgGroup.add(outerFenceInst);
    envControls.outerFenceInst = outerFenceInst;
  }

  // 4. Low Valley Mist Ribbons behind the perimeter trees & across the mountain basin (1 draw call)
  const valleyMist = buildValleyMistMesh(THREE, bounds, sunPos);
  bgGroup.add(valleyMist.mesh);
  envControls.valleyMistMesh = valleyMist.mesh;
  envControls.mistUniforms = valleyMist.mistUniforms;

  bgGroup.updateMatrix();
  return { bgGroup, envControls };
}
