/**
 * MapLoader for Khu Quân Sự Cũ 5v5 (v3.1 Performance + 3-Tier Quality):
 * - Balanced ~3.5:1 sun-to-ambient lighting, toned PMREM IBL, layered height fog & aerial perspective
 * - Pre-baked 512x512 world-space ground mask (replaces 14-octave per-pixel FBM with 1 texture fetch!)
 * - Consolidated GLSL customProgramCacheKey (~7 shared programs instead of 54!)
 * - Runtime applyQualityPreset() controlling shadows, post-grade/atmosphere, grass density, tree draw distance & fog length
 */

import { buildTriangleBVH, createMapCollision } from "/js/map_collision.js";
import { MILITARY_COLLIDERS, MILITARY_LAYOUT } from "/js/military_map_data.js";
import { QUALITY_PRESETS } from "/js/graphics_quality.js";
import { yieldToUI } from "/js/loading_manager.js";

// Rich weathered military tones (deep saturation without pastel washout or crushed blacks)
const CONTAINER_PALETTE = [0x86382b, 0x47573d, 0x384e5e];
const BARREL_PALETTE = [0x445438, 0x823426, 0x4b555d];
// Crisp 3/4 cross-lighting from East-Northeast (~31 deg elevation) so containers, warehouses & crates show sunlit + shaded faces
const SUN_POS = { x: 50, y: 32, z: -26 };
const FOG_HORIZON_HEX = 0xa8b8c6;
const FOG_SUN_HEX = 0xe4d5ba;

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
    vec3 milFogCol = mix(fogColor, uMilSunFogColor, milSunScatter * 0.42);
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

