/**
 * MapLoader for Khu Quân Sự Cũ 5v5 (v3.1 Performance + 3-Tier Quality):
 * - Balanced ~3.5:1 sun-to-ambient lighting, toned PMREM IBL, layered height fog & aerial perspective
 * - Pre-baked 512x512 world-space ground mask (replaces 14-octave per-pixel FBM with 1 texture fetch!)
 * - Consolidated GLSL customProgramCacheKey (~7 shared programs instead of 54!)
 * - Runtime applyQualityPreset() controlling shadows, post-grade/atmosphere, grass density, tree draw distance & fog length
 */

import { buildTriangleBVH, createMapCollision } from "/js/map_collision.js";
import { MILITARY_COLLIDERS, MILITARY_LAYOUT } from "/js/military_map_data.js";
import { QUALITY_PRESETS, updateTexturesAnisotropyInPlace } from "/js/graphics_quality.js";
import { yieldToUI } from "/js/loading_manager.js";
import {
  MILITARY_FOG_HEX,
  MILITARY_SUN_FOG_HEX,
  buildMilitaryEnvironmentGroupAsync,
  buildMilitaryGodRaysAndDust,
  buildMilitarySkySystemAsync,
} from "/js/military_environment.js";

// Rich weathered military tones (deep saturation without pastel washout or crushed blacks)
const CONTAINER_PALETTE = [0x86382b, 0x47573d, 0x384e5e];
const BARREL_PALETTE = [0x445438, 0x823426, 0x4b555d];
// Unified Compass Convention (matches model/maps/layout_spec.py):
//   North = -Z (Team A base, looking South +Z) | South = +Z (Team B base, looking North -Z)
//   West  = -X (Lane A twin warehouses)        | East  = +X (Lane B container yard)
// Pure West afternoon cross-sun (z = 0, ~34 deg elevation) guarantees 100% N-S team visual fairness!
export const MILITARY_SUN_POS = Object.freeze({ x: -56, y: 38, z: 0 });
const SUN_POS = MILITARY_SUN_POS;
const FOG_HORIZON_HEX = MILITARY_FOG_HEX;
const FOG_SUN_HEX = MILITARY_SUN_FOG_HEX;

