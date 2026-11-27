/**
 * Ballistics VFX & Material Impact System (Phương án A — Selective HDR Halo, Zero Per-Shot Allocation):
 * - Pure math helpers (Node.js AAA testable): surface classification, tactical tracer cadence,
 *   true surface reflection, metal ricochet gating, and closest-point bullet whiz-by pan/distance.
 * - Pre-allocated InstancedMesh GPU pools:
 *   1. 32 Cross-Quad Traveling Tracers (1 draw call, fog:false + distance fade + 1-2m near-muzzle fade-in)
 *   2. 192 Velocity-Stretched Additive Sparks & Water Droplets (1 draw call, fog:false, gravity + ground bounce)
 *   3. 160 Soft Alpha Dust / Gunsmoke / Water Mist & Flat Expanding Water Ripples (1 draw call, fog:true)
 *   4. 96 3D Tumbling Concrete / Wood / Dirt Debris Chips (1 draw call, fog:true, gravity + bounce)
 *   5. 96 Ring-Buffer Bullet Hole Decals (1 draw call, 2x2 atlas: concrete, metal, wood, ricochet graze)
 *   6. 24 Brief Metal Impact Flash Coronas (1 draw call, additive, fog:false)
 * - Multi-Layer Viewmodel Muzzle Flash Rig (2x2 randomized flame atlas, per-weapon brake profile).
 */

export const SURFACE_TYPES = Object.freeze(["concrete", "metal", "wood", "dirt", "water"]);

export const SURFACE_FX = Object.freeze({
  concrete: Object.freeze({
    dustColor: 0x9c9589,
    dustCount: 7,
    debrisColor: 0x676158,
    debrisCount: 6,
    debrisStretch: 1.0,
    sparksCount: 2,
    sparkColor: 0xffc878,
    holeTile: 0, // (0,0) chipped concrete crater
    impactFlash: false,
    waterRipple: false,
    ricochetChance: 0.0,
    sound: "hit_concrete",
  }),
  metal: Object.freeze({
    dustColor: 0x6d7076,
    dustCount: 2,
    debrisColor: 0x4b4e52,
    debrisCount: 0,
    debrisStretch: 1.0,
    sparksCount: 15,
    sparkColor: 0xffe08a,
    holeTile: 1, // (1,0) blackened steel dent with shiny lip
    impactFlash: true,
    waterRipple: false,
    ricochetChance: 0.28,
    sound: "hit_metal",
  }),
  wood: Object.freeze({
    dustColor: 0x8b6b45,
    dustCount: 5,
    debrisColor: 0x704c26,
    debrisCount: 8,
    debrisStretch: 2.6, // Elongated wood splinters
    sparksCount: 0,
    sparkColor: 0xffc878,
    holeTile: 2, // (0,1) splintered wood puncture
    impactFlash: false,
    waterRipple: false,
    ricochetChance: 0.0,
    sound: "hit_wood",
  }),
  dirt: Object.freeze({
    dustColor: 0x63503a,
    dustCount: 7,
    debrisColor: 0x463626,
    debrisCount: 5,
    debrisStretch: 1.1,
    sparksCount: 0,
    sparkColor: 0xffc878,
    holeTile: -1, // No persistent bullet hole on loose dirt / sandbags
    impactFlash: false,
    waterRipple: false,
    ricochetChance: 0.0,
    sound: "hit_dirt",
  }),
  water: Object.freeze({
    dustColor: 0xd6e6f2,
    dustCount: 6,
    debrisColor: 0xffffff,
    debrisCount: 0,
    debrisStretch: 1.0,
    sparksCount: 11, // Stretched silver-white water splash droplets
    sparkColor: 0xd8ecff,
    holeTile: -1, // No bullet hole on water
    impactFlash: false,
    waterRipple: true,
    ricochetChance: 0.0,
    sound: "hit_water",
  }),
});

const METAL_TAG_RE = /(container|barrel|fence|barbed|roof|truck|watchtower|metal|steel|crane|pipe)/i;
const WOOD_TAG_RE = /(wood|crate|pallet|plank)/i;
const DIRT_TAG_RE = /(sandbag|tire|dirt|soil|grass|mud|earth)/i;

/**
 * Deterministic 0..1 pseudo-random helper for synchronized LAN visual rolls (tracer/ricochet/spread).
 */
export function seededUnit(seed, salt = 0) {
  let n = Math.imul(((seed | 0) + Math.imul(salt | 0, 374761393)) | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * Resolve physical surface category from collider tag, mesh userData.surface, or ground puddle/dirt sampler.
 */
export function resolveSurfaceType({
  tag = "",
  objectSurface = "",
  x = 0,
  z = 0,
  samplePuddle = null,
  sampleDirt = null,
} = {}) {
  const direct = typeof objectSurface === "string" ? objectSurface.toLowerCase() : "";
  const safeTag = typeof tag === "string" ? tag.toLowerCase() : "";

  if (direct === "ground" || safeTag === "ground") {
    if (typeof samplePuddle === "function" && Number(samplePuddle(x, z)) > 0.35) {
      return "water";
    }
    if (typeof sampleDirt === "function" && Number(sampleDirt(x, z)) > 0.54) {
      return "dirt";
    }
    return "concrete";
  }

  if (direct && SURFACE_FX[direct]) return direct;
  if (METAL_TAG_RE.test(safeTag)) return "metal";
  if (WOOD_TAG_RE.test(safeTag)) return "wood";
  if (DIRT_TAG_RE.test(safeTag)) return "dirt";
  return "concrete";
}

/**
 * Tactical tracer sparsity: realistic & readable (avoids Star-Wars beam spam in 5v5).
 */
export function shouldSpawnTracer({
  weaponId = "m416",
  shotIndex = 1,
  magRemaining = 30,
  isRemote = false,
} = {}) {
  const idx = Math.max(1, Number(shotIndex) | 0);
  if (weaponId === "sniper") return true;
  if (weaponId === "pistol") return idx === 1 || idx % 2 === 0;
  if (isRemote) return idx === 1 || idx % 2 === 1;
  // M416: first round of burst, every 3rd round, plus final 5 rounds of mag as tactical low-ammo cue
  return idx === 1 || idx % 3 === 0 || (magRemaining > 0 && magRemaining <= 5);
}

/**
 * Pure unit reflection R = D - 2 * dot(D, N) * N.
 */
export function computeReflectionDir(dx, dy, dz, nx, ny, nz) {
  const dl = Math.hypot(dx, dy, dz) || 1;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ux = dx / dl, uy = dy / dl, uz = dz / dl;
  const vx = nx / nl, vy = ny / nl, vz = nz / nl;
  const dot = ux * vx + uy * vy + uz * vz;
  const rx = ux - 2 * dot * vx;
  const ry = uy - 2 * dot * vy;
  const rz = uz - 2 * dot * vz;
  const rl = Math.hypot(rx, ry, rz) || 1;
  return { x: rx / rl, y: ry / rl, z: rz / rl };
}

/**
 * Returns true if a hit qualifies for a grazing metallic ricochet spark/tracer + whine sound.
 */
export function computeRicochetEligibility(dx, dy, dz, nx, ny, nz, surface, roll01 = 0) {
  const fx = SURFACE_FX[surface];
  if (!fx || fx.ricochetChance <= 0) return false;
  const dl = Math.hypot(dx, dy, dz) || 1;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const absDot = Math.abs((dx * nx + dy * ny + dz * nz) / (dl * nl));
  // Grazing angles (not straight 90-deg perpendicular hits) can ricochet
  if (absDot >= 0.72) return false;
  return roll01 < fx.ricochetChance;
}

/**
 * Closest-point-on-segment calculation for supersonic bullet whiz-by stereo audio.
 */
export function computeBulletWhizBy(origin, end, listenerPos, listenerRight, maxRadius = 4.6) {
  if (!origin || !end || !listenerPos) return null;
  const abx = end.x - origin.x;
  const aby = end.y - origin.y;
  const abz = end.z - origin.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 9.0) return null; // Ignore ultra-short shots < 3m

  const apx = listenerPos.x - origin.x;
  const apy = listenerPos.y - origin.y;
  const apz = listenerPos.z - origin.z;
  const t = (apx * abx + apy * aby + apz * abz) / abLenSq;
  // Require bullet to genuinely pass beside the listener (not originate right on top of them)
  if (t < 0.06 || t > 0.96) return null;

  const qx = origin.x + abx * t;
  const qy = origin.y + aby * t;
  const qz = origin.z + abz * t;
  const dx = qx - listenerPos.x;
  const dy = qy - listenerPos.y;
  const dz = qz - listenerPos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > maxRadius || dist < 0.15) return null;

  let pan = 0;
  if (listenerRight) {
    const rLen = Math.hypot(listenerRight.x, listenerRight.y, listenerRight.z) || 1;
    pan = Math.max(-1, Math.min(1, ((dx * listenerRight.x + dy * listenerRight.y + dz * listenerRight.z) / (dist * rLen))));
  }
  const closeness = Math.max(0, Math.min(1, 1 - dist / maxRadius));
  return { dist, pan, closeness, point: { x: qx, y: qy, z: qz } };
}