async function buildSkyDomeAndEnvMapAsync(renderer, THREE, yieldFn) {
  // 512x256 sculpted volumetric sky dome (4x faster load, visually smooth with linear filtering)
  const w = 512, h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;

  const sl = Math.hypot(SUN_POS.x, SUN_POS.y, SUN_POS.z);
  const sx = SUN_POS.x / sl, sy = SUN_POS.y / sl, sz = SUN_POS.z / sl;

  for (let py = 0; py < h; py++) {
    if (py === 128 && yieldFn) await yieldFn();
    const v = py / (h - 1);
    const phi = v * Math.PI;
    const sinP = Math.sin(phi), cosP = Math.cos(phi);
    for (let px = 0; px < w; px++) {
      const u = px / w;
      const theta = u * Math.PI * 2;
      const dx = -Math.cos(theta) * sinP;
      const dy = cosP;
      const dz = Math.sin(theta) * sinP;
      const idx = (py * w + px) * 4;

      if (dy < -0.02) {
        const gFade = Math.min(1, (-dy - 0.02) * 3.0);
        d[idx] = Math.round(78 * (1 - gFade) + 28 * gFade);
        d[idx + 1] = Math.round(74 * (1 - gFade) + 26 * gFade);
        d[idx + 2] = Math.round(68 * (1 - gFade) + 22 * gFade);
        d[idx + 3] = 255;
        continue;
      }

      const sunDot = Math.max(0, dx * sx + dy * sy + dz * sz);
      const mieGlow = Math.pow(sunDot, 4.5) * 0.30 + Math.pow(sunDot, 36.0) * 0.72;
      const sunDisc = Math.pow(sunDot, 420.0) * 1.15;

      const c1 = periodicNoise(u * 5, v * 4, 5, 19);
      const c2 = periodicNoise(u * 12, v * 9, 12, 47);
      const c3 = periodicNoise(u * 26, v * 18, 26, 89);
      const cloudField = 0.50 * c1 + 0.32 * c2 + 0.18 * c3;
      const elevFade = Math.max(0, Math.min(1, (dy - 0.03) / 0.14)) * (1 - Math.max(0, (dy - 0.78) / 0.22));
      const cloudMask = Math.max(0, Math.min(1, (cloudField - 0.45) * 3.1)) * elevFade;

      const cSun = 0.55 * periodicNoise((u + 0.014) * 5, (v - 0.012) * 4, 5, 19)
        + 0.45 * periodicNoise((u + 0.014) * 12, (v - 0.012) * 9, 12, 47);
      const cloudLit = Math.max(0.18, Math.min(1.0, 0.52 + (cloudField - cSun) * 3.8 + sunDot * 0.35 + dy * 0.25));

      const tElev = Math.max(0, Math.min(1, dy));
      const horizonMix = Math.pow(1 - tElev, 2.5);
      let r = 0.21 + 0.45 * horizonMix + mieGlow * 0.46 + sunDisc;
      let g = 0.33 + 0.39 * horizonMix + mieGlow * 0.37 + sunDisc * 0.94;
      let b = 0.49 + 0.29 * horizonMix + mieGlow * 0.19 + sunDisc * 0.80;

      const cR = 0.40 + cloudLit * 0.46 + mieGlow * 0.24;
      const cG = 0.44 + cloudLit * 0.43 + mieGlow * 0.18;
      const cB = 0.49 + cloudLit * 0.37 + mieGlow * 0.08;
      r = r * (1 - cloudMask * 0.82) + cR * (cloudMask * 0.82);
      g = g * (1 - cloudMask * 0.82) + cG * (cloudMask * 0.82);
      b = b * (1 - cloudMask * 0.82) + cB * (cloudMask * 0.82);

      d[idx] = Math.min(255, Math.round(r * 255));
      d[idx + 1] = Math.min(255, Math.round(g * 255));
      d[idx + 2] = Math.min(255, Math.round(b * 255));
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const skyTex = new THREE.CanvasTexture(canvas);
  skyTex.encoding = THREE.sRGBEncoding || THREE.LinearEncoding;

  const skyGeo = new THREE.SphereGeometry(225, 32, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = "military_sky_dome";

  if (yieldFn) await yieldFn();

  // Slow-drifting upper wispy cloud deck
  const cw = 256, ch = 128;
  const cCanvas = document.createElement("canvas");
  cCanvas.width = cw;
  cCanvas.height = ch;
  const cCtx = cCanvas.getContext("2d");
  const cImg = cCtx.createImageData(cw, ch);
  const cd = cImg.data;
  for (let py = 0; py < ch; py++) {
    const v = py / (ch - 1);
    const dy = Math.cos(v * Math.PI);
    const band = Math.max(0, Math.min(1, (dy - 0.10) / 0.18)) * Math.max(0, Math.min(1, (0.92 - dy) / 0.25));
    for (let px = 0; px < cw; px++) {
      const u = px / cw;
      const idx = (py * cw + px) * 4;
      const n = 0.58 * periodicNoise(u * 7, v * 5, 7, 311)
        + 0.42 * periodicNoise(u * 16, v * 11, 16, 419);
      const a = Math.max(0, Math.min(1, (n - 0.50) * 2.8)) * band;
      cd[idx] = 236;
      cd[idx + 1] = 232;
      cd[idx + 2] = 224;
      cd[idx + 3] = Math.round(a * 115);
    }
  }
  cCtx.putImageData(cImg, 0, 0);
  const driftTex = new THREE.CanvasTexture(cCanvas);
  driftTex.wrapS = THREE.RepeatWrapping;
  if (THREE.sRGBEncoding) driftTex.encoding = THREE.sRGBEncoding;
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(212, 24, 12),
    new THREE.MeshBasicMaterial({
      map: driftTex,
      transparent: true,
      opacity: 0.72,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  cloudMesh.name = "military_drifting_clouds";

  if (yieldFn) await yieldFn();

  // Balanced PMREM IBL
  const es = new THREE.Scene();
  const envSphere = new THREE.Mesh(
    new THREE.SphereGeometry(28, 28, 14),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, toneMapped: false }),
  );
  const sunBounce = new THREE.Mesh(
    new THREE.SphereGeometry(3.4, 12, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.15, 1.76, 1.32), toneMapped: false }),
  );
  sunBounce.position.set(SUN_POS.x * 0.4, SUN_POS.y * 0.4, SUN_POS.z * 0.4);
  es.add(envSphere, sunBounce);

  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(es, 0.032);
  pm.dispose();
  envSphere.geometry.dispose();
  sunBounce.geometry.dispose();

  return { skyMesh, cloudMesh, envMap: rt.texture, skyTex, driftTex };
}

function buildGodRaysDustAndFlare(THREE) {
  const rayCanvas = document.createElement("canvas");
  rayCanvas.width = 64;
  rayCanvas.height = 128;
  const g = rayCanvas.getContext("2d");
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0.0, "rgba(255, 236, 198, 0.0)");
  gr.addColorStop(0.20, "rgba(255, 232, 188, 0.16)");
  gr.addColorStop(0.68, "rgba(235, 214, 178, 0.08)");
  gr.addColorStop(1.0, "rgba(210, 196, 172, 0.0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = "destination-in";
  const hr = g.createLinearGradient(0, 0, 64, 0);
  hr.addColorStop(0.0, "rgba(0,0,0,0)");
  hr.addColorStop(0.32, "rgba(0,0,0,0.85)");
  hr.addColorStop(0.5, "rgba(0,0,0,1.0)");
  hr.addColorStop(0.68, "rgba(0,0,0,0.85)");
  hr.addColorStop(1.0, "rgba(0,0,0,0)");
  g.fillStyle = hr;
  g.fillRect(0, 0, 64, 128);

  const rayTex = new THREE.CanvasTexture(rayCanvas);
  const rayMat = new THREE.MeshBasicMaterial({
    map: rayTex,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  const rayGroup = new THREE.Group();
  rayGroup.name = "military_god_rays";
  const shaftGroup = new THREE.Group();
  shaftGroup.name = "military_god_ray_shafts";
  const shaftGeo = new THREE.PlaneGeometry(13, 56);
  const sunDir = new THREE.Vector3(SUN_POS.x, SUN_POS.y, SUN_POS.z).normalize();
  const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir);

  const shaftSpecs = [
    [-10, 18, -12, 0.2],
    [4, 20, -2, 0.85],
    [16, 19, 8, -0.45],
    [-4, 21, 16, 1.1],
  ];
  for (const [sx, sy, sz, yawOff] of shaftSpecs) {
    const m = new THREE.Mesh(shaftGeo, rayMat);
    m.position.set(sx, sy, sz);
    m.quaternion.copy(alignQ);
    m.rotateY(yawOff);
    m.renderOrder = 4;
    shaftGroup.add(m);
  }
  rayGroup.add(shaftGroup);

  // Subtle occluded sun glare / lens flare corona along sun direction
  const flareCanvas = document.createElement("canvas");
  flareCanvas.width = flareCanvas.height = 128;
  const fg = flareCanvas.getContext("2d");
  const fGrad = fg.createRadialGradient(64, 64, 1, 64, 64, 62);
  fGrad.addColorStop(0.0, "rgba(255, 248, 226, 0.72)");
  fGrad.addColorStop(0.18, "rgba(255, 224, 168, 0.36)");
  fGrad.addColorStop(0.50, "rgba(255, 198, 130, 0.10)");
  fGrad.addColorStop(1.0, "rgba(255, 180, 110, 0.0)");
  fg.fillStyle = fGrad;
  fg.fillRect(0, 0, 128, 128);
  const flareTex = new THREE.CanvasTexture(flareCanvas);
  const sunFlare = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: flareTex,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
    }),
  );
  sunFlare.position.copy(sunDir).multiplyScalar(202);
  sunFlare.scale.set(42, 42, 1);
  sunFlare.name = "military_sun_flare";
  rayGroup.add(sunFlare);

  // Wind-swept airborne dust motes (160 particles, skipped cleanly when dustEnabled=false)
  const N = 160;
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
    color: 0xdccbb0,
    size: 0.075,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  dustPoints.name = "military_dust_motes";

  return {
    rayGroup,
    shaftGroup,
    sunFlare,
    dustPoints,
    update(tSec) {
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
  }, 16, 20, true);
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
  }, 16, 20, false);
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
  }, 16, 20, false);
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
  ammoInst.castShadow = true;
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
  signInst.castShadow = true;
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