function decodeBase64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function periodicNoise(nx, ny, period, seedOff) {
  const x0 = Math.floor(nx), y0 = Math.floor(ny);
  const fx = nx - x0, fy = ny - y0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const h = (ix, iy) => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    let n = Math.imul(wx * 374761393 + wy * 668265263 + seedOff, 1274126177);
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

// Deterministic world-space FBM helpers shared between baked ground mask & wet footstep sampling
function hash2Js(ix, iz) {
  let n = Math.imul(ix * 374761393 + iz * 668265263, 1274126177);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function noise2Js(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2Js(ix, iz), b = hash2Js(ix + 1, iz);
  const c = hash2Js(ix, iz + 1), d = hash2Js(ix + 1, iz + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
function fbm2Js(x, z, octaves = 4) {
  let px = x, pz = z, v = 0, a = 0.52;
  for (let k = 0; k < octaves; k++) {
    v += a * noise2Js(px, pz);
    const nx = 0.8 * px + 0.6 * pz;
    const nz = -0.6 * px + 0.8 * pz;
    px = nx * 2.04 + 17.3;
    pz = nz * 2.04 + 9.2;
    a *= 0.48;
  }
  return v;
}
function smoothstepJs(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function sampleMilitaryPuddle(x, z) {
  if (x > -27.2 && x < -16.8 && Math.abs(Math.abs(z) - 14.0) < 7.2) return 0;
  const pField = fbm2Js(x * 0.072, z * 0.072, 4);
  return smoothstepJs(0.58, 0.68, pField);
}

function sampleMilitaryDirt(x, z) {
  if (x > -27.2 && x < -16.8 && Math.abs(Math.abs(z) - 14.0) < 7.2) return 0;
  const macroA = fbm2Js(x * 0.042, z * 0.042, 3);
  return smoothstepJs(0.46, 0.72, macroA);
}

// Pre-bake world-space macro variation, puddles & convoy tire tracks into 1 single 512x512 RGBA DataTexture!
// Eliminates 14-octave per-pixel FBM (56 hash calls/pixel -> 1 hardware bilinear texture2D fetch).
const WORLD_MASK_HALF_X = 72.0;
const WORLD_MASK_HALF_Z = 82.0;

async function buildWorldGroundMaskAsync(THREE, yieldFn) {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    if (py > 0 && py % 128 === 0 && yieldFn) await yieldFn();
    const wz = ((py / (size - 1)) * 2 - 1) * WORLD_MASK_HALF_Z;
    for (let px = 0; px < size; px++) {
      const wx = ((px / (size - 1)) * 2 - 1) * WORLD_MASK_HALF_X;
      const idx = (py * size + px) * 4;

      const macroA = fbm2Js(wx * 0.042, wz * 0.042, 3);
      const macroB = fbm2Js(wx * 0.115 + 31.4, wz * 0.115 - 19.2, 3);
      const dirtPatch = smoothstepJs(0.46, 0.72, macroA);
      const asphaltPatch = smoothstepJs(0.56, 0.76, macroB) * (1 - dirtPatch * 0.7);

      const inWh = wx > -27.2 && wx < -16.8 && Math.abs(Math.abs(wz) - 14.0) < 7.2;
      const pField = inWh ? 0 : fbm2Js(wx * 0.072, wz * 0.072, 4);

      // World-space military convoy tire tracks running through Mid lane
      const roadCenter = -1.5 + Math.sin(wz * 0.055) * 4.2;
      const dT1 = Math.abs(wx - (roadCenter - 0.92));
      const dT2 = Math.abs(wx - (roadCenter + 0.92));
      const tireTrack =
        Math.max(1 - smoothstepJs(0.16, 0.42, dT1), 1 - smoothstepJs(0.16, 0.42, dT2)) *
        smoothstepJs(-40.0, -32.0, wz) *
        (1 - smoothstepJs(32.0, 40.0, wz));

      data[idx] = Math.min(255, Math.max(0, Math.round(dirtPatch * 255)));
      data[idx + 1] = Math.min(255, Math.max(0, Math.round(asphaltPatch * 255)));
      data[idx + 2] = Math.min(255, Math.max(0, Math.round(pField * 255)));
      data[idx + 3] = Math.min(255, Math.max(0, Math.round(tireTrack * 255)));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Shared GLSL height-fog + optional in-shader WebGL color grade (zero DOM CSS filter compositor blit!)
const HEIGHT_FOG_VERT_CHUNK = `
  #include <project_vertex>
  vec4 milFogWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    milFogWp = instanceMatrix * milFogWp;
  #endif
  milFogWp = modelMatrix * milFogWp;
  vMilWorldPos = milFogWp.xyz;
`;

const HEIGHT_FOG_FRAG_CHUNK = `
  #ifdef USE_FOG
    vec3 milToFrag = vMilWorldPos - cameraPosition;
    float milDist = length(milToFrag);
    vec3 milViewDir = milToFrag / max(milDist, 0.0001);
    float milNearClear = smoothstep(uMilFogParams.x, uMilFogParams.y, milDist);
    float milHeightBand = exp(-max(0.0, vMilWorldPos.y - 0.4) * 0.048);
    float milDistFog = 1.0 - exp(-milDist * (uMilFogParams.z + uMilFogParams.w * milHeightBand));
    float milFogAmt = clamp(milDistFog * milNearClear, 0.0, 0.88);
    float milSunScatter = pow(max(dot(milViewDir, uMilSunDir), 0.0), 4.5);
    vec3 milFogCol = mix(fogColor, uMilSunFogColor, milSunScatter * 0.22);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, milFogCol, milFogAmt);
  #endif
  if (uMilPostGrade > 0.5) {
    float milLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor.rgb = mix(vec3(milLum), gl_FragColor.rgb, 1.09);
    gl_FragColor.rgb = max(vec3(0.0), (gl_FragColor.rgb - 0.16) * 1.08 + 0.16);
  }
`;

function createHeightFogUniforms(THREE) {
  const sunDir = new THREE.Vector3(SUN_POS.x, SUN_POS.y, SUN_POS.z).normalize();
  return {
    uMilSunDir: { value: sunDir },
    uMilSunFogColor: { value: new THREE.Color(FOG_SUN_HEX) },
    // (nearStart, nearEnd, distBase, heightAmp)
    uMilFogParams: { value: new THREE.Vector4(14.0, 34.0, 0.0022, 0.0030) },
    uMilPostGrade: { value: 1.0 },
  };
}

function applyMilitaryHeightFog(mat, fogUniforms, extraHook = null, cacheTag = "mil_hfog_std") {
  const prevCompile = mat.onBeforeCompile;
  mat.customProgramCacheKey = () => cacheTag;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    shader.uniforms.uMilSunDir = fogUniforms.uMilSunDir;
    shader.uniforms.uMilSunFogColor = fogUniforms.uMilSunFogColor;
    shader.uniforms.uMilFogParams = fogUniforms.uMilFogParams;
    shader.uniforms.uMilPostGrade = fogUniforms.uMilPostGrade;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMilWorldPos;")
      .replace("#include <project_vertex>", HEIGHT_FOG_VERT_CHUNK);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vMilWorldPos;\nuniform vec3 uMilSunDir;\nuniform vec3 uMilSunFogColor;\nuniform vec4 uMilFogParams;\nuniform float uMilPostGrade;",
      )
      .replace("#include <fog_fragment>", HEIGHT_FOG_FRAG_CHUNK);
    if (extraHook) extraHook(shader, renderer);
  };
}

async function buildConcreteGroundTexturesAsync(THREE, maxAniso, yieldFn) {
  // 512x512 crisp seamless aggregate tile (2.3x faster load than 768x768, crisp up close via detailNormalMap)
  const size = 512;
  const makeTex = (fn, repX, repY, isColor = false) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    fn(c.getContext("2d"), size, size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repX, repY);
    t.anisotropy = maxAniso;
    if (isColor && THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    return t;
  };

  const heights = new Float32Array(size * size);
  const jointMask = new Float32Array(size * size);
  const pebbleMask = new Float32Array(size * size);
  const gravelTint = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    if (y === 256 && yieldFn) await yieldFn();
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const n1 = periodicNoise(u * 4, v * 4, 4, 101);
      const n2 = periodicNoise(u * 12, v * 12, 12, 211);
      const n3 = periodicNoise(u * 40, v * 40, 40, 307);
      const n4 = periodicNoise(u * 128, v * 128, 128, 353);

      const warpU = (n2 - 0.5) * 0.012 + (n3 - 0.5) * 0.004;
      const warpV = (periodicNoise(u * 12, v * 12, 12, 263) - 0.5) * 0.012;
      const duJoint = Math.min(Math.abs(((u + warpU + 1) % 0.5) - 0.25), 0.25);
      const dvJoint = Math.min(Math.abs(((v + warpV + 1) % 0.5) - 0.25), 0.25);
      const jSeam = Math.max(
        1 - smoothstepJs(0.002, 0.009, Math.abs(duJoint - 0.25)),
        1 - smoothstepJs(0.002, 0.009, Math.abs(dvJoint - 0.25)),
      ) * (0.45 + 0.55 * n2);
      jointMask[idx] = jSeam;

      const pebble = smoothstepJs(0.60, 0.84, n3 * 0.45 + n4 * 0.55);
      pebbleMask[idx] = pebble;
      gravelTint[idx] = n2 * 0.6 + n3 * 0.4;

      heights[idx] = 0.24 * n1 + 0.26 * n2 + 0.28 * n3 + 0.22 * n4 + pebble * 0.12 - jSeam * 0.22;
    }
  }
  if (yieldFn) await yieldFn();

  const albedo = makeTex((g, w, h) => {
    const im = g.createImageData(w, h);
    const d = im.data;
    for (let i = 0; i < w * h; i++) {
      const hv = heights[i];
      const jm = jointMask[i];
      const pb = pebbleMask[i];
      const gt = gravelTint[i];
      const base = 0.37 + (hv - 0.48) * 0.20 + (pb - 0.2) * 0.06 - jm * 0.13;
      const r = base * (1.03 + gt * 0.04);
      const gr = base * (0.99 + gt * 0.02);
      const b = base * (0.91 - gt * 0.03);
      d[i * 4] = Math.max(24, Math.min(182, Math.round(r * 255)));
      d[i * 4 + 1] = Math.max(24, Math.min(176, Math.round(gr * 255)));
      d[i * 4 + 2] = Math.max(22, Math.min(165, Math.round(b * 255)));
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }, 5, 7, true);
  if (yieldFn) await yieldFn();

  const normal = makeTex((g, w, h) => {
    const im = g.createImageData(w, h);
    const d = im.data;
    for (let y = 0; y < h; y++) {
      const ym = (y - 1 + h) % h, yp = (y + 1) % h;
      for (let x = 0; x < w; x++) {
        const xm = (x - 1 + w) % w, xp = (x + 1) % w;
        const dx = (heights[y * w + xp] - heights[y * w + xm]) * 2.55;
        const dy = (heights[yp * w + x] - heights[ym * w + x]) * 2.55;
        const idx = (y * w + x) * 4;
        d[idx] = Math.max(0, Math.min(255, Math.round(128 - dx * 64)));
        d[idx + 1] = Math.max(0, Math.min(255, Math.round(128 - dy * 64)));
        d[idx + 2] = 255;
        d[idx + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, 5, 7, false);
  if (yieldFn) await yieldFn();

  const roughness = makeTex((g, w, h) => {
    const im = g.createImageData(w, h);
    const d = im.data;
    for (let i = 0; i < w * h; i++) {
      const hv = heights[i];
      const pb = pebbleMask[i];
      const rVal = 0.90 - 0.08 * hv - 0.05 * pb;
      const bVal = Math.max(185, Math.min(246, Math.round(rVal * 255)));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = bVal;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }, 5, 7, false);
  if (yieldFn) await yieldFn();

  const worldMask = await buildWorldGroundMaskAsync(THREE, yieldFn);
  return { albedo, normal, roughness, worldMask };
}

function buildPerimeterGrassAndDebris(THREE, layout, fogUniforms, windUniform, windScaleUniform) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  let s = 20261126;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  // Deterministic Fisher-Yates shuffle so dynamic inst.count thins evenly across the whole map
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };

  // 1. Multi-height curved wild grass clump (5 slender blades = 20 tris)
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + (b % 2) * 0.34;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const px = -sn, pz = cs;
    const h = 0.24 + (b % 3) * 0.11;
    const reach = 0.16 + (b % 2) * 0.09;
    const rOff = 0.04 + (b % 3) * 0.028;
    const vBase = positions.length / 3;
    const rings = [
      [0.0, 0.032, 0.14, 0.12, 0.08],
      [0.48, 0.020, 0.28, 0.32, 0.16],
      [1.0, 0.004, 0.48, 0.49, 0.25],
    ];
    for (const [t, halfW, cr, cg, cb] of rings) {
      const arch = t * t * reach + rOff;
      const py = Math.sin(t * 1.15) * h;
      const cx = cs * arch, cz = sn * arch;
      positions.push(
        cx - px * halfW, py, cz - pz * halfW,
        cx + px * halfW, py, cz + pz * halfW,
      );
      const nx = cs * 0.42, nz = sn * 0.42;
      normals.push(nx, 0.90, nz, nx, 0.90, nz);
      colors.push(cr, cg, cb, cr, cg, cb);
    }
    indices.push(
      vBase + 0, vBase + 1, vBase + 2,
      vBase + 1, vBase + 3, vBase + 2,
      vBase + 2, vBase + 3, vBase + 4,
      vBase + 3, vBase + 5, vBase + 4,
    );
  }
  const grassGeo = new THREE.BufferGeometry();
  grassGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  grassGeo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  grassGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  grassGeo.setIndex(indices);

  const grassMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.90,
    metalness: 0.0,
    envMapIntensity: 0.28,
    side: THREE.DoubleSide,
  });
  applyMilitaryHeightFog(
    grassMat,
    fogUniforms,
    (shader) => {
      shader.uniforms.uWindTime = windUniform;
      shader.uniforms.uWindScale = windScaleUniform;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;\nuniform float uWindScale;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nfloat gSway = max(0.0, transformed.y) * 0.14 * uWindScale;\ntransformed.x += sin(uWindTime * 2.2 + transformed.z * 5.0) * gSway;",
        );
    },
    "mil_hfog_grass",
  );

  const anchors = layout.objects.filter(
    (o) =>
      !o.id.startsWith("perim_") &&
      o.position[1] < 0.2 &&
      (o.asset === "concrete_wall" ||
        o.asset === "container" ||
        o.asset === "wood_crate" ||
        o.asset === "sandbag" ||
        o.asset === "tire_stack" ||
        o.asset === "warehouse"),
  );
  const grassPlacements = [];
  for (let c = 0; c < 52; c++) {
    const edge = c % 4;
    let bx = 0, bz = 0;
    if (edge === 0) { bx = minX + 0.35 + rnd() * 0.9; bz = minZ + 2 + rnd() * (maxZ - minZ - 4); }
    else if (edge === 1) { bx = maxX - 0.35 - rnd() * 0.9; bz = minZ + 2 + rnd() * (maxZ - minZ - 4); }
    else if (edge === 2) { bx = minX + 2 + rnd() * (maxX - minX - 4); bz = minZ + 0.35 + rnd() * 0.9; }
    else { bx = minX + 2 + rnd() * (maxX - minX - 4); bz = maxZ - 0.35 - rnd() * 0.9; }
    const count = 4 + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      grassPlacements.push({
        x: Math.max(minX + 0.2, Math.min(maxX - 0.2, bx + (rnd() - 0.5) * 1.15)),
        z: Math.max(minZ + 0.2, Math.min(maxZ - 0.2, bz + (rnd() - 0.5) * 1.15)),
        sx: 0.72 + rnd() * 0.95,
        sy: 0.55 + rnd() * 1.15,
        ry: rnd() * Math.PI * 2,
      });
    }
  }
  for (let c = 0; c < 75 && anchors.length > 0; c++) {
    const baseObj = anchors[Math.floor(rnd() * anchors.length)];
    const halfX = baseObj.asset === "warehouse" ? 5.2 : baseObj.asset === "container" ? 3.1 : baseObj.asset === "concrete_wall" ? 2.1 : 1.05;
    const halfZ = baseObj.asset === "warehouse" ? 7.2 : baseObj.asset === "container" ? 1.35 : 0.95;
    const side = Math.floor(rnd() * 4);
    let lx = 0, lz = 0;
    if (side === 0) { lx = (rnd() - 0.5) * halfX * 1.8; lz = halfZ + 0.12 + rnd() * 0.35; }
    else if (side === 1) { lx = (rnd() - 0.5) * halfX * 1.8; lz = -halfZ - 0.12 - rnd() * 0.35; }
    else if (side === 2) { lx = halfX + 0.12 + rnd() * 0.35; lz = (rnd() - 0.5) * halfZ * 1.8; }
    else { lx = -halfX - 0.12 - rnd() * 0.35; lz = (rnd() - 0.5) * halfZ * 1.8; }
    const ry = baseObj.rotationY || 0;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const bx = baseObj.position[0] + lx * cs + lz * sn;
    const bz = baseObj.position[2] - lx * sn + lz * cs;
    const count = 3 + Math.floor(rnd() * 2);
    for (let k = 0; k < count; k++) {
      grassPlacements.push({
        x: bx + (rnd() - 0.5) * 0.72,
        z: bz + (rnd() - 0.5) * 0.72,
        sx: 0.65 + rnd() * 0.85,
        sy: 0.50 + rnd() * 1.05,
        ry: rnd() * Math.PI * 2,
      });
    }
  }
  shuffle(grassPlacements);

  const grassInst = new THREE.InstancedMesh(grassGeo, grassMat, grassPlacements.length);
  grassInst.castShadow = false;
  grassInst.receiveShadow = true;
  grassInst.matrixAutoUpdate = false;
  grassInst.name = "military_weeds";
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const grassTints = [0x9ea37a, 0x8a9268, 0xb0a476, 0x7c845d];
  grassPlacements.forEach((g, idx) => {
    dummy.position.set(g.x, 0, g.z);
    dummy.rotation.set(0, g.ry, 0);
    dummy.scale.set(g.sx, g.sy, g.sx);
    dummy.updateMatrix();
    grassInst.setMatrixAt(idx, dummy.matrix);
    col.setHex(grassTints[idx % grassTints.length]);
    grassInst.setColorAt(idx, col);
  });
  grassInst.instanceMatrix.needsUpdate = true;
  grassInst.updateMatrix();
  if (grassInst.instanceColor) grassInst.instanceColor.needsUpdate = true;

  // 2. Angular broken concrete rubble (8 tris/rock, shuffled for smooth density scaling)
  const debGeo = new THREE.OctahedronGeometry(0.11, 0);
  const debMat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0.0, envMapIntensity: 0.28 });
  applyMilitaryHeightFog(debMat, fogUniforms, null, "mil_hfog_std");
  const debCount = 280;
  const debSpecs = [];
  for (let i = 0; i < debCount; i++) {
    let x, z;
    if (i < 175 && anchors.length > 0) {
      const a = anchors[Math.floor(rnd() * anchors.length)];
      x = a.position[0] + (rnd() - 0.5) * 4.8;
      z = a.position[2] + (rnd() - 0.5) * 4.8;
    } else {
      x = -33 + rnd() * 66;
      z = -43 + rnd() * 86;
    }
    debSpecs.push({
      x, z,
      scX: 0.55 + rnd() * 1.45,
      scY: 0.22 + rnd() * 0.36,
      scZ: 0.50 + rnd() * 1.35,
      rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3,
    });
  }
  shuffle(debSpecs);
  const debInst = new THREE.InstancedMesh(debGeo, debMat, debCount);
  debInst.castShadow = false;
  debInst.receiveShadow = true;
  debInst.matrixAutoUpdate = false;
  debInst.name = "military_rubble";
  const debPalette = [0x454038, 0x524b41, 0x39352f, 0x5a5246];
  debSpecs.forEach((p, i) => {
    dummy.position.set(p.x, 0.015 * p.scY, p.z);
    dummy.rotation.set(p.rx, p.ry, p.rz);
    dummy.scale.set(p.scX, p.scY, p.scZ);
    dummy.updateMatrix();
    debInst.setMatrixAt(i, dummy.matrix);
    col.setHex(debPalette[i % debPalette.length]);
    debInst.setColorAt(i, col);
  });
  debInst.instanceMatrix.needsUpdate = true;
  debInst.updateMatrix();
  if (debInst.instanceColor) debInst.instanceColor.needsUpdate = true;

  return { grassInst, maxGrassCount: grassPlacements.length, debInst, maxDebrisCount: debCount };
}