// ---------- Procedural Atlas & Texture Generators (Browser Only) ----------

function makeTracerTexture(THREE) {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 128;
  const g = c.getContext("2d");
  // Longitudinal hot head (y=0) -> amber mid -> soft fading orange tail (y=128)
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.10, "rgba(255,235,175,0.96)");
  grad.addColorStop(0.32, "rgba(255,175,85,0.68)");
  grad.addColorStop(0.70, "rgba(255,112,36,0.24)");
  grad.addColorStop(1.0, "rgba(255,84,20,0.0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 128);

  // Soft Gaussian transverse profile (crisp bright needle + gentle selective bloom envelope)
  const side = g.createLinearGradient(0, 0, 16, 0);
  side.addColorStop(0.0, "rgba(0,0,0,0.0)");
  side.addColorStop(0.24, "rgba(0,0,0,0.34)");
  side.addColorStop(0.50, "rgba(0,0,0,1.0)");
  side.addColorStop(0.76, "rgba(0,0,0,0.34)");
  side.addColorStop(1.0, "rgba(0,0,0,0.0)");
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = side;
  g.fillRect(0, 0, 16, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * 2x2 Muzzle Flash Sprite Atlas (4 distinct jagged multi-fin tactical plasma shapes).
 */
function makeMuzzleAtlasTexture(THREE) {
  const size = 256;
  const half = size / 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.clearRect(0, 0, size, size);

  let s = 481516;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const cx = tx * half + half * 0.5;
      const cy = ty * half + half * 0.5;
      g.save();
      g.beginPath();
      g.rect(tx * half, ty * half, half, half);
      g.clip();

      // Soft outer selective-bloom amber halo
      const halo = g.createRadialGradient(cx, cy, 2, cx, cy, half * 0.48);
      halo.addColorStop(0.0, "rgba(255,252,235,0.95)");
      halo.addColorStop(0.24, "rgba(255,204,112,0.58)");
      halo.addColorStop(0.62, "rgba(255,126,38,0.16)");
      halo.addColorStop(1.0, "rgba(255,90,20,0.0)");
      g.fillStyle = halo;
      g.fillRect(tx * half, ty * half, half, half);

      // Jagged tactical star-fins (5-7 asymmetric prongs per tile)
      const spikes = 5 + ((tx + ty * 2) % 3);
      for (let k = 0; k < spikes; k++) {
        const ang = (k / spikes) * Math.PI * 2 + (rnd() - 0.5) * 0.35 + tx * 0.4;
        const len = half * (0.28 + rnd() * 0.19);
        const w = 5.5 + rnd() * 5.0;
        g.save();
        g.translate(cx, cy);
        g.rotate(ang);
        const fg = g.createLinearGradient(0, 0, len, 0);
        fg.addColorStop(0.0, "rgba(255,255,248,0.98)");
        fg.addColorStop(0.32, "rgba(255,222,136,0.88)");
        fg.addColorStop(0.75, "rgba(255,128,36,0.42)");
        fg.addColorStop(1.0, "rgba(255,80,16,0.0)");
        g.fillStyle = fg;
        g.beginPath();
        g.moveTo(0, -w * 0.55);
        g.quadraticCurveTo(len * 0.45, -w * 0.9, len, 0);
        g.quadraticCurveTo(len * 0.45, w * 0.9, 0, w * 0.55);
        g.closePath();
        g.fill();
        g.restore();
      }

      // Incandescent white-hot inner plasma core
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, half * 0.17);
      core.addColorStop(0.0, "rgba(255,255,255,1.0)");
      core.addColorStop(0.55, "rgba(255,246,204,0.85)");
      core.addColorStop(1.0, "rgba(255,200,110,0.0)");
      g.fillStyle = core;
      g.beginPath();
      g.arc(cx, cy, half * 0.18, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * 2x2 Impact Particle Atlas:
 * (0,0) Soft multi-lobe dust/smoke puff | (1,0) Stretched glowing spark streak
 * (0,1) Frothy water splash plume       | (1,1) Concentric expanding water ripple ring
 */
function makeParticleAtlasTexture(THREE) {
  const size = 256;
  const half = size / 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.clearRect(0, 0, size, size);

  // Tile (0,0): Billowy soft dust / gunsmoke puff
  {
    const cx = half * 0.5, cy = half * 0.5;
    const lobes = [
      [0, 0, 44, 0.58],
      [-15, -10, 30, 0.44],
      [16, -8, 28, 0.42],
      [-10, 14, 29, 0.40],
      [14, 13, 27, 0.38],
    ];
    for (const [ox, oy, rad, op] of lobes) {
      const gr = g.createRadialGradient(cx + ox, cy + oy, 2, cx + ox, cy + oy, rad);
      gr.addColorStop(0.0, `rgba(255,255,255,${op})`);
      gr.addColorStop(0.55, `rgba(240,238,234,${op * 0.55})`);
      gr.addColorStop(1.0, "rgba(230,228,224,0.0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx + ox, cy + oy, rad, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Tile (1,0): Hot spark streak + soft bloom halo
  {
    const x0 = half;
    const cx = x0 + half * 0.5;
    const cy = half * 0.5;
    const gr = g.createRadialGradient(cx, cy, 1, cx, cy, 48);
    gr.addColorStop(0.0, "rgba(255,255,255,1.0)");
    gr.addColorStop(0.18, "rgba(255,235,175,0.85)");
    gr.addColorStop(0.55, "rgba(255,155,60,0.22)");
    gr.addColorStop(1.0, "rgba(255,120,30,0.0)");
    g.fillStyle = gr;
    g.fillRect(x0, 0, half, half);
  }

  // Tile (0,1): Water splash froth & spray
  {
    const cx = half * 0.5, cy = half + half * 0.5;
    const gr = g.createRadialGradient(cx, cy, 3, cx, cy, 48);
    gr.addColorStop(0.0, "rgba(245,252,255,0.86)");
    gr.addColorStop(0.45, "rgba(220,238,250,0.48)");
    gr.addColorStop(1.0, "rgba(200,225,245,0.0)");
    g.fillStyle = gr;
    g.beginPath();
    g.arc(cx, cy, 48, 0, Math.PI * 2);
    g.fill();
    let ws = 9191;
    const wrnd = () => ((ws = (ws * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 18; i++) {
      const a = wrnd() * Math.PI * 2;
      const d = 14 + wrnd() * 34;
      g.fillStyle = `rgba(255,255,255,${0.35 + wrnd() * 0.45})`;
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2.2 + wrnd() * 3.8, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Tile (1,1): Crisp concentric water ripple ring
  {
    const cx = half + half * 0.5;
    const cy = half + half * 0.5;
    const drawRing = (r, lw, alpha) => {
      g.strokeStyle = `rgba(235,248,255,${alpha})`;
      g.lineWidth = lw;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    };
    drawRing(50, 5.5, 0.72);
    drawRing(44, 2.5, 0.35);
    drawRing(32, 3.2, 0.50);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * 2x2 Bullet Hole Decal Atlas:
 * (0,0) Concrete spall crater | (1,0) Metal dented burn + bright steel rim
 * (0,1) Wood splinter hole    | (1,1) Metal ricochet scrape
 */
function makeBulletHoleAtlasTexture(THREE) {
  const size = 256;
  const half = size / 2;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.clearRect(0, 0, size, size);

  let s = 231719;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  // Tile (0,0): Concrete crater — pale dusty spall ring + radiating hairline cracks + dark core
  {
    const cx = half * 0.5, cy = half * 0.5;
    const spall = g.createRadialGradient(cx, cy, 8, cx, cy, 48);
    spall.addColorStop(0.0, "rgba(218,212,202,0.88)");
    spall.addColorStop(0.55, "rgba(186,180,168,0.52)");
    spall.addColorStop(1.0, "rgba(160,154,142,0.0)");
    g.fillStyle = spall;
    g.beginPath();
    g.arc(cx, cy, 48, 0, Math.PI * 2);
    g.fill();

    // Hairline cracks
    g.strokeStyle = "rgba(28,26,24,0.62)";
    g.lineWidth = 1.6;
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + (rnd() - 0.5) * 0.45;
      const l = 22 + rnd() * 24;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
      g.lineTo(cx + Math.cos(a + 0.14) * l * 0.55, cy + Math.sin(a + 0.14) * l * 0.55);
      g.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l);
      g.stroke();
    }
    // Deep recessed dark core
    const core = g.createRadialGradient(cx, cy, 2, cx, cy, 17);
    core.addColorStop(0.0, "rgba(12,11,10,0.98)");
    core.addColorStop(0.68, "rgba(32,30,28,0.90)");
    core.addColorStop(1.0, "rgba(70,66,60,0.0)");
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, 17, 0, Math.PI * 2);
    g.fill();
  }

  // Tile (1,0): Metal bullet dent — blackened carbon scorch + bright bare-steel sheared rim + pitch dark hole
  {
    const cx = half + half * 0.5, cy = half * 0.5;
    const scorch = g.createRadialGradient(cx, cy, 10, cx, cy, 46);
    scorch.addColorStop(0.0, "rgba(18,19,22,0.78)");
    scorch.addColorStop(0.58, "rgba(28,30,34,0.36)");
    scorch.addColorStop(1.0, "rgba(28,30,34,0.0)");
    g.fillStyle = scorch;
    g.beginPath();
    g.arc(cx, cy, 46, 0, Math.PI * 2);
    g.fill();

    // Bright exposed metallic sheared edge
    g.strokeStyle = "rgba(225,232,240,0.88)";
    g.lineWidth = 4.2;
    g.beginPath();
    g.arc(cx, cy, 17, 0, Math.PI * 2);
    g.stroke();

    // Dark center dent
    const hole = g.createRadialGradient(cx, cy, 2, cx, cy, 15);
    hole.addColorStop(0.0, "rgba(6,7,9,0.99)");
    hole.addColorStop(0.75, "rgba(20,22,26,0.95)");
    hole.addColorStop(1.0, "rgba(40,44,48,0.0)");
    g.fillStyle = hole;
    g.beginPath();
    g.arc(cx, cy, 15, 0, Math.PI * 2);
    g.fill();
  }

  // Tile (0,1): Wood splinter hole — radiating tan wood fibers + ragged dark core
  {
    const cx = half * 0.5, cy = half + half * 0.5;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
      const l = 18 + rnd() * 28;
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.fillStyle = k % 2 === 0 ? "rgba(166,126,76,0.78)" : "rgba(112,82,48,0.72)";
      g.beginPath();
      g.moveTo(6, -3.5);
      g.lineTo(l, 0);
      g.lineTo(6, 3.5);
      g.closePath();
      g.fill();
      g.restore();
    }
    const core = g.createRadialGradient(cx, cy, 2, cx, cy, 16);
    core.addColorStop(0.0, "rgba(18,12,7,0.98)");
    core.addColorStop(0.7, "rgba(46,31,18,0.88)");
    core.addColorStop(1.0, "rgba(74,52,30,0.0)");
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, 16, 0, Math.PI * 2);
    g.fill();
  }

  // Tile (1,1): Metal ricochet graze mark — elongated silver scratch + dark streak
  {
    const cx = half + half * 0.5, cy = half + half * 0.5;
    const gr = g.createLinearGradient(cx - 42, cy, cx + 42, cy);
    gr.addColorStop(0.0, "rgba(210,220,230,0.0)");
    gr.addColorStop(0.35, "rgba(225,232,240,0.82)");
    gr.addColorStop(0.65, "rgba(40,42,46,0.88)");
    gr.addColorStop(1.0, "rgba(20,22,24,0.0)");
    g.fillStyle = gr;
    g.fillRect(cx - 42, cy - 6, 84, 12);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  return tex;
}

// ---------- Multi-Layer First-Person Muzzle Flash Rig ----------

/**
 * Creates a 3-plane star-cross muzzle flash mesh mounted on VIEW_LAYER with 2x2 randomized atlas frames.
 */
export function createMuzzleFlashRig({ THREE, muzzleAtlasTex, viewLayer = 1 }) {
  const parts = [];
  // Frontal star-burst quad
  const front = new THREE.PlaneGeometry(0.30, 0.30);
  parts.push(front);
  // Two crossed axial blast-plume quads extending forward (-Z) from muzzle
  for (let k = 0; k < 2; k++) {
    const p = new THREE.PlaneGeometry(0.18, 0.34);
    p.rotateX(Math.PI * 0.5);
    p.translate(0, 0, -0.14);
    p.rotateZ(k * Math.PI * 0.5 + 0.35);
    parts.push(p);
  }

  let tv = 0, ti = 0;
  for (const g of parts) { tv += g.attributes.position.count; ti += g.index.count; }
  const pos = new Float32Array(tv * 3);
  const uv = new Float32Array(tv * 2);
  const idx = new Uint16Array(ti);
  let vo = 0, io = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: muzzleAtlasTex },
      uTile: { value: new THREE.Vector2(0, 0) },
      uOpacity: { value: 0.0 },
      uColor: { value: new THREE.Color(1.45, 1.15, 0.72) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec2 uTile;
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        vec2 atlasUv = (vUv + uTile) * 0.5;
        vec4 tex = texture2D(uMap, atlasUv);
        float a = tex.a * uOpacity;
        if (a < 0.01) discard;
        // Selective HDR glow core (white-hot center -> warm amber outer wings)
        vec3 col = tex.rgb * uColor * (1.0 + tex.a * 0.65);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  mat.customProgramCacheKey = () => "vfx_muzzle_flash";

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "viewmodel_muzzle_flash_rig";
  mesh.layers.set(viewLayer);
  mesh.visible = false;
  mesh.frustumCulled = false;

  let timer = 0;
  let duration = 0.048;

  return {
    mesh,
    material: mat,
    trigger(weaponId = "m416") {
      const tileIdx = (Math.random() * 4) | 0;
      mat.uniforms.uTile.value.set(tileIdx & 1, (tileIdx >> 1) & 1);
      mesh.rotation.z = Math.random() * Math.PI * 2;
      const baseScale = weaponId === "sniper" ? 1.38 : weaponId === "pistol" ? 0.62 : 0.96;
      const rScale = 0.76 + Math.random() * 0.48;
      // AWM side-brake widens X/Y slightly; rifle extends forward Z
      const sx = baseScale * rScale * (weaponId === "sniper" ? 1.32 : 1.0);
      const sy = baseScale * rScale * (weaponId === "sniper" ? 0.88 : 1.0);
      const sz = baseScale * rScale * (weaponId === "sniper" ? 1.35 : 1.05);
      mesh.scale.set(sx, sy, sz);
      duration = weaponId === "sniper" ? 0.058 : weaponId === "pistol" ? 0.038 : 0.046;
      timer = duration;
      mat.uniforms.uOpacity.value = 1.0;
      mesh.visible = true;
    },
    update(dt) {
      if (timer <= 0) {
        if (mesh.visible) mesh.visible = false;
        return;
      }
      timer -= dt;
      if (timer <= 0) {
        timer = 0;
        mat.uniforms.uOpacity.value = 0;
        mesh.visible = false;
      } else {
        const k = timer / Math.max(0.01, duration);
        mat.uniforms.uOpacity.value = Math.pow(k, 0.72);
      }
    },
    setWarmupVisible(active) {
      mesh.visible = Boolean(active);
      mat.uniforms.uOpacity.value = active ? 0.85 : 0.0;
      if (!active) timer = 0;
    },
  };
}

// ---------- Main Pooled World Ballistics VFX Engine ----------

export function createBallisticsVfxSystem({ THREE, scene }) {
  const MAX_TRACERS = 32;
  const MAX_SPARKS = 192;
  const MAX_DUST = 160;
  const MAX_DEBRIS = 96;
  const MAX_HOLES = 96;
  const MAX_FLASHES = 24;

  const group = new THREE.Group();
  group.name = "BallisticsVfxGroup";
  scene.add(group);

  const tracerTex = makeTracerTexture(THREE);
  const muzzleAtlasTex = makeMuzzleAtlasTexture(THREE);
  const particleAtlasTex = makeParticleAtlasTexture(THREE);
  const bulletHoleAtlasTex = makeBulletHoleAtlasTexture(THREE);

  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const _dummy = new THREE.Object3D();
  const _vA = new THREE.Vector3();
  const _vB = new THREE.Vector3();
  const _vC = new THREE.Vector3();
  const _qA = new THREE.Quaternion();
  const _qB = new THREE.Quaternion();
  const _col = new THREE.Color();

  let qualityScale = 1.0;
  let maxActiveHoles = MAX_HOLES;
  let muzzleSmokeEnabled = true;
  let waterRipplesEnabled = true;

  // =========================================================================
  // 1. TRACER POOL (32 Cross-Quad Traveling Beams in 1 InstancedMesh)
  // =========================================================================
  const buildCrossTracerGeo = () => {
    const p1 = new THREE.PlaneGeometry(0.044, 1.0);
    p1.translate(0, -0.5, 0); // Head at y=0, tail stretches toward -Y
    const p2 = new THREE.PlaneGeometry(0.044, 1.0);
    p2.rotateY(Math.PI * 0.5);
    p2.translate(0, -0.5, 0);
    const pos = new Float32Array(24);
    const uv = new Float32Array(16);
    pos.set(p1.attributes.position.array, 0);
    pos.set(p2.attributes.position.array, 12);
    uv.set(p1.attributes.uv.array, 0);
    uv.set(p2.attributes.uv.array, 8);
    const idx = new Uint16Array([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
    p1.dispose();
    p2.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  };

  const tracerGeo = buildCrossTracerGeo();
  const tracerParamsArr = new Float32Array(MAX_TRACERS * 4); // (opacity, headDist, tailDist, fadeNearEnd)
  const tracerParamsAttr = new THREE.InstancedBufferAttribute(tracerParamsArr, 4);
  tracerGeo.setAttribute("aTracerParams", tracerParamsAttr);

  const tracerMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tracerTex },
    },
    vertexShader: `
      attribute vec4 aTracerParams;
      varying vec2 vUv;
      varying vec4 vParams;
      varying vec3 vInstCol;
      varying float vCamDist;
      void main() {
        vUv = uv;
        vParams = aTracerParams;
        #ifdef USE_INSTANCING_COLOR
          vInstCol = instanceColor;
        #else
          vInstCol = vec3(1.0, 0.85, 0.62);
        #endif
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vCamDist = length(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec4 vParams;
      varying vec3 vInstCol;
      varying float vCamDist;
      void main() {
        if (vParams.x <= 0.005) discard;
        // CanvasTexture has flipY=true, so vUv.y=1.0 (local head y=0) samples canvas top (white-hot head)
        vec4 tex = texture2D(uMap, vUv);
        // Smooth near-muzzle fade-in (1-2m from barrel) so 1st-person tracers never blind crosshair
        float worldAlong = mix(vParams.z, vParams.y, vUv.y);
        float nearFade = smoothstep(0.45, max(0.55, vParams.w), worldAlong);
        // Distance attenuation for additive fog:false safety (prevents glowing distant fog beams!)
        float distFade = exp(-vCamDist * 0.0068);
        float alpha = tex.a * vParams.x * nearFade * distFade;
        if (alpha < 0.005) discard;
        // Selective HDR glow core (> 1.0 radiance) tinted per weapon/drone
        vec3 col = tex.rgb * vInstCol * vec3(2.45, 2.05, 1.55);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  tracerMat.customProgramCacheKey = () => "vfx_tracer";

  const tracerInst = new THREE.InstancedMesh(tracerGeo, tracerMat, MAX_TRACERS);
  tracerInst.name = "vfx_tracer_pool";
  tracerInst.frustumCulled = false;
  tracerInst.renderOrder = 6;
  group.add(tracerInst);

  const tracers = Array.from({ length: MAX_TRACERS }, () => ({
    active: false,
    ox: 0, oy: 0, oz: 0,
    dx: 0, dy: 0, dz: -1,
    dist: 0, speed: 320, length: 6, width: 1.0,
    t: 0, opacity: 1.0, fadeNearEnd: 2.0,
    quat: new THREE.Quaternion(),
  }));
  let tracerCursor = 0;

  // IMPORTANT (Three.js r128): Populate instanceColor BEFORE setting count = 0,
  // because setColorAt allocates Float32Array(this.count * 3)!
  _dummy.scale.set(0, 0, 0);
  _dummy.updateMatrix();
  _col.setHex(0xffe4a8);
  for (let i = 0; i < MAX_TRACERS; i++) {
    tracerInst.setMatrixAt(i, _dummy.matrix);
    tracerInst.setColorAt(i, _col);
  }
  tracerInst.instanceMatrix.needsUpdate = true;
  if (tracerInst.instanceColor) tracerInst.instanceColor.needsUpdate = true;
  tracerInst.count = 0;
  tracerInst.visible = false;

  // =========================================================================
  // 2. VELOCITY-STRETCHED ADDITIVE SPARKS & WATER DROPLETS (192 slots)
  // =========================================================================
  const sparkGeo = new THREE.PlaneGeometry(0.036, 0.24);
  const sparkAlphaArr = new Float32Array(MAX_SPARKS);
  const sparkAlphaAttr = new THREE.InstancedBufferAttribute(sparkAlphaArr, 1);
  sparkGeo.setAttribute("aAlpha", sparkAlphaAttr);

  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: particleAtlasTex },
    },
    vertexShader: `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vInstCol;
      varying float vCamDist;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        #ifdef USE_INSTANCING_COLOR
          vInstCol = instanceColor;
        #else
          vInstCol = vec3(1.0, 0.85, 0.55);
        #endif
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vCamDist = length(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying float vAlpha;
      varying vec3 vInstCol;
      varying float vCamDist;
      void main() {
        if (vAlpha <= 0.005) discard;
        // Sample Tile (1,0) of particle atlas
        vec2 uvA = vec2(0.5 + vUv.x * 0.5, 0.5 + vUv.y * 0.5);
        vec4 tex = texture2D(uAtlas, uvA);
        float distFade = exp(-vCamDist * 0.0085);
        float a = tex.a * vAlpha * distFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vInstCol * (1.55 + tex.a * 0.85), a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  sparkMat.customProgramCacheKey = () => "vfx_spark";

  const sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  sparkInst.name = "vfx_spark_pool";
  sparkInst.frustumCulled = false;
  sparkInst.renderOrder = 6;
  group.add(sparkInst);

  const sparks = Array.from({ length: MAX_SPARKS }, () => ({
    active: false,
    x: 0, y: -99, z: 0,
    vx: 0, vy: 0, vz: 0,
    age: 0, life: 0.3, gravity: 14.0, drag: 1.5, stretch: 1.0, width: 1.0,
    bounce: 0.42,
  }));
  let sparkCursor = 0;
  for (let i = 0; i < MAX_SPARKS; i++) {
    sparkInst.setMatrixAt(i, _dummy.matrix);
    _col.setHex(0xffe08a);
    sparkInst.setColorAt(i, _col);
  }
  sparkInst.instanceMatrix.needsUpdate = true;
  if (sparkInst.instanceColor) sparkInst.instanceColor.needsUpdate = true;
  sparkInst.count = 0;
  sparkInst.visible = false;

  // =========================================================================
  // 3. SOFT DUST / GUNSMOKE / WATER MIST & FLAT WATER RIPPLES (160 slots, fog:true)
  // =========================================================================
  const dustGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const dustDataArr = new Float32Array(MAX_DUST * 3); // (tileX, tileY, alpha)
  const dustDataAttr = new THREE.InstancedBufferAttribute(dustDataArr, 3);
  dustGeo.setAttribute("aDustData", dustDataAttr);

  const dustMat = new THREE.MeshBasicMaterial({
    map: particleAtlasTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  dustMat.customProgramCacheKey = () => "vfx_dust_alpha";
  dustMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aDustData;\nvarying vec3 vDustData;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDustData = aDustData;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDustData;")
      .replace(
        "#include <map_fragment>",
        `if (vDustData.z <= 0.004) discard;
        vec2 dAtlasUv = vec2((vUv.x + vDustData.x) * 0.5, (vUv.y + (1.0 - vDustData.y)) * 0.5);
        vec4 sampledDiffuseColor = texture2D( map, dAtlasUv );
        diffuseColor *= sampledDiffuseColor;
        diffuseColor.a *= vDustData.z;`,
      );
  };

  const dustInst = new THREE.InstancedMesh(dustGeo, dustMat, MAX_DUST);
  dustInst.name = "vfx_dust_pool";
  dustInst.frustumCulled = false;
  dustInst.renderOrder = 4;
  group.add(dustInst);

  const dustParts = Array.from({ length: MAX_DUST }, () => ({
    active: false,
    x: 0, y: -99, z: 0,
    vx: 0, vy: 0, vz: 0,
    age: 0, life: 0.7,
    size0: 0.14, size1: 0.55,
    alpha0: 0.55, roll: 0, spin: 0,
    drag: 3.5, rise: 0.45,
    tileX: 0, tileY: 0,
    flatHorizontal: false,
  }));
  let dustCursor = 0;
  for (let i = 0; i < MAX_DUST; i++) {
    dustInst.setMatrixAt(i, _dummy.matrix);
    _col.setHex(0xb9b2a5);
    dustInst.setColorAt(i, _col);
  }
  dustInst.instanceMatrix.needsUpdate = true;
  if (dustInst.instanceColor) dustInst.instanceColor.needsUpdate = true;
  dustInst.count = 0;
  dustInst.visible = false;

  // =========================================================================
  // 4. 3D TUMBLING BOUNCING DEBRIS CHIPS (Concrete / Wood Splinters / Dirt, 96 slots)
  // =========================================================================
  const debrisGeo = new THREE.TetrahedronGeometry(0.019, 0);
  const debrisMat = new THREE.MeshStandardMaterial({
    roughness: 0.90,
    metalness: 0.04,
    fog: true,
  });
  const debrisInst = new THREE.InstancedMesh(debrisGeo, debrisMat, MAX_DEBRIS);
  debrisInst.name = "vfx_debris_pool";
  debrisInst.frustumCulled = false;
  debrisInst.castShadow = false;
  debrisInst.receiveShadow = false;
  group.add(debrisInst);

  const debris = Array.from({ length: MAX_DEBRIS }, () => ({
    active: false,
    x: 0, y: -99, z: 0,
    vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0,
    vrx: 0, vry: 0, vrz: 0,
    sx: 1, sy: 1, sz: 1,
    age: 0, life: 0.85,
  }));
  let debrisCursor = 0;
  for (let i = 0; i < MAX_DEBRIS; i++) {
    debrisInst.setMatrixAt(i, _dummy.matrix);
    _col.setHex(0x9e978b);
    debrisInst.setColorAt(i, _col);
  }
  debrisInst.instanceMatrix.needsUpdate = true;
  if (debrisInst.instanceColor) debrisInst.instanceColor.needsUpdate = true;
  debrisInst.count = 0;
  debrisInst.visible = false;

  // =========================================================================
  // 5. BULLET HOLE RING BUFFER (96 decals in 1 InstancedMesh, 2x2 atlas)
  // =========================================================================
  const holeGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const holeTileArr = new Float32Array(MAX_HOLES * 3); // (tileX, tileY, visibleAlpha)
  const holeTileAttr = new THREE.InstancedBufferAttribute(holeTileArr, 3);
  holeGeo.setAttribute("aHoleTile", holeTileAttr);

  const holeMat = new THREE.MeshBasicMaterial({
    map: bulletHoleAtlasTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: true,
  });
  holeMat.customProgramCacheKey = () => "vfx_bullet_hole";
  holeMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aHoleTile;\nvarying vec3 vHoleTile;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHoleTile = aHoleTile;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHoleTile;")
      .replace(
        "#include <map_fragment>",
        `if (vHoleTile.z <= 0.01) discard;
        vec2 hAtlasUv = vec2((vUv.x + vHoleTile.x) * 0.5, (vUv.y + (1.0 - vHoleTile.y)) * 0.5);
        vec4 sampledDiffuseColor = texture2D( map, hAtlasUv );
        diffuseColor *= sampledDiffuseColor;
        diffuseColor.a *= vHoleTile.z;`,
      );
  };

  const holeInst = new THREE.InstancedMesh(holeGeo, holeMat, MAX_HOLES);
  holeInst.name = "vfx_bullet_hole_pool";
  holeInst.frustumCulled = false;
  holeInst.renderOrder = 2;
  holeInst.count = 0;
  holeInst.visible = false;
  group.add(holeInst);

  let holeCursor = 0;
  let activeHoleCount = 0;
  for (let i = 0; i < MAX_HOLES; i++) holeInst.setMatrixAt(i, _dummy.matrix);
  holeInst.instanceMatrix.needsUpdate = true;

  // =========================================================================
  // 6. METAL IMPACT FLASH CORONA POOL (24 slots, brief 45ms additive burst)
  // =========================================================================
  const flashGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const flashAlphaArr = new Float32Array(MAX_FLASHES);
  const flashAlphaAttr = new THREE.InstancedBufferAttribute(flashAlphaArr, 1);
  flashGeo.setAttribute("aAlpha", flashAlphaAttr);

  const flashMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: muzzleAtlasTex } },
    vertexShader: `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vCamDist;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vCamDist = length(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vCamDist;
      void main() {
        if (vAlpha <= 0.01) discard;
        vec4 tex = texture2D(uMap, vUv * 0.5);
        float a = tex.a * vAlpha * exp(-vCamDist * 0.008);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(2.3, 1.85, 1.15) * tex.rgb, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  flashMat.customProgramCacheKey = () => "vfx_impact_flash";

  const flashInst = new THREE.InstancedMesh(flashGeo, flashMat, MAX_FLASHES);
  flashInst.name = "vfx_impact_flash_pool";
  flashInst.frustumCulled = false;
  flashInst.renderOrder = 6;
  flashInst.count = 0;
  flashInst.visible = false;
  group.add(flashInst);

  const impactFlashes = Array.from({ length: MAX_FLASHES }, () => ({
    active: false, x: 0, y: -99, z: 0, age: 0, life: 0.05, size: 0.24, roll: 0,
  }));
  let flashCursor = 0;
  for (let i = 0; i < MAX_FLASHES; i++) flashInst.setMatrixAt(i, _dummy.matrix);
  flashInst.instanceMatrix.needsUpdate = true;

  // ---------- Spawn Functions (Zero-Allocation Ring Buffers) ----------

  function spawnTracer(origin, hitPoint, {
    speed = 320,
    length = 6.0,
    width = 1.0,
    opacity = 0.88,
    fadeNearEnd = 1.9,
    colorHex = 0xffe4a8,
  } = {}) {
    const dx = hitPoint.x - origin.x;
    const dy = hitPoint.y - origin.y;
    const dz = hitPoint.z - origin.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.35) return;

    const i = tracerCursor;
    const slot = tracers[i];
    tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
    slot.active = true;
    slot.ox = origin.x;
    slot.oy = origin.y;
    slot.oz = origin.z;
    slot.dx = dx / dist;
    slot.dy = dy / dist;
    slot.dz = dz / dist;
    slot.dist = dist;
    slot.speed = speed;
    slot.length = Math.min(length, Math.max(0.8, dist * 0.72));
    slot.width = width;
    slot.t = Math.min(dist, 0.35);
    slot.opacity = opacity;
    slot.fadeNearEnd = fadeNearEnd;
    _vA.set(slot.dx, slot.dy, slot.dz);
    slot.quat.setFromUnitVectors(Y_AXIS, _vA);
    _col.setHex(colorHex);
    tracerInst.setColorAt(i, _col);
    if (tracerInst.instanceColor) tracerInst.instanceColor.needsUpdate = true;
    if (i + 1 > tracerInst.count) tracerInst.count = i + 1;
    tracerInst.visible = true;
  }

  function spawnSparkParticle(x, y, z, vx, vy, vz, {
    colorHex = 0xffe08a,
    life = 0.28,
    gravity = 14.0,
    drag = 1.4,
    stretch = 1.0,
    width = 1.0,
    bounce = 0.42,
  } = {}) {
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
    const p = sparks[i];
    p.active = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0; p.life = life;
    p.gravity = gravity; p.drag = drag;
    p.stretch = stretch; p.width = width;
    p.bounce = bounce;
    _col.setHex(colorHex);
    sparkInst.setColorAt(i, _col);
    if (sparkInst.instanceColor) sparkInst.instanceColor.needsUpdate = true;
  }

  function spawnDustParticle(x, y, z, vx, vy, vz, {
    colorHex = 0xb9b2a5,
    life = 0.72,
    size0 = 0.14,
    size1 = 0.56,
    alpha0 = 0.52,
    drag = 3.2,
    rise = 0.38,
    tileX = 0,
    tileY = 0,
    flatHorizontal = false,
  } = {}) {
    const i = dustCursor;
    dustCursor = (dustCursor + 1) % MAX_DUST;
    const p = dustParts[i];
    p.active = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0; p.life = life;
    p.size0 = size0; p.size1 = size1;
    p.alpha0 = alpha0;
    p.roll = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * 2.2;
    p.drag = drag; p.rise = rise;
    p.tileX = tileX; p.tileY = tileY;
    p.flatHorizontal = flatHorizontal;
    _col.setHex(colorHex);
    dustInst.setColorAt(i, _col);
    if (dustInst.instanceColor) dustInst.instanceColor.needsUpdate = true;
  }

  function spawnDebrisChunk(x, y, z, vx, vy, vz, {
    colorHex = 0x8e887d,
    life = 0.85,
    scale = 1.0,
    stretch = 1.0,
  } = {}) {
    const i = debrisCursor;
    debrisCursor = (debrisCursor + 1) % MAX_DEBRIS;
    const d = debris[i];
    d.active = true;
    d.x = x; d.y = y; d.z = z;
    d.vx = vx; d.vy = vy; d.vz = vz;
    d.rx = Math.random() * 6.28;
    d.ry = Math.random() * 6.28;
    d.rz = Math.random() * 6.28;
    d.vrx = (Math.random() - 0.5) * 18;
    d.vry = (Math.random() - 0.5) * 18;
    d.vrz = (Math.random() - 0.5) * 18;
    d.sx = scale * (0.7 + Math.random() * 0.6);
    d.sy = scale * (0.65 + Math.random() * 0.55) * stretch;
    d.sz = scale * (0.65 + Math.random() * 0.55);
    d.age = 0; d.life = life;
    _col.setHex(colorHex);
    debrisInst.setColorAt(i, _col);
    if (debrisInst.instanceColor) debrisInst.instanceColor.needsUpdate = true;
  }

  function placeBulletHole(point, normal, tileIdx = 0) {
    if (tileIdx < 0 || maxActiveHoles <= 0) return;
    const cap = Math.min(MAX_HOLES, maxActiveHoles);
    const i = holeCursor % cap;
    holeCursor = (holeCursor + 1) % cap;
    activeHoleCount = Math.min(cap, activeHoleCount + 1);

    _vA.set(normal.x, normal.y, normal.z).normalize();
    _dummy.position.set(
      point.x + _vA.x * 0.009,
      point.y + _vA.y * 0.009,
      point.z + _vA.z * 0.009,
    );
    _dummy.quaternion.setFromUnitVectors(Z_AXIS, _vA);
    _dummy.rotateZ(Math.random() * Math.PI * 2);
    const sc = tileIdx === 3 ? (0.11 + Math.random() * 0.05) : (0.072 + Math.random() * 0.042);
    _dummy.scale.set(sc, sc, 1);
    _dummy.updateMatrix();
    holeInst.setMatrixAt(i, _dummy.matrix);
    holeInst.instanceMatrix.needsUpdate = true;

    holeTileArr[i * 3] = tileIdx & 1;
    holeTileArr[i * 3 + 1] = (tileIdx >> 1) & 1;
    holeTileArr[i * 3 + 2] = 0.94;
    holeTileAttr.needsUpdate = true;
    holeInst.count = Math.min(cap, Math.max(holeInst.count, i + 1));
    holeInst.visible = true;
  }

  function spawnImpactFlash(point, normal, size = 0.28) {
    const i = flashCursor;
    flashCursor = (flashCursor + 1) % MAX_FLASHES;
    const f = impactFlashes[i];
    f.active = true;
    f.x = point.x + normal.x * 0.04;
    f.y = point.y + normal.y * 0.04;
    f.z = point.z + normal.z * 0.04;
    f.age = 0;
    f.life = 0.048;
    f.size = size * (0.8 + Math.random() * 0.45);
    f.roll = Math.random() * Math.PI * 2;
  }

  // Random vector scattered inside cone around unit axis (ax, ay, az)
  function scatterCone(ax, ay, az, spread, minSpd, maxSpd, out) {
    const spd = minSpd + Math.random() * (maxSpd - minSpd);
    const rx = ax + (Math.random() - 0.5) * spread * 2;
    const ry = ay + (Math.random() - 0.5) * spread * 2;
    const rz = az + (Math.random() - 0.5) * spread * 2;
    const l = Math.hypot(rx, ry, rz) || 1;
    out.set((rx / l) * spd, (ry / l) * spd, (rz / l) * spd);
    return out;
  }

  function spawnMuzzleSmokeAndSparks(origin, dir, weaponId = "m416") {
    const smokeCount = muzzleSmokeEnabled ? Math.max(1, Math.round((weaponId === "sniper" ? 3 : 2) * qualityScale)) : 0;
    for (let k = 0; k < smokeCount; k++) {
      scatterCone(dir.x, dir.y + 0.25, dir.z, 0.55, 0.55, 1.35, _vB);
      spawnDustParticle(
        origin.x + dir.x * 0.08,
        origin.y + dir.y * 0.08,
        origin.z + dir.z * 0.08,
        _vB.x,
        _vB.y + 0.35,
        _vB.z,
        {
          colorHex: 0xc2c6cc,
          life: 0.45 + Math.random() * 0.30,
          size0: weaponId === "sniper" ? 0.14 : 0.09,
          size1: weaponId === "sniper" ? 0.52 : 0.34,
          alpha0: 0.24,
          drag: 4.5,
          rise: 0.55,
          tileX: 0,
          tileY: 0,
        },
      );
    }
    const sparkCount = Math.max(1, Math.round((weaponId === "sniper" ? 5 : weaponId === "pistol" ? 2 : 3) * qualityScale));
    for (let k = 0; k < sparkCount; k++) {
      scatterCone(dir.x, dir.y, dir.z, 0.26, 6.5, 13.5, _vB);
      spawnSparkParticle(
        origin.x + dir.x * 0.06,
        origin.y + dir.y * 0.06,
        origin.z + dir.z * 0.06,
        _vB.x,
        _vB.y,
        _vB.z,
        {
          colorHex: 0xffd578,
          life: 0.08 + Math.random() * 0.09,
          gravity: 8.5,
          drag: 3.5,
          stretch: 0.9,
          width: 0.72,
          bounce: 0.2,
        },
      );
    }
  }

  /**
   * Main surface-aware bullet impact handler. Returns { surface, ricochet } for audio sync.
   */
  function spawnSurfaceImpact({
    point,
    normal,
    incomingDir,
    surface = "concrete",
    seed = Math.random() * 999999,
    weaponId = "m416",
  }) {
    const safeSurface = SURFACE_FX[surface] ? surface : "concrete";
    const fx = SURFACE_FX[safeSurface];
    const nl = Math.hypot(normal.x, normal.y, normal.z) || 1;
    const nx = normal.x / nl, ny = normal.y / nl, nz = normal.z / nl;
    const dl = Math.hypot(incomingDir.x, incomingDir.y, incomingDir.z) || 1;
    const dx = incomingDir.x / dl, dy = incomingDir.y / dl, dz = incomingDir.z / dl;

    const powerScale = weaponId === "sniper" ? 1.32 : weaponId === "pistol" ? 0.82 : 1.0;
    const ricochet = computeRicochetEligibility(dx, dy, dz, nx, ny, nz, safeSurface, seededUnit(seed, 31));

    // 1. Persistent bullet hole decal (use graze tile 3 on metal ricochet!)
    if (fx.holeTile >= 0) {
      placeBulletHole(point, { x: nx, y: ny, z: nz }, ricochet ? 3 : fx.holeTile);
    }

    // 2. Brief additive impact flash on metal hits
    if (fx.impactFlash) {
      spawnImpactFlash(point, { x: nx, y: ny, z: nz }, 0.30 * powerScale);
    }

    // 3. Directional Dust / Wood Sawdust / Dirt Plume / Water Spray Mist (along surface normal)
    const dustCount = fx.dustCount > 0 ? Math.max(1, Math.round(fx.dustCount * qualityScale * powerScale)) : 0;
    for (let k = 0; k < dustCount; k++) {
      const isWater = safeSurface === "water";
      const ax = isWater ? nx * 0.35 : nx;
      const ay = isWater ? 1.0 : ny + 0.18;
      const az = isWater ? nz * 0.35 : nz;
      scatterCone(ax, ay, az, isWater ? 0.42 : 0.68, isWater ? 1.8 : 0.9, isWater ? 4.4 : 2.9, _vB);
      spawnDustParticle(
        point.x + nx * 0.04,
        point.y + ny * 0.04,
        point.z + nz * 0.04,
        _vB.x,
        _vB.y,
        _vB.z,
        {
          colorHex: fx.dustColor,
          life: (isWater ? 0.38 : 0.56) + Math.random() * 0.38,
          size0: (isWater ? 0.12 : 0.15) * powerScale,
          size1: (isWater ? 0.48 : 0.62) * powerScale,
          alpha0: isWater ? 0.62 : 0.54,
          drag: isWater ? 4.2 : 3.2,
          rise: isWater ? -1.4 : 0.35,
          tileX: 0,
          tileY: isWater ? 1 : 0,
        },
      );
    }

    // 4. Water Expanding Ripple Rings on puddle surface
    if (fx.waterRipple && waterRipplesEnabled) {
      for (let r = 0; r < 2; r++) {
        spawnDustParticle(
          point.x,
          Math.max(0.025, point.y + 0.025),
          point.z,
          0, 0, 0,
          {
            colorHex: 0xeaf6ff,
            life: 0.62 + r * 0.24,
            size0: 0.16 + r * 0.10,
            size1: 0.95 + r * 0.42,
            alpha0: 0.82 - r * 0.18,
            drag: 0,
            rise: 0,
            tileX: 1,
            tileY: 1,
            flatHorizontal: true,
          },
        );
      }
    }

    // 5. Directional Reflection Sparks (metal) or Parabolic Water Splash Droplets (water)
    const sparkCount = fx.sparksCount > 0 ? Math.max(1, Math.round(fx.sparksCount * qualityScale * powerScale)) : 0;
    if (sparkCount > 0) {
      const refl = computeReflectionDir(dx, dy, dz, nx, ny, nz);
      const isWater = safeSurface === "water";
      for (let k = 0; k < sparkCount; k++) {
        const ax = isWater ? refl.x * 0.28 : refl.x;
        const ay = isWater ? 0.96 : Math.max(0.12, refl.y + 0.14);
        const az = isWater ? refl.z * 0.28 : refl.z;
        scatterCone(
          ax, ay, az,
          isWater ? 0.48 : 0.42,
          isWater ? 2.6 : 4.2,
          isWater ? 6.2 : 11.5,
          _vB,
        );
        spawnSparkParticle(
          point.x + nx * 0.03,
          point.y + ny * 0.03,
          point.z + nz * 0.03,
          _vB.x,
          _vB.y,
          _vB.z,
          {
            colorHex: fx.sparkColor,
            life: (isWater ? 0.26 : 0.20) + Math.random() * 0.20,
            gravity: isWater ? 15.5 : 14.0,
            drag: isWater ? 1.8 : 1.2,
            stretch: isWater ? 0.75 : 1.25,
            width: isWater ? 1.2 : 0.9,
            bounce: isWater ? 0.0 : 0.46,
          },
        );
      }

      // 6. Ricochet mini-tracer bouncing away from metallic surface
      if (ricochet) {
        scatterCone(refl.x, Math.max(0.04, refl.y), refl.z, 0.12, 10.0, 18.0, _vB);
        spawnTracer(
          { x: point.x + nx * 0.04, y: point.y + ny * 0.04, z: point.z + nz * 0.04 },
          { x: point.x + _vB.x, y: point.y + _vB.y, z: point.z + _vB.z },
          { speed: 240, length: 3.4, width: 0.75, opacity: 0.62, fadeNearEnd: 0.4 },
        );
      }
    }

    // 7. Bouncing Solid Debris (Concrete chunks, Wood splinters, Dirt clods)
    const debrisCount = fx.debrisCount > 0 ? Math.max(1, Math.round(fx.debrisCount * qualityScale * powerScale)) : 0;
    for (let k = 0; k < debrisCount; k++) {
      scatterCone(nx, ny + 0.38, nz, 0.72, 1.8, 5.4, _vB);
      spawnDebrisChunk(
        point.x + nx * 0.04,
        point.y + ny * 0.04,
        point.z + nz * 0.04,
        _vB.x,
        _vB.y,
        _vB.z,
        {
          colorHex: fx.debrisColor,
          life: 0.62 + Math.random() * 0.45,
          scale: (0.75 + Math.random() * 0.55) * powerScale,
          stretch: fx.debrisStretch,
        },
      );
    }

    return { surface: safeSurface, ricochet, sound: fx.sound };
  }

  /**
   * High-energy spark burst for Drone explosions & enemy metallic drone hits.
   */
  function spawnBurstSparks(point, count = 12, speed = 4.0, colorHex = 0xffb85c) {
    const n = Math.max(2, Math.round(count * qualityScale));
    for (let k = 0; k < n; k++) {
      scatterCone(0, 0.45, 0, 1.25, speed * 0.45, speed * 1.35, _vB);
      spawnSparkParticle(point.x, point.y, point.z, _vB.x, _vB.y, _vB.z, {
        colorHex,
        life: 0.24 + Math.random() * 0.26,
        gravity: 11.5,
        drag: 1.8,
        stretch: 1.15,
        width: 1.1,
        bounce: 0.4,
      });
    }
    if (count >= 25) {
      spawnImpactFlash(point, { x: 0, y: 1, z: 0 }, 1.15);
      for (let k = 0; k < Math.max(3, Math.round(7 * qualityScale)); k++) {
        scatterCone(0, 0.55, 0, 1.1, 1.2, 3.6, _vB);
        spawnDustParticle(point.x, point.y, point.z, _vB.x, _vB.y, _vB.z, {
          colorHex: 0x3b3835,
          life: 0.75 + Math.random() * 0.45,
          size0: 0.35,
          size1: 1.45,
          alpha0: 0.65,
          drag: 2.4,
          rise: 0.85,
        });
      }
    }
  }

  // ---------- Per-Frame Pool Stepper (Zero Allocations) ----------

  function update(dt, camera) {
    const camQuat = camera ? camera.quaternion : _qA.identity();

    // 1. Update traveling cross-quad tracers
    let tracerDirty = false;
    let maxTracerIdx = -1;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const tr = tracers[i];
      if (!tr.active) continue;
      tracerDirty = true;
      tr.t += tr.speed * dt;
      const head = Math.min(tr.t, tr.dist);
      const tail = Math.max(0, tr.t - tr.length);
      if (tail >= tr.dist) {
        tr.active = false;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        tracerInst.setMatrixAt(i, _dummy.matrix);
        tracerParamsArr[i * 4] = 0;
        continue;
      }
      maxTracerIdx = i;
      const segLen = Math.max(0.05, head - tail);
      _dummy.position.set(
        tr.ox + tr.dx * head,
        tr.oy + tr.dy * head,
        tr.oz + tr.dz * head,
      );
      _dummy.quaternion.copy(tr.quat);
      _dummy.scale.set(tr.width, segLen, tr.width);
      _dummy.updateMatrix();
      tracerInst.setMatrixAt(i, _dummy.matrix);
      tracerParamsArr[i * 4] = tr.opacity;
      tracerParamsArr[i * 4 + 1] = head;
      tracerParamsArr[i * 4 + 2] = tail;
      tracerParamsArr[i * 4 + 3] = tr.fadeNearEnd;
    }
    if (tracerDirty) {
      tracerInst.instanceMatrix.needsUpdate = true;
      tracerParamsAttr.needsUpdate = true;
      tracerInst.count = maxTracerIdx + 1;
      tracerInst.visible = maxTracerIdx >= 0;
    }

    // 2. Update velocity-stretched sparks & water droplets
    let sparkDirty = false;
    let maxSparkIdx = -1;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const p = sparks[i];
      if (!p.active) continue;
      sparkDirty = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        sparkInst.setMatrixAt(i, _dummy.matrix);
        sparkAlphaArr[i] = 0;
        continue;
      }
      const dragK = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragK;
      p.vz *= dragK;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.025 && p.vy < 0) {
        p.y = 0.025;
        if (p.bounce > 0.05) {
          p.vy = -p.vy * p.bounce;
          p.vx *= 0.72;
          p.vz *= 0.72;
        } else {
          p.active = false;
          _dummy.scale.set(0, 0, 0);
          _dummy.updateMatrix();
          sparkInst.setMatrixAt(i, _dummy.matrix);
          sparkAlphaArr[i] = 0;
          continue;
        }
      }
      maxSparkIdx = i;
      const spd = Math.hypot(p.vx, p.vy, p.vz) || 0.01;
      const lifeK = 1 - p.age / p.life;
      // Align stretched spark quad along velocity vector, facing camera around its axis
      _vA.set(p.vx / spd, p.vy / spd, p.vz / spd);
      _dummy.position.set(p.x, p.y, p.z);
      _dummy.quaternion.setFromUnitVectors(Y_AXIS, _vA);
      if (camera) {
        _vB.subVectors(camera.position, _dummy.position);
        // Project view vector perpendicular to velocity axis so spark never goes edge-on thin
        const proj = _vB.dot(_vA);
        _vB.addScaledVector(_vA, -proj);
        if (_vB.lengthSq() > 1e-5) {
          _vB.normalize();
          _vC.crossVectors(_vA, _vB).normalize();
          _dummy.matrix.makeBasis(_vC, _vA, _vB);
          _dummy.quaternion.setFromRotationMatrix(_dummy.matrix);
        }
      }
      const lenScale = Math.max(0.28, Math.min(2.6, spd * 0.16 * p.stretch));
      _dummy.scale.set(p.width * (0.45 + 0.55 * lifeK), lenScale, 1);
      _dummy.updateMatrix();
      sparkInst.setMatrixAt(i, _dummy.matrix);
      sparkAlphaArr[i] = Math.pow(lifeK, 0.65);
    }
    if (sparkDirty) {
      sparkInst.instanceMatrix.needsUpdate = true;
      sparkAlphaAttr.needsUpdate = true;
      sparkInst.count = maxSparkIdx + 1;
      sparkInst.visible = maxSparkIdx >= 0;
    }

    // 3. Update soft dust / smoke / water mist & expanding horizontal puddle ripples
    let dustDirty = false;
    let maxDustIdx = -1;
    for (let i = 0; i < MAX_DUST; i++) {
      const p = dustParts[i];
      if (!p.active) continue;
      dustDirty = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        dustInst.setMatrixAt(i, _dummy.matrix);
        dustDataArr[i * 3 + 2] = 0;
        continue;
      }
      maxDustIdx = i;
      const t = p.age / p.life;
      if (!p.flatHorizontal) {
        const dragK = Math.max(0, 1 - p.drag * dt);
        p.vx *= dragK;
        p.vy = p.vy * dragK + p.rise * dt;
        p.vz *= dragK;
        p.x += p.vx * dt;
        p.y = Math.max(0.03, p.y + p.vy * dt);
        p.z += p.vz * dt;
        p.roll += p.spin * dt;
      }
      const curSize = p.size0 + (p.size1 - p.size0) * Math.pow(t, 0.72);
      const fadeIn = Math.min(1, t * 7.5);
      const fadeOut = Math.pow(1 - t, 1.35);
      _dummy.position.set(p.x, p.y, p.z);
      if (p.flatHorizontal) {
        _dummy.rotation.set(-Math.PI * 0.5, 0, p.roll);
      } else {
        _dummy.quaternion.copy(camQuat);
        _qB.setFromAxisAngle(Z_AXIS, p.roll);
        _dummy.quaternion.multiply(_qB);
      }
      _dummy.scale.set(curSize, curSize, 1);
      _dummy.updateMatrix();
      dustInst.setMatrixAt(i, _dummy.matrix);
      dustDataArr[i * 3] = p.tileX;
      dustDataArr[i * 3 + 1] = p.tileY;
      dustDataArr[i * 3 + 2] = p.alpha0 * fadeIn * fadeOut;
    }
    if (dustDirty) {
      dustInst.instanceMatrix.needsUpdate = true;
      dustDataAttr.needsUpdate = true;
      dustInst.count = maxDustIdx + 1;
      dustInst.visible = maxDustIdx >= 0;
    }

    // 4. Update 3D tumbling debris chunks
    let debrisDirty = false;
    let maxDebrisIdx = -1;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = debris[i];
      if (!d.active) continue;
      debrisDirty = true;
      d.age += dt;
      if (d.age >= d.life) {
        d.active = false;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        debrisInst.setMatrixAt(i, _dummy.matrix);
        continue;
      }
      maxDebrisIdx = i;
      d.vy -= 15.0 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rx += d.vrx * dt;
      d.ry += d.vry * dt;
      d.rz += d.vrz * dt;
      if (d.y < 0.025 && d.vy < 0) {
        d.y = 0.025;
        d.vy = -d.vy * 0.34;
        d.vx *= 0.62;
        d.vz *= 0.62;
        d.vrx *= 0.55;
        d.vry *= 0.55;
        d.vrz *= 0.55;
      }
      const shrink = d.age > d.life * 0.72 ? Math.max(0, 1 - (d.age - d.life * 0.72) / (d.life * 0.28)) : 1;
      _dummy.position.set(d.x, d.y, d.z);
      _dummy.rotation.set(d.rx, d.ry, d.rz);
      _dummy.scale.set(d.sx * shrink, d.sy * shrink, d.sz * shrink);
      _dummy.updateMatrix();
      debrisInst.setMatrixAt(i, _dummy.matrix);
    }
    if (debrisDirty) {
      debrisInst.instanceMatrix.needsUpdate = true;
      debrisInst.count = maxDebrisIdx + 1;
      debrisInst.visible = maxDebrisIdx >= 0;
    }

    // 5. Update brief metal impact flashes
    let flashDirty = false;
    let maxFlashIdx = -1;
    for (let i = 0; i < MAX_FLASHES; i++) {
      const f = impactFlashes[i];
      if (!f.active) continue;
      flashDirty = true;
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        flashInst.setMatrixAt(i, _dummy.matrix);
        flashAlphaArr[i] = 0;
        continue;
      }
      maxFlashIdx = i;
      const k = 1 - f.age / f.life;
      _dummy.position.set(f.x, f.y, f.z);
      _dummy.quaternion.copy(camQuat);
      _qB.setFromAxisAngle(Z_AXIS, f.roll);
      _dummy.quaternion.multiply(_qB);
      const sc = f.size * (0.65 + 0.55 * k);
      _dummy.scale.set(sc, sc, 1);
      _dummy.updateMatrix();
      flashInst.setMatrixAt(i, _dummy.matrix);
      flashAlphaArr[i] = k;
    }
    if (flashDirty) {
      flashInst.instanceMatrix.needsUpdate = true;
      flashAlphaAttr.needsUpdate = true;
      flashInst.count = maxFlashIdx + 1;
      flashInst.visible = maxFlashIdx >= 0;
    }
  }

  function clear() {
    _dummy.scale.set(0, 0, 0);
    _dummy.updateMatrix();
    for (let i = 0; i < MAX_TRACERS; i++) {
      tracers[i].active = false;
      tracerInst.setMatrixAt(i, _dummy.matrix);
      tracerParamsArr[i * 4] = 0;
    }
    for (let i = 0; i < MAX_SPARKS; i++) {
      sparks[i].active = false;
      sparkInst.setMatrixAt(i, _dummy.matrix);
      sparkAlphaArr[i] = 0;
    }
    for (let i = 0; i < MAX_DUST; i++) {
      dustParts[i].active = false;
      dustInst.setMatrixAt(i, _dummy.matrix);
      dustDataArr[i * 3 + 2] = 0;
    }
    for (let i = 0; i < MAX_DEBRIS; i++) {
      debris[i].active = false;
      debrisInst.setMatrixAt(i, _dummy.matrix);
    }
    for (let i = 0; i < MAX_HOLES; i++) {
      holeInst.setMatrixAt(i, _dummy.matrix);
      holeTileArr[i * 3 + 2] = 0;
    }
    for (let i = 0; i < MAX_FLASHES; i++) {
      impactFlashes[i].active = false;
      flashInst.setMatrixAt(i, _dummy.matrix);
      flashAlphaArr[i] = 0;
    }
    tracerCursor = 0;
    sparkCursor = 0;
    dustCursor = 0;
    debrisCursor = 0;
    flashCursor = 0;
    holeCursor = 0;
    activeHoleCount = 0;
    tracerInst.count = 0; tracerInst.visible = false;
    sparkInst.count = 0; sparkInst.visible = false;
    dustInst.count = 0; dustInst.visible = false;
    debrisInst.count = 0; debrisInst.visible = false;
    holeInst.count = 0; holeInst.visible = false;
    flashInst.count = 0; flashInst.visible = false;
    tracerInst.instanceMatrix.needsUpdate = true;
    tracerParamsAttr.needsUpdate = true;
    sparkInst.instanceMatrix.needsUpdate = true;
    sparkAlphaAttr.needsUpdate = true;
    dustInst.instanceMatrix.needsUpdate = true;
    dustDataAttr.needsUpdate = true;
    debrisInst.instanceMatrix.needsUpdate = true;
    holeInst.instanceMatrix.needsUpdate = true;
    holeTileAttr.needsUpdate = true;
    flashInst.instanceMatrix.needsUpdate = true;
    flashAlphaAttr.needsUpdate = true;
  }

  function applyQualityPreset(preset = {}) {
    qualityScale = Number.isFinite(preset.vfxScale) ? preset.vfxScale : 1.0;
    maxActiveHoles = Number.isFinite(preset.maxBulletHoles) ? preset.maxBulletHoles : MAX_HOLES;
    muzzleSmokeEnabled = preset.muzzleSmokeEnabled !== false;
    waterRipplesEnabled = preset.waterRipplesEnabled !== false;
    // Hide excess decals beyond preset cap without reallocating pool
    let holesChanged = false;
    for (let i = maxActiveHoles; i < MAX_HOLES; i++) {
      if (holeTileArr[i * 3 + 2] > 0) {
        holeTileArr[i * 3 + 2] = 0;
        _dummy.scale.set(0, 0, 0);
        _dummy.updateMatrix();
        holeInst.setMatrixAt(i, _dummy.matrix);
        holesChanged = true;
      }
    }
    activeHoleCount = Math.min(activeHoleCount, maxActiveHoles);
    holeInst.count = Math.min(holeInst.count, maxActiveHoles);
    holeInst.visible = activeHoleCount > 0;
    if (holesChanged) {
      holeInst.instanceMatrix.needsUpdate = true;
      holeTileAttr.needsUpdate = true;
    }
  }

  /**
   * Expose 1 active instance per pool behind Loading Screen so every VFX shader compiles upfront (0 first-shot hitch!).
   */
  function setWarmupPassActive(active, camPos = { x: 0, y: 1.7, z: -40 }, forwardZ = 1) {
    if (active) {
      clear();
      const z = (camPos.z || 0) + forwardZ * 6.0;
      spawnTracer({ x: camPos.x - 0.5, y: 1.5, z: z - 2 }, { x: camPos.x + 0.5, y: 1.5, z: z + 2 }, { speed: 1, length: 2 });
      spawnSparkParticle(camPos.x, 1.5, z, 0, 1, 0, { life: 1.0 });
      spawnDustParticle(camPos.x, 1.5, z, 0, 0, 0, { life: 1.0 });
      spawnDebrisChunk(camPos.x, 1.5, z, 0, 0, 0, { life: 1.0 });
      placeBulletHole({ x: camPos.x, y: 1.5, z }, { x: 0, y: 0, z: -forwardZ }, 0);
      spawnImpactFlash({ x: camPos.x, y: 1.5, z }, { x: 0, y: 0, z: -forwardZ }, 0.25);
      update(0.016, null);
      return;
    }
    clear();
  }

  return {
    group,
    muzzleAtlasTex,
    extraTextures: [tracerTex, muzzleAtlasTex, particleAtlasTex, bulletHoleAtlasTex],
    spawnTracer,
    spawnMuzzleSmokeAndSparks,
    spawnSurfaceImpact,
    spawnBurstSparks,
    placeBulletHole,
    update,
    clear,
    applyQualityPreset,
    setWarmupPassActive,
    getStats: () => ({
      activeTracers: tracers.reduce((n, t) => n + (t.active ? 1 : 0), 0),
      activeSparks: sparks.reduce((n, p) => n + (p.active ? 1 : 0), 0),
      activeDust: dustParts.reduce((n, p) => n + (p.active ? 1 : 0), 0),
      activeDebris: debris.reduce((n, d) => n + (d.active ? 1 : 0), 0),
      activeHoles: activeHoleCount,
      maxActiveHoles,
      qualityScale,
    }),
  };
}