async function buildBackgroundTreesAndMountainsAsync(THREE, layout, envMap, fogUniforms, windUniform, windScaleUniform, yieldFn) {
  const bgGroup = new THREE.Group();
  bgGroup.name = "military_background_horizon";
  bgGroup.matrixAutoUpdate = false;
  const { maxX, maxZ } = layout.bounds;

  // 1. Multi-layer atmospheric mountain ridges
  const makeRidgeRing = (rTop, rBot, height, baseY, segs, hSegs, peakBias, sunRgb, shadeRgb, valleyRgb, seedShift) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, height, segs, hSegs, true);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const ang = Math.atan2(z, x);
      const tH = Math.max(0, (y + height * 0.5) / height);
      if (tH > 0.10) {
        const heroPeak = Math.exp(-Math.pow(((ang - 1.72 + Math.PI * 3) % (Math.PI * 2)) - Math.PI, 2) / 0.30) * peakBias;
        const heroRight = Math.exp(-Math.pow(((ang - 0.94 + Math.PI * 3) % (Math.PI * 2)) - Math.PI, 2) / 0.22) * (peakBias * 0.74);
        const ridge =
          Math.sin(ang * 3 + 0.6 + seedShift) * 7.8 +
          Math.abs(Math.sin(ang * 6 + 1.1 + seedShift)) * 6.8 +
          Math.cos(ang * 13 + seedShift) * 3.1 +
          Math.sin(ang * 23 + seedShift * 2.1) * 1.35 +
          heroPeak +
          heroRight;
        pos.setY(i, Math.max(-height * 0.45, y + ridge * tH));
      }
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const cols = new Float32Array(pos.count * 3);
    const sLen = Math.hypot(SUN_POS.x, SUN_POS.y, SUN_POS.z) || 1;
    const sx = SUN_POS.x / sLen, sy = SUN_POS.y / sLen, sz = SUN_POS.z / sLen;
    for (let i = 0; i < pos.count; i++) {
      const tH = Math.max(0, Math.min(1, (pos.getY(i) + height * 0.5) / (height * 1.32)));
      const nx = -nrm.getX(i), ny = Math.abs(nrm.getY(i)), nz = -nrm.getZ(i);
      const sunDot = Math.max(0, Math.min(1, nx * sx + ny * sy + nz * sz));
      const baseMix = Math.pow(1 - tH, 1.45) * 0.62;
      const cr = (shadeRgb[0] + (sunRgb[0] - shadeRgb[0]) * sunDot) * (1 - baseMix) + valleyRgb[0] * baseMix;
      const cg = (shadeRgb[1] + (sunRgb[1] - shadeRgb[1]) * sunDot) * (1 - baseMix) + valleyRgb[1] * baseMix;
      const cb = (shadeRgb[2] + (sunRgb[2] - shadeRgb[2]) * sunDot) * (1 - baseMix) + valleyRgb[2] * baseMix;
      cols[i * 3] = cr; cols[i * 3 + 1] = cg; cols[i * 3 + 2] = cb;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    applyMilitaryHeightFog(mat, fogUniforms, null, "mil_hfog_mountain");
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = baseY;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  };
  const nearRidge = makeRidgeRing(130, 162, 46, 15, 76, 5, 22.0, [0.46, 0.44, 0.37], [0.22, 0.27, 0.33], [0.54, 0.61, 0.68], 0.0);
  const farRidge = makeRidgeRing(166, 200, 66, 23, 64, 4, 29.0, [0.52, 0.56, 0.62], [0.36, 0.43, 0.52], [0.64, 0.70, 0.76], 1.7);
  bgGroup.add(nearRidge, farRidge);

  const mergeStaticParts = (parts, withColor = false) => {
    let totalV = 0, totalI = 0;
    for (const g of parts) {
      totalV += g.attributes.position.count;
      totalI += g.index.count;
    }
    const pArr = new Float32Array(totalV * 3);
    const nArr = new Float32Array(totalV * 3);
    const uArr = new Float32Array(totalV * 2);
    const cArr = withColor ? new Float32Array(totalV * 3) : null;
    const iArr = new Uint16Array(totalI);
    let vo = 0, io = 0;
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
  };

  const fixAlphaBleed = (ctx, w, h, fillR, fillG, fillB) => {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      if (d[i * 4 + 3] < 20) {
        d[i * 4] = fillR;
        d[i * 4 + 1] = fillG;
        d[i * 4 + 2] = fillB;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const buildBroadleafTex = () => {
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
    const shades = ["#38422a", "#434e31", "#4e5836", "#5a603a", "#67643d", "#746840", "#303a24"];
    for (let k = 0; k < 245; k++) {
      const rDist = Math.pow(lrnd(), 0.62) * 96;
      const theta = lrnd() * Math.PI * 2;
      const lx = 128 + Math.cos(theta) * rDist;
      const ly = 128 + Math.sin(theta) * rDist;
      const wLeaf = 7.5 + lrnd() * 8.5;
      const hLeaf = 3.2 + lrnd() * 3.8;
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
    fixAlphaBleed(g, 256, 256, 66, 76, 48);
    const t = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    return t;
  };

  const buildPineTex = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 256, 256);
    let ps = 553319;
    const prnd = () => ((ps = (ps * 16807) % 2147483647) / 2147483647);
    const pineCols = ["#243322", "#2d3e29", "#374930", "#425338", "#1e2b1d", "#4c583c"];
    for (let b = 0; b < 9; b++) {
      const bAng = (b / 9) * Math.PI * 2 + (prnd() - 0.5) * 0.28;
      const bLen = 78 + prnd() * 34;
      g.strokeStyle = "#372d22";
      g.lineWidth = 2.6;
      g.beginPath();
      g.moveTo(128, 128);
      g.lineTo(128 + Math.cos(bAng) * bLen, 128 + Math.sin(bAng) * bLen);
      g.stroke();
      for (let n = 0; n < 38; n++) {
        const frac = 0.14 + (n / 38) * 0.86;
        const bx = 128 + Math.cos(bAng) * bLen * frac;
        const by = 128 + Math.sin(bAng) * bLen * frac;
        const side = n % 2 === 0 ? 1 : -1;
        const nAng = bAng + side * (0.48 + prnd() * 0.55);
        const nLen = (14 + prnd() * 14) * (1.15 - frac * 0.45);
        g.strokeStyle = pineCols[Math.floor(prnd() * pineCols.length)];
        g.lineWidth = 2.4 + prnd() * 1.4;
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(nAng) * nLen, by + Math.sin(nAng) * nLen);
        g.stroke();
      }
    }
    fixAlphaBleed(g, 256, 256, 44, 58, 39);
    const t = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    return t;
  };

  let s = 334455;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const groves = [
    [-46, -42, 10, 12, 7],
    [-48, -14, 11, 14, 8],
    [-46, 20, 10, 14, 7],
    [-44, 48, 11, 10, 6],
    [-16, -56, 12, 8, 7],
    [18, -56, 13, 9, 7],
    [-18, 56, 13, 9, 7],
    [16, 56, 13, 9, 7],
    [46, -34, 11, 13, 7],
    [48, 2, 11, 14, 7],
    [46, 36, 11, 12, 7],
  ];

  const broadleafList = [];
  const pineList = [];
  const deadList = [];
  const bushList = [];

  for (const [gx, gz, rx, rz, cnt] of groves) {
    for (let k = 0; k < cnt; k++) {
      let x = gx + (rnd() - 0.5) * rx * 2;
      let z = gz + (rnd() - 0.5) * rz * 2;
      if (Math.abs(x) < maxX + 3.2 && Math.abs(z) < maxZ + 3.2) {
        if (Math.abs(x) / maxX > Math.abs(z) / maxZ) x = Math.sign(x || 1) * (maxX + 3.8 + rnd() * 5);
        else z = Math.sign(z || 1) * (maxZ + 3.8 + rnd() * 5);
      }
      const dist = Math.hypot(x, z);
      const pick = rnd();
      if (pick < 0.50) {
        broadleafList.push({ x, z, dist, trunkH: 2.6 + rnd() * 2.6, r: 2.4 + rnd() * 1.9, ry: rnd() * Math.PI * 2, tint: Math.floor(rnd() * 5) });
      } else if (pick < 0.86) {
        pineList.push({ x, z, dist, h: 9.0 + rnd() * 6.5, r: 2.1 + rnd() * 1.3, ry: rnd() * Math.PI * 2, tint: Math.floor(rnd() * 4) });
      } else {
        deadList.push({ x, z, dist, h: 6.2 + rnd() * 4.5, r: 1.6 + rnd() * 1.0, ry: rnd() * Math.PI * 2 });
      }
    }
    for (let b = 0; b < 2; b++) {
      let bx = gx * 0.90 + (rnd() - 0.5) * rx * 1.7;
      let bz = gz * 0.90 + (rnd() - 0.5) * rz * 1.7;
      if (Math.abs(bx) < maxX + 2.4 && Math.abs(bz) < maxZ + 2.4) {
        if (Math.abs(bx) / maxX > Math.abs(bz) / maxZ) bx = Math.sign(bx || 1) * (maxX + 2.8 + rnd() * 2.5);
        else bz = Math.sign(bz || 1) * (maxZ + 2.8 + rnd() * 2.5);
      }
      bushList.push({ x: bx, z: bz, s: 1.3 + rnd() * 1.3, ry: rnd() * Math.PI * 2, tint: Math.floor(rnd() * 5) });
    }
  }

  // Sort nearest-first so treeDrawDistance cleanly adjusts inst.count without reallocating GPU buffers!
  broadleafList.sort((a, b) => a.dist - b.dist);
  pineList.sort((a, b) => a.dist - b.dist);

  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x3b2f23, roughness: 0.94, metalness: 0.0, envMap, envMapIntensity: 0.25,
  });
  applyMilitaryHeightFog(trunkMat, fogUniforms, null, "mil_hfog_std");

  const broadleafTex = buildBroadleafTex();
  if (yieldFn) await yieldFn();
  const pineTex = buildPineTex();
  if (yieldFn) await yieldFn();

  const makeFoliageMat = (mapTex) => {
    const m = new THREE.MeshStandardMaterial({
      map: mapTex,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.0,
      envMap,
      envMapIntensity: 0.58,
      alphaTest: 0.44,
      side: THREE.DoubleSide,
    });
    // Share ONE compiled foliage shader program across broadleaf, pine & bushes!
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
            "#include <begin_vertex>\nfloat wAmp = max(0.0, transformed.y - 0.25) * 0.045 * uWindScale;\ntransformed.x += sin(uWindTime * 1.55 + transformed.y * 2.4 + transformed.z * 2.0) * wAmp;\ntransformed.z += cos(uWindTime * 1.20 + transformed.x * 2.2) * wAmp * 0.55;",
          );
      },
      "mil_hfog_foliage",
    );
    return m;
  };

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const treeControls = {
    farRidge,
    blTrunkInst: null,
    blCrownInst: null,
    blDists: broadleafList.map((t) => t.dist),
    pineTrunkInst: null,
    pineCrownInst: null,
    pineDists: pineList.map((t) => t.dist),
    deadInst: null,
    bushInst: null,
  };

  // ---- Species 1: Broadleaf / Deciduous Trees (outer perimeter -> castShadow=false saves ~3.5k alpha shadow tris!) ----
  if (broadleafList.length > 0) {
    const stem = new THREE.CylinderGeometry(0.14, 0.30, 1.0, 5); stem.translate(0, 0.50, 0);
    const b1 = new THREE.CylinderGeometry(0.06, 0.12, 0.55, 4); b1.rotateZ(0.62); b1.translate(-0.18, 0.92, 0.06);
    const b2 = new THREE.CylinderGeometry(0.06, 0.12, 0.55, 4); b2.rotateZ(-0.56); b2.rotateY(2.1); b2.translate(0.16, 0.94, -0.08);
    const b3 = new THREE.CylinderGeometry(0.05, 0.10, 0.48, 4); b3.rotateX(0.55); b3.translate(0.03, 0.96, 0.15);
    const blTrunkGeo = mergeStaticParts([stem, b1, b2, b3], false);
    const blTrunkInst = new THREE.InstancedMesh(blTrunkGeo, trunkMat, broadleafList.length);
    blTrunkInst.castShadow = false;
    blTrunkInst.matrixAutoUpdate = false;

    const cards = [];
    let cs = 774411;
    const crnd = () => ((cs = (cs * 16807) % 2147483647) / 2147483647);
    const lobes = [[0, 0.95, 0, 1.0], [-0.45, 0.65, 0.30, 0.72], [0.48, 0.72, -0.26, 0.75]];
    for (let cIdx = 0; cIdx < 32; cIdx++) {
      const lobe = lobes[cIdx % lobes.length];
      const phi = Math.acos(1 - 2 * ((cIdx + 0.5) / 32));
      const theta = Math.PI * (1 + Math.sqrt(5)) * cIdx + crnd() * 0.45;
      const rad = (0.34 + crnd() * 0.68) * lobe[3];
      const ox = lobe[0] + Math.sin(phi) * Math.cos(theta) * rad;
      const oy = lobe[1] + Math.cos(phi) * rad * 0.78;
      const oz = lobe[2] + Math.sin(phi) * Math.sin(theta) * rad;
      const cardSz = 0.88 + crnd() * 0.44;
      const card = new THREE.PlaneGeometry(cardSz, cardSz);
      card.rotateX((crnd() - 0.5) * 1.5);
      card.rotateY(theta + (crnd() - 0.5) * 1.6);
      card.rotateZ((crnd() - 0.5) * 1.3);
      card.translate(ox, oy, oz);

      const cp = card.attributes.position;
      const cn = card.attributes.normal;
      const vc = new Float32Array(cp.count * 3);
      for (let vi = 0; vi < cp.count; vi++) {
        const vx = cp.getX(vi), vy = cp.getY(vi) - 0.85, vz = cp.getZ(vi);
        const distC = Math.hypot(vx, vy, vz);
        const len = distC || 1;
        const nx = (vx / len) * 0.82;
        const ny = (vy / len) * 0.68 + 0.38;
        const nz = (vz / len) * 0.82;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        cn.setXYZ(vi, nx / nLen, ny / nLen, nz / nLen);
        const aoRad = Math.max(0.0, Math.min(1.0, (distC - 0.28) / 0.92));
        const aoH = Math.max(0.0, Math.min(1.0, (cp.getY(vi) - 0.15) / 1.45));
        const ao = 0.48 + 0.34 * aoRad + 0.24 * aoH;
        vc[vi * 3] = ao;
        vc[vi * 3 + 1] = ao * (0.97 + 0.03 * aoH);
        vc[vi * 3 + 2] = ao * 0.92;
      }
      card.setAttribute("color", new THREE.BufferAttribute(vc, 3));
      cards.push(card);
    }
    const blCrownGeo = mergeStaticParts(cards, true);
    const blCrownMat = makeFoliageMat(broadleafTex);
    const blCrownInst = new THREE.InstancedMesh(blCrownGeo, blCrownMat, broadleafList.length);
    blCrownInst.castShadow = false;
    blCrownInst.receiveShadow = false;
    blCrownInst.matrixAutoUpdate = false;

    const blPalette = [0xbdc29e, 0xb0b896, 0xc9bd94, 0xa5b090, 0xc2ae84];
    broadleafList.forEach((tr, idx) => {
      dummy.position.set(tr.x, 0, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r * 0.55, tr.trunkH, tr.r * 0.55);
      dummy.updateMatrix();
      blTrunkInst.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(tr.x, tr.trunkH * 0.82, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r, tr.r * (0.96 + (idx % 3) * 0.10), tr.r);
      dummy.updateMatrix();
      blCrownInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(blPalette[tr.tint]);
      blCrownInst.setColorAt(idx, col);
    });
    blTrunkInst.instanceMatrix.needsUpdate = true; blTrunkInst.updateMatrix();
    blCrownInst.instanceMatrix.needsUpdate = true; blCrownInst.updateMatrix();
    if (blCrownInst.instanceColor) blCrownInst.instanceColor.needsUpdate = true;
    bgGroup.add(blTrunkInst, blCrownInst);
    treeControls.blTrunkInst = blTrunkInst;
    treeControls.blCrownInst = blCrownInst;
  }

  // ---- Species 2: Conifer / Pine Trees ----
  if (pineList.length > 0) {
    const pStem = new THREE.CylinderGeometry(0.05, 0.24, 0.92, 5); pStem.translate(0, 0.46, 0);
    const pineTrunkInst = new THREE.InstancedMesh(pStem, trunkMat, pineList.length);
    pineTrunkInst.castShadow = false;
    pineTrunkInst.matrixAutoUpdate = false;

    const pCards = [];
    let ps = 661188;
    const prnd = () => ((ps = (ps * 16807) % 2147483647) / 2147483647);
    const tiers = [
      [0.26, 0.85, 7, 1.05],
      [0.46, 0.68, 6, 0.92],
      [0.65, 0.48, 5, 0.78],
      [0.82, 0.28, 4, 0.62],
      [0.95, 0.08, 2, 0.48],
    ];
    for (const [ty, rad, cnt, sz] of tiers) {
      for (let k = 0; k < cnt; k++) {
        const ang = (k / cnt) * Math.PI * 2 + ty * 4.5 + (prnd() - 0.5) * 0.35;
        const card = new THREE.PlaneGeometry(sz, sz);
        card.rotateX(-0.55 + (prnd() - 0.5) * 0.35);
        card.rotateY(ang);
        card.translate(Math.cos(ang) * rad * 0.55, ty, Math.sin(ang) * rad * 0.55);
        const cp = card.attributes.position;
        const cn = card.attributes.normal;
        const vc = new Float32Array(cp.count * 3);
        for (let vi = 0; vi < cp.count; vi++) {
          const vx = cp.getX(vi), vy = cp.getY(vi), vz = cp.getZ(vi);
          const rHoriz = Math.hypot(vx, vz);
          const len = Math.hypot(vx, 0.55, vz) || 1;
          cn.setXYZ(vi, vx / len, 0.55 / len, vz / len);
          const ao = 0.46 + 0.32 * Math.min(1, rHoriz / (rad + 0.25)) + 0.28 * vy;
          vc[vi * 3] = ao * 0.94;
          vc[vi * 3 + 1] = ao;
          vc[vi * 3 + 2] = ao * 0.92;
        }
        card.setAttribute("color", new THREE.BufferAttribute(vc, 3));
        pCards.push(card);
      }
    }
    const pineCrownGeo = mergeStaticParts(pCards, true);
    const pineCrownMat = makeFoliageMat(pineTex);
    const pineCrownInst = new THREE.InstancedMesh(pineCrownGeo, pineCrownMat, pineList.length);
    pineCrownInst.castShadow = false;
    pineCrownInst.receiveShadow = false;
    pineCrownInst.matrixAutoUpdate = false;

    const pinePalette = [0xa2b398, 0x94a68d, 0xabb89c, 0x899a82];
    pineList.forEach((tr, idx) => {
      dummy.position.set(tr.x, 0, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r * 0.5, tr.h, tr.r * 0.5);
      dummy.updateMatrix();
      pineTrunkInst.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(tr.x, 0, tr.z);
      dummy.rotation.set(0, tr.ry, 0);
      dummy.scale.set(tr.r, tr.h, tr.r);
      dummy.updateMatrix();
      pineCrownInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(pinePalette[tr.tint]);
      pineCrownInst.setColorAt(idx, col);
    });
    pineTrunkInst.instanceMatrix.needsUpdate = true; pineTrunkInst.updateMatrix();
    pineCrownInst.instanceMatrix.needsUpdate = true; pineCrownInst.updateMatrix();
    if (pineCrownInst.instanceColor) pineCrownInst.instanceColor.needsUpdate = true;
    bgGroup.add(pineTrunkInst, pineCrownInst);
    treeControls.pineTrunkInst = pineTrunkInst;
    treeControls.pineCrownInst = pineCrownInst;
  }

  // ---- Species 3: Weathered Dead / Dry Snag Trees + Low Scrub Bushes ----
  if (deadList.length > 0) {
    const dStem = new THREE.CylinderGeometry(0.08, 0.26, 0.85, 5); dStem.translate(0, 0.425, 0);
    const db1 = new THREE.CylinderGeometry(0.03, 0.09, 0.48, 4); db1.rotateZ(0.75); db1.translate(-0.18, 0.72, 0.04);
    const db2 = new THREE.CylinderGeometry(0.025, 0.08, 0.45, 4); db2.rotateZ(-0.68); db2.rotateY(1.4); db2.translate(0.16, 0.78, -0.06);
    const db3 = new THREE.CylinderGeometry(0.02, 0.06, 0.36, 4); db3.rotateX(0.70); db3.translate(0.02, 0.86, 0.14);
    const deadGeo = mergeStaticParts([dStem, db1, db2, db3], false);
    const deadMat = new THREE.MeshStandardMaterial({
      color: 0x5c5347, roughness: 0.95, metalness: 0.0, envMap, envMapIntensity: 0.25,
    });
    applyMilitaryHeightFog(deadMat, fogUniforms, null, "mil_hfog_std");
    const deadInst = new THREE.InstancedMesh(deadGeo, deadMat, deadList.length);
    deadInst.castShadow = false;
    deadInst.matrixAutoUpdate = false;
    deadList.forEach((tr, idx) => {
      dummy.position.set(tr.x, 0, tr.z);
      dummy.rotation.set((rnd() - 0.5) * 0.08, tr.ry, (rnd() - 0.5) * 0.08);
      dummy.scale.set(tr.r * 0.65, tr.h, tr.r * 0.65);
      dummy.updateMatrix();
      deadInst.setMatrixAt(idx, dummy.matrix);
    });
    deadInst.instanceMatrix.needsUpdate = true; deadInst.updateMatrix();
    bgGroup.add(deadInst);
    treeControls.deadInst = deadInst;
  }

  if (bushList.length > 0) {
    const bCards = [];
    let bs = 992233;
    const brnd = () => ((bs = (bs * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2 + brnd() * 0.4;
      const rad = 0.22 + brnd() * 0.38;
      const c = new THREE.PlaneGeometry(0.75 + brnd() * 0.25, 0.70 + brnd() * 0.22);
      c.rotateX((brnd() - 0.5) * 1.1);
      c.rotateY(ang + (brnd() - 0.5) * 1.2);
      c.translate(Math.cos(ang) * rad, 0.36 + brnd() * 0.28, Math.sin(ang) * rad);
      const cp = c.attributes.position;
      const cn = c.attributes.normal;
      const vc = new Float32Array(cp.count * 3);
      for (let vi = 0; vi < cp.count; vi++) {
        const vy = cp.getY(vi);
        cn.setXYZ(vi, cp.getX(vi) * 0.45, 0.88, cp.getZ(vi) * 0.45);
        const ao = 0.42 + 0.56 * Math.max(0, Math.min(1, vy / 0.85));
        vc[vi * 3] = ao; vc[vi * 3 + 1] = ao * 0.96; vc[vi * 3 + 2] = ao * 0.88;
      }
      c.setAttribute("color", new THREE.BufferAttribute(vc, 3));
      bCards.push(c);
    }
    const bushGeo = mergeStaticParts(bCards, true);
    const bushMat = makeFoliageMat(broadleafTex);
    const bushInst = new THREE.InstancedMesh(bushGeo, bushMat, bushList.length);
    bushInst.castShadow = false;
    bushInst.receiveShadow = false;
    bushInst.matrixAutoUpdate = false;
    const bushPal = [0x8b916c, 0x7d8460, 0x9b8e66, 0x6f7a58, 0x8d835c];
    bushList.forEach((b, idx) => {
      dummy.position.set(b.x, 0, b.z);
      dummy.rotation.set(0, b.ry, 0);
      dummy.scale.set(b.s * 1.15, b.s * 0.85, b.s * 1.15);
      dummy.updateMatrix();
      bushInst.setMatrixAt(idx, dummy.matrix);
      col.setHex(bushPal[b.tint]);
      bushInst.setColorAt(idx, col);
    });
    bushInst.instanceMatrix.needsUpdate = true; bushInst.updateMatrix();
    if (bushInst.instanceColor) bushInst.instanceColor.needsUpdate = true;
    bgGroup.add(bushInst);
    treeControls.bushInst = bushInst;
  }

  bgGroup.updateMatrix();
  return { bgGroup, treeControls };
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

    emit(0.18, "Dựng bầu trời & bản đồ ánh sáng PMREM...");
    if (!skyEnvCache) skyEnvCache = await buildSkyDomeAndEnvMapAsync(renderer, THREE, stepYield);
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
    group.add(skyEnvCache.skyMesh, skyEnvCache.cloudMesh);

    const { rayGroup, shaftGroup, sunFlare, dustPoints, update: updateDust } = buildGodRaysDustAndFlare(THREE);
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

    const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 260), groundMat);
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

    emit(0.83, "Dựng đạo cụ chiến thuật & rừng núi hậu cảnh...");
    group.add(buildTacticalClutter(THREE, layout, skyEnvCache.envMap, fogUniforms, windUniform, windScaleUniform));
    await stepYield();

    const { bgGroup, treeControls } = await buildBackgroundTreesAndMountainsAsync(
      THREE,
      layout,
      skyEnvCache.envMap,
      fogUniforms,
      windUniform,
      windScaleUniform,
      stepYield,
    );
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
    const hemi = new THREE.HemisphereLight(0xa2c0de, 0x564b3d, 0.52);
    const sun = new THREE.DirectionalLight(0xffe9c2, 2.65);
    sun.position.set(SUN_POS.x, SUN_POS.y, SUN_POS.z);
    sun.castShadow = Boolean(initialPreset.shadowsEnabled);
    const initShadowSize = initialPreset.shadowMapSize || 2048;
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

    let currentShadowExtent = initShadowExtent;
    let currentShadowSize = initShadowSize;
    let lastSnapX = Number.NaN;
    let lastSnapZ = Number.NaN;
    let curFogDensity = initialPreset.fogDensity || 0.0034;

    const countWithinDist = (dists, maxDist, minKeep = 4) => {
      let c = 0;
      for (let i = 0; i < dists.length; i++) {
        if (dists[i] <= maxDist) c++;
        else break;
      }
      return Math.max(Math.min(minKeep, dists.length), c);
    };

    const applyQualityPreset = (preset = QUALITY_PRESETS.high) => {
      // 1. Shadows (enable/disable, mapSize & frustum without leaks)
      sun.castShadow = Boolean(preset.shadowsEnabled);
      if (preset.shadowsEnabled) {
        const nextSize = preset.shadowMapSize || 1024;
        const nextExt = preset.shadowExtent || 24;
        if (nextExt !== currentShadowExtent) {
          currentShadowExtent = nextExt;
          Object.assign(sun.shadow.camera, {
            left: -nextExt, right: nextExt, top: nextExt, bottom: -nextExt,
          });
          sun.shadow.camera.updateProjectionMatrix();
        }
        if (nextSize !== currentShadowSize) {
          currentShadowSize = nextSize;
          sun.shadow.mapSize.set(nextSize, nextSize);
          if (sun.shadow.map) {
            sun.shadow.map.dispose();
            sun.shadow.map = null;
          }
        }
      }
      lastSnapX = Number.NaN;
      lastSnapZ = Number.NaN;

      // 2. Post-processing & atmospheric extras
      fogUniforms.uMilPostGrade.value = preset.postGradeEnabled ? 1.0 : 0.0;
      shaftGroup.visible = Boolean(preset.godRaysEnabled);
      sunFlare.visible = Boolean(preset.sunFlareEnabled);
      skyEnvCache.cloudMesh.visible = Boolean(preset.cloudsEnabled);
      dustPoints.visible = Boolean(preset.dustEnabled);
      windScaleUniform.value = preset.windEnabled ? (preset.id === "medium" ? 0.6 : 1.0) : 0.0;

      // 3. Grass & rubble density (zero-allocation InstancedMesh.count)
      grassInst.count = Math.max(1, Math.round(maxGrassCount * (preset.grassDensity ?? 1.0)));
      debInst.count = Math.max(1, Math.round(maxDebrisCount * (preset.rubbleDensity ?? 1.0)));

      // 4. Tree draw distance (nearest-sorted InstancedMesh.count + outer dead/bush visibility)
      const maxTreeDist = preset.treeDrawDistance ?? 200;
      if (treeControls.blTrunkInst && treeControls.blCrownInst) {
        const blCnt = countWithinDist(treeControls.blDists, maxTreeDist, 6);
        treeControls.blTrunkInst.count = blCnt;
        treeControls.blCrownInst.count = blCnt;
      }
      if (treeControls.pineTrunkInst && treeControls.pineCrownInst) {
        const pineCnt = countWithinDist(treeControls.pineDists, maxTreeDist, 4);
        treeControls.pineTrunkInst.count = pineCnt;
        treeControls.pineCrownInst.count = pineCnt;
      }
      if (treeControls.deadInst) treeControls.deadInst.visible = Boolean(preset.showDeadTrees);
      if (treeControls.bushInst) treeControls.bushInst.visible = Boolean(preset.showBushes);
      if (treeControls.farRidge) treeControls.farRidge.visible = preset.id !== "low";

      // 5. Fog distance & height-fog falloff
      curFogDensity = preset.fogDensity ?? 0.0034;
      fogUniforms.uMilFogParams.value.set(
        preset.fogNearStart ?? 14.0,
        preset.fogNearEnd ?? 34.0,
        preset.fogDistBase ?? 0.0022,
        preset.fogHeightAmp ?? 0.0030,
      );

      // 6. Texture anisotropy cap
      const nextAniso = Math.min(hwMaxAniso, preset.maxAnisotropy || 4);
      for (const tex of managedTextures) {
        if (tex.anisotropy !== nextAniso) {
          tex.anisotropy = nextAniso;
          tex.needsUpdate = true;
        }
      }
    };

    applyQualityPreset(initialPreset);

    const updateAtmosphere = (tSec, camPos, preset = QUALITY_PRESETS.high) => {
      if (preset.windEnabled) windUniform.value = tSec;
      if (preset.cloudsEnabled) skyEnvCache.cloudMesh.rotation.y = tSec * 0.0045;
      if (preset.dustEnabled) updateDust(tSec);

      let shadowMoved = false;
      if (preset.shadowsEnabled && camPos) {
        // Snap shadow camera in 0.40m chunks (clean texel-aligned steps) so shadows only re-render on real player movement!
        const texelWorld = (currentShadowExtent * 2) / currentShadowSize;
        const stepWorld = Math.max(texelWorld * 12, 0.36);
        const snapX = Math.round(camPos.x / stepWorld) * stepWorld;
        const snapZ = Math.round(camPos.z / stepWorld) * stepWorld;
        if (snapX !== lastSnapX || snapZ !== lastSnapZ) {
          lastSnapX = snapX;
          lastSnapZ = snapZ;
          sun.target.position.set(snapX, 0, snapZ);
          sun.target.updateMatrixWorld();
          sun.position.set(snapX + SUN_POS.x, SUN_POS.y, snapZ + SUN_POS.z);
          shadowMoved = true;
        }
      }
      return shadowMoved;
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
      skyEnvCache.skyTex,
      skyEnvCache.driftTex,
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
      updateAtmosphere,
      samplePuddle: sampleMilitaryPuddle,
      getQualityStats: () => ({
        grassCount: grassInst.count,
        maxGrassCount,
        rubbleCount: debInst.count,
        broadleafCount: treeControls.blCrownInst ? treeControls.blCrownInst.count : 0,
        pineCount: treeControls.pineCrownInst ? treeControls.pineCrownInst.count : 0,
        deadTreesVisible: treeControls.deadInst ? treeControls.deadInst.visible : false,
        bushesVisible: treeControls.bushInst ? treeControls.bushInst.visible : false,
        cloudsVisible: skyEnvCache.cloudMesh.visible,
        godRaysVisible: shaftGroup.visible,
        dustVisible: dustPoints.visible,
        sunFlareVisible: sunFlare.visible,
        sunCastShadow: sun.castShadow,
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