function buildTacticalClutter(THREE, layout, envMap, fogUniforms, windUniform, windScaleUniform) {
  const clutterGroup = new THREE.Group();
  clutterGroup.name = "military_tactical_clutter";
  let s = 447799;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const dummy = new THREE.Object3D();

  const mergeGeos = (parts) => {
    let tv = 0, ti = 0;
    for (const g of parts) { tv += g.attributes.position.count; ti += g.index.count; }
    const p = new Float32Array(tv * 3), n = new Float32Array(tv * 3), u = new Float32Array(tv * 2);
    const ix = new Uint16Array(ti);
    let vo = 0, io = 0;
    for (const g of parts) {
      p.set(g.attributes.position.array, vo * 3);
      n.set(g.attributes.normal.array, vo * 3);
      u.set(g.attributes.uv.array, vo * 2);
      const gi = g.index.array;
      for (let k = 0; k < gi.length; k++) ix[io + k] = gi[k] + vo;
      vo += g.attributes.position.count;
      io += gi.length;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(p, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    out.setAttribute("uv", new THREE.BufferAttribute(u, 2));
    out.setIndex(new THREE.BufferAttribute(ix, 1));
    return out;
  };

  // 1. Military olive-drab steel ammo crates
  const ammoCanvas = document.createElement("canvas");
  ammoCanvas.width = 128; ammoCanvas.height = 64;
  const ag = ammoCanvas.getContext("2d");
  ag.fillStyle = "#36402b";
  ag.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 160; i++) {
    ag.fillStyle = i % 2 ? "rgba(20,24,16,0.28)" : "rgba(110,96,68,0.16)";
    ag.fillRect(rnd() * 128, rnd() * 64, 4 + rnd() * 12, 2 + rnd() * 5);
  }
  ag.fillStyle = "#c8a33a";
  ag.fillRect(10, 22, 108, 6);
  ag.fillStyle = "#22261c";
  ag.font = "bold 10px monospace";
  ag.fillText("5.56MM NATO", 24, 46);
  const ammoTex = new THREE.CanvasTexture(ammoCanvas);
  if (THREE.sRGBEncoding) ammoTex.encoding = THREE.sRGBEncoding;

  const ammoBase = new THREE.BoxGeometry(0.62, 0.28, 0.34); ammoBase.translate(0, 0.14, 0);
  const ammoLid = new THREE.BoxGeometry(0.65, 0.05, 0.37); ammoLid.translate(0, 0.295, 0);
  const ammoLatch1 = new THREE.BoxGeometry(0.05, 0.09, 0.03); ammoLatch1.translate(-0.18, 0.25, 0.185);
  const ammoLatch2 = new THREE.BoxGeometry(0.05, 0.09, 0.03); ammoLatch2.translate(0.18, 0.25, 0.185);
  const ammoGeo = mergeGeos([ammoBase, ammoLid, ammoLatch1, ammoLatch2]);
  const ammoMat = new THREE.MeshStandardMaterial({
    map: ammoTex, roughness: 0.68, metalness: 0.38, envMap, envMapIntensity: 0.52,
  });
  applyMilitaryHeightFog(ammoMat, fogUniforms, null, "mil_hfog_std");

  const ammoSpots = [
    [-2.8, 0, -35.8, 0.28], [-2.0, 0, -36.2, -0.15], [3.6, 0, -35.6, 0.55],
    [6.1, 0, -34.9, -0.35], [-6.6, 0, -34.0, 0.14],
    [2.8, 0, 35.6, -0.4], [-3.4, 0, 35.5, 0.32],
    [-14.6, 0, -23.8, 0.45], [-16.6, 0, -4.4, -0.25], [-18.4, 0, -14.8, 0.18],
    [-14.6, 0, 23.6, -0.38], [-15.8, 0, 1.4, 0.72],
    [2.5, 0, -20.0, 0.52], [3.2, 0, -19.6, -0.22], [-4.8, 0, -24.8, 0.35],
    [2.6, 0, 0.9, 0.42], [5.4, 0, -1.2, -0.60], [-8.8, 0, 2.2, 0.22],
    [18.6, 0, -24.8, 0.48], [19.4, 0, -24.4, -0.30], [20.4, 0, -20.5, 0.18],
    [20.0, 0, -7.2, 0.65], [14.5, 0, -5.6, -0.22], [23.2, 0, 6.2, 0.45],
    [13.4, 0, 21.8, -0.52], [4.1, 4.0, -0.9, 0.30],
  ];
  const ammoInst = new THREE.InstancedMesh(ammoGeo, ammoMat, ammoSpots.length);
  // Small ground props rely on 2-stage contact shadows -> castShadow=false trims shadow-pass work
  ammoInst.castShadow = false;
  ammoInst.receiveShadow = true;
  ammoInst.matrixAutoUpdate = false;
  ammoInst.name = "military_ammo_crates";
  ammoSpots.forEach(([x, y, z, ry], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.set(0.92 + rnd() * 0.22, 0.92 + rnd() * 0.18, 0.92 + rnd() * 0.22);
    dummy.updateMatrix();
    ammoInst.setMatrixAt(i, dummy.matrix);
  });
  ammoInst.instanceMatrix.needsUpdate = true;
  ammoInst.updateMatrix();
  clutterGroup.add(ammoInst);

  // 2. Weathered military hazard / restricted-area warning signs
  const signCanvas = document.createElement("canvas");
  signCanvas.width = 128; signCanvas.height = 128;
  const sg = signCanvas.getContext("2d");
  sg.fillStyle = "#b58d26";
  sg.fillRect(0, 0, 128, 128);
  sg.strokeStyle = "#1b1c18";
  sg.lineWidth = 8;
  sg.strokeRect(6, 6, 116, 116);
  sg.fillStyle = "#1b1c18";
  for (let sx = -32; sx < 140; sx += 24) {
    sg.beginPath();
    sg.moveTo(sx, 96); sg.lineTo(sx + 12, 96); sg.lineTo(sx + 2, 122); sg.lineTo(sx - 10, 122);
    sg.fill();
  }
  sg.beginPath();
  sg.moveTo(64, 20); sg.lineTo(96, 78); sg.lineTo(32, 78); sg.closePath();
  sg.lineWidth = 6; sg.stroke();
  sg.fillRect(61, 38, 6, 22);
  sg.fillRect(61, 65, 6, 6);
  for (let i = 0; i < 90; i++) {
    sg.fillStyle = i % 2 ? "rgba(72,38,18,0.28)" : "rgba(35,34,30,0.22)";
    sg.fillRect(rnd() * 128, rnd() * 128, 3 + rnd() * 10, 3 + rnd() * 10);
  }
  const signTex = new THREE.CanvasTexture(signCanvas);
  if (THREE.sRGBEncoding) signTex.encoding = THREE.sRGBEncoding;

  const signPost = new THREE.BoxGeometry(0.055, 1.55, 0.055); signPost.translate(0, 0.775, 0);
  const signBoard = new THREE.BoxGeometry(0.54, 0.54, 0.03); signBoard.translate(0, 1.32, 0.03);
  const signGeo = mergeGeos([signPost, signBoard]);
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex, roughness: 0.72, metalness: 0.28, envMap, envMapIntensity: 0.50,
  });
  applyMilitaryHeightFog(signMat, fogUniforms, null, "mil_hfog_std");

  const signSpots = [
    [-5.6, 0, -34.4, 3.05, 0.04], [5.8, 0, -34.4, 3.22, -0.05],
    [-16.4, 0, -19.8, 1.48, 0.03], [-16.4, 0, 19.8, 1.62, -0.04],
    [13.4, 0, -23.6, -2.85, 0.05], [27.2, 0, -23.2, -1.65, -0.03],
    [12.0, 0, 1.4, -1.55, 0.04], [-10.8, 0, -17.8, 0.65, -0.05],
    [33.8, 0, -16.0, -1.57, 0.02], [-33.8, 0, 10.0, 1.57, -0.03],
  ];
  const signInst = new THREE.InstancedMesh(signGeo, signMat, signSpots.length);
  signInst.castShadow = false;
  signInst.receiveShadow = true;
  signInst.matrixAutoUpdate = false;
  signInst.name = "military_hazard_signs";
  signSpots.forEach(([x, y, z, ry, tilt], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(tilt * 0.5, ry, tilt);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    signInst.setMatrixAt(i, dummy.matrix);
  });
  signInst.instanceMatrix.needsUpdate = true;
  signInst.updateMatrix();
  clutterGroup.add(signInst);

  // 3. Ground debris planks
  const plankGeo = new THREE.BoxGeometry(0.95, 0.024, 0.22);
  const plankMat = new THREE.MeshStandardMaterial({
    color: 0x5c5044, roughness: 0.94, metalness: 0.04, envMap, envMapIntensity: 0.40,
  });
  applyMilitaryHeightFog(plankMat, fogUniforms, null, "mil_hfog_std");

  const plankSpots = [
    [-1.6, 0.012, -37.6, 0.42], [2.1, 0.012, -37.2, -0.65], [-5.2, 0.012, -37.5, 1.1],
    [-15.0, 0.012, -5.5, 0.85], [-18.2, 0.012, -7.2, -0.35], [-12.2, 0.012, -10.8, 0.22],
    [-9.2, 0.012, -16.5, 1.42], [0.8, 0.012, -25.0, -0.45], [6.4, 0.012, -22.2, 0.72],
    [15.6, 0.012, -25.4, 0.35], [18.8, 0.012, -26.2, -0.82], [21.8, 0.012, -18.5, 1.25],
    [18.2, 0.012, -9.8, 0.15], [12.5, 0.012, -8.4, -0.55], [-2.5, 0.012, 18.4, 0.95],
    [8.2, 0.012, 19.6, -0.32], [21.5, 0.012, 14.5, 0.62], [-17.5, 0.012, 8.2, -1.12],
    [-4.2, 0.012, -6.4, 0.48], [6.4, 0.012, -6.2, -0.78], [16.5, 0.012, 3.8, 0.28],
    [-13.5, 0.012, -19.2, 1.05], [25.6, 0.012, -24.6, -0.44], [0.2, 0.012, -19.8, 0.18],
  ];
  const plankInst = new THREE.InstancedMesh(plankGeo, plankMat, plankSpots.length);
  plankInst.castShadow = false;
  plankInst.receiveShadow = true;
  plankInst.matrixAutoUpdate = false;
  plankInst.name = "military_debris_planks";
  const tmpC = new THREE.Color();
  const plankCols = [0x6e5d4c, 0x5c5247, 0x645648, 0x524a42];
  plankSpots.forEach(([x, y, z, ry], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, ry, (rnd() - 0.5) * 0.03);
    dummy.scale.set(0.72 + rnd() * 0.62, 1.0, 0.8 + rnd() * 0.65);
    dummy.updateMatrix();
    plankInst.setMatrixAt(i, dummy.matrix);
    tmpC.setHex(plankCols[i % plankCols.length]);
    plankInst.setColorAt(i, tmpC);
  });
  plankInst.instanceMatrix.needsUpdate = true;
  plankInst.updateMatrix();
  if (plankInst.instanceColor) plankInst.instanceColor.needsUpdate = true;
  clutterGroup.add(plankInst);

  // 4. Wind-animated watchtower weathered pennant
  const clothMat = new THREE.MeshStandardMaterial({
    color: 0x8e3b28, roughness: 0.86, metalness: 0.0, envMap, envMapIntensity: 0.45, side: THREE.DoubleSide,
  });
  applyMilitaryHeightFog(
    clothMat,
    fogUniforms,
    (shader) => {
      shader.uniforms.uWindTime = windUniform;
      shader.uniforms.uWindScale = windScaleUniform;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;\nuniform float uWindScale;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nfloat fPin = clamp((transformed.x + 0.65) / 1.3, 0.0, 1.0) * uWindScale;\ntransformed.z += sin(uWindTime * 4.8 - transformed.x * 5.2) * 0.12 * fPin;\ntransformed.y += cos(uWindTime * 3.6 - transformed.x * 4.1) * 0.035 * fPin;",
        );
    },
    "mil_hfog_cloth",
  );
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5c636b, roughness: 0.48, metalness: 0.76, envMap, envMapIntensity: 0.85 });
  applyMilitaryHeightFog(poleMat, fogUniforms, null, "mil_hfog_std");
  const poleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 2.3, 6), poleMat);
  poleMesh.position.set(5.55, 7.25, -1.55);
  poleMesh.matrixAutoUpdate = false;
  poleMesh.updateMatrix();

  const flagGeo = new THREE.PlaneGeometry(1.3, 0.52, 8, 3);
  const flagMesh = new THREE.Mesh(flagGeo, clothMat);
  flagMesh.position.set(6.20, 8.05, -1.55);
  flagMesh.castShadow = false;
  flagMesh.name = "military_watchtower_flag";

  clutterGroup.add(poleMesh, flagMesh);
  return clutterGroup;
}

function buildContactShadows(THREE, layout) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 128);
  g.filter = "blur(12px)";
  g.fillStyle = "rgba(8, 10, 12, 0.44)";
  g.fillRect(14, 14, 100, 100);
  g.filter = "blur(4px)";
  g.fillStyle = "rgba(4, 6, 8, 0.86)";
  g.fillRect(24, 24, 80, 80);

  const tex = new THREE.CanvasTexture(c);
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const shadowTargets = layout.objects.filter(
    (o) =>
      o.position[1] < 0.2 &&
      (o.asset === "container" ||
        o.asset === "warehouse" ||
        o.asset === "wrecked_truck" ||
        o.asset === "watchtower" ||
        o.asset === "wood_crate" ||
        o.asset === "oil_barrel" ||
        o.asset === "sandbag" ||
        o.asset === "tire_stack" ||
        o.asset === "wood_pallet" ||
        o.asset === "concrete_wall"),
  );

  const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, shadowTargets.length));
  inst.name = "military_contact_shadows";
  inst.matrixAutoUpdate = false;
  const dummy = new THREE.Object3D();
  shadowTargets.forEach((o, idx) => {
    let sx = 1.4, sz = 1.4;
    if (o.asset === "container") { sx = 7.7; sz = 3.9; }
    else if (o.asset === "warehouse") { sx = 12.2; sz = 16.2; }
    else if (o.asset === "wrecked_truck") { sx = 3.7; sz = 7.6; }
    else if (o.asset === "watchtower") { sx = 4.9; sz = 4.9; }
    else if (o.asset === "wood_crate") { sx = 2.05; sz = 2.05; }
    else if (o.asset === "oil_barrel") { sx = 1.18; sz = 1.18; }
    else if (o.asset === "sandbag") { sx = 2.65; sz = 1.55; }
    else if (o.asset === "tire_stack") { sx = 1.62; sz = 1.62; }
    else if (o.asset === "wood_pallet") { sx = 1.82; sz = 1.62; }
    else if (o.asset === "concrete_wall") {
      sx = 4.7 * ((o.scale && o.scale[0]) || 1);
      sz = 1.65 * ((o.scale && o.scale[2]) || 1);
    }
    dummy.position.set(o.position[0], 0.014, o.position[2]);
    dummy.rotation.set(0, o.rotationY || 0, 0);
    dummy.scale.set(sx, 1, sz);
    dummy.updateMatrix();
    inst.setMatrixAt(idx, dummy.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.updateMatrix();
  return inst;
}

export function createMilitaryMapLoader({ renderer, THREE }) {
  const protoCache = new Map();
  const bvhCache = new WeakMap();
  let jsonPromise = null;
  let concreteTexCache = null;
  let skyEnvCache = null;

  function loadSharedJson() {
    if (!jsonPromise) {
      jsonPromise = Promise.resolve({
        layout: MILITARY_LAYOUT,
        colliders: MILITARY_COLLIDERS,
      });
    }
    return jsonPromise;
  }

  function loadAssetProto(assetName) {
    const modelKey = `map_${assetName}`;
    if (protoCache.has(modelKey)) return protoCache.get(modelKey);

    const prom = new Promise((resolve, reject) => {
      if (typeof THREE.GLTFLoader !== "function") {
        reject(new Error("THREE.GLTFLoader unavailable"));
        return;
      }
      const loader = new THREE.GLTFLoader();
      const b64 = window.FPS_MODELS && window.FPS_MODELS[modelKey];
      const onDone = (gltf) => {
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        const parts = [];
        root.traverse((obj) => {
          if (!obj.isMesh || !obj.geometry) return;
          const g = obj.geometry;
          if (!bvhCache.has(g) && g.attributes.position) {
            const pos = g.attributes.position.array;
            const idx = g.index ? g.index.array : null;
            bvhCache.set(g, buildTriangleBVH(pos, idx, 12));
          }
          parts.push({
            name: obj.name || modelKey,
            geometry: g,
            material: obj.material,
            localMatrix: obj.matrixWorld.clone(),
          });
        });
        resolve({ root, parts });
      };
      if (b64) {
        loader.parse(decodeBase64ToArrayBuffer(b64), "", onDone, reject);
      } else {
        loader.load(`/model/dist/${modelKey}.glb`, onDone, undefined, reject);
      }
    });
    protoCache.set(modelKey, prom);
    return prom;
  }

  async function buildMilitaryScene({
    scene,
    envMapTargetList = [],
    initialPreset = QUALITY_PRESETS.high,
    onProgress = null,
    yieldFn = yieldToUI,
    deferActivate = false,
  }) {
    const stepYield = typeof yieldFn === "function" ? yieldFn : yieldToUI;
    const emit = (fraction, detail = "") => {
      if (typeof onProgress === "function") onProgress(fraction, detail);
    };

    const hwMaxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 16);
    const startAniso = Math.min(hwMaxAniso, initialPreset.maxAnisotropy || 16);

    emit(0.02, "Sinh kết cấu mặt đất & vũng nước Khu Quân Sự...");
    if (!concreteTexCache) concreteTexCache = await buildConcreteGroundTexturesAsync(THREE, startAniso, stepYield);
    await stepYield();

    emit(0.18, "Dựng bầu trời tán xạ khí quyển & bản đồ ánh sáng PMREM...");
    if (!skyEnvCache) skyEnvCache = await buildMilitarySkySystemAsync(renderer, THREE, SUN_POS, stepYield);
    await stepYield();

    const assetNames = [
      "container",
      "warehouse",
      "wrecked_truck",
      "watchtower",
      "sandbag",
      "concrete_wall",
      "fence",
      "wood_crate",
      "oil_barrel",
      "wood_pallet",
      "tire_stack",
      "barbed_wire",
    ];

    const { layout, colliders } = await loadSharedJson();
    const protos = {};
    for (let i = 0; i < assetNames.length; i++) {
      const name = assetNames[i];
      emit(
        0.24 + (i / assetNames.length) * 0.46,
        `Nạp mô hình bản đồ (${i + 1}/${assetNames.length}): ${name}`,
      );
      protos[name] = await loadAssetProto(name);
      await stepYield();
    }

    emit(0.72, "Dựng khí quyển & mặt sân chiến đấu...");
    const fogUniforms = createHeightFogUniforms(THREE);
    const windUniform = { value: 0.0 };
    const windScaleUniform = { value: 1.0 };

    const group = new THREE.Group();
    group.name = "MilitaryMapGroup";
    if (deferActivate) group.visible = false;
    group.add(skyEnvCache.skyMesh);

    const { rayGroup, shaftGroup, sunFlare, flareTex, dustPoints, update: updateDust } = buildMilitaryGodRaysAndDust(THREE, SUN_POS);
    group.add(rayGroup, dustPoints);

    // Ultra-fast pre-baked world-mask ground (1 texture2D replaces 14 octaves of per-pixel FBM!)
    const groundMat = new THREE.MeshStandardMaterial({
      map: concreteTexCache.albedo,
      normalMap: concreteTexCache.normal,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughnessMap: concreteTexCache.roughness,
      roughness: 1.0,
      metalness: 0.02,
      envMap: skyEnvCache.envMap,
      envMapIntensity: 0.46,
    });
    groundMat.userData.extraTextures = [concreteTexCache.worldMask];
    applyMilitaryHeightFog(
      groundMat,
      fogUniforms,
      (shader) => {
        shader.uniforms.detailNormalMap = { value: concreteTexCache.normal };
        shader.uniforms.uWorldMask = { value: concreteTexCache.worldMask };
        shader.uniforms.uWindTime = windUniform;
        shader.uniforms.uWindScale = windScaleUniform;
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
            uniform sampler2D detailNormalMap;
            uniform sampler2D uWorldMask;
            uniform float uWindTime;
            uniform float uWindScale;`,
          )
          .replace(
            "#include <map_fragment>",
            `#include <map_fragment>
            vec2 gXZ = vMilWorldPos.xz;
            vec2 wUv = clamp(gXZ / vec2(${WORLD_MASK_HALF_X.toFixed(1)}, ${WORLD_MASK_HALF_Z.toFixed(1)}) * 0.5 + 0.5, 0.0, 1.0);
            vec4 wMask = texture2D(uWorldMask, wUv);
            float dirtPatch = wMask.r;
            float asphaltPatch = wMask.g;
            float pField = wMask.b;
            float tireW = wMask.a;
            // Ultra-cheap micro-grit & edge breakup (2 trig ops instead of 56 per-pixel hashes!)
            float microBreak = sin(gXZ.x * 1.7 + sin(gXZ.y * 1.3)) * cos(gXZ.y * 1.9 - cos(gXZ.x * 1.1));
            vec3 dirtCol = vec3(0.28, 0.23, 0.17);
            vec3 asphaltCol = vec3(0.14, 0.145, 0.15);
            diffuseColor.rgb = mix(diffuseColor.rgb, dirtCol, dirtPatch * 0.46);
            diffuseColor.rgb = mix(diffuseColor.rgb, asphaltCol, asphaltPatch * 0.42);
            diffuseColor.rgb *= (0.96 + 0.04 * microBreak);
            float tread = 0.74 + 0.26 * sin(gXZ.y * 16.0);
            diffuseColor.rgb *= (1.0 - tireW * tread * 0.22);
            float pVal = pField + microBreak * 0.020;
            float outdoorOk = step(0.02, pField);
            float milDamp = smoothstep(0.55, 0.66, pVal) * outdoorOk;
            float milWet = smoothstep(0.63, 0.72, pVal) * outdoorOk;
            diffuseColor.rgb *= mix(1.0, 0.72, milDamp);
            diffuseColor.rgb *= mix(1.0, 0.68, milWet);`,
          )
          .replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>
            roughnessFactor = mix(roughnessFactor, 0.58, milDamp);
            roughnessFactor = mix(roughnessFactor, 0.06, milWet);`,
          )
          .replace(
            "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;\n\tmapN.xy *= normalScale;",
            `vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            vec3 detN = texture2D( detailNormalMap, vUv * 12.0 ).xyz * 2.0 - 1.0;
            float dryWeight = (1.0 - milDamp * 0.55) * (1.0 - milWet * 0.96);
            mapN.xy = (mapN.xy + detN.xy * 0.80) * dryWeight;
            float ripX = sin(vMilWorldPos.x * 5.2 + uWindTime * 1.8) * cos(vMilWorldPos.z * 4.8 - uWindTime * 1.3);
            float ripY = cos(vMilWorldPos.x * 4.5 - uWindTime * 1.5) * sin(vMilWorldPos.z * 5.6 + uWindTime * 1.6);
            mapN.xy += vec2(ripX, ripY) * 0.010 * milWet * uWindScale;
            mapN = normalize(mapN);`,
          )
          .replace(
            "#include <lights_fragment_end>",
            `#include <lights_fragment_end>
            reflectedLight.indirectSpecular *= mix(1.0, 2.25, milWet);`,
          );
      },
      "mil_hfog_ground",
    );

    // Fit courtyard concrete tightly inside/under the perimeter walls (72x92m) so sculpted foothills begin right outside!
    const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(72, 92), groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    groundMesh.name = "military_ground";
    group.add(groundMesh);
    await stepYield();

    emit(0.78, "Bố trí cỏ dại, gạch vụn & bóng tiếp xúc...");
    const { grassInst, maxGrassCount, debInst, maxDebrisCount } = buildPerimeterGrassAndDebris(
      THREE,
      layout,
      fogUniforms,
      windUniform,
      windScaleUniform,
    );
    group.add(grassInst, debInst);
    group.add(buildContactShadows(THREE, layout));
    await stepYield();

    emit(0.83, "Dựng núi 3D xói mòn, rừng thông sườn núi & hậu cảnh...");
    group.add(buildTacticalClutter(THREE, layout, skyEnvCache.envMap, fogUniforms, windUniform, windScaleUniform));
    await stepYield();

    const { bgGroup, envControls } = await buildMilitaryEnvironmentGroupAsync({
      THREE,
      layout,
      sunPos: SUN_POS,
      envMap: skyEnvCache.envMap,
      fogUniforms,
      windUniform,
      windScaleUniform,
      applyMilitaryHeightFog,
      yieldFn: stepYield,
    });
    group.add(bgGroup);
    await stepYield();

    emit(0.92, "Ghép InstancedMesh & cấu trúc va chạm BVH...");

    // Hydrate prototype materials sharing ONE compiled shader key ("mil_hfog_std") -> ~7x fewer WebGL programs!
    const hydratedMats = new Map();
    const managedTextures = new Set([concreteTexCache.albedo, concreteTexCache.normal, concreteTexCache.roughness]);
    const getMat = (srcMat) => {
      if (hydratedMats.has(srcMat)) return hydratedMats.get(srcMat);
      const m = srcMat.clone();
      m.envMap = skyEnvCache.envMap;
      if (m.name === "Container_Hardware") {
        m.envMapIntensity = 1.25;
      } else if (m.metalness > 0.55) {
        m.envMapIntensity = 1.05;
      } else if (m.metalness > 0.20) {
        m.envMapIntensity = 0.62;
      } else {
        m.envMapIntensity = 0.50;
      }
      if (m.map) { m.map.anisotropy = startAniso; managedTextures.add(m.map); }
      if (m.normalMap) { m.normalMap.anisotropy = startAniso; managedTextures.add(m.normalMap); }
      if (m.roughnessMap) { m.roughnessMap.anisotropy = startAniso; managedTextures.add(m.roughnessMap); }
      if (m.name === "Watchtower_CamoNet") {
        m.transparent = false;
        m.alphaTest = 0.45;
        m.side = THREE.DoubleSide;
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
                "#include <begin_vertex>\ntransformed.x += sin(uWindTime * 2.6 + transformed.y * 5.0 + transformed.z * 3.0) * 0.018 * uWindScale;",
              );
          },
          "mil_hfog_camo",
        );
      } else {
        applyMilitaryHeightFog(m, fogUniforms, null, "mil_hfog_std");
      }
      m.needsUpdate = true;
      hydratedMats.set(srcMat, m);
      return m;
    };

    const instancedBuckets = new Map();
    const bvhEntries = [];
    const solidMeshes = [groundMesh];
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();

    for (const obj of layout.objects) {
      const asset = obj.asset;
      const proto = protos[asset];
      if (!proto) continue;

      if (obj.bvhCollision) {
        const containerObj = new THREE.Group();
        containerObj.name = obj.id;
        containerObj.position.set(obj.position[0], obj.position[1], obj.position[2]);
        containerObj.rotation.y = obj.rotationY || 0;
        const sc = obj.scale || [1, 1, 1];
        containerObj.scale.set(sc[0], sc[1], sc[2]);

        for (const part of proto.parts) {
          const mesh = new THREE.Mesh(part.geometry, getMat(part.material));
          mesh.applyMatrix4(part.localMatrix);
          mesh.castShadow = Boolean(obj.castShadow);
          mesh.receiveShadow = true;
          mesh.matrixAutoUpdate = false;
          mesh.name = `${obj.id}_${part.name}`;
          containerObj.add(mesh);
          solidMeshes.push(mesh);

          containerObj.updateMatrixWorld(true);
          mesh.updateMatrixWorld(true);
          const invMat = mesh.matrixWorld.clone().invert();
          const wb = new THREE.Box3().setFromObject(mesh);
          bvhEntries.push({
            id: mesh.name,
            tag: asset,
            bvh: bvhCache.get(part.geometry),
            invMatrix: invMat.elements,
            worldBox: {
              x0: wb.min.x, x1: wb.max.x,
              y0: wb.min.y, y1: wb.max.y,
              z0: wb.min.z, z1: wb.max.z,
            },
          });
        }
        containerObj.matrixAutoUpdate = false;
        containerObj.updateMatrix();
        group.add(containerObj);
      } else {
        if (!instancedBuckets.has(asset)) instancedBuckets.set(asset, []);
        instancedBuckets.get(asset).push(obj);
      }
    }

    for (const [asset, items] of instancedBuckets.entries()) {
      const proto = protos[asset];
      if (!proto || !items.length) continue;

      for (const part of proto.parts) {
        const mat = getMat(part.material);
        const inst = new THREE.InstancedMesh(part.geometry, mat, items.length);
        inst.name = `inst_${asset}_${part.name}`;
        inst.castShadow = items.some((it) => it.castShadow);
        inst.receiveShadow = true;

        const isTintableContainer = asset === "container" && part.name === "container_body";
        const isTintableBarrel = asset === "oil_barrel";

        items.forEach((it, idx) => {
          dummy.position.set(it.position[0], it.position[1], it.position[2]);
          dummy.rotation.set(0, it.rotationY || 0, 0);
          const sc = it.scale || [1, 1, 1];
          dummy.scale.set(sc[0], sc[1], sc[2]);
          dummy.updateMatrix();
          const finalMat = dummy.matrix.clone().multiply(part.localMatrix);
          inst.setMatrixAt(idx, finalMat);

          if (isTintableContainer) {
            tmpColor.setHex(CONTAINER_PALETTE[(it.variant || 0) % CONTAINER_PALETTE.length]);
            inst.setColorAt(idx, tmpColor);
          } else if (isTintableBarrel) {
            tmpColor.setHex(BARREL_PALETTE[(it.variant || 0) % BARREL_PALETTE.length]);
            inst.setColorAt(idx, tmpColor);
          }
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.matrixAutoUpdate = false;
        inst.updateMatrix();
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        group.add(inst);
      }
    }

    // Golden-afternoon directional sun (~3.5:1 - 4:1 sunlit-to-shadow ratio)
    // Keep sun.castShadow = true ALWAYS so NUM_DIR_LIGHT_SHADOWS never flips (zero shader recompilation on quality switch!).
    const EMPTY_SHADOW_OFFSET_Y = 500;
    const hemi = new THREE.HemisphereLight(0xa2c0de, 0x564b3d, 0.52);
    const sun = new THREE.DirectionalLight(0xffe9c2, 2.65);
    sun.position.set(SUN_POS.x, SUN_POS.y, SUN_POS.z);
    sun.castShadow = true;
    const initShadowSize = initialPreset.shadowMapSize || (initialPreset.shadowsEnabled ? 2048 : 16);
    const initShadowExtent = initialPreset.shadowExtent || 28;
    sun.shadow.mapSize.set(initShadowSize, initShadowSize);
    Object.assign(sun.shadow.camera, {
      left: -initShadowExtent,
      right: initShadowExtent,
      top: initShadowExtent,
      bottom: -initShadowExtent,
      near: 4,
      far: 150,
    });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.022;
    hemi.layers.enableAll();
    sun.layers.enableAll();
    group.add(hemi, sun, sun.target);

    let curShadowsEnabled = Boolean(initialPreset.shadowsEnabled);
    let currentShadowExtent = initShadowExtent;
    let currentShadowSize = initShadowSize;
    let lastSnapX = Number.NaN;
    let lastSnapZ = Number.NaN;
    let lastCamX = 0;
    let lastCamZ = -40;
    let curFogDensity = initialPreset.fogDensity || 0.0034;

    const resizeSunShadowMap = (nextSize) => {
      if (nextSize === currentShadowSize) return;
      currentShadowSize = nextSize;
      sun.shadow.mapSize.set(nextSize, nextSize);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    };

    const setSunShadowFrustum = (extent, near, far) => {
      if (
        currentShadowExtent === extent &&
        sun.shadow.camera.near === near &&
        sun.shadow.camera.far === far
      ) {
        return;
      }
      currentShadowExtent = extent;
      Object.assign(sun.shadow.camera, {
        left: -extent,
        right: extent,
        top: extent,
        bottom: -extent,
        near,
        far,
      });
      sun.shadow.camera.updateProjectionMatrix();
    };

    const parkEmptySunShadow = () => {
      // Preserve exact (SUN_POS.x, SUN_POS.y, SUN_POS.z) light direction while moving shadow frustum into empty sky
      sun.target.position.set(0, EMPTY_SHADOW_OFFSET_Y, 0);
      sun.target.updateMatrixWorld();
      sun.position.set(SUN_POS.x, EMPTY_SHADOW_OFFSET_Y + SUN_POS.y, SUN_POS.z);
      setSunShadowFrustum(0.05, 0.1, 1.0);
    };

    const snapSunToPosition = (x, z) => {
      const texelWorld = (currentShadowExtent * 2) / Math.max(16, currentShadowSize);
      const stepWorld = Math.max(texelWorld * 12, 0.36);
      const snapX = Math.round(x / stepWorld) * stepWorld;
      const snapZ = Math.round(z / stepWorld) * stepWorld;
      if (snapX === lastSnapX && snapZ === lastSnapZ) return false;
      lastSnapX = snapX;
      lastSnapZ = snapZ;
      sun.target.position.set(snapX, 0, snapZ);
      sun.target.updateMatrixWorld();
      sun.position.set(snapX + SUN_POS.x, SUN_POS.y, snapZ + SUN_POS.z);
      return true;
    };

    const countWithinDist = (dists, maxDist, minKeep = 4) => {
      let c = 0;
      for (let i = 0; i < dists.length; i++) {
        if (dists[i] <= maxDist) c++;
        else break;
      }
      return Math.max(Math.min(minKeep, dists.length), c);
    };

    const applyQualityPreset = (preset = QUALITY_PRESETS.high, camPos = null) => {
      if (camPos) {
        lastCamX = camPos.x;
        lastCamZ = camPos.z;
        // Lock sun corona sprite strictly to infinite sun direction relative to camera (zero double-sun parallax!)
        if (sunFlare.visible) {
          const sl = Math.hypot(SUN_POS.x, SUN_POS.y, SUN_POS.z) || 1;
          sunFlare.position.set(
            camPos.x + (SUN_POS.x / sl) * 300,
            (camPos.y || 0) + (SUN_POS.y / sl) * 300,
            camPos.z + (SUN_POS.z / sl) * 300,
          );
        }
      }

      // 1. Invariant-shader shadow control: keep sun.castShadow=true; park tiny 16x16 frustum on Low
      sun.castShadow = true;
      curShadowsEnabled = Boolean(preset.shadowsEnabled);
      lastSnapX = Number.NaN;
      lastSnapZ = Number.NaN;
      if (curShadowsEnabled) {
        const nextSize = preset.shadowMapSize || 1024;
        const nextExt = preset.shadowExtent || 24;
        setSunShadowFrustum(nextExt, 4, 150);
        resizeSunShadowMap(nextSize);
        snapSunToPosition(lastCamX, lastCamZ);
      } else {
        resizeSunShadowMap(preset.shadowMapSize || 16);
        parkEmptySunShadow();
      }

      // 2. Post-processing & atmospheric extras (all uniform/visibility switches -> 0 shader recompile!)
      fogUniforms.uMilPostGrade.value = preset.postGradeEnabled ? 1.0 : 0.0;
      shaftGroup.visible = Boolean(preset.godRaysEnabled);
      sunFlare.visible = Boolean(preset.sunFlareEnabled);
      if (skyEnvCache.skyUniforms) {
        skyEnvCache.skyUniforms.uCloudEnabled.value = preset.cloudsEnabled ? 1.0 : 0.0;
        skyEnvCache.skyUniforms.uCloudDetail.value = preset.cloudDetail ?? 1.0;
      }
      if (envControls.valleyMistMesh) {
        envControls.valleyMistMesh.visible = Boolean(preset.valleyMistEnabled);
      }
      if (envControls.terrainUniforms) {
        envControls.terrainUniforms.uHazeScale.value =
          preset.id === "low" ? 1.25 : preset.id === "medium" ? 1.08 : 1.0;
      }
      dustPoints.visible = Boolean(preset.dustEnabled);
      windScaleUniform.value = preset.windEnabled ? (preset.id === "medium" ? 0.6 : 1.0) : 0.0;

      // 3. Grass & rubble density (zero-allocation InstancedMesh.count)
      grassInst.count = Math.max(1, Math.round(maxGrassCount * (preset.grassDensity ?? 1.0)));
      debInst.count = Math.max(1, Math.round(maxDebrisCount * (preset.rubbleDensity ?? 1.0)));

      // 4. Tree draw distance (2-tier LOD: <60m 3D InstancedMesh + >=60m full-tree billboard + mountain-slope conifer carpet)
      const maxTreeDist = preset.treeDrawDistance ?? 215;
      if (envControls.blTrunkInst && envControls.blCrownInst) {
        const blCnt = countWithinDist(envControls.blDists, maxTreeDist, 6);
        envControls.blTrunkInst.count = blCnt;
        envControls.blCrownInst.count = blCnt;
      }
      if (envControls.blFarLodInst) {
        const blFarCnt = countWithinDist(envControls.blFarDists, maxTreeDist, 0);
        envControls.blFarLodInst.count = blFarCnt;
        envControls.blFarLodInst.visible = blFarCnt > 0;
      }
      if (envControls.pineTrunkInst && envControls.pineCrownInst) {
        const pineCnt = countWithinDist(envControls.pineDists, maxTreeDist, 6);
        envControls.pineTrunkInst.count = pineCnt;
        envControls.pineCrownInst.count = pineCnt;
      }
      if (envControls.slopeConiferInst) {
        const slopeDens = preset.slopeForestDensity ?? 1.0;
        const maxSlopeByDist = countWithinDist(envControls.slopeConiferDists, maxTreeDist, 0);
        const slopeCnt = slopeDens <= 0 ? 0 : Math.min(maxSlopeByDist, Math.round(envControls.slopeConiferDists.length * slopeDens));
        envControls.slopeConiferInst.count = slopeCnt;
        envControls.slopeConiferInst.visible = slopeCnt > 0;
      }
      if (envControls.deadInst) envControls.deadInst.visible = Boolean(preset.showDeadTrees);
      if (envControls.bushInst) envControls.bushInst.visible = Boolean(preset.showBushes);
      if (envControls.boulderInst) envControls.boulderInst.visible = preset.id !== "low";
      if (envControls.outerFenceInst) envControls.outerFenceInst.visible = preset.id !== "low";
      if (envControls.farRidge) envControls.farRidge.visible = preset.id !== "low";

      // 5. Fog distance & height-fog falloff
      curFogDensity = preset.fogDensity ?? 0.0034;
      fogUniforms.uMilFogParams.value.set(
        preset.fogNearStart ?? 14.0,
        preset.fogNearEnd ?? 34.0,
        preset.fogDistBase ?? 0.0022,
        preset.fogHeightAmp ?? 0.0030,
      );

      // 6. Texture anisotropy cap in-place (ZERO texImage2D / generateMipmap re-uploads!)
      const nextAniso = Math.min(hwMaxAniso, preset.maxAnisotropy || 4);
      updateTexturesAnisotropyInPlace(renderer, managedTextures, nextAniso);
    };

    const setWarmupPassActive = (active, preset = QUALITY_PRESETS.high, camPos = null) => {
      if (active) {
        // Expose all High-only meshes & expand shadow frustum behind Loading Screen so every shader + MeshDepthMaterial compiles once
        shaftGroup.visible = true;
        sunFlare.visible = true;
        if (skyEnvCache.skyUniforms) {
          skyEnvCache.skyUniforms.uCloudEnabled.value = 1.0;
          skyEnvCache.skyUniforms.uCloudDetail.value = 1.0;
        }
        dustPoints.visible = true;
        if (envControls.valleyMistMesh) envControls.valleyMistMesh.visible = true;
        if (envControls.deadInst) envControls.deadInst.visible = true;
        if (envControls.bushInst) envControls.bushInst.visible = true;
        if (envControls.boulderInst) envControls.boulderInst.visible = true;
        if (envControls.outerFenceInst) envControls.outerFenceInst.visible = true;
        if (envControls.farRidge) envControls.farRidge.visible = true;
        if (envControls.blFarLodInst) {
          envControls.blFarLodInst.visible = true;
          envControls.blFarLodInst.count = Math.max(1, envControls.blFarDists.length);
        }
        if (envControls.slopeConiferInst) {
          envControls.slopeConiferInst.visible = true;
          envControls.slopeConiferInst.count = Math.max(1, envControls.slopeConiferDists.length);
        }
        if (!curShadowsEnabled) {
          sun.target.position.set(0, 0, 0);
          sun.target.updateMatrixWorld();
          sun.position.set(SUN_POS.x, SUN_POS.y, SUN_POS.z);
          setSunShadowFrustum(55, 4, 150);
        }
        return;
      }
      applyQualityPreset(preset, camPos);
    };

    applyQualityPreset(initialPreset);

    const updateAtmosphere = (tSec, camPos, preset = QUALITY_PRESETS.high) => {
      if (preset.windEnabled) windUniform.value = tSec;
      if (skyEnvCache.skyUniforms && preset.cloudsEnabled && preset.windEnabled) {
        skyEnvCache.skyUniforms.uTime.value = tSec;
      }
      if (envControls.mistUniforms && preset.valleyMistEnabled && preset.windEnabled) {
        envControls.mistUniforms.uTime.value = tSec;
      }
      if (preset.dustEnabled || preset.godRaysEnabled) updateDust(tSec);

      if (camPos) {
        lastCamX = camPos.x;
        lastCamZ = camPos.z;
        // Lock sun corona sprite strictly to infinite sun direction relative to camera (zero double-sun parallax!)
        if (sunFlare.visible) {
          const sl = Math.hypot(SUN_POS.x, SUN_POS.y, SUN_POS.z) || 1;
          sunFlare.position.set(
            camPos.x + (SUN_POS.x / sl) * 300,
            (camPos.y || 0) + (SUN_POS.y / sl) * 300,
            camPos.z + (SUN_POS.z / sl) * 300,
          );
        }
      }
      if (preset.shadowsEnabled && camPos) {
        // Snap shadow camera in texel-aligned steps so shadows only re-render on real player movement!
        return snapSunToPosition(camPos.x, camPos.z);
      }
      return false;
    };

    const collision = createMapCollision({
      bounds: colliders.bounds,
      boxes: colliders.boxes,
      obbs: colliders.obbs,
      walkableSlabs: colliders.walkableSlabs,
      ladders: colliders.ladders,
      bvhEntries,
    });

    groundMesh.matrixAutoUpdate = false;
    groundMesh.updateMatrix();
    scene.add(group);
    if (!deferActivate) {
      scene.background = new THREE.Color(FOG_HORIZON_HEX);
      scene.fog = new THREE.FogExp2(FOG_HORIZON_HEX, curFogDensity);

      for (const target of envMapTargetList) {
        if (target) {
          target.traverse((o) => {
            if (o.isMesh && o.material && "envMap" in o.material) {
              o.material.envMap = skyEnvCache.envMap;
              o.material.needsUpdate = true;
            }
          });
        }
      }
    }

    const extraTextures = [
      concreteTexCache.albedo,
      concreteTexCache.normal,
      concreteTexCache.roughness,
      concreteTexCache.worldMask,
      skyEnvCache.envMap,
      skyEnvCache.cloudNoiseTex,
      flareTex,
      ...envControls.extraTextures,
      ...managedTextures,
    ];
    emit(1.0, "Hoàn tất dựng bản đồ Khu Quân Sự Cũ");

    return {
      mapId: "military",
      group,
      groundMesh,
      solidMeshes,
      layout,
      colliders,
      collision,
      envMap: skyEnvCache.envMap,
      extraTextures,
      fogColor: FOG_HORIZON_HEX,
      get fogDensity() { return curFogDensity; },
      applyQualityPreset,
      setWarmupPassActive,
      updateAtmosphere,
      samplePuddle: sampleMilitaryPuddle,
      sampleDirt: sampleMilitaryDirt,
      getQualityStats: () => ({
        grassCount: grassInst.count,
        maxGrassCount,
        rubbleCount: debInst.count,
        broadleafCount:
          (envControls.blCrownInst ? envControls.blCrownInst.count : 0) +
          (envControls.blFarLodInst && envControls.blFarLodInst.visible ? envControls.blFarLodInst.count : 0),
        pineCount:
          (envControls.pineCrownInst ? envControls.pineCrownInst.count : 0) +
          (envControls.slopeConiferInst && envControls.slopeConiferInst.visible ? envControls.slopeConiferInst.count : 0),
        farTreeLodCount:
          (envControls.blFarLodInst && envControls.blFarLodInst.visible ? envControls.blFarLodInst.count : 0) +
          (envControls.slopeConiferInst && envControls.slopeConiferInst.visible ? envControls.slopeConiferInst.count : 0),
        slopeForestCount:
          envControls.slopeConiferInst && envControls.slopeConiferInst.visible ? envControls.slopeConiferInst.count : 0,
        deadTreesVisible: envControls.deadInst ? envControls.deadInst.visible : false,
        bushesVisible: envControls.bushInst ? envControls.bushInst.visible : false,
        valleyMistVisible: envControls.valleyMistMesh ? envControls.valleyMistMesh.visible : false,
        cloudsVisible: skyEnvCache.skyUniforms ? skyEnvCache.skyUniforms.uCloudEnabled.value > 0.5 : false,
        godRaysVisible: shaftGroup.visible,
        dustVisible: dustPoints.visible,
        sunFlareVisible: sunFlare.visible,
        dynamicShadowsActive: curShadowsEnabled,
        sunCastShadow: sun.castShadow,
        sunPos: { x: SUN_POS.x, y: SUN_POS.y, z: SUN_POS.z },
        shadowMapSize: currentShadowSize,
        fogDensity: curFogDensity,
        postGradeValue: fogUniforms.uMilPostGrade.value,
      }),
      isRainy: false,
    };
  }

  return {
    loadSharedJson,
    buildMilitaryScene,
  };
}
