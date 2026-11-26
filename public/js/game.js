/**
 * Three.js Rainy Harbor FPS Engine (Truy Kích LAN PvP + Offline Solo Drone):
 * - Shared weapons.js state machine (M416, Glock-17 Pistol, AWM Sniper; infinite reserve)
 * - 3-layer Input (BIND, e.code, Hold/Toggle, key rebind, Alt+Tab safety) & 60Hz fixed physics
 * - Crouch (ceiling raycast + lowered capsule), Jump buffer/coyote/anti-bhop, Sprint/Reload/ADS rules
 * - TeamColor shared PBR materials (A=#2F80FF ▲, B=#FF4D2E ●, FFA=#8A8F98), teammate nameplates & Radar
 */

import { MSG, sanitizeText } from "/js/protocol.js";
import { createMilitaryMapLoader } from "/js/map_loader.js";
import {
  computeEffectivePixelRatio,
  detectHardwareTier,
  probeHardwareInfo,
  resolveQualityPreset,
} from "/js/graphics_quality.js";
import {
  buildSocketPose,
  createSkinnedArmsController,
  viewmodelPointToWorld,
} from "/js/arm_rig.js";
import {
  BASE_MOVE_SPEED,
  FLAG,
  SLOT_TO_WEAPON_ID,
  TEAM_META,
  WEAPON_SLOTS,
  WEAPONS,
  computeWeaponSpread,
  getMoveSpeedMultiplier,
  getReloadDurationMs,
  resolveWeaponConfig,
} from "/js/weapons.js";

const THREE = window.THREE;
const Vec = THREE.Vector3;
const VIEW_LAYER = 1;
const OPTIC_Y = 0.097;
const UP = new Vec(0, 1, 0);
const INTERP_DELAY_MS = 100;
const FIXED_DT = 1 / 60;
const JUMP_BUFFER_MS = 100;
const COYOTE_TIME_MS = 80;
const JUMP_COOLDOWN_MS = 300;
const EYE_STAND = 1.70;
const EYE_CROUCH = 1.12;
const RING_CIRCUMFERENCE = 106.81;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatClock(sec) {
  const s = Math.max(0, sec | 0);
  return `${String((s / 60) | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function createGameEngine({ net, settings, input, onRequestExitToRoom, onRequestExitToLobby }) {
  const $ = (id) => document.getElementById(id);
  const rnd = (a, b) => a + Math.random() * (b - a);
  let seed = 11;
  const sr = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // ---------- Renderer, scene, camera & Graphics Quality ----------
  const R = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  const hwInfo = probeHardwareInfo(R.getContext());
  const detectedQualityTier = detectHardwareTier(hwInfo);
  let activeQuality = resolveQualityPreset(
    settings && settings.get ? settings.get().graphicsQuality : "auto",
    detectedQualityTier,
  );
  const resolveShadowTypeEnum = (typeStr) =>
    typeStr === "pcfsoft"
      ? THREE.PCFSoftShadowMap
      : typeStr === "pcf"
        ? THREE.PCFShadowMap
        : THREE.BasicShadowMap;

  R.setPixelRatio(computeEffectivePixelRatio(activeQuality.preset, devicePixelRatio));
  R.setSize(innerWidth, innerHeight);
  R.shadowMap.enabled = Boolean(activeQuality.preset.shadowsEnabled);
  R.shadowMap.type = resolveShadowTypeEnum(activeQuality.preset.shadowType);
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = 1.08;
  document.body.prepend(R.domElement);

  const S = new THREE.Scene();
  S.background = new THREE.Color(0x050a11);
  S.fog = new THREE.FogExp2(0x050a11, 0.025);

  const cam = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, activeQuality.preset.cameraFar);
  cam.rotation.order = "YXZ";
  S.add(cam);

  // Dedicated Viewmodel Camera (FOV 62 -> 50, near = 0.01) eliminates wide-FOV forearm stretching & near-plane clipping
  const VM_HIP_FOV = 62;
  const VM_ADS_FOV = 50;
  const vmCam = new THREE.PerspectiveCamera(VM_HIP_FOV, innerWidth / innerHeight, 0.01, 6.0);
  vmCam.rotation.order = "YXZ";
  vmCam.layers.set(VIEW_LAYER);
  S.add(vmCam);

  addEventListener("resize", () => {
    R.setPixelRatio(computeEffectivePixelRatio(activeQuality.preset, devicePixelRatio));
    R.setSize(innerWidth, innerHeight);
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
    vmCam.aspect = innerWidth / innerHeight;
    vmCam.updateProjectionMatrix();
  });

  // ---------- Lights & Lamp halos ----------
  const harborGroup = new THREE.Group();
  harborGroup.name = "HarborMapGroup";
  S.add(harborGroup);

  // R3: Warm-vs-cool night contrast (deep cold midnight ambient vs rich warm sodium streetlamps)
  const hemi = new THREE.HemisphereLight(0x28456b, 0x030509, 0.28);
  S.add(hemi);
  const moon = new THREE.DirectionalLight(0x5b82b8, 0.38);
  moon.position.set(-30, 50, 20);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  Object.assign(moon.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, far: 140 });
  S.add(moon);
  // Warm amber fill from lamp height to separate foreground gun/arms from the cool night backdrop
  const warmFill = new THREE.DirectionalLight(0xffb45c, 0.20);
  warmFill.position.set(12, 8, -6);
  S.add(warmFill);

  // R3: Warm amber halo for harbor sodium lamps
  const lampHaloTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,208,132,.95)");
    gr.addColorStop(0.20, "rgba(255,176,84,.48)");
    gr.addColorStop(0.55, "rgba(195,120,40,.14)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();

  // R3: Warm amber harbor lamps (sodium streetlamp feel) vs deep cold night shadows
  const lamps = [];
  for (const [x, z] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]]) {
    const L = new THREE.PointLight(0xffa94d, 1.55, 30, 1.75);
    L.position.set(x, 6.2, z);
    harborGroup.add(L);
    lamps.push(L);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 6.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x1b2128, metalness: 0.6, roughness: 0.5 }),
    );
    pole.position.set(x, 3.1, z);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe4be }),
    );
    bulb.position.set(x, 6.2, z);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: lampHaloTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.90,
      }),
    );
    halo.position.set(x, 6.2, z);
    halo.scale.set(7.8, 7.8, 1);
    harborGroup.add(pole, bulb, halo);
  }

  const maxAniso = Math.min(16, R.capabilities.getMaxAnisotropy ? R.capabilities.getMaxAnisotropy() : 16);
  function tex(w, h, fn, rep) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    fn(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (rep) t.repeat.set(rep, rep);
    t.anisotropy = maxAniso;
    return t;
  }

  // ---------- R3: Crisp wet asphalt harbor floor (organic puddles + 5mm aggregate & hairline cracks via onBeforeCompile) ----------
  const GROUND_TEX_SIZE = 512;
  const GROUND_REPEAT = 4;
  const puddleMask = new Float32Array(GROUND_TEX_SIZE * GROUND_TEX_SIZE);
  // Exact periodic toroidal value noise in [0, 1] (zero seam at x=0/w-1 or y=0/h-1)
  function tileNoise(nx, ny, period, seedOff) {
    const x0 = Math.floor(nx), y0 = Math.floor(ny);
    const fx = nx - x0, fy = ny - y0;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
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

  // Generate irregular multi-lobe organic puddles with natural wet-to-damp shorelines (kept clear of tile wrap boundary)
  const puddleDefs = [];
  for (let i = 0; i < 18; i++) {
    const a = sr() * Math.PI;
    puddleDefs.push({
      cx: 0.22 + sr() * 0.56,
      cy: 0.22 + sr() * 0.56,
      rx: 0.06 + sr() * 0.07,
      ry: 0.04 + sr() * 0.05,
      cs: Math.cos(a),
      sn: Math.sin(a),
      strength: 0.80 + sr() * 0.20,
    });
  }
  for (let y = 0; y < GROUND_TEX_SIZE; y++) {
    const py = y / GROUND_TEX_SIZE;
    for (let x = 0; x < GROUND_TEX_SIZE; x++) {
      const px = x / GROUND_TEX_SIZE;
      const edgeWarp =
        (tileNoise(px * 8, py * 8, 8, 17) - 0.5) * 0.42 +
        (tileNoise(px * 22, py * 22, 22, 43) - 0.5) * 0.18 +
        (tileNoise(px * 52, py * 52, 52, 79) - 0.5) * 0.07;
      let wMax = 0;
      for (let i = 0; i < puddleDefs.length; i++) {
        const p = puddleDefs[i];
        let dx = px - p.cx;
        let dy = py - p.cy;
        if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
        if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
        const u = (dx * p.cs + dy * p.sn) / p.rx;
        const v = (-dx * p.sn + dy * p.cs) / p.ry;
        const d = Math.sqrt(u * u + v * v) + edgeWarp;
        if (d < 0.96) {
          const tShore = Math.max(0, Math.min(1, (0.96 - d) / 0.20));
          const s = tShore * tShore * (3 - 2 * tShore) * p.strength;
          if (s > wMax) wMax = s;
        }
      }
      puddleMask[y * GROUND_TEX_SIZE + x] = wMax;
    }
  }

  const gtex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    for (let y = 0; y < h; y++) {
      const u = y / h;
      for (let x = 0; x < w; x++) {
        const v = x / w;
        const idx = y * w + x;
        const nMacro = tileNoise(v * 8, u * 8, 8, 31);
        const nMid = tileNoise(v * 32, u * 32, 32, 73);
        const nFine = tileNoise(v * 128, u * 128, 128, 137);
        const wet = puddleMask[idx];
        const pebble = 0.40 * nMid + 0.60 * nFine;
        // Deep charcoal wet asphalt (#080a0e..#11151b) subtly darker in mirror puddles (#040609)
        const base = (7.5 + nMacro * 4.5 + pebble * 8.5) * (1 - wet * 0.42);
        d[idx * 4] = Math.max(2, Math.min(255, Math.round(base * 0.90)));
        d[idx * 4 + 1] = Math.max(3, Math.min(255, Math.round(base * 0.98)));
        d[idx * 4 + 2] = Math.max(4, Math.min(255, Math.round(base * 1.12)));
        d[idx * 4 + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, GROUND_REPEAT);

  const gNormTex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    const hMap = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const u = y / h;
      for (let x = 0; x < w; x++) {
        const v = x / w;
        const idx = y * w + x;
        const nFine = tileNoise(v * 96, u * 96, 96, 211);
        const nMid = tileNoise(v * 32, u * 32, 32, 97);
        const smoothCalm = 1 - Math.min(1, puddleMask[idx] * 1.15);
        hMap[idx] = (0.62 * nFine + 0.38 * nMid) * smoothCalm;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym = (y - 1 + h) % h, yp = (y + 1) % h;
      for (let x = 0; x < w; x++) {
        const xm = (x - 1 + w) % w, xp = (x + 1) % w;
        const idx = y * w + x;
        const dx = (hMap[y * w + xp] - hMap[y * w + xm]) * 1.15;
        const dy = (hMap[yp * w + x] - hMap[ym * w + x]) * 1.15;
        d[idx * 4] = Math.max(0, Math.min(255, Math.round(128 - dx * 48)));
        d[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 - dy * 48)));
        d[idx * 4 + 2] = 255;
        d[idx * 4 + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, GROUND_REPEAT);

  const gRoughTex = tex(GROUND_TEX_SIZE, GROUND_TEX_SIZE, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    for (let y = 0; y < h; y++) {
      const u = y / h;
      for (let x = 0; x < w; x++) {
        const v = x / w;
        const idx = y * w + x;
        const dampVar = tileNoise(v * 18, u * 18, 18, 313);
        const wet = puddleMask[idx];
        // Textured damp asphalt (~0.56..0.78) that sparkles on stone chips vs mirror puddles (~0.035)
        const rough = (0.56 + 0.22 * dampVar) * (1 - wet) + 0.035 * wet;
        const r = Math.max(8, Math.min(225, Math.round(rough * 255)));
        d[idx * 4] = d[idx * 4 + 1] = d[idx * 4 + 2] = r;
        d[idx * 4 + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, GROUND_REPEAT);

  // Seamless 512x512 crisp asphalt stone-chip & hairline crack detail map (100% periodic mod w/h; R/G=normal, B=grit/crack)
  const asphaltDetailNormal = tex(512, 512, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    const hMap = new Float32Array(w * h);
    const detCrack = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const u = y / h;
      for (let x = 0; x < w; x++) {
        const v = x / w;
        const g1 = tileNoise(v * 64, u * 64, 64, 509);
        const g2 = tileNoise(v * 32, u * 32, 32, 617);
        const g3 = tileNoise(v * 16, u * 16, 16, 733);
        hMap[y * w + x] = Math.pow(g1, 1.35) * 0.55 + g2 * 0.30 + g3 * 0.15;

        // Exact periodic ridged-noise hairline cracks (smoothly continuous across x=0/511 and y=0/511)
        const wx = (tileNoise(v * 4, u * 4, 4, 811) - 0.5) * 0.32;
        const wy = (tileNoise(v * 4, u * 4, 4, 823) - 0.5) * 0.32;
        const r1 = Math.abs(tileNoise((v + wx) * 3, (u + wy) * 3, 3, 911) - 0.5);
        const r2 = Math.abs(tileNoise((v - wy * 0.8) * 4, (u + wx * 0.8) * 4, 4, 977) - 0.5);
        const c1 = Math.max(0, 1 - r1 / 0.032);
        const c2 = Math.max(0, 1 - r2 / 0.028);
        detCrack[y * w + x] = Math.max(c1, c2);
      }
    }
    for (let y = 0; y < h; y++) {
      const ym = (y - 1 + h) % h, yp = (y + 1) % h;
      for (let x = 0; x < w; x++) {
        const xm = (x - 1 + w) % w, xp = (x + 1) % w;
        const idx = y * w + x;
        const hL = hMap[y * w + xm] - detCrack[y * w + xm] * 0.28;
        const hR = hMap[y * w + xp] - detCrack[y * w + xp] * 0.28;
        const hD = hMap[ym * w + x] - detCrack[ym * w + x] * 0.28;
        const hU = hMap[yp * w + x] - detCrack[yp * w + x] * 0.28;
        const dx = (hR - hL) * 1.85;
        const dy = (hU - hD) * 1.85;
        d[idx * 4] = Math.max(0, Math.min(255, Math.round(128 - dx * 60)));
        d[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 - dy * 60)));
        const gritVal = 150 + (hMap[idx] - 0.45) * 165 - detCrack[idx] * 95;
        d[idx * 4 + 2] = Math.max(24, Math.min(255, Math.round(gritVal)));
        d[idx * 4 + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, 1);

  const groundMat = new THREE.MeshStandardMaterial({
    map: gtex,
    normalMap: gNormTex,
    normalScale: new THREE.Vector2(0.65, 0.65),
    roughnessMap: gRoughTex,
    roughness: 1,
    metalness: 0.04,
    envMapIntensity: 0.88,
  });
  // Inject multi-octave crisp stone-chip aggregate & hairline cracks into albedo, normal, and roughness on Three.js r128
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.detailNormalMap = { value: asphaltDetailNormal };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <normalmap_pars_fragment>",
        "#include <normalmap_pars_fragment>\nuniform sampler2D detailNormalMap;"
      )
      .replace(
        "#include <map_fragment>",
        "#include <map_fragment>\n\tfloat gritA = texture2D( detailNormalMap, vUv * 22.0 ).z;\n\tfloat gritB = texture2D( detailNormalMap, vUv * 57.0 ).z;\n\tfloat gritMix = mix(gritA, gritB, 0.48);\n\tdiffuseColor.rgb *= (0.62 + 0.68 * gritMix);"
      )
      .replace(
        "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;\n\tmapN.xy *= normalScale;",
        "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;\n\tmapN.xy *= normalScale;\n\tvec3 detN1 = texture2D( detailNormalMap, vUv * 22.0 ).xyz * 2.0 - 1.0;\n\tvec3 detN2 = texture2D( detailNormalMap, vUv * 57.0 ).xyz * 2.0 - 1.0;\n\tfloat puddleCalm = clamp((0.32 - roughnessFactor) * 4.5, 0.0, 1.0);\n\tmapN.xy += (detN1.xy * 1.75 + detN2.xy * 1.35) * (1.0 - puddleCalm);\n\tmapN = normalize(mapN);"
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n\tvec3 detR = texture2D( detailNormalMap, vUv * 22.0 ).xyz * 2.0 - 1.0;\n\tfloat rCalm = clamp((0.32 - roughnessFactor) * 4.5, 0.0, 1.0);\n\troughnessFactor = clamp(roughnessFactor - abs(detR.x + detR.y) * 0.24 * (1.0 - rCalm), 0.035, 0.94);"
      );
  };

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(130, 130),
    groundMat,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  harborGroup.add(ground);

  const solid = [];
  const cols = [];

  function cTex(col, k) {
    return tex(k ? 256 : 1024, 512, (g, w, h) => {
      g.fillStyle = col;
      g.fillRect(0, 0, w, h);
      const rb = [44, 12, 10, 30][k];
      for (let x = 0; x < w; x++) {
        const a = Math.cos((x / w) * 6.2832 * rb);
        g.fillStyle = a > 0 ? `rgba(255,255,255,${a * 0.12})` : `rgba(0,0,0,${-a * 0.3})`;
        g.fillRect(x, 0, 1, h);
      }
      g.fillStyle = col;
      g.fillRect(0, 0, w, h * 0.045);
      g.fillRect(0, h * 0.955, w, h * 0.045);
      for (let i = 0; i < 65; i++) {
        const x = sr() * w, y = sr() * h * 0.6, l = h * (0.1 + sr() * 0.5);
        const q = g.createLinearGradient(0, y, 0, y + l);
        q.addColorStop(0, "rgba(120,52,18,.45)");
        q.addColorStop(1, "rgba(120,52,18,0)");
        g.fillStyle = q;
        g.fillRect(x, y, 1 + sr() * 3, l);
      }
      if (k === 0) {
        g.fillStyle = "rgba(240,240,235,.88)";
        g.textBaseline = "top";
        g.font = "bold 56px Arial,sans-serif";
        g.fillText("MSKU " + ((100000 + sr() * 899999) | 0) + " " + ((sr() * 9) | 0), 30, h * 0.1);
        g.font = "bold 120px Arial,sans-serif";
        g.fillText("HALDEN", w * 0.42, h * 0.3);
        g.font = "bold 30px Arial,sans-serif";
        g.fillText("MAX GROSS 30480 KG   TARE 2220 KG", w * 0.42, h * 0.62);
      }
      if (k === 1) {
        g.fillStyle = "rgba(0,0,0,.45)";
        g.fillRect(w / 2 - 2, h * 0.05, 4, h * 0.9);
      }
      // R3: strong grime/occlusion at the container foot so it is not lit evenly top-to-bottom
      const gr = g.createLinearGradient(0, h, 0, h * 0.46);
      gr.addColorStop(0, "rgba(1,2,3,.99)");
      gr.addColorStop(0.32, "rgba(4,5,7,.90)");
      gr.addColorStop(0.65, "rgba(14,12,10,.45)");
      gr.addColorStop(1, "rgba(35,25,15,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    });
  }

  const cPalette = [0x8c3a2b, 0x2c5878, 0x3b6a4a, 0xb08428, 0x6a7077, 0x6e3f55];
  const cMats = cPalette.map((c) => {
    const col = "#" + c.toString(16).padStart(6, "0");
    const mk = (k) => {
      const t = cTex(col, k);
      return new THREE.MeshStandardMaterial({
        map: t,
        bumpMap: t,
        bumpScale: 1.4,
        roughness: 0.74,
        metalness: 0.20,
      });
    };
    const side = mk(0);
    return [mk(1), mk(2), mk(3), new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.9 }), side, side];
  });

  // R3: soft contact-shadow decal + blurred wet-asphalt reflection under each container foot
  const contactShadowTex = (() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const g = c.getContext("2d");
    g.filter = "blur(9px)";
    g.fillStyle = "rgba(0,0,0,0.92)";
    g.fillRect(14, 12, 228, 104);
    g.filter = "blur(2px)";
    g.fillStyle = "rgba(0,0,0,1.0)";
    g.fillRect(26, 22, 204, 84);
    return new THREE.CanvasTexture(c);
  })();
  const contactShadowGeo = new THREE.PlaneGeometry(8.8, 5.0);
  const contactShadowMat = new THREE.MeshBasicMaterial({
    map: contactShadowTex,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // Soft wet-asphalt reflection streak under containers (single InstancedMesh draw call)
  const containerReflTex = (() => {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 12, 64, 64, 62);
    gr.addColorStop(0.0, "rgba(255,255,255,0.0)");
    gr.addColorStop(0.42, "rgba(255,255,255,0.34)");
    gr.addColorStop(0.75, "rgba(255,255,255,0.16)");
    gr.addColorStop(1.0, "rgba(255,255,255,0.0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const containerReflGeo = new THREE.PlaneGeometry(8.2, 5.2);
  containerReflGeo.rotateX(-Math.PI / 2);
  const containerReflMat = new THREE.MeshBasicMaterial({
    map: containerReflTex,
    transparent: true,
    opacity: 0.44,
    depthWrite: false,
  });
  const containerReflItems = [];

  const cGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
  let mapSeed = 11042026;
  const msr = () => (mapSeed = (mapSeed * 16807) % 2147483647) / 2147483647;
  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      if ((gx === 0 && gz === 0) || msr() < 0.42) continue;
      const x = gx * 13 + (msr() - 0.5) * 3;
      const z = gz * 13 + (msr() - 0.5) * 3;
      const rot = msr() < 0.5;
      const cIdx = (msr() * cMats.length) | 0;
      const mat = cMats[cIdx];
      const stacked = msr() < 0.3;
      const m = new THREE.Mesh(cGeo, mat);
      m.position.set(x, 1.285, z);
      m.rotation.y = rot ? Math.PI / 2 : 0;
      m.castShadow = m.receiveShadow = true;
      harborGroup.add(m);
      solid.push(m);
      if (stacked) {
        const t = m.clone();
        t.position.y = 3.885;
        harborGroup.add(t);
        solid.push(t);
      }
      const hx = rot ? 1.22 : 3.05, hz = rot ? 3.05 : 1.22;
      cols.push({ x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz, y1: stacked ? 5.2 : 2.6 });
      const contactShadow = new THREE.Mesh(contactShadowGeo, contactShadowMat);
      contactShadow.rotation.x = -Math.PI / 2;
      contactShadow.rotation.z = rot ? Math.PI / 2 : 0;
      contactShadow.position.set(x, 0.007, z);
      contactShadow.renderOrder = 1;
      harborGroup.add(contactShadow);
      containerReflItems.push({ x, z, rot, hex: cPalette[cIdx] });
    }
  }
  if (containerReflItems.length > 0) {
    const reflInst = new THREE.InstancedMesh(containerReflGeo, containerReflMat, containerReflItems.length);
    reflInst.position.set(0, 0.005, 0);
    const dummy = new THREE.Object3D();
    const colTmp = new THREE.Color();
    containerReflItems.forEach((it, idx) => {
      dummy.position.set(it.x, 0, it.z);
      dummy.rotation.set(0, it.rot ? Math.PI / 2 : 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      reflInst.setMatrixAt(idx, dummy.matrix);
      colTmp.setHex(it.hex).multiplyScalar(0.55);
      reflInst.setColorAt(idx, colTmp);
    });
    reflInst.instanceMatrix.needsUpdate = true;
    if (reflInst.instanceColor) reflInst.instanceColor.needsUpdate = true;
    harborGroup.add(reflInst);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2128, roughness: 0.9 });
  for (const [x, z, w, d] of [[0, -52, 100, 1], [0, 52, 100, 1], [-52, 0, 1, 100], [52, 0, 1, 100]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 10, d), wallMat);
    m.position.set(x, 5, z);
    harborGroup.add(m);
    solid.push(m);
  }

  // ---------- Environment Map & Low Mist ----------
  const envMap = (() => {
    const es = new THREE.Scene(), geo = new THREE.SphereGeometry(20, 32, 16), p = geo.attributes.position, col = [];
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 20, t = Math.max(0, y);
      col.push(...(y > 0 ? [0.08 + 0.22 * t, 0.11 + 0.28 * t, 0.16 + 0.36 * t] : [0.02, 0.025, 0.03]));
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    es.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false })));
    const panel = (r, g, b, w, h, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), side: THREE.DoubleSide, toneMapped: false }));
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      es.add(m);
    };
    // Cool night overcast sky + warm amber harbor streetlamp reflections
    panel(0.9, 1.35, 2.0, 14, 5, 0, 15, -4);
    for (const [x, y, z] of [[-9, 6.2, -9], [9, 6.2, -9], [-9, 6.2, 9], [9, 6.2, 9]]) {
      panel(8.8, 4.9, 1.7, 2.0, 2.0, x, y, z);
    }
    panel(1.9, 2.5, 3.6, 2.2, 2.2, 0, 14, -11);
    const pm = new THREE.PMREMGenerator(R), rt = pm.fromScene(es, 0.025);
    pm.dispose();
    return rt.texture;
  })();
  ground.material.envMap = envMap;
  ground.material.needsUpdate = true;

  const mistTex = tex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, "rgba(105,138,172,.22)");
    gr.addColorStop(0.5, "rgba(65,92,124,.08)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  for (const [x, y, z] of [[-7, 1.8, -14], [8, 1.9, -18], [0, 2.1, -24], [-15, 2.0, -22], [14, 1.8, -12]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.16, depthWrite: false }));
    sp.position.set(x, y, z);
    sp.scale.set(16, 6, 1);
    harborGroup.add(sp);
  }

  // ---------- Particles, Rain, Tracers, Audio ----------
  function mkPS(N, col, size) {
    const p = new Float32Array(N * 3).fill(-999), v = new Float32Array(N * 3), l = new Float32Array(N);
    let n = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    const o = new THREE.Points(g, new THREE.PointsMaterial({ color: col, size, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    o.frustumCulled = false;
    S.add(o);
    return {
      emit(x, y, z, c, up, s) {
        for (let k = 0; k < c; k++) {
          const i = n++ % N;
          p.set([x, y, z], i * 3);
          v.set([rnd(-s, s), rnd(0.5, 1) * up, rnd(-s, s)], i * 3);
          l[i] = rnd(0.25, 0.45);
        }
      },
      upd(dt) {
        for (let i = 0; i < N; i++) {
          if (l[i] <= 0) continue;
          l[i] -= dt;
          if (l[i] <= 0) { p[i * 3 + 1] = -999; continue; }
          v[i * 3 + 1] -= 9 * dt;
          for (let a = 0; a < 3; a++) p[i * 3 + a] += v[i * 3 + a] * dt;
        }
        g.attributes.position.needsUpdate = true;
      },
    };
  }
  const sparks = mkPS(320, 0xffb060, 0.11);
  // R3: InstancedMesh thin 22-34cm rain ripple rings (zero alpha texture overdraw, single draw call)
  const rainRipples = (() => {
    const geo = new THREE.RingGeometry(0.86, 1.0, 24);
    geo.rotateX(-Math.PI / 2);
    const POOL = 112;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const inst = new THREE.InstancedMesh(geo, mat, POOL);
    inst.position.set(0, 0.014, 0);
    inst.frustumCulled = false;
    harborGroup.add(inst);

    const dummy = new THREE.Object3D();
    const fadeColor = new THREE.Color();
    const state = [];
    for (let i = 0; i < POOL; i++) {
      const active = i < 76;
      const inArenaCenter = i < 48;
      const rx = inArenaCenter ? (-8 + sr() * 14) : (sr() - 0.5) * 24;
      const rz = inArenaCenter ? (-6 + sr() * 12) : (sr() - 0.5) * 24;
      const maxRadius = 0.24 + sr() * 0.11;
      const life = active ? sr() * 0.34 : 0;
      const maxLife = 0.46 + sr() * 0.12;
      const t0 = life / maxLife;
      const sc0 = active ? (0.11 + (maxRadius - 0.11) * t0) : 0.001;
      state.push({ active, x: rx, z: rz, life, maxLife, size: maxRadius });
      dummy.position.set(rx, active ? 0 : -50, rz);
      dummy.scale.set(sc0, 1, sc0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const f0 = active ? Math.min(1, t0 / 0.14) * Math.pow(1 - t0, 1.45) * 0.29 : 0;
      inst.setColorAt(i, fadeColor.setRGB(0.70 * f0, 0.84 * f0, 0.98 * f0));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    let next = 0;
    return {
      emit(x, z) {
        const s = state[next++ % POOL];
        s.active = true;
        s.x = x;
        s.z = z;
        s.life = 0;
        s.maxLife = rnd(0.46, 0.58);
        s.size = rnd(0.24, 0.35);
      },
      upd(dt) {
        for (let i = 0; i < POOL; i++) {
          const s = state[i];
          if (!s.active) continue;
          s.life += dt;
          const t = s.life / s.maxLife;
          if (t >= 1) {
            s.active = false;
            dummy.position.set(0, -50, 0);
            dummy.scale.setScalar(0.001);
            dummy.updateMatrix();
            inst.setMatrixAt(i, dummy.matrix);
            continue;
          }
          const sc = 0.11 + (s.size - 0.11) * t;
          dummy.position.set(s.x, 0, s.z);
          dummy.scale.set(sc, 1, sc);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
          const fade = Math.min(1, t / 0.14) * Math.pow(1 - t, 1.45) * 0.29;
          inst.setColorAt(i, fadeColor.setRGB(0.70 * fade, 0.84 * fade, 0.98 * fade));
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      },
    };
  })();

  function burst(pt, n, spd, dir) {
    for (let k = 0; k < n; k++) {
      sparks.emit(
        pt.x + (dir ? dir.x * 0.02 : 0),
        pt.y + (dir ? dir.y * 0.02 : 0),
        pt.z + (dir ? dir.z * 0.02 : 0),
        1,
        spd * 0.9,
        spd,
      );
    }
  }

  const ND2 = 3000, rd = new Float32Array(ND2 * 4), rp2 = new Float32Array(ND2 * 6), rc2 = new Float32Array(ND2 * 6);
  for (let i = 0; i < ND2; i++) {
    rd.set([rnd(-24, 24), rnd(0, 26), rnd(-24, 24), rnd(0.6, 1.4)], i * 4);
    const b = rd[i * 4 + 3] * 0.27;
    rc2.set([0, 0, 0, b * 0.55, b * 0.68, b * 0.82], i * 6);
  }
  const rg2 = new THREE.BufferGeometry();
  rg2.setAttribute("position", new THREE.BufferAttribute(rp2, 3));
  rg2.setAttribute("color", new THREE.BufferAttribute(rc2, 3));
  const rain2 = new THREE.LineSegments(rg2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  rain2.frustumCulled = false;
  harborGroup.add(rain2);

  const tr = [];
  for (let i = 0; i < 14; i++) {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new Vec(), new Vec()]),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0 }),
    );
    l.frustumCulled = false;
    l.userData.t = 0;
    S.add(l);
    tr.push(l);
  }
  let tri = 0;
  function tracer(a, b, col) {
    const l = tr[tri++ % tr.length], p = l.geometry.attributes.position;
    p.setXYZ(0, a.x, a.y, a.z);
    p.setXYZ(1, b.x, b.y, b.z);
    p.needsUpdate = true;
    l.material.color.setHex(col);
    l.userData.t = 0.09;
  }

  let AC = null, NB = null, REV = null;
  let ambFilter = null, ambGain = null;
  function syncAmbientAudio() {
    if (!AC || !ambFilter || !ambGain) return;
    const t = AC.currentTime;
    if (activeMapId === "military") {
      ambFilter.type = "bandpass";
      ambFilter.frequency.setTargetAtTime(280, t, 0.25);
      ambFilter.Q.setTargetAtTime(0.85, t, 0.25);
      ambGain.gain.setTargetAtTime(0.055, t, 0.25);
    } else {
      ambFilter.type = "lowpass";
      ambFilter.frequency.setTargetAtTime(420, t, 0.25);
      ambFilter.Q.setTargetAtTime(0.7, t, 0.25);
      ambGain.gain.setTargetAtTime(0.09, t, 0.25);
    }
  }
  function initAudio() {
    if (AC) { AC.resume().catch(() => {}); syncAmbientAudio(); return; }
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      const n = AC.sampleRate * 2;
      NB = AC.createBuffer(1, n, AC.sampleRate);
      const d = NB.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const revLen = AC.sampleRate * 1.3;
      const rb = AC.createBuffer(2, revLen, AC.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = rb.getChannelData(c);
        for (let i = 0; i < revLen; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / revLen, 3.2);
      }
      REV = AC.createConvolver();
      REV.buffer = rb;
      const g = AC.createGain();
      g.gain.value = 0.45;
      REV.connect(g).connect(AC.destination);
      const r = AC.createBufferSource();
      r.buffer = NB;
      r.loop = true;
      ambFilter = AC.createBiquadFilter();
      ambFilter.type = "lowpass";
      ambFilter.frequency.value = 420;
      ambGain = AC.createGain();
      ambGain.gain.value = 0.09;
      r.connect(ambFilter).connect(ambGain).connect(AC.destination);
      r.start();
      syncAmbientAudio();
    } catch {
      // Audio blocked until gesture
    }
  }
  function nz(dur, f0, f1, v, w = 0) {
    if (!AC || !NB) return;
    const t = AC.currentTime, s = AC.createBufferSource();
    s.buffer = NB;
    const f = AC.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = AC.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g);
    g.connect(AC.destination);
    if (w && REV) { const k = AC.createGain(); k.gain.value = w; g.connect(k).connect(REV); }
    s.start(0, Math.random());
    s.stop(t + dur);
  }
  function tone(f0, f1, dur, v, type = "sine") {
    if (!AC) return;
    const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(AC.destination);
    o.start(t);
    o.stop(t + dur);
  }
  const snd = {
    shot() { nz(0.06, 9000, 2500, 0.45, 0.15); nz(0.28, 3500, 160, 0.55, 0.35); tone(140, 32, 0.2, 0.7); },
    pistolShot() { nz(0.05, 8200, 2200, 0.36, 0.12); nz(0.18, 2800, 220, 0.42, 0.24); tone(180, 48, 0.12, 0.52); },
    sniperShot() { nz(0.09, 10000, 1800, 0.6, 0.28); nz(0.55, 3200, 90, 0.72, 0.48); tone(105, 22, 0.36, 0.88); },
    dryClick() { tone(1350, 720, 0.032, 0.14, "square"); },
    hit() { tone(1300, 600, 0.07, 0.16, "square"); },
    headshot() { tone(1850, 920, 0.09, 0.25, "triangle"); setTimeout(() => tone(2450, 1500, 0.11, 0.18, "sine"), 35); },
    remoteShot(dist) { const a = Math.max(0.05, Math.min(0.6, 9 / (dist + 6))); nz(0.16, 4800, 260, 0.45 * a, 0.2 * a); tone(135, 38, 0.14, 0.4 * a); },
    boom() { nz(0.7, 2500, 80, 0.65); },
    laser() { tone(900, 200, 0.14, 0.09, "sawtooth"); },
    hurt() { tone(120, 60, 0.22, 0.38, "square"); },
    reload() { tone(300, 520, 0.09, 0.12, "square"); },
    click(f) { tone(f, f * 0.5, 0.04, 0.1, "square"); },
    shell() { tone(4300, 3200, 0.06, 0.06, "triangle"); },
    thunder() { nz(2.8, 480, 30, 0.8, 0.7); },
    heartbeat(intensity = 0.7) {
      const vol = 0.16 * Math.max(0.25, Math.min(1.0, intensity));
      tone(64, 34, 0.13, vol, "sine");
      setTimeout(() => tone(54, 30, 0.14, vol * 0.75, "sine"), 165);
    },
    footstep(surface = "concrete") {
      if (surface === "puddle") {
        nz(0.09, 2600, 640, 0.13, 0.08);
        tone(380, 170, 0.055, 0.04, "sine");
      } else if (surface === "metal") {
        tone(310, 140, 0.075, 0.095, "triangle");
        nz(0.045, 3200, 1100, 0.08, 0.10);
      } else {
        // Compacted concrete/gravel crunch
        nz(0.068, 2100, 480, 0.10, 0.04);
        tone(112, 56, 0.052, 0.08, "sine");
      }
    },
    distantBird() {
      const f = 2200 + Math.random() * 900;
      tone(f, f * 0.76, 0.09, 0.022, "sine");
      setTimeout(() => tone(f * 1.06, f * 0.82, 0.11, 0.018, "sine"), 120);
    },
  };

  // ---------- PBR Asset Loading & Viewmodel Setup ----------
  const gun = new THREE.Group();
  const muz = new THREE.Object3D();
  const laserOrigin = new THREE.Object3D();
  const flashL = new THREE.PointLight(0xffa550, 0, 9);
  muz.position.set(0, 0.02, -0.615);
  laserOrigin.position.set(0.046, 0.025, -0.35);
  flashL.position.set(0, 0.02, -0.68);
  gun.add(muz, laserOrigin, flashL);

  const glowTex = tex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.2, "rgba(255,255,255,.8)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const laserBeam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new Vec(), new Vec(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  laserBeam.frustumCulled = false;
  S.add(laserBeam);
  const laserDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x7dff8f, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
  laserDot.visible = false;
  S.add(laserDot);

  const mf = new THREE.Group();
  const fm = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), fm);
  mf.add(f1);
  mf.position.set(0, 0.02, -0.615);
  mf.visible = false;
  gun.add(mf);

  // R1/R3: cool key + warm amber fill/rim separates arms & gun from the cold night background without blowing out thumb skin
  const vmKey = new THREE.PointLight(0xbcd0ea, 0.42, 2.4, 1.1);
  vmKey.position.set(-0.35, 0.55, 0.25);
  const vmFill = new THREE.PointLight(0xffb36a, 0.14, 2.0, 1.2);
  vmFill.position.set(0.45, -0.2, -0.1);
  const vmRim = new THREE.PointLight(0xffc27a, 0.26, 2.2, 1.3);
  vmRim.position.set(0.32, 0.38, -0.65);
  vmCam.add(vmKey, vmFill, vmRim, gun);

  const _vmScratchPt = new Vec();
  function getViewmodelWorldPoint(node, outVec) {
    vmCam.updateMatrixWorld(true);
    node.getWorldPosition(_vmScratchPt);
    vmCam.worldToLocal(_vmScratchPt);
    return viewmodelPointToWorld(_vmScratchPt, vmCam.fov, cam.fov, cam.position, cam.quaternion, outVec, THREE);
  }

  function decodeBase64ToArrayBuffer(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function hydratePbrMaterial(src, objName = "", envScale = 1.45, isSkinned = false) {
    const phys = (src.userData && src.userData.pbrPhysical) || {};
    if (phys.unlit) {
      const col = src.emissive && src.emissive.getHex() ? src.emissive : src.color;
      const isOverlayReticle = objName === "reticle_group";
      return new THREE.MeshBasicMaterial({
        name: src.name || objName || "",
        color: col,
        side: src.side,
        fog: false,
        toneMapped: false,
        depthWrite: !isOverlayReticle,
        skinning: Boolean(src.skinning || isSkinned),
      });
    }
    const isGlass = phys.transmission > 0 || src.transparent;
    // R2: near-clear Red Dot glass with weak reflections so the red reticle reads as a crisp dot, not a smear
    const isHoloLens = objName === "holo_lens";
    const isSkin = src.name === "Arms_WetSkin" || src.name === "Soldier_Skin";
    const isGlove =
      src.name === "Arms_TacticalGlove" ||
      src.name === "Arms_SkinnedGlove" ||
      src.name === "material" ||
      src.name === "Soldier_Glove" ||
      objName.toLowerCase().includes("armmesh");
    const mat = new THREE.MeshPhysicalMaterial({
      name: src.name || objName || "",
      color: src.color,
      map: src.map || null,
      aoMap: src.aoMap || null,
      aoMapIntensity: src.aoMap ? (isSkinned ? 0.95 : 0.85) : (src.aoMapIntensity ?? 0.42),
      metalness: src.metalness,
      roughness: src.roughness,
      roughnessMap: src.roughnessMap || null,
      metalnessMap: src.metalnessMap || null,
      normalMap: src.normalMap || null,
      normalScale: src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1),
      envMap: activeEnvMap,
      envMapIntensity: isHoloLens ? 0.5 : isGlass ? 1.8 : isSkin ? 0.42 : isGlove ? 0.36 : envScale,
      clearcoat: src.name === "AWM_RiflePBR" ? 0.04 : (phys.clearcoat || 0),
      clearcoatRoughness: phys.clearcoatRoughness || 0,
      transparent: isGlass,
      opacity: isHoloLens ? 0.1 : isGlass ? 0.26 : 1,
      depthWrite: !isGlass,
      side: src.side,
      skinning: Boolean(src.skinning || isSkinned),
    });
    if (phys.sheenColor !== undefined) mat.sheen = new THREE.Color(phys.sheenColor);
    if (objName === "watch_dial" && src.map) {
      mat.emissiveMap = src.map;
      mat.emissive = new THREE.Color(0x88ffcc);
      mat.emissiveIntensity = 0.45;
    }
    return mat;
  }

  let boltVis = new THREE.Object3D(), trig = new THREE.Group(), ch = new THREE.Group(), reticle = new THREE.Object3D(), laserLens = new THREE.Object3D(), mag = new THREE.Group();
  let pistolSlideNode = new THREE.Object3D(), pistolTriggerNode = new THREE.Object3D(), pistolMagNode = new THREE.Object3D();
  let awmBoltPivot = new THREE.Object3D(), awmMagGroup = new THREE.Object3D(), awmTriggerNode = new THREE.Object3D();
  let m416WorldProto = null, pistolWorldProto = null, awmWorldProto = null, soldierProto = null;
  const pistolMuzAnchorPos = new Vec(0, 0.0495, -0.172);
  const awmMuzAnchorPos = new Vec(0, 0.020, -0.802);
  let awmOpticY = 0.0947;
  let pistolSlideOffset = 0, pistolRecoilPitch = 0, pistolRecoilKickZ = 0, pistolTrigPull = 0;
  let awmBoltCycleStartAt = 0;

  // Multi-weapon Viewmodel sub-groups mounted under gun
  const m416ViewGroup = new THREE.Group();
  const pistolViewGroup = new THREE.Group();
  const pistolPivot = new THREE.Group();
  pistolViewGroup.add(pistolPivot);

  // 3-cone additive Tactical Pistol muzzle flash matched to reference PBR spec
  const pistolFlashMat = new THREE.MeshBasicMaterial({
    color: 0xffd27a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const pistolMuzzleFlash = new THREE.Group();
  pistolMuzzleFlash.position.copy(pistolMuzAnchorPos);
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.075, 8), pistolFlashMat);
    cone.rotation.x = -Math.PI * 0.5;
    cone.rotation.z = (i * Math.PI) / 3;
    cone.position.z = -0.028;
    pistolMuzzleFlash.add(cone);
  }
  pistolPivot.add(pistolMuzzleFlash);
  pistolViewGroup.traverse((o) => o.layers.set(VIEW_LAYER));
  pistolViewGroup.visible = false;

  const sniperViewGroup = new THREE.Group();
  function makeSocketNode(name, pos, distal, palmNormal, isRightHand) {
    const pose = buildSocketPose(pos, distal, palmNormal, isRightHand, THREE);
    const node = new THREE.Object3D();
    node.name = name;
    node.position.copy(pose.p);
    node.quaternion.copy(pose.q);
    return node;
  }

  const sniperSockHandguard = makeSocketNode(
    "socket_handguard",
    [-0.028, -0.044, -0.275],
    [-0.20, -0.18, -0.963],
    [0.64, 0.77, -0.04],
    false,
  );
  const sniperSockGrip = makeSocketNode(
    "socket_grip",
    [0.036, -0.062, 0.065],
    [0.14, -0.06, -0.988],
    [-0.95, 0.14, 0.28],
    true,
  );
  const sniperSockMag = makeSocketNode(
    "socket_mag",
    [-0.038, -0.080, -0.090],
    [0.36, -0.16, -0.919],
    [0.88, 0.28, 0.38],
    false,
  );
  const sniperSockBolt = makeSocketNode(
    "socket_charging",
    [0.0604, -0.019, 0.018],
    [0.12, 0.16, -0.98],
    [-0.88, -0.42, 0.22],
    true,
  );
  sniperViewGroup.add(sniperSockHandguard, sniperSockGrip, sniperSockMag, sniperSockBolt);
  sniperViewGroup.traverse((o) => o.layers.set(VIEW_LAYER));
  sniperViewGroup.visible = false;

  // Fallback attachment sockets before async GLB models finish parsing
  const weaponSockets = {
    m416: {
      handguard: makeSocketNode("socket_handguard", [-0.031, -0.033, -0.252], [-0.22, -0.20, -0.954], [0.64, 0.77, -0.04], false),
      grip: makeSocketNode("socket_grip", [0.024, -0.058, 0.082], [0.18, -0.04, -0.983], [-0.96, 0.08, 0.26], true),
      mag: makeSocketNode("socket_mag", [-0.036, -0.130, -0.070], [0.36, -0.16, -0.919], [0.90, 0.28, 0.33], false),
      bolt: makeSocketNode("socket_charging", [-0.026, 0.035, 0.130], [0.68, 0.08, -0.73], [0.24, -0.94, 0.23], false),
    },
    pistol: {
      handguard: makeSocketNode("socket_handguard", [-0.024, -0.038, 0.024], [-0.16, -0.12, -0.980], [0.90, 0.34, 0.27], false),
      grip: makeSocketNode("socket_grip", [0.020, -0.036, 0.056], [0.16, -0.04, -0.986], [-0.96, 0.08, 0.26], true),
      mag: makeSocketNode("socket_mag", [-0.014, -0.072, 0.040], [0.54, -0.18, -0.82], [0.78, 0.32, 0.54], false),
      bolt: makeSocketNode("socket_slide", [-0.015, 0.048, 0.022], [0.66, 0.06, -0.75], [0.35, -0.90, 0.26], false),
    },
    sniper: {
      handguard: sniperSockHandguard,
      grip: sniperSockGrip,
      mag: sniperSockMag,
      bolt: sniperSockBolt,
    },
  };
  m416ViewGroup.add(weaponSockets.m416.handguard, weaponSockets.m416.grip, weaponSockets.m416.mag, weaponSockets.m416.bolt);
  pistolPivot.add(weaponSockets.pistol.handguard, weaponSockets.pistol.grip, weaponSockets.pistol.mag, weaponSockets.pistol.bolt);

  gun.add(m416ViewGroup, pistolViewGroup, sniperViewGroup);

  function applyViewmodelWeapon(weaponId) {
    m416ViewGroup.visible = weaponId === "m416";
    pistolViewGroup.visible = weaponId === "pistol";
    sniperViewGroup.visible = weaponId === "sniper";
    if (weaponId === "pistol") {
      muz.position.copy(pistolMuzAnchorPos);
      mf.position.copy(pistolMuzAnchorPos);
      flashL.position.set(0, 0.0495, -0.185);
    } else if (weaponId === "sniper") {
      muz.position.copy(awmMuzAnchorPos);
      mf.position.copy(awmMuzAnchorPos);
      flashL.position.set(awmMuzAnchorPos.x, awmMuzAnchorPos.y, awmMuzAnchorPos.z - 0.08);
    } else {
      muz.position.set(0, 0.02, -0.615);
      mf.position.set(0, 0.02, -0.615);
      flashL.position.set(0, 0.02, -0.68);
    }
  }

  // Strictly 3 shared team materials across entire room (Section B2)
  const teamAccentMats = {};
  function initTeamMaterials(templateMat) {
    const emissiveLevels = { A: 0.48, B: 0.50, FFA: 0.16 };
    for (const key of ["A", "B", "FFA"]) {
      const m = templateMat
        ? templateMat.clone()
        : new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.14 });
      m.name = `TeamColor_${key}`;
      m.color.setHex(TEAM_META[key].colorNum);
      m.emissive.setHex(TEAM_META[key].colorNum);
      m.emissiveIntensity = emissiveLevels[key];
      teamAccentMats[key] = m;
    }
  }
  initTeamMaterials(null);

  function loadModelAsset(key, glbPath, onLoaded) {
    if (typeof THREE.GLTFLoader !== "function") return;
    const loader = new THREE.GLTFLoader();
    const b64 = window.FPS_MODELS && window.FPS_MODELS[key];
    if (b64) {
      loader.parse(decodeBase64ToArrayBuffer(b64), "", onLoaded, (e) => console.error(key, e));
      return;
    }
    loader.load(glbPath, onLoaded, undefined, (e) => console.error(key, e));
  }

  const CH_REST_Z = 0.118, MAG_REST = new Vec(0, -0.042, -0.064);
  let armsCtrl = null;
  let armsRoot = null;

  loadModelAsset("m416", "/model/dist/m416.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (!matCache.has(obj.material)) matCache.set(obj.material, hydratePbrMaterial(obj.material, obj.name, 1.05));
      obj.material = matCache.get(obj.material);
      if (obj.name === "holo_lens") obj.renderOrder = 5;
      if (obj.name === "reticle_group") obj.renderOrder = 10;
    });
    m416WorldProto = root.clone();
    boltVis = root.getObjectByName("bolt_vis") || boltVis;
    trig = root.getObjectByName("trigger_group") || trig;
    ch = root.getObjectByName("charging_handle") || ch;
    reticle = root.getObjectByName("reticle_group") || reticle;
    laserLens = root.getObjectByName("laser_lens") || laserLens;
    mag = root.getObjectByName("mag_group") || mag;
    weaponSockets.m416.handguard = root.getObjectByName("socket_handguard") || weaponSockets.m416.handguard;
    weaponSockets.m416.grip = root.getObjectByName("socket_grip") || weaponSockets.m416.grip;
    weaponSockets.m416.mag = root.getObjectByName("socket_mag") || weaponSockets.m416.mag;
    weaponSockets.m416.bolt = root.getObjectByName("socket_charging") || weaponSockets.m416.bolt;
    const muzNode = root.getObjectByName("muzzle_anchor"), lasNode = root.getObjectByName("laser_origin");
    if (muzNode && SLOT_TO_WEAPON_ID[activeSlot] === "m416") muz.position.copy(muzNode.position);
    if (lasNode) laserOrigin.position.copy(lasNode.position);
    m416ViewGroup.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[activeSlot] || "m416");
    upgradeRemoteWeapons();
    gunAnim(0, 0);
    window.__m416Loaded = true;
  });

  loadModelAsset("pistol", "/model/dist/pistol.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.88));
      obj.material = matCache.get(ck);
    });
    pistolWorldProto = root.clone();
    pistolSlideNode = root.getObjectByName("pistol_slide") || pistolSlideNode;
    pistolTriggerNode = root.getObjectByName("pistol_trigger") || pistolTriggerNode;
    pistolMagNode = root.getObjectByName("pistol_mag") || pistolMagNode;
    weaponSockets.pistol.handguard = root.getObjectByName("socket_handguard") || weaponSockets.pistol.handguard;
    weaponSockets.pistol.grip = root.getObjectByName("socket_grip") || weaponSockets.pistol.grip;
    weaponSockets.pistol.mag = root.getObjectByName("socket_mag") || weaponSockets.pistol.mag;
    weaponSockets.pistol.bolt = root.getObjectByName("socket_slide") || weaponSockets.pistol.bolt;
    const pMuz = root.getObjectByName("pistol_muzzle");
    if (pMuz) {
      pistolMuzAnchorPos.copy(pMuz.position);
      pistolMuzzleFlash.position.copy(pMuz.position);
    }
    pistolPivot.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[activeSlot] || "m416");
    upgradeRemoteWeapons();
    gunAnim(0, 0);
    window.__pistolLoaded = true;
  });

  loadModelAsset("awm", "/model/dist/awm.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.96));
      obj.material = matCache.get(ck);
    });
    awmWorldProto = root.clone();
    awmBoltPivot = root.getObjectByName("awm_bolt_pivot") || awmBoltPivot;
    awmMagGroup = root.getObjectByName("awm_mag_group") || awmMagGroup;
    awmTriggerNode = root.getObjectByName("trigger") || awmTriggerNode;
    weaponSockets.sniper.handguard = root.getObjectByName("socket_handguard") || weaponSockets.sniper.handguard;
    weaponSockets.sniper.grip = root.getObjectByName("socket_grip") || weaponSockets.sniper.grip;
    weaponSockets.sniper.mag = root.getObjectByName("socket_mag") || weaponSockets.sniper.mag;
    weaponSockets.sniper.bolt =
      root.getObjectByName("socket_bolt_right") ||
      root.getObjectByName("socket_charging") ||
      weaponSockets.sniper.bolt;
    const aMuz = root.getObjectByName("muzzle_anchor");
    if (aMuz) awmMuzAnchorPos.copy(aMuz.position);
    const aEye = root.getObjectByName("scope_eye");
    if (aEye) awmOpticY = aEye.position.y;
    sniperViewGroup.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[activeSlot] || "m416");
    upgradeRemoteWeapons();
    gunAnim(0, 0);
    window.__awmLoaded = true;
  });

  loadModelAsset("fps_arms", "/model/dist/fps_arms.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (obj.isSkinnedMesh) obj.frustumCulled = false;
      if (obj.geometry && !obj.geometry.attributes.uv2 && obj.geometry.attributes.uv) {
        obj.geometry.setAttribute("uv2", obj.geometry.attributes.uv);
      }
      const ck = `${obj.material.uuid}:${obj.isSkinnedMesh ? 1 : 0}`;
      if (!matCache.has(ck)) {
        matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 0.85, Boolean(obj.isSkinnedMesh)));
      }
      obj.material = matCache.get(ck);
    });
    const ctrl = createSkinnedArmsController(root, THREE);
    if (!ctrl || !ctrl.ready) {
      armsCtrl = null;
      armsRoot = null;
      window.__armsLoaded = false;
      console.warn("fps_arms asset missing required skinned rig bones; rebuild with python -m model.build");
      return;
    }
    armsRoot = root;
    armsCtrl = ctrl;
    vmCam.add(root);
    gunAnim(0, 0);
    window.__armsLoaded = true;
  });

  loadModelAsset("soldier", "/model/dist/soldier.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    let teamTemplate = null;
    root.traverse((obj) => {
      obj.layers.set(0);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (obj.material && (obj.material.name === "TeamColor" || obj.material.name === "Soldier_TeamAccent")) {
        teamTemplate = obj.material;
      }
      if (!matCache.has(obj.material)) matCache.set(obj.material, hydratePbrMaterial(obj.material, obj.name, 1.1));
      obj.material = matCache.get(obj.material);
    });
    if (teamTemplate) initTeamMaterials(hydratePbrMaterial(teamTemplate, "TeamColor", 1.1));
    soldierProto = root;
    upgradeRemoteSoldiers();
    window.__soldierLoaded = true;
  });

  // ---------- Remote Soldiers (100ms interpolation + hitbox tags) ----------
  const remotePlayers = new Map();

  function tagHitMeshes(root, playerId) {
    const hitMeshes = [];
    const headNode = root.getObjectByName("head_group");
    const legL = root.getObjectByName("leg_left");
    const legR = root.getObjectByName("leg_right");
    const headSet = new Set(), legSet = new Set();
    if (headNode) headNode.traverse((o) => headSet.add(o));
    if (legL) legL.traverse((o) => legSet.add(o));
    if (legR) legR.traverse((o) => legSet.add(o));

    root.traverse((o) => {
      if (!o.isMesh) return;
      const part = headSet.has(o) ? "head" : legSet.has(o) ? "limb" : "body";
      o.userData.hitTarget = { id: playerId, part };
      hitMeshes.push(o);
    });
    return hitMeshes;
  }

  function buildSoldierVisual(team, playerId) {
    const tKey = team === "A" || team === "B" ? team : "FFA";
    if (!soldierProto) {
      const root = new THREE.Group();
      const uni = new THREE.MeshStandardMaterial({ color: 0x323b42, roughness: 0.75 });
      const acc = teamAccentMats[tKey];
      const upper = new THREE.Group();
      upper.position.set(0, 0.96, 0);
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.5, 0.22), uni);
      torso.position.set(0, 0.25, 0);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.24), acc);
      strip.position.set(0, 0.36, 0);
      const headGroup = new THREE.Group();
      headGroup.name = "head_group";
      headGroup.position.set(0, 0.5, 0);
      const helm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), acc);
      helm.position.set(0, 0.14, 0);
      headGroup.add(helm);
      const weaponMount = new THREE.Object3D();
      weaponMount.position.set(0.105, 0.31, -0.305);
      upper.add(torso, strip, headGroup, weaponMount);
      const legL = new THREE.Group();
      legL.name = "leg_left";
      legL.position.set(-0.105, 0.86, 0);
      const mL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.84, 0.14), uni);
      mL.position.set(0, -0.43, 0);
      legL.add(mL);
      const legR = legL.clone();
      legR.name = "leg_right";
      legR.position.x = 0.105;
      root.add(upper, legL, legR);
      return { root, upper, headGroup, legL, legR, weaponMount, hitMeshes: tagHitMeshes(root, playerId), isFallback: true };
    }

    const root = soldierProto.clone();
    const accMat = teamAccentMats[tKey];
    root.traverse((o) => {
      o.layers.set(0);
      if (
        o.isMesh &&
        (o.name.includes("team") || (o.material && (o.material.name === "TeamColor" || o.material.name === "Soldier_TeamAccent")))
      ) {
        o.material = accMat;
      }
    });
    return {
      root,
      upper: root.getObjectByName("upper_body") || root,
      headGroup: root.getObjectByName("head_group"),
      armsGroup: root.getObjectByName("arms_group"),
      legL: root.getObjectByName("leg_left"),
      legR: root.getObjectByName("leg_right"),
      weaponMount: root.getObjectByName("weapon_mount"),
      hitMeshes: tagHitMeshes(root, playerId),
      isFallback: false,
    };
  }

  function makeNameplateSprite(name, team, hpVal) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const t = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: true }));
    sp.scale.set(1.38, 0.34, 1);
    sp.position.set(0, 2.08, 0);
    sp.userData = { canvas: c, tex: t, lastKey: "" };
    updateNameplateSprite(sp, name, team, hpVal);
    return sp;
  }

  function updateNameplateSprite(sp, name, team, hpVal) {
    const meta = TEAM_META[team] || TEAM_META.FFA;
    const key = `${name}:${meta.id}:${hpVal | 0}`;
    if (sp.userData.lastKey === key) return;
    sp.userData.lastKey = key;
    const c = sp.userData.canvas, g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = "rgba(8, 14, 20, 0.78)";
    g.fillRect(22, 6, 212, 48);
    g.strokeStyle = meta.hex;
    g.lineWidth = 2.5;
    g.strokeRect(22, 6, 212, 48);
    g.fillStyle = meta.hex;
    g.font = "bold 19px sans-serif";
    g.textAlign = "center";
    g.fillText(`${meta.symbol} ${name}`, 128, 29);
    g.fillStyle = "#222a30";
    g.fillRect(46, 39, 164, 7);
    g.fillStyle = hpVal > 35 ? "#4ec3b0" : "#ff5245";
    g.fillRect(46, 39, Math.max(0, Math.min(1, hpVal / 100)) * 164, 7);
    sp.userData.tex.needsUpdate = true;
  }

  function syncRemoteWeaponVisibility(av) {
    const wid = av.weaponId || "m416";
    if (av.m416Mesh) av.m416Mesh.visible = wid !== "pistol" && wid !== "sniper";
    if (av.pistolMesh) av.pistolMesh.visible = wid === "pistol";
    if (av.awmMesh) av.awmMesh.visible = wid === "sniper";
    av.muzNode =
      wid === "pistol"
        ? av.pistolMuzNode || av.m416MuzNode
        : wid === "sniper"
          ? av.awmMuzNode || av.m416MuzNode
          : av.m416MuzNode;
  }

  function attachWeaponToRig(av) {
    if (!av.rig.weaponMount) return;
    if (!av.m416Mesh && m416WorldProto) {
      const w = m416WorldProto.clone();
      w.traverse((o) => { o.layers.set(0); if (o.name === "reticle_group") o.visible = false; });
      w.scale.setScalar(1.06);
      av.rig.weaponMount.add(w);
      av.m416Mesh = w;
      av.m416MuzNode = w.getObjectByName("muzzle_anchor") || null;
    }
    if (!av.pistolMesh && pistolWorldProto) {
      const pw = pistolWorldProto.clone();
      pw.traverse((o) => o.layers.set(0));
      pw.scale.setScalar(1.16);
      pw.position.set(0.0, -0.015, 0.13);
      av.rig.weaponMount.add(pw);
      av.pistolMesh = pw;
      av.pistolMuzNode = pw.getObjectByName("pistol_muzzle") || null;
    }
    if (!av.awmMesh && awmWorldProto) {
      const aw = awmWorldProto.clone();
      aw.traverse((o) => o.layers.set(0));
      aw.scale.setScalar(1.02);
      aw.position.set(0.0, -0.006, 0.04);
      av.rig.weaponMount.add(aw);
      av.awmMesh = aw;
      av.awmMuzNode = aw.getObjectByName("muzzle_anchor") || null;
    }
    av.weaponAttached = Boolean(av.m416Mesh || av.pistolMesh || av.awmMesh);
    syncRemoteWeaponVisibility(av);
  }

  function createRemoteAvatar(p) {
    const container = new THREE.Group();
    const rig = buildSoldierVisual(p.team, p.id);
    container.add(rig.root);

    const shieldDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 16, 12),
      new THREE.MeshBasicMaterial({ color: TEAM_META[p.team]?.colorNum || 0x2f80ff, transparent: true, opacity: 0.16, wireframe: true }),
    );
    shieldDome.position.set(0, 0.92, 0);
    container.add(shieldDome);

    const muzFlash = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffd584 }));
    muzFlash.visible = false;
    container.add(muzFlash);

    const nameplate = makeNameplateSprite(p.name, p.team, p.hp);
    container.add(nameplate);
    S.add(container);

    const av = {
      id: p.id, name: p.name, team: p.team, container, rig, hitMeshes: rig.hitMeshes,
      shieldDome, muzFlash, muzNode: null, m416Mesh: null, pistolMesh: null, awmMesh: null, m416MuzNode: null, pistolMuzNode: null, awmMuzNode: null,
      weaponAttached: false, nameplate,
      snapshots: [], walkPhase: 0, flashTimer: 0, alive: p.alive, deathTime: 0,
      weaponId: p.weaponId || "m416", reloadEndsAt: 0, reloadDurMs: 0, radarBlipUntil: 0, crouchK: 0,
    };
    attachWeaponToRig(av);
    remotePlayers.set(p.id, av);
    return av;
  }

  function swapAvatarRig(av, team) {
    av.team = team;
    av.container.remove(av.rig.root);
    av.rig = buildSoldierVisual(team, av.id);
    av.hitMeshes = av.rig.hitMeshes;
    av.weaponAttached = false;
    av.muzNode = av.m416Mesh = av.pistolMesh = av.awmMesh = av.m416MuzNode = av.pistolMuzNode = av.awmMuzNode = null;
    av.container.add(av.rig.root);
    attachWeaponToRig(av);
  }

  function upgradeRemoteSoldiers() {
    for (const av of remotePlayers.values()) {
      if (av.rig.isFallback && soldierProto) swapAvatarRig(av, av.team);
    }
  }
  function upgradeRemoteWeapons() {
    for (const av of remotePlayers.values()) attachWeaponToRig(av);
  }
  function clearRemotePlayers() {
    for (const av of remotePlayers.values()) S.remove(av.container);
    remotePlayers.clear();
  }

  function updateRemotePlayers(dt) {
    const nowMs = performance.now();
    const renderTime = Date.now() + net.clockOffsetMs - INTERP_DELAY_MS;
    for (const av of remotePlayers.values()) {
      const snaps = av.snapshots;
      if (!snaps.length) continue;
      while (snaps.length >= 2 && snaps[1].t <= renderTime) snaps.shift();
      let pose = snaps[0];
      if (snaps.length >= 2 && snaps[1].t > snaps[0].t) {
        const alpha = Math.max(0, Math.min(1, (renderTime - snaps[0].t) / (snaps[1].t - snaps[0].t)));
        pose = {
          x: THREE.MathUtils.lerp(snaps[0].x, snaps[1].x, alpha),
          y: THREE.MathUtils.lerp(snaps[0].y, snaps[1].y, alpha),
          z: THREE.MathUtils.lerp(snaps[0].z, snaps[1].z, alpha),
          yaw: lerpAngle(snaps[0].yaw, snaps[1].yaw, alpha),
          pitch: THREE.MathUtils.lerp(snaps[0].pitch, snaps[1].pitch, alpha),
          mv: THREE.MathUtils.lerp(snaps[0].mv, snaps[1].mv, alpha),
          flags: snaps[1].flags || 0,
          weaponId: snaps[1].weaponId || av.weaponId,
          reloading: Boolean(snaps[1].reloading),
          hp: snaps[1].hp,
          alive: snaps[1].alive,
          invulnerable: snaps[1].invulnerable,
        };
      }

      if (av.alive && !pose.alive) {
        av.deathTime = 0;
        av.reloadEndsAt = 0; // Cancel reload animation immediately on death
      }
      if (pose.weaponId && pose.weaponId !== av.weaponId && nowMs >= (av.weaponLockUntil || 0)) {
        av.weaponId = pose.weaponId;
        av.reloadEndsAt = 0;
        syncRemoteWeaponVisibility(av);
      }
      if (!pose.reloading && av.reloadEndsAt > nowMs + 250) {
        av.reloadEndsAt = 0;
      }
      av.alive = pose.alive;
      av.flags = pose.flags || 0;
      av.container.position.set(pose.x, pose.y, pose.z);
      av.container.rotation.y = pose.yaw;

      if (!pose.alive) {
        av.deathTime += dt;
        av.container.visible = av.deathTime < 2.2;
        const drop = Math.min(1, av.deathTime * 4.5);
        av.rig.root.rotation.x = -drop * Math.PI * 0.48;
        av.rig.root.position.y = drop * 0.16;
        av.shieldDome.visible = false;
        av.nameplate.visible = false;
        continue;
      }

      av.container.visible = true;
      av.rig.root.rotation.x = 0;
      const targetCrouch = pose.flags & FLAG.CROUCH ? 1 : 0;
      av.crouchK += (targetCrouch - av.crouchK) * Math.min(1, 14 * dt);
      av.rig.root.position.y = -0.44 * av.crouchK;
      av.shieldDome.visible = !!pose.invulnerable;
      updateNameplateSprite(av.nameplate, av.name, av.team, pose.hp);

      // Section B4: Show nameplates only on teammates in TDM (hide enemies & FFA competitors)
      const sameSquad = currentMode === "TDM" && av.team === meTeam;
      av.nameplate.visible = sameSquad;

      if (av.rig.upper && !av.rig.isFallback) {
        av.rig.upper.rotation.x = pose.pitch * 0.45 + 0.18 * av.crouchK;
      }
      if (av.rig.headGroup) av.rig.headGroup.rotation.x = pose.pitch * 0.55;

      // Remote player reload animation (plays on EVENT_RELOAD, cancels on switch/death)
      if (av.rig.armsGroup) {
        if (av.reloadEndsAt > nowMs && av.reloadDurMs > 0) {
          const pRel = Math.max(0, Math.min(1, 1 - (av.reloadEndsAt - nowMs) / av.reloadDurMs));
          av.rig.armsGroup.rotation.x = Math.sin(pRel * Math.PI) * 0.38;
          av.rig.armsGroup.rotation.z = -Math.sin(pRel * Math.PI) * 0.28;
        } else {
          av.rig.armsGroup.rotation.x *= 0.8;
          av.rig.armsGroup.rotation.z *= 0.8;
        }
      }

      if (pose.mv > 0.05) {
        av.walkPhase += dt * (6 + pose.mv * 4.5);
        const swing = Math.sin(av.walkPhase) * 0.55 * Math.min(1.2, pose.mv);
        if (av.rig.legL) av.rig.legL.rotation.x = swing;
        if (av.rig.legR) av.rig.legR.rotation.x = -swing;
      } else {
        if (av.rig.legL) av.rig.legL.rotation.x *= 0.85;
        if (av.rig.legR) av.rig.legR.rotation.x *= 0.85;
      }
      if (av.rig.legL) av.rig.legL.position.y = 0.86 - 0.14 * av.crouchK;
      if (av.rig.legR) av.rig.legR.position.y = 0.86 - 0.14 * av.crouchK;

      if (av.flashTimer > 0) {
        av.flashTimer -= dt;
        if (av.muzNode) {
          const wp = av.muzNode.getWorldPosition(new Vec());
          av.container.worldToLocal(wp);
          av.muzFlash.position.copy(wp);
        } else {
          av.muzFlash.position.set(0.11, 1.3, -0.78);
        }
        av.muzFlash.visible = av.flashTimer > 0;
      } else {
        av.muzFlash.visible = false;
      }
    }
  }

  // ---------- Viewmodel Positions, Socket Sampling & Animation ----------
  // Lower bottom-right placement with upright roll (0) & gentle inward cant toward center crosshair
  const HIP_POS = new Vec(0.172, -0.156, -0.435), ADS_POS = new Vec(0, -OPTIC_Y, -0.215);
  const PISTOL_HIP_POS = new Vec(0.125, -0.128, -0.315), PISTOL_ADS_POS = new Vec(0, -0.0671, -0.245);
  const SNIPER_HIP_POS = new Vec(0.166, -0.140, -0.455);
  const lerp = THREE.MathUtils.lerp;
  const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  const _vmInvQ = new THREE.Quaternion();
  const _sockHgP = new Vec(), _sockHgQ = new THREE.Quaternion();
  const _sockMagP = new Vec(), _sockMagQ = new THREE.Quaternion();
  const _sockBoltP = new Vec(), _sockBoltQ = new THREE.Quaternion();
  const _sockGripP = new Vec(), _sockGripQ = new THREE.Quaternion();
  const _sockRBoltP = new Vec(), _sockRBoltQ = new THREE.Quaternion();
  const _leftTargetP = new Vec(), _leftTargetQ = new THREE.Quaternion();
  const _rightTargetP = new Vec(), _rightTargetQ = new THREE.Quaternion();

  function sampleSniperLeftSocket(rl, socks) {
    readSocketInVmCam(socks.handguard, _sockHgP, _sockHgQ);
    if (rl <= 0.04 || rl >= 0.78) {
      if (rl >= 0.66 && rl < 0.78) {
        readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
        const k = smooth01((rl - 0.66) / 0.12);
        _leftTargetP.lerpVectors(_sockMagP, _sockHgP, k);
        _leftTargetQ.copy(_sockMagQ).slerp(_sockHgQ, k);
        return k < 0.5 ? "mag" : "support";
      }
      _leftTargetP.copy(_sockHgP);
      _leftTargetQ.copy(_sockHgQ);
      return "support";
    }
    readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
    if (rl <= 0.22) {
      const k = smooth01((rl - 0.04) / 0.18);
      _leftTargetP.lerpVectors(_sockHgP, _sockMagP, k);
      _leftTargetQ.copy(_sockHgQ).slerp(_sockMagQ, k);
      return k > 0.5 ? "mag" : "support";
    }
    _leftTargetP.copy(_sockMagP);
    _leftTargetQ.copy(_sockMagQ);
    return "mag";
  }

  function readSocketInVmCam(node, outPos, outQuat) {
    node.getWorldPosition(outPos);
    vmCam.worldToLocal(outPos);
    node.getWorldQuaternion(outQuat);
    outQuat.premultiply(_vmInvQ).normalize();
  }

  function sampleLeftSocket(rl, isTactical, socks) {
    readSocketInVmCam(socks.handguard, _sockHgP, _sockHgQ);
    if (rl <= 0.03) {
      _leftTargetP.copy(_sockHgP);
      _leftTargetQ.copy(_sockHgQ);
      return "support";
    }

    readSocketInVmCam(socks.mag, _sockMagP, _sockMagQ);
    if (rl <= 0.22) {
      const k = smooth01((rl - 0.03) / 0.19);
      _leftTargetP.lerpVectors(_sockHgP, _sockMagP, k);
      _leftTargetQ.copy(_sockHgQ).slerp(_sockMagQ, k);
      return k > 0.5 ? "mag" : "support";
    }
    if (rl <= 0.72) {
      _leftTargetP.copy(_sockMagP);
      _leftTargetQ.copy(_sockMagQ);
      return "mag";
    }
    if (isTactical) {
      const k = smooth01((rl - 0.72) / 0.26);
      _leftTargetP.lerpVectors(_sockMagP, _sockHgP, k);
      _leftTargetQ.copy(_sockMagQ).slerp(_sockHgQ, k);
      return k < 0.6 ? "mag" : "support";
    }

    readSocketInVmCam(socks.bolt, _sockBoltP, _sockBoltQ);
    if (rl <= 0.81) {
      const k = smooth01((rl - 0.72) / 0.09);
      _leftTargetP.lerpVectors(_sockMagP, _sockBoltP, k);
      _leftTargetQ.copy(_sockMagQ).slerp(_sockBoltQ, k);
      return k > 0.5 ? "bolt" : "mag";
    }
    if (rl <= 0.92) {
      _leftTargetP.copy(_sockBoltP);
      _leftTargetQ.copy(_sockBoltQ);
      return "bolt";
    }
    const kBack = smooth01((rl - 0.92) / 0.08);
    _leftTargetP.lerpVectors(_sockBoltP, _sockHgP, kBack);
    _leftTargetQ.copy(_sockBoltQ).slerp(_sockHgQ, kBack);
    return kBack < 0.4 ? "bolt" : "support";
  }

  // ---------- Multi-Map State & Loader (harbor / military) ----------
  const militaryLoader = createMilitaryMapLoader({ renderer: R, THREE });
  let activeMapId = "military";
  let militaryData = null;
  let militaryBuildPromise = null;
  let activeCollision = null;
  let activeEnvMap = envMap;

  let gt = 0, activeState = "menu", meAlive = true, hp = 100;
  let shadowDirty = true;
  let shadowFrameTick = 0;
  let lastCanvasFilter = "";
  function updateCanvasPostGrade(nowSec = 0) {
    const inPlayLowHp = activeState === "play" && meAlive && hp < 35;
    const lowHpFactor = inPlayLowHp ? Math.max(0, Math.min(1, (35 - hp) / 25)) : 0;

    // Never apply CSS filter on <canvas> during normal play (avoids browser compositor full-frame blit & stutter!).
    // Color grading on High runs directly inside WebGL shaders (uMilPostGrade).
    let nextFilter = "";
    if (lowHpFactor > 0.05 && activeQuality.preset.lowHpBlurEnabled) {
      const sat = (1.0 - 0.48 * lowHpFactor).toFixed(2);
      nextFilter = `saturate(${sat}) blur(${(lowHpFactor * 1.1).toFixed(2)}px)`;
    }

    if (nextFilter !== lastCanvasFilter) {
      lastCanvasFilter = nextFilter;
      R.domElement.style.filter = nextFilter;
    }

    const lowOv = $("lowHpOverlay");
    if (lowOv) {
      if (lowHpFactor > 0.01) {
        const pulse = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(nowSec * (4.2 + lowHpFactor * 2.6)), 3);
        lowOv.style.opacity = (lowHpFactor * pulse).toFixed(3);
      } else if (lowOv.style.opacity !== "0") {
        lowOv.style.opacity = "0";
      }
    }
  }

  function applyGraphicsQuality(choiceOverride = null) {
    const reqChoice = choiceOverride !== null
      ? choiceOverride
      : (settings && settings.get ? settings.get().graphicsQuality : "auto");
    activeQuality = resolveQualityPreset(reqChoice, detectedQualityTier);
    const p = activeQuality.preset;

    // 1. Resolution scale (pixelRatio)
    const effPr = computeEffectivePixelRatio(p, devicePixelRatio);
    if (Math.abs(R.getPixelRatio() - effPr) > 0.001) {
      R.setPixelRatio(effPr);
      R.setSize(innerWidth, innerHeight);
    }

    // 2. Camera far plane
    const targetFar = activeMapId === "military" ? p.cameraFar : Math.max(200, p.cameraFar);
    if (cam.far !== targetFar) {
      cam.far = targetFar;
      cam.updateProjectionMatrix();
    }

    // 3. Shadow map enabled / type / mapSize (recompile materials ONCE only if shadow mode actually changed)
    const prevShEnabled = R.shadowMap.enabled;
    const prevShType = R.shadowMap.type;
    const nextShType = resolveShadowTypeEnum(p.shadowType);
    R.shadowMap.enabled = Boolean(p.shadowsEnabled);
    R.shadowMap.type = nextShType;

    moon.castShadow = Boolean(p.shadowsEnabled);
    if (p.shadowsEnabled && moon.shadow.mapSize.x !== p.shadowMapSize) {
      moon.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      if (moon.shadow.map) { moon.shadow.map.dispose(); moon.shadow.map = null; }
    }

    if (militaryData && militaryData.applyQualityPreset) {
      militaryData.applyQualityPreset(p);
      if (activeMapId === "military" && S.fog) {
        S.fog.density = militaryData.fogDensity;
      }
    }

    if (prevShEnabled !== R.shadowMap.enabled || prevShType !== R.shadowMap.type) {
      S.traverse((o) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && !m.isMeshBasicMaterial) m.needsUpdate = true;
          }
        }
      });
    }

    // 4. Vignette & post-grade sync
    const vig = $("vignette");
    if (vig) vig.style.opacity = activeMapId === "military" && p.vignetteEnabled ? "1" : "0";
    updateCanvasPostGrade(gt);
    shadowDirty = true;
    return activeQuality;
  }

  if (settings && typeof settings.onChange === "function") {
    settings.onChange((st) => {
      if (st && st.graphicsQuality !== activeQuality.choice) {
        applyGraphicsQuality(st.graphicsQuality);
      }
    });
  }

  function applySceneEnvMap(targetEnv, isMilitary = false) {
    activeEnvMap = targetEnv;
    S.environment = targetEnv || null;
    for (const root of [gun, armsRoot, m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto]) {
      if (!root) continue;
      root.traverse((o) => {
        if (o.isMesh && o.material && "envMap" in o.material && o.name !== "reticle_group") {
          o.material.envMap = targetEnv;
          const mName = o.material.name || "";
          if (mName.includes("GunMetal") || mName.includes("Slide") || mName.includes("ScopePBR")) {
            o.material.envMapIntensity = isMilitary ? 1.18 : 1.05;
          }
          o.material.needsUpdate = true;
        }
      });
    }
    if (isMilitary) {
      vmKey.color.setHex(0xffe9c4);
      vmKey.intensity = 0.82;
      vmFill.color.setHex(0x88aacb);
      vmFill.intensity = 0.20;
      vmRim.color.setHex(0xffce84);
      vmRim.intensity = 0.42;
    } else {
      vmKey.color.setHex(0xbcd0ea);
      vmKey.intensity = 0.42;
      vmFill.color.setHex(0xffb36a);
      vmFill.intensity = 0.14;
      vmRim.color.setHex(0xffc27a);
      vmRim.intensity = 0.26;
    }
    for (const av of remotePlayers.values()) {
      av.container.traverse((o) => {
        if (o.isMesh && o.material && "envMap" in o.material) {
          o.material.envMap = targetEnv;
          o.material.needsUpdate = true;
        }
      });
    }
  }

  function activateHarborMap() {
    activeMapId = "harbor";
    activeCollision = null;
    harborGroup.visible = true;
    hemi.visible = moon.visible = warmFill.visible = true;
    if (militaryData && militaryData.group) militaryData.group.visible = false;
    R.outputEncoding = THREE.LinearEncoding;
    R.toneMappingExposure = 1.08;
    const vig = $("vignette");
    if (vig) vig.style.opacity = "0";
    cam.far = Math.max(200, activeQuality.preset.cameraFar);
    cam.updateProjectionMatrix();
    S.background = new THREE.Color(0x050a11);
    S.fog = new THREE.FogExp2(0x050a11, 0.025);
    applySceneEnvMap(envMap, false);
    updateCanvasPostGrade(gt);
    syncAmbientAudio();
    shadowDirty = true;
  }

  function ensureMapActive(mapId = "military") {
    const target = mapId === "harbor" ? "harbor" : "military";
    if (target === "harbor") {
      activateHarborMap();
      return Promise.resolve(null);
    }
    activeMapId = "military";
    if (militaryData) {
      harborGroup.visible = false;
      hemi.visible = moon.visible = warmFill.visible = false;
      militaryData.group.visible = true;
      activeCollision = militaryData.collision;
      R.outputEncoding = THREE.sRGBEncoding || THREE.LinearEncoding;
      R.toneMappingExposure = 0.86;
      militaryData.applyQualityPreset(activeQuality.preset);
      const vig = $("vignette");
      if (vig) vig.style.opacity = activeQuality.preset.vignetteEnabled ? "1" : "0";
      cam.far = activeQuality.preset.cameraFar;
      cam.updateProjectionMatrix();
      S.background = new THREE.Color(militaryData.fogColor);
      S.fog = new THREE.FogExp2(militaryData.fogColor, militaryData.fogDensity);
      applySceneEnvMap(militaryData.envMap, true);
      updateCanvasPostGrade(gt);
      syncAmbientAudio();
      shadowDirty = true;
      window.__militaryMapLoaded = true;
      return Promise.resolve(militaryData);
    }
    if (!militaryBuildPromise) {
      militaryBuildPromise = militaryLoader
        .buildMilitaryScene({
          scene: S,
          envMapTargetList: [gun, armsRoot, m416WorldProto, pistolWorldProto, awmWorldProto, soldierProto],
          initialPreset: activeQuality.preset,
        })
        .then((res) => {
          militaryData = res;
          window.__militaryMapLoaded = true;
          if (activeMapId === "military") {
            harborGroup.visible = false;
            hemi.visible = moon.visible = warmFill.visible = false;
            res.group.visible = true;
            activeCollision = res.collision;
            R.outputEncoding = THREE.sRGBEncoding || THREE.LinearEncoding;
            R.toneMappingExposure = 0.86;
            res.applyQualityPreset(activeQuality.preset);
            const vig = $("vignette");
            if (vig) vig.style.opacity = activeQuality.preset.vignetteEnabled ? "1" : "0";
            cam.far = activeQuality.preset.cameraFar;
            cam.updateProjectionMatrix();
            S.background = new THREE.Color(res.fogColor);
            S.fog = new THREE.FogExp2(res.fogColor, res.fogDensity);
            applySceneEnvMap(res.envMap, true);
            updateCanvasPostGrade(gt);
            syncAmbientAudio();
            shadowDirty = true;
          } else {
            res.group.visible = false;
          }
          return res;
        })
        .catch((err) => {
          console.error("Failed to build military map:", err);
          militaryBuildPromise = null;
          activateHarborMap();
          return null;
        });
    }
    return militaryBuildPromise;
  }

  // Start preloading default Khu Quân Sự Cũ immediately unless ?map=harbor is requested
  let initialDefaultMap = "military";
  try {
    if (new URLSearchParams(location.search).get("map") === "harbor") initialDefaultMap = "harbor";
  } catch {}
  ensureMapActive(initialDefaultMap);

  // ---------- Gameplay State ----------
  const P = new Vec();
  let engineMode = "idle"; // "idle" | "lan" | "solo"
  let testLocked = false;
  let currentMode = "TDM";
  let killLimit = 30;
  let timeLeftSec = 600;
  let teamScores = { A: 0, B: 0 };
  let lastPlayers = [];
  let meTeam = "A";
  let meInvuln = false;
  let respawnMs = 0;

  let weapons = {};
  let activeSlot = 1;
  let prevSlot = 2;
  function resetAllWeapons() {
    weapons = {};
    for (const slot of WEAPON_SLOTS) {
      const wid = SLOT_TO_WEAPON_ID[slot];
      const cfg = WEAPONS[wid];
      weapons[wid] = {
        id: wid,
        slot,
        mag: cfg.magSize,
        nextFireAt: 0,
        reloadStartAt: 0,
        reloadEndsAt: 0,
        reloadDuration: cfg.reloadTime,
        isTactical: false,
      };
    }
  }
  resetAllWeapons();
  function activeWeapon() {
    const wid = SLOT_TO_WEAPON_ID[activeSlot] || "m416";
    return { cfg: WEAPONS[wid], st: weapons[wid] };
  }

  let yaw = 0, pitch = 0, vy = 0, velX = 0, velZ = 0, eyeHeight = EYE_STAND;
  let crouched = false, grounded = true, onLadder = false, isSprinting = false, sprintBrokenUntilShiftUp = false;
  let lastGroundedAt = 0, jumpBufferedUntil = 0, nextJumpAllowedAt = 0, physicsAccum = 0;
  let bob = 0, lyaw = 0, lpit = 0, swx = 0, swy = 0, spr = 0;
  let recoil = 0, kick = 0, flash = 0, bolt = 0, rlp = 0, ads = 0, trigPull = 0;
  let hm = 0, dmgV = 0, shake = 0, killAlertT = 0, soloScore = 0, soloWave = 0, soloWaveCd = 0;
  let laserOn = false, chatOpen = false, curFlags = 0, testAimHeld = false;
  let lastInputSentAt = 0;
  const drones = [], ray = new THREE.Raycaster(), lr = new THREE.Raycaster(), laserRay = new THREE.Raycaster(), upRay = new THREE.Raycaster();
  const _lp = new Vec(), _ls = new Vec(), _ld = new Vec();

  gun.position.copy(HIP_POS);
  gun.traverse((o) => o.layers.set(VIEW_LAYER));
  S.traverse((o) => { if (o.isLight) o.layers.enableAll(); });
  vmKey.layers.set(VIEW_LAYER);
  vmFill.layers.set(VIEW_LAYER);
  vmRim.layers.set(VIEW_LAYER);

  function gunAnim(dt, mv) {
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();
    const isReloading = st.reloadEndsAt > nowMs;
    const rl = isReloading ? Math.max(0, Math.min(1, (nowMs - st.reloadStartAt) / (st.reloadDuration || cfg.reloadTime))) : 0;

    const wantsAds = (testAimHeld || input.isAdsActive()) && !isReloading && !isSprinting;
    const prevAds = ads;
    ads += ((wantsAds ? 1 : 0) - ads) * Math.min(1, 13 * dt);
    const baseFov = settings ? settings.get().fov : 75;
    const targetAdsFov = cfg.adsFov || 55;
    if (Math.abs(ads - prevAds) > 1e-4 || dt === 0) {
      cam.fov = lerp(baseFov, targetAdsFov, ads);
      cam.updateProjectionMatrix();
      vmCam.fov = lerp(VM_HIP_FOV, VM_ADS_FOV, ads);
      vmCam.updateProjectionMatrix();
    }

    const aliveSelf = engineMode === "solo" || meAlive;
    const scopedSniper = aliveSelf && cfg.scopeOverlay && ads > 0.72;
    $("sniperScope").style.display = scopedSniper ? "block" : "none";
    $("cross").style.opacity = scopedSniper ? 0 : Math.max(0, 1 - ads * 1.4);
    const spreadK = computeWeaponSpread(cfg, curFlags) / Math.max(0.001, cfg.baseSpread);
    $("cross").style.transform = `scale(${(1 + recoil * 4 + (mv && !ads ? 0.16 : 0) + (spreadK - 1) * 0.25).toFixed(3)})`;

    if (isReloading) {
      $("reloadRingWrap").style.display = "block";
      $("reloadArc").setAttribute("stroke-dashoffset", (RING_CIRCUMFERENCE * (1 - rl)).toFixed(2));
    } else {
      $("reloadRingWrap").style.display = "none";
    }

    spr += ((isSprinting ? 1 : 0) - spr) * Math.min(1, 8 * dt);
    swx += (Math.max(-0.06, Math.min(0.06, (yaw - lyaw) * -2)) - swx) * Math.min(1, 12 * dt);
    swy += (Math.max(-0.05, Math.min(0.05, (pitch - lpit) * 2)) - swy) * Math.min(1, 12 * dt);
    lyaw = yaw;
    lpit = pitch;

    const isPistol = cfg.id === "pistol";
    const isSniper = cfg.id === "sniper";
    const tl = rl > 0 ? Math.min(1, rl / 0.1, (1 - rl) / 0.1) : 0;

    mag.position.copy(MAG_REST);
    mag.rotation.set(0, 0, 0);
    awmMagGroup.position.set(0, 0, 0);
    if (rl > 0.24 && rl < 0.72) {
      const magArc = Math.sin(((rl - 0.24) / 0.48) * Math.PI);
      if (cfg.id === "m416") {
        mag.position.set(-0.020 * magArc, MAG_REST.y - 0.116 * magArc, MAG_REST.z - 0.014 * magArc);
        mag.rotation.set(0.14 * magArc, 0, -0.08 * magArc);
      } else if (isSniper) {
        awmMagGroup.position.set(0, -11.5 * magArc, 2.0 * magArc);
      }
    }

    // AWM bolt-action cycling: lift handle (-0.88 rad on RootNode Z), pull back (-11cm on RootNode Z), push & lock
    let awmCycleT = 0;
    if (isSniper) {
      if (isReloading && !st.isTactical && rl >= 0.72) {
        awmCycleT = smooth01((rl - 0.72) / 0.26);
      } else if (awmBoltCycleStartAt > 0 && !isReloading) {
        const dtShot = (nowMs - awmBoltCycleStartAt) / 920;
        if (dtShot >= 0 && dtShot < 1) {
          awmCycleT = dtShot;
        } else if (dtShot >= 1) {
          awmBoltCycleStartAt = 0;
        }
      }
    }
    if (awmCycleT > 0 && awmCycleT < 1) {
      let liftK = 0;
      let pullK = 0;
      if (awmCycleT < 0.18) {
        liftK = smooth01(awmCycleT / 0.18);
      } else if (awmCycleT < 0.50) {
        liftK = 1;
        pullK = smooth01((awmCycleT - 0.18) / 0.32);
      } else if (awmCycleT < 0.82) {
        liftK = 1;
        pullK = 1 - smooth01((awmCycleT - 0.50) / 0.32);
      } else {
        liftK = 1 - smooth01((awmCycleT - 0.82) / 0.18);
      }
      awmBoltPivot.rotation.z = -0.88 * liftK;
      awmBoltPivot.position.z = -23.12 - 11.0 * pullK;
    } else {
      awmBoltPivot.rotation.z = 0;
      awmBoltPivot.position.z = -23.12;
    }

    // Tactical Pistol blowback, empty slide-lock (0.042m), slide-release & angled 17.5° mag drop
    const decayRecoilP = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;
    const decayKickZ = dt > 0 ? 1 - Math.exp(-16 * dt) : 1;
    const decaySlide = dt > 0 ? 1 - Math.exp(-22 * dt) : 1;
    pistolRecoilPitch = lerp(pistolRecoilPitch, 0, decayRecoilP);
    pistolRecoilKickZ = lerp(pistolRecoilKickZ, 0, decayKickZ);

    let pistolMagDrop = 0;
    let pistolReloadTiltZ = 0;
    if (isPistol && rl > 0) {
      if (rl >= 0.16 && rl < 0.46) {
        const kDrop = smooth01((rl - 0.16) / 0.30);
        pistolMagDrop = kDrop * 0.14;
        pistolReloadTiltZ = kDrop * 0.26;
      } else if (rl >= 0.46 && rl < 0.74) {
        const kIns = smooth01((rl - 0.46) / 0.28);
        pistolMagDrop = (1 - kIns) * 0.14;
        pistolReloadTiltZ = (1 - kIns) * 0.26;
      }
    }
    pistolMagNode.position.set(0, -pistolMagDrop, pistolMagDrop * 0.32);

    const pistolEmptyLocked =
      weapons.pistol &&
      ((weapons.pistol.mag === 0 && !(isPistol && isReloading)) ||
        (isPistol && isReloading && !st.isTactical && rl < 0.88));
    const pistolRackPull =
      isPistol && isReloading && !st.isTactical && rl >= 0.83 && rl < 0.93
        ? smooth01((rl - 0.83) / 0.06) * 0.046
        : 0;
    const targetSlideZ = pistolRackPull > 0 ? pistolRackPull : pistolEmptyLocked ? 0.042 : 0;
    pistolSlideOffset = lerp(pistolSlideOffset, targetSlideZ, decaySlide);
    pistolSlideNode.position.z = pistolSlideOffset;
    pistolPivot.position.set(0, 0, pistolRecoilKickZ);
    pistolPivot.rotation.set(pistolRecoilPitch, 0, pistolReloadTiltZ);

    const pull = !st.isTactical && rl >= 0.83 && rl < 0.94 ? smooth01((rl - 0.83) / 0.07) : 0;
    ch.position.z = CH_REST_Z + pull * 0.055;
    if (rl > 0 && !isPistol) bolt = pull;
    if (rlp < 0.28 && rl >= 0.28) snd.click(900);
    if (rlp < 0.68 && rl >= 0.68) snd.click(1400);
    if (!st.isTactical && rlp < 0.88 && rl >= 0.88) snd.click(620);
    rlp = rl;
    if (rl <= 0) bolt = Math.max(0, bolt - dt * 16);
    boltVis.visible = bolt < 0.15;

    const firingVisual = (input.fireHeld || curFlags & FLAG.FIRING) && !isReloading && st.mag > 0;
    trigPull += ((firingVisual ? 1 : 0) - trigPull) * Math.min(1, 25 * dt);
    pistolTrigPull = lerp(pistolTrigPull, firingVisual && isPistol ? 0.42 : 0, dt > 0 ? 1 - Math.exp(-18 * dt) : 1);
    trig.rotation.x = trigPull * 0.3;
    pistolTriggerNode.rotation.x = pistolTrigPull;

    const hip = 1 - ads, calm = 1 - 0.78 * ads, bobK = mv * (1 - 0.88 * ads);
    const chW = !st.isTactical && rl > 0.74 && rl < 0.98 ? smooth01(Math.min((rl - 0.74) / 0.09, (0.98 - rl) / 0.08)) : 0;
    const baseHip = isPistol ? PISTOL_HIP_POS : isSniper ? SNIPER_HIP_POS : HIP_POS;
    const targetAdsX = isPistol ? PISTOL_ADS_POS.x : ADS_POS.x;
    const adsPosY = isPistol ? PISTOL_ADS_POS.y : isSniper ? -awmOpticY : ADS_POS.y;
    const adsPosZ = isPistol ? PISTOL_ADS_POS.z : isSniper ? -0.165 : ADS_POS.z;

    gun.position.set(
      lerp(baseHip.x, targetAdsX, ads) + (swx + Math.sin(bob) * 0.0055 * bobK) * calm - (isPistol ? 0.024 : 0.044) * tl,
      lerp(baseHip.y, adsPosY, ads) + (swy + Math.sin(bob * 2) * 0.007 * bobK) * calm - 0.055 * spr + 0.018 * tl + Math.sin(gt * 1.6) * 0.0016 * hip,
      lerp(baseHip.z, adsPosZ, ads) + recoil * (isPistol ? 0.35 : 0.95 - 0.65 * ads) + 0.028 * tl - (isPistol ? 0.022 : 0.042) * chW,
    );

    // Upright roll = 0 at rest (no rightward tilt), barrel angled gently inward toward center crosshair
    const hipPitch = (isPistol ? 0.028 : isSniper ? 0.032 : 0.036) * hip;
    const hipYaw = (isPistol ? 0.038 : isSniper ? 0.046 : 0.052) * hip;
    gun.rotation.set(
      hipPitch + (recoil * (isPistol ? 0.85 : 1.85) + swy * 1.8) * calm - 0.20 * spr + (isPistol ? 0.09 : 0.16) * tl,
      hipYaw + (0.48 * spr + swx * 1.8) * calm + (isPistol ? 0.12 : 0.20) * tl,
      swx * 1.2 * calm - (isPistol ? 0.10 : 0.24) * tl,
    );

    // Sync viewmodel hierarchy and lock skinned hands onto active weapon sockets via 2-bone IK
    vmCam.position.copy(cam.position);
    vmCam.quaternion.copy(cam.quaternion);
    vmCam.updateMatrixWorld(true);
    _vmInvQ.copy(vmCam.quaternion).invert();

    const activeSocks = weaponSockets[cfg.id] || weaponSockets.m416;
    const leftAction = isSniper
      ? sampleSniperLeftSocket(rl, activeSocks)
      : sampleLeftSocket(rl, Boolean(st.isTactical), activeSocks);

    readSocketInVmCam(activeSocks.grip, _sockGripP, _sockGripQ);
    let rightAction = "grip";
    if (isSniper && awmCycleT > 0.02 && awmCycleT < 0.98) {
      readSocketInVmCam(activeSocks.bolt, _sockRBoltP, _sockRBoltQ);
      const reachK =
        awmCycleT < 0.15
          ? smooth01(awmCycleT / 0.15)
          : awmCycleT > 0.85
            ? 1 - smooth01((awmCycleT - 0.85) / 0.15)
            : 1;
      _rightTargetP.lerpVectors(_sockGripP, _sockRBoltP, reachK);
      _rightTargetQ.copy(_sockGripQ).slerp(_sockRBoltQ, reachK);
      rightAction = reachK > 0.4 ? "bolt" : "grip";
    } else {
      _rightTargetP.copy(_sockGripP);
      _rightTargetQ.copy(_sockGripQ);
    }

    if (armsCtrl) {
      const canShowArms = (engineMode === "solo" || meAlive) && engineMode !== "idle" && !scopedSniper;
      armsCtrl.update({
        weaponId: cfg.id,
        leftSocketPos: _leftTargetP,
        leftSocketQuat: _leftTargetQ,
        rightSocketPos: _rightTargetP,
        rightSocketQuat: _rightTargetQ,
        triggerPull: isPistol ? Math.min(1, pistolTrigPull / 0.42) : trigPull,
        ads,
        leftAction,
        rightAction,
        hideArms: !canShowArms,
      });
      if (armsRoot) armsRoot.updateMatrixWorld(true);
    }
  }

  const _hudCache = Object.create(null);
  function hud() {
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();
    const isReloading = st.reloadEndsAt > nowMs;

    const hpW = Math.max(0, hp) + "%";
    const hpBg = meInvuln ? "#64c8ff" : hp > 35 ? "#4ec3b0" : "#e85445";
    const hpText = `MÁU ${Math.max(0, Math.round(hp))} / 100`;
    if (_hudCache.hpW !== hpW) { _hudCache.hpW = hpW; $("hpb").style.width = hpW; }
    if (_hudCache.hpBg !== hpBg) { _hudCache.hpBg = hpBg; $("hpb").style.background = hpBg; }
    if (_hudCache.hpText !== hpText) {
      _hudCache.hpText = hpText;
      const hpLbl = $("hpLabel");
      if (hpLbl) hpLbl.textContent = hpText;
    }

    const isLow = st.mag <= Math.ceil(cfg.magSize * 0.3);
    const amText = isReloading ? "Nạp đạn…" : `${st.mag} / ∞`;
    const amLow = isLow && !isReloading;
    const relHint = amLow && activeState === "play" && meAlive ? "block" : "none";
    if (_hudCache.amText !== amText) { _hudCache.amText = amText; $("am").textContent = amText; }
    if (_hudCache.amLow !== amLow) { _hudCache.amLow = amLow; $("am").classList.toggle("amLow", amLow); }
    if (_hudCache.relHint !== relHint) { _hudCache.relHint = relHint; $("reloadHint").style.display = relHint; }

    if (_hudCache.activeSlot !== activeSlot) {
      _hudCache.activeSlot = activeSlot;
      for (const s of WEAPON_SLOTS) {
        const pNode = $(`slotPill${s}`);
        if (pNode) pNode.classList.toggle("active", s === activeSlot);
      }
    }

    const postureLabel = isSprinting
      ? "Chạy nước rút"
      : crouched
        ? "Ngồi"
        : !grounded
          ? "Trên không"
          : ads > 0.3
            ? "Đang ngắm"
            : "Đứng";
    const postureText = `${cfg.name} • ${postureLabel}`;
    if (_hudCache.postureText !== postureText) {
      _hudCache.postureText = postureText;
      $("postureBadge").textContent = postureText;
    }

    if (_hudCache.engineMode !== engineMode) {
      _hudCache.engineMode = engineMode;
      $("top").style.display = engineMode === "solo" ? "block" : "none";
      $("pvpTop").style.display = engineMode === "lan" ? "flex" : "none";
      $("radarCanvas").style.display = engineMode === "lan" ? "block" : "none";
    }
    if (_hudCache.soloWave !== soloWave) { _hudCache.soloWave = soloWave; $("wv").textContent = soloWave; }
    if (_hudCache.soloScore !== soloScore) { _hudCache.soloScore = soloScore; $("sc").textContent = soloScore; }
    if (engineMode === "lan") {
      const showRespawn = !meAlive && activeState === "play";
      const respDisp = showRespawn ? "block" : "none";
      if (_hudCache.respDisp !== respDisp) { _hudCache.respDisp = respDisp; $("respawnBanner").style.display = respDisp; }
      if (showRespawn) {
        const respText = `Đã bị hạ — Hồi sinh sau ${(respawnMs / 1000).toFixed(1)}s`;
        if (_hudCache.respText !== respText) { _hudCache.respText = respText; $("respawnBanner").textContent = respText; }
      }
      if (currentMode === "TDM") {
        const metaText = `${formatClock(timeLeftSec)} | ${killLimit} Mạng`;
        if (_hudCache.scA !== teamScores.A) { _hudCache.scA = teamScores.A; $("scA").textContent = teamScores.A; }
        if (_hudCache.scB !== teamScores.B) { _hudCache.scB = teamScores.B; $("scB").textContent = teamScores.B; }
        if (_hudCache.pvpMeta !== metaText) { _hudCache.pvpMeta = metaText; $("pvpMeta").textContent = metaText; }
      } else {
        const topP = lastPlayers.slice().sort((a, b) => b.kills - a.kills)[0];
        const aVal = topP ? topP.kills : 0;
        const metaText = `FFA ${formatClock(timeLeftSec)} | Dẫn đầu: ${topP ? topP.name : "-"}`;
        if (_hudCache.scA !== aVal) { _hudCache.scA = aVal; $("scA").textContent = aVal; }
        if (_hudCache.scB !== killLimit) { _hudCache.scB = killLimit; $("scB").textContent = killLimit; }
        if (_hudCache.pvpMeta !== metaText) { _hudCache.pvpMeta = metaText; $("pvpMeta").textContent = metaText; }
      }
    } else if (_hudCache.respDisp !== "none") {
      _hudCache.respDisp = "none";
      $("respawnBanner").style.display = "none";
    }
  }

  function setHitmarker(headshot) {
    hm = 1;
    $("hm").style.borderColor = headshot ? "#ff3b3b" : "var(--amber)";
    $("hm").style.borderWidth = headshot ? "3px" : "2px";
  }

  function showKillAlert(text, color = "#ff4747") {
    const node = $("killAlert");
    node.textContent = text;
    node.style.color = color;
    node.style.opacity = "1";
    killAlertT = 1.6;
  }

  function pushKillfeed(ev) {
    const kf = $("killfeed");
    const row = el("div", "kfRow");
    const kMeta = TEAM_META[ev.killerTeam] || TEAM_META.FFA;
    const vMeta = TEAM_META[ev.victimTeam] || TEAM_META.FFA;
    const kSpan = el("span", "", `${kMeta.symbol} ${ev.killer}`);
    kSpan.style.color = kMeta.hex;
    const wTag = ev.weapon || "M416";
    const mid = el("span", "", ev.head ? ` [HEADSHOT • ${wTag}] ` : ` [${wTag}] `);
    mid.style.color = ev.head ? "#ff5252" : "#cfd8df";
    mid.style.fontWeight = "700";
    const vSpan = el("span", "", `${vMeta.symbol} ${ev.victim}`);
    vSpan.style.color = vMeta.hex;
    row.append(kSpan, mid, vSpan);
    kf.prepend(row);
    while (kf.children.length > 5) kf.lastChild.remove();
    setTimeout(() => row.remove(), 5500);
  }

  function pushHudChat(ev) {
    const log = $("hudChatLog");
    const line = el("div", "hudChatRow");
    const meta = TEAM_META[ev.team] || TEAM_META.FFA;
    const who = el("b", "", `${meta.symbol} ${ev.from}: `);
    who.style.color = meta.hex;
    line.append(who, el("span", "", ev.text));
    log.append(line);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => line.remove(), 7000);
  }

  function renderScoreboardTable() {
    const tbody = $("sbBody");
    tbody.textContent = "";
    const rows = lastPlayers.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.headshots - a.headshots);
    for (const p of rows) {
      const tr = document.createElement("tr");
      if (p.id === net.playerId) tr.style.background = "rgba(240, 180, 41, 0.14)";
      const meta = TEAM_META[p.team] || TEAM_META.FFA;
      const tdTeam = el("td", "", `${meta.symbol} ${meta.name}`);
      tdTeam.style.color = meta.hex;
      tr.append(
        el("td", "", p.name + (p.id === net.playerId ? " (Bạn)" : "")),
        tdTeam,
        el("td", "", String(p.kills)),
        el("td", "", String(p.deaths)),
        el("td", "", String(p.headshots)),
        el("td", "", p.alive ? "Sống" : "Hồi sinh"),
      );
      tbody.append(tr);
    }
    $("sbTitle").textContent = `${currentMode === "FFA" ? "Đấu Đơn (FFA)" : "Đấu Đội (TDM)"} — Mục tiêu ${killLimit} mạng (Còn ${formatClock(timeLeftSec)})`;
  }

  // ---------- Solo Offline Drone mode ----------
  const dMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.8, roughness: 0.35 });
  function spawnDrone() {
    const g = new THREE.Group(), m = dMat.clone();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), m);
    body.scale.y = 0.6;
    body.castShadow = true;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    eye.position.z = 0.42;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.04, 6, 20), dMat);
    ring.rotation.x = Math.PI / 2;
    g.add(body, eye, ring);
    const a = rnd(0, 6.28);
    const spawnRad = activeMapId === "military" ? 24 : 42;
    const patBound = activeMapId === "military" ? 26 : 35;
    g.position.set(Math.cos(a) * spawnRad, 6.5, Math.sin(a) * spawnRad);
    S.add(g);
    const d = { g, body, ring, hp: 3, st: "patrol", tgt: new Vec(rnd(-patBound, patBound), 6.5, rnd(-patBound, patBound)), cd: rnd(1, 2), los: false, losT: 0, hitT: 0, sd: Math.random() < 0.5 ? 1 : -1 };
    body.userData.drone = d;
    drones.push(d);
  }
  function canSee(a, b) {
    const d = b.clone().sub(a), L = d.length();
    if (L < 1e-4) return true;
    d.divideScalar(L);
    if (activeCollision) {
      const hit = activeCollision.raycastShot(a.x, a.y, a.z, d.x, d.y, d.z, L - 0.05);
      return !hit;
    }
    lr.set(a, d);
    lr.far = L;
    return lr.intersectObjects(solid, false).length === 0;
  }
  function hurtSolo(n) {
    hp -= n;
    dmgV = 1;
    shake = 0.25;
    snd.hurt();
    hud();
    if (hp <= 0) {
      activeState = "over";
      fire = aimHeld = false;
      if (document.pointerLockElement === R.domElement) document.exitPointerLock();
      $("pauseTitle").textContent = "Bạn đã bị hạ (Offline)";
      $("pauseSub").textContent = `Điểm: ${soloScore} — Trụ được ${soloWave} đợt.`;
      $("btnPauseResume").textContent = "Chơi lại";
      $("pauseOverlay").style.display = "grid";
    }
  }
  function updDrone(d, dt) {
    const g = d.g, e = cam.position, to = e.clone().sub(g.position), dist = to.length();
    d.ring.rotation.z += dt * 18;
    d.hitT = Math.max(0, d.hitT - dt);
    d.body.material.emissive.setHex(d.hitT > 0 ? 0xffffff : 0);
    d.losT -= dt;
    if (d.losT <= 0) { d.losT = 0.3; d.los = dist < 32 && canSee(g.position, e); }
    if (d.st === "patrol" && d.los && dist < 26) d.st = "chase";
    else if (d.st === "chase") { if (d.los && dist < 14) d.st = "attack"; else if (dist > 38) d.st = "patrol"; }
    else if (d.st === "attack" && (!d.los || dist > 18)) d.st = "chase";
    let alt = 6.5, sp = 3, dir = new Vec();
    if (d.st === "patrol") {
      dir.copy(d.tgt).sub(g.position).setY(0);
      if (dir.length() < 2) d.tgt.set(rnd(-35, 35), 6.5, rnd(-35, 35));
    } else if (d.st === "chase") {
      alt = 4; sp = 6.5; dir.copy(to).setY(0);
    } else {
      alt = 2.3; sp = 3.5;
      const f = to.clone().setY(0).normalize();
      dir.copy(f).multiplyScalar(dist > 9 ? 1 : -1).add(new Vec(-f.z, 0, f.x).multiplyScalar(d.sd * 1.2));
      d.cd -= dt;
      if (d.cd <= 0) {
        d.cd = rnd(1, 1.7);
        snd.laser();
        const miss = Math.random() < 0.4;
        const aim = e.clone().add(new Vec(rnd(-1, 1), rnd(-1, 0.3), rnd(-1, 1)).multiplyScalar(miss ? 1.8 : 0));
        tracer(g.position, aim, 0xff3a2a);
        if (!miss) hurtSolo(9);
      }
    }
    dir.setY(0).normalize();
    g.position.addScaledVector(dir, sp * dt);
    g.position.y += (alt + Math.sin(performance.now() / 400 + d.sd) * 0.3 - g.position.y) * Math.min(1, 2 * dt);
    g.lookAt(e.x, g.position.y, e.z);
  }

  // ---------- Shooting, Reload, Weapon Switch & Controls ----------
  function switchWeapon(targetSlot) {
    if (activeState !== "play" || (engineMode === "lan" && !meAlive)) return false;
    const wid = SLOT_TO_WEAPON_ID[targetSlot];
    if (!wid || !WEAPONS[wid] || targetSlot === activeSlot) return false;

    const cur = activeWeapon().st;
    cur.reloadEndsAt = 0;
    cur.reloadStartAt = 0;
    input.clearAds();
    testAimHeld = false;
    ads = 0;

    prevSlot = activeSlot;
    activeSlot = targetSlot;
    rlp = 0;
    awmBoltCycleStartAt = 0;
    applyViewmodelWeapon(wid);
    gunAnim(0, 0);
    snd.click(740);
    if (engineMode === "lan") {
      net.send(MSG.SWITCH_WEAPON, { slot: targetSlot });
    }
    hud();
    return true;
  }

  function reload() {
    if (activeState !== "play" || (engineMode === "lan" && !meAlive)) return false;
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();
    if (st.reloadEndsAt > nowMs || st.mag >= cfg.magSize) return false;

    const dur = getReloadDurationMs(cfg, st.mag);
    st.isTactical = st.mag > 0;
    st.reloadStartAt = nowMs;
    st.reloadDuration = dur;
    st.reloadEndsAt = nowMs + dur;
    rlp = 0;

    input.clearAds();
    testAimHeld = false;
    snd.reload();
    if (engineMode === "lan") net.send(MSG.RELOAD, {});
    hud();
    return true;
  }

  function shoot() {
    if (activeState !== "play" || (engineMode === "lan" && !meAlive)) return false;
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();

    if (st.reloadEndsAt > nowMs || isSprinting) return false;
    if (st.mag <= 0) {
      snd.dryClick();
      reload();
      return false;
    }
    if (nowMs < st.nextFireAt) return false;

    st.mag--;
    st.nextFireAt = nowMs + cfg.fireInterval;
    recoil = cfg.recoil || 0.07;
    kick += lerp(cfg.kickHip || 0.014, cfg.kickAds || 0.009, ads);
    flash = cfg.id === "pistol" ? 0.048 : 0.06;
    bolt = 1;
    if (cfg.id === "pistol") {
      pistolRecoilPitch = 0.22 * (1 - 0.45 * ads);
      pistolRecoilKickZ = 0.022 * (1 - 0.35 * ads);
      pistolSlideOffset = 0.044;
      pistolTrigPull = 0.42;
      pistolMuzzleFlash.rotation.z = rnd(0, 6.28);
    } else if (cfg.id === "sniper" && st.mag > 0) {
      awmBoltCycleStartAt = nowMs + 190;
    }
    mf.rotation.z = rnd(0, 6.28);
    mf.scale.setScalar(rnd(0.8, 1.3));
    if (cfg.id === "sniper") snd.sniperShot();
    else if (cfg.id === "pistol") snd.pistolShot();
    else snd.shot();
    hud();

    const spread = computeWeaponSpread(cfg, curFlags);
    ray.far = cfg.maxRange || 140;
    ray.setFromCamera({ x: rnd(-spread, spread), y: rnd(-spread, spread) }, cam);

    const enemyMeshes = [];
    if (engineMode === "lan") {
      for (const av of remotePlayers.values()) {
        if (!av.alive) continue;
        if (currentMode === "TDM" && av.team === meTeam) continue;
        enemyMeshes.push(...av.hitMeshes);
      }
    }
    const candidates = engineMode === "solo" ? drones.map((d) => d.body) : enemyMeshes;
    let hit = null;
    if (activeCollision) {
      const targetHit = candidates.length ? ray.intersectObjects(candidates, false)[0] : null;
      const worldHit = activeCollision.raycastShot(
        ray.ray.origin.x,
        ray.ray.origin.y,
        ray.ray.origin.z,
        ray.ray.direction.x,
        ray.ray.direction.y,
        ray.ray.direction.z,
        ray.far,
      );
      if (worldHit && (!targetHit || worldHit.dist < targetHit.distance)) {
        hit = {
          distance: worldHit.dist,
          point: new Vec(worldHit.x, worldHit.y, worldHit.z),
          object: { userData: {} },
        };
      } else {
        hit = targetHit || null;
      }
    } else {
      hit = ray.intersectObjects([ground, ...solid, ...candidates], false)[0] || null;
    }
    const from = getViewmodelWorldPoint(muz, new Vec());
    const end = hit ? hit.point : ray.ray.at(75, new Vec());
    tracer(from, end, cfg.id === "sniper" ? 0xfff5cc : 0xffe2a0);

    if (engineMode === "lan") {
      net.send(MSG.FIRE, {
        weapon: cfg.id,
        flags: curFlags,
        origin: { x: ray.ray.origin.x, y: ray.ray.origin.y, z: ray.ray.origin.z },
        dir: { x: ray.ray.direction.x, y: ray.ray.direction.y, z: ray.ray.direction.z },
      });
      if (hit && hit.object.userData.hitTarget) {
        const tgt = hit.object.userData.hitTarget;
        net.send(MSG.HIT, { targetId: tgt.id, part: tgt.part });
        burst(hit.point, 10, 3);
      } else if (hit) {
        burst(hit.point, 9, 2.5, ray.ray.direction.clone().negate());
      }
    } else if (hit) {
      const d = hit.object.userData.drone;
      if (d) {
        d.hp -= cfg.id === "sniper" ? 3 : 1;
        d.hitT = 0.08;
        setHitmarker(cfg.id === "sniper");
        snd.hit();
        burst(hit.point, 8, 3);
        if (d.st === "patrol") d.st = "chase";
        if (d.hp <= 0) {
          burst(d.g.position, 45, 6);
          snd.boom();
          S.remove(d.g);
          drones.splice(drones.indexOf(d), 1);
          soloScore += 100;
          hud();
        }
      } else {
        burst(hit.point, 10, 2.5, ray.ray.direction.clone().negate());
      }
    }

    if (st.mag === 0) {
      reload();
    }
    return true;
  }

  input.attach(R.domElement);

  $("hudChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const txt = sanitizeText($("hudChatInput").value, "", 120);
      if (txt) net.send(MSG.CHAT, { text: txt });
      $("hudChatInput").value = "";
      chatOpen = false;
      $("hudChatInput").style.display = "none";
      input.setTextFocusBlocked(false);
      input.tryLock();
    } else if (e.key === "Escape") {
      e.preventDefault();
      chatOpen = false;
      $("hudChatInput").style.display = "none";
      input.setTextFocusBlocked(false);
      input.tryLock();
    }
  });

  R.domElement.addEventListener("click", () => {
    if (activeState === "play" && !input.active && !chatOpen) {
      initAudio();
      $("pauseOverlay").style.display = "none";
      input.tryLock();
    }
  });

  function showPauseOverlay(title, sub) {
    $("pauseTitle").textContent = title;
    $("pauseSub").textContent = sub;
    $("btnPauseResume").textContent = "Tiếp tục";
    $("btnPauseLeave").textContent = engineMode === "lan" ? "Rời phòng" : "Về sảnh chính";
    $("pauseOverlay").style.display = "grid";
  }

  function onPointerLockChanged(isLocked) {
    if (isLocked) {
      $("pauseOverlay").style.display = "none";
      testLocked = true;
    } else {
      testLocked = false;
      $("scoreboard").style.display = "none";
    }
  }

  function onPointerUnlocked() {
    if (activeState === "play" && !chatOpen) {
      if (engineMode === "lan") {
        showPauseOverlay(
          "Menu trận đấu (Trận đang chạy)",
          "Esc chỉ thả chuột — Trận PvP vẫn tiếp tục trực tiếp trên LAN.",
        );
      } else {
        showPauseOverlay("Tạm dừng (Offline)", "Bấm Tiếp tục để quay lại luyện tập Drone.");
      }
    }
  }

  function onPointerLockFailed() {
    if (activeState === "play" && !input.active && !chatOpen) {
      showPauseOverlay(
        "Trận đấu đã sẵn sàng",
        "Bấm Tiếp tục hoặc click màn hình để khóa chuột và chiến đấu.",
      );
    }
  }

  $("btnPauseResume").onclick = () => {
    initAudio();
    if (activeState === "over" && engineMode === "solo") {
      startSolo();
      return;
    }
    $("pauseOverlay").style.display = "none";
    input.tryLock();
  };
  $("btnPauseLeave").onclick = () => {
    stopEngine();
    onRequestExitToLobby();
  };

  // ---------- Networking Sync Hooks ----------
  function applySnapshot(snap) {
    if (!snap || engineMode !== "lan") return;
    currentMode = snap.mode;
    killLimit = snap.killLimit;
    timeLeftSec = snap.timeLeftSec;
    teamScores = snap.teamScores || { A: 0, B: 0 };
    lastPlayers = snap.players || [];

    const seen = new Set();
    for (const p of lastPlayers) {
      seen.add(p.id);
      if (p.id === net.playerId) {
        const wasAlive = meAlive;
        meTeam = p.team || "FFA";
        meAlive = p.alive;
        meInvuln = p.invulnerable;
        respawnMs = p.respawnMs;
        hp = p.hp;
        const serverWid = p.weaponId || SLOT_TO_WEAPON_ID[activeSlot];
        if (weapons[serverWid] && !p.reloading && Number.isFinite(p.ammo)) {
          weapons[serverWid].mag = p.ammo;
          if (weapons[serverWid].reloadEndsAt > performance.now() && p.ammo >= WEAPONS[serverWid].magSize) {
            weapons[serverWid].reloadEndsAt = 0;
          }
        }
        if (!wasAlive && p.alive) {
          P.set(p.x, p.y, p.z);
          yaw = p.yaw;
          pitch = 0;
          vy = velX = velZ = 0;
          crouched = false;
          eyeHeight = EYE_STAND;
          resetAllWeapons();
          cam.position.set(P.x, P.y + EYE_STAND, P.z);
          cam.rotation.set(pitch, yaw, 0);
        }
        continue;
      }

      let av = remotePlayers.get(p.id);
      if (!av) av = createRemoteAvatar(p);
      else if (av.team !== p.team) swapAvatarRig(av, p.team);
      av.snapshots.push({
        t: snap.t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
        mv: p.mv || 0, flags: p.flags || 0, weaponId: p.weaponId || "m416",
        reloading: Boolean(p.reloading), hp: p.hp, alive: p.alive, invulnerable: p.invulnerable,
      });
      if (av.snapshots.length > 16) av.snapshots.shift();
    }

    for (const [id, av] of remotePlayers.entries()) {
      if (!seen.has(id)) {
        S.remove(av.container);
        remotePlayers.delete(id);
      }
    }
    if (input.isDown("score")) renderScoreboardTable();
    hud();
  }

  net.on(MSG.SNAPSHOT, (msg) => applySnapshot(msg));
  net.on(MSG.AMMO, (msg) => {
    if (engineMode !== "lan") return;
    if (msg.weapons && typeof msg.weapons === "object") {
      for (const [wid, val] of Object.entries(msg.weapons)) {
        if (weapons[wid] && Number.isFinite(val)) weapons[wid].mag = val;
      }
    }
    if (msg.activeWeaponId && WEAPONS[msg.activeWeaponId]) {
      const targetSlot = WEAPONS[msg.activeWeaponId].slot;
      if (targetSlot !== activeSlot) {
        activeSlot = targetSlot;
        applyViewmodelWeapon(msg.activeWeaponId);
      }
    }
    if (msg.id && weapons[msg.id] && Number.isFinite(msg.mag)) {
      weapons[msg.id].mag = msg.mag;
      if (msg.reloadingMs > 0) {
        const dur = weapons[msg.id].reloadDuration || WEAPONS[msg.id].reloadTime;
        weapons[msg.id].reloadStartAt = performance.now() - Math.max(0, dur - msg.reloadingMs);
        weapons[msg.id].reloadEndsAt = performance.now() + msg.reloadingMs;
      } else {
        weapons[msg.id].reloadEndsAt = 0;
      }
    }
    hud();
  });
  net.on(MSG.EVENT_RELOAD, (ev) => {
    const pid = ev.playerId || ev.pid;
    if (!pid || pid === net.playerId || engineMode !== "lan") return;
    const av = remotePlayers.get(pid);
    if (av) {
      av.reloadDurMs = ev.dur || 2000;
      av.reloadEndsAt = performance.now() + av.reloadDurMs;
    }
  });
  net.on(MSG.SWITCH_WEAPON, (ev) => {
    if (!ev.playerId || ev.playerId === net.playerId || engineMode !== "lan") return;
    const av = remotePlayers.get(ev.playerId);
    if (av) {
      av.weaponId = ev.weaponId || "m416";
      av.weaponLockUntil = performance.now() + 260;
      av.reloadEndsAt = 0;
      syncRemoteWeaponVisibility(av);
    }
  });
  net.on(MSG.EVENT_FIRE, (ev) => {
    if (ev.playerId === net.playerId || engineMode !== "lan") return;
    const av = remotePlayers.get(ev.playerId);
    if (av) {
      av.flashTimer = 0.06;
      av.radarBlipUntil = performance.now() + 2000;
    }
    const fromV = new Vec(ev.origin.x, ev.origin.y, ev.origin.z);
    const dirV = new Vec(ev.dir.x, ev.dir.y, ev.dir.z).normalize();
    tracer(fromV, fromV.clone().addScaledVector(dirV, 40), 0xffe2a0);
    snd.remoteShot(cam.position.distanceTo(fromV));
  });
  net.on(MSG.EVENT_HIT, (ev) => {
    if (engineMode !== "lan") return;
    if (ev.shooterId === net.playerId) {
      if (ev.part === "shield") showKillAlert("Mục tiêu đang bất tử hồi sinh", "#64c8ff");
      else if (ev.part === "head") { setHitmarker(true); snd.headshot(); }
      else { setHitmarker(false); snd.hit(); }
    } else if (ev.targetId === net.playerId && ev.damage > 0) {
      hp = ev.hp;
      dmgV = 1;
      shake = 0.25;
      snd.hurt();
      hud();
    }
  });
  net.on(MSG.EVENT_KILL, (ev) => {
    if (engineMode !== "lan") return;
    pushKillfeed(ev);
    if (ev.killerId === net.playerId) {
      showKillAlert(ev.head ? `HEADSHOT! ${ev.victim}` : `HẠ GỤC ${ev.victim}`, ev.head ? "#ff3b3b" : "#f0b429");
    } else if (ev.victimId === net.playerId) {
      meAlive = false;
      activeWeapon().st.reloadEndsAt = 0;
      input.clearAds();
      testAimHeld = false;
      hp = 0;
      respawnMs = 4000;
      dmgV = 1;
      hud();
      showKillAlert(`BỊ HẠ BỞI ${ev.killer}${ev.head ? " (HEADSHOT)" : ""}`, "#ff6b4a");
    }
  });
  net.on(MSG.EVENT_RESPAWN, (ev) => {
    if (engineMode !== "lan") return;
    if (ev.playerId === net.playerId) {
      meAlive = true;
      meInvuln = true;
      hp = 100;
      crouched = false;
      eyeHeight = EYE_STAND;
      resetAllWeapons();
      P.set(ev.pos.x, ev.pos.y, ev.pos.z);
      yaw = ev.yaw;
      pitch = 0;
      vy = velX = velZ = 0;
      cam.position.set(P.x, P.y + EYE_STAND, P.z);
      cam.rotation.set(pitch, yaw, 0);
      hud();
    }
  });
  net.on(MSG.CHAT, (ev) => {
    if (engineMode === "lan") pushHudChat(ev);
  });

  // ---------- Main Frame Loop ----------
  let ltn = rnd(8, 16), lt = 0;
  let nextBirdAt = rnd(7, 15), nextHeartbeatAt = 0, lastStepIdx = 0;
  const clock = new THREE.Clock();

  function updateWeatherAndRain(dt) {
    gt += dt;
    sparks.upd(dt);
    if (activeMapId !== "harbor") {
      if (militaryData && militaryData.updateAtmosphere) {
        if (militaryData.updateAtmosphere(gt, cam.position, activeQuality.preset)) {
          shadowDirty = true;
        }
      }
      if (AC && ambFilter && ambGain) {
        const gust = 0.5 + 0.5 * Math.sin(gt * 0.27) * Math.cos(gt * 0.13);
        ambFilter.frequency.setTargetAtTime(210 + gust * 250, AC.currentTime, 0.2);
        ambGain.gain.setTargetAtTime(0.042 + gust * 0.032, AC.currentTime, 0.2);
      }
      if (activeState === "play" && AC) {
        nextBirdAt -= dt;
        if (nextBirdAt <= 0) {
          nextBirdAt = rnd(10, 22);
          snd.distantBird();
        }
      }
      return;
    }

    const wind = Math.sin(gt * 0.23) * 0.6 + Math.sin(gt * 0.71) * 0.25;
    const px = P.x, pz = P.z;
    for (let i = 0; i < ND2; i++) {
      const k = i * 4, v = rd[k + 3], sp = 24 + 16 * v;
      let x = rd[k] + wind * 3 * dt, y = rd[k + 1] - sp * dt, z = rd[k + 2];
      if (x - px > 24) x -= 48; else if (x - px < -24) x += 48;
      if (z - pz > 24) z -= 48; else if (z - pz < -24) z += 48;
      if (y < 0) { y += 26; if (i % 3 !== 0 && Math.abs(x - px) < 11 && Math.abs(z - pz) < 11) rainRipples.emit(x, z); }
      rd[k] = x; rd[k + 1] = y; rd[k + 2] = z;
      rp2.set([x - wind * 0.07, y + sp * 0.022, z, x, y, z], i * 6);
    }
    rg2.attributes.position.needsUpdate = true;
    rainRipples.upd(dt);

    ltn -= dt;
    if (ltn <= 0) { ltn = rnd(12, 26); lt = 0.4; setTimeout(() => snd.thunder(), rnd(500, 2200)); }
    lt = Math.max(0, lt - dt);
    const b = lt > 0.28 || (lt < 0.2 && lt > 0.1) ? 1 : lt > 0 ? 0.3 : 0;
    hemi.intensity = 0.28 + b * 2.0;
    moon.intensity = 0.38 + b * 1.7;
    S.fog.color.setRGB(0.020 + b * 0.24, 0.039 + b * 0.27, 0.067 + b * 0.33);
    S.background.copy(S.fog.color);
  }

  function canStandUp() {
    if (activeCollision) {
      return activeCollision.canStandUp(P.x, P.y, P.z);
    }
    for (const c of cols) {
      if (P.x >= c.x0 - 0.42 && P.x <= c.x1 + 0.42 && P.z >= c.z0 - 0.42 && P.z <= c.z1 + 0.42) {
        const baseY = c.y0 || 0;
        if (baseY > P.y + 1.05 && baseY < P.y + 1.85) return false;
      }
    }
    upRay.set(new Vec(P.x, P.y + 1.0, P.z), UP);
    upRay.far = 0.86;
    return upRay.intersectObjects(solid, false).length === 0;
  }

  function updateRadarAndCrosshair(nowMs) {
    if (engineMode !== "lan") {
      $("cross").classList.remove("targetEnemy");
      return;
    }
    const enemyMeshes = [];
    for (const av of remotePlayers.values()) {
      if (!av.alive) continue;
      if (currentMode === "TDM" && av.team === meTeam) continue;
      enemyMeshes.push(...av.hitMeshes);
    }
    ray.far = 160;
    ray.setFromCamera({ x: 0, y: 0 }, cam);
    let hover = null;
    if (activeCollision) {
      const targetHit = enemyMeshes.length ? ray.intersectObjects(enemyMeshes, false)[0] : null;
      const worldHit = activeCollision.raycastShot(
        ray.ray.origin.x,
        ray.ray.origin.y,
        ray.ray.origin.z,
        ray.ray.direction.x,
        ray.ray.direction.y,
        ray.ray.direction.z,
        ray.far,
      );
      if (targetHit && (!worldHit || targetHit.distance <= worldHit.dist)) {
        hover = targetHit;
      }
    } else {
      hover = ray.intersectObjects([ground, ...solid, ...enemyMeshes], false)[0];
    }
    $("cross").classList.toggle("targetEnemy", Boolean(hover && hover.object.userData.hitTarget));

    const canvas = $("radarCanvas");
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const cx = 62, cy = 62, range = 45, scale = 54 / range;
    g.clearRect(0, 0, 124, 124);
    g.strokeStyle = "rgba(180,210,230,0.16)";
    g.beginPath(); g.arc(cx, cy, 27, 0, Math.PI * 2); g.stroke();

    const sn = Math.sin(yaw), cs = Math.cos(yaw);
    for (const av of remotePlayers.values()) {
      if (!av.alive) continue;
      const isTeammate = currentMode === "TDM" && av.team === meTeam;
      if (!isTeammate && nowMs > av.radarBlipUntil) continue;
      const dx = av.container.position.x - P.x;
      const dz = av.container.position.z - P.z;
      const rx = dx * cs - dz * sn;
      const rz = dx * sn + dz * cs;
      let px = cx + rx * scale;
      let py = cy + rz * scale;
      const d = Math.hypot(px - cx, py - cy);
      if (d > 54) {
        px = cx + ((px - cx) / d) * 54;
        py = cy + ((py - cy) / d) * 54;
      }
      g.fillStyle = (TEAM_META[av.team] || TEAM_META.FFA).hex;
      g.beginPath();
      g.arc(px, py, isTeammate ? 4.2 : 3.6, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = "#f0b429";
    g.beginPath();
    g.moveTo(cx, cy - 6);
    g.lineTo(cx - 4.5, cy + 4.5);
    g.lineTo(cx + 4.5, cy + 4.5);
    g.closePath();
    g.fill();
  }

  function isControlActive() {
    return input.active || testLocked;
  }

  function stepPhysicsFixed(dtFixed, nowMs) {
    const canAct = engineMode === "solo" || (meAlive && activeState === "play");
    const { cfg, st } = activeWeapon();

    if (st.reloadEndsAt > 0 && nowMs >= st.reloadEndsAt) {
      st.mag = cfg.magSize;
      st.reloadEndsAt = 0;
      hud();
    }

    if (!canAct) {
      curFlags = 0;
      return;
    }

    const activeInput = isControlActive();
    const f = activeInput && !chatOpen ? ((input.isDown("forward") ? 1 : 0) - (input.isDown("back") ? 1 : 0)) : 0;
    const s = activeInput && !chatOpen ? ((input.isDown("right") ? 1 : 0) - (input.isDown("left") ? 1 : 0)) : 0;
    const hasMove = f !== 0 || s !== 0;

    const rawShift = activeInput && !chatOpen && input.isDown("sprint");
    if (!rawShift) sprintBrokenUntilShiftUp = false;

    const wantsCrouchRaw = activeInput && !chatOpen && input.isCrouchActive();
    if (wantsCrouchRaw) {
      crouched = true;
      sprintBrokenUntilShiftUp = true;
    } else if (crouched && canStandUp()) {
      crouched = false;
    }

    const wantsAds = (testAimHeld || (activeInput && !chatOpen && input.isAdsActive())) && st.reloadEndsAt <= nowMs;
    if (wantsAds && rawShift) sprintBrokenUntilShiftUp = true;
    if ((input.fireJustPressed || input.fireHeld) && rawShift && isSprinting) {
      sprintBrokenUntilShiftUp = true;
    }

    isSprinting = rawShift && !sprintBrokenUntilShiftUp && !crouched && grounded && !onLadder && hasMove;
    if (isSprinting) {
      input.clearAds();
      testAimHeld = false;
    }

    const isReloading = st.reloadEndsAt > nowMs;
    const effectiveAds = (testAimHeld || (activeInput && input.isAdsActive())) && !isReloading && !isSprinting;

    curFlags =
      (crouched ? FLAG.CROUCH : 0) |
      (effectiveAds ? FLAG.ADS : 0) |
      (isSprinting ? FLAG.SPRINT : 0) |
      (!grounded ? FLAG.AIR : 0) |
      (input.fireHeld ? FLAG.FIRING : 0) |
      (isReloading ? FLAG.RELOADING : 0);

    if (grounded) lastGroundedAt = nowMs;
    if (activeInput && !chatOpen && input.wasHit("jump")) {
      jumpBufferedUntil = nowMs + JUMP_BUFFER_MS;
    }
    if (
      nowMs <= jumpBufferedUntil &&
      (grounded || nowMs <= lastGroundedAt + COYOTE_TIME_MS) &&
      nowMs >= nextJumpAllowedAt
    ) {
      vy = 7.5;
      grounded = false;
      jumpBufferedUntil = 0;
      nextJumpAllowedAt = nowMs + JUMP_COOLDOWN_MS;
    }

    const speed = BASE_MOVE_SPEED * getMoveSpeedMultiplier(curFlags);
    let targetVx = 0, targetVz = 0;
    if (hasMove) {
      const l = Math.hypot(f, s) || 1;
      const sn = Math.sin(yaw), cs = Math.cos(yaw);
      targetVx = ((-sn * f + cs * s) / l) * speed;
      targetVz = ((-cs * f - sn * s) / l) * speed;
    }
    const accelFactor = grounded ? Math.min(1, 22 * dtFixed) : 0.25 * Math.min(1, 10 * dtFixed);
    velX = lerp(velX, targetVx, accelFactor);
    velZ = lerp(velZ, targetVz, accelFactor);

    P.x += velX * dtFixed;
    P.z += velZ * dtFixed;
    if (activeCollision) {
      const mState = { x: P.x, y: P.y, z: P.z, vy, grounded, onLadder };
      activeCollision.stepPlayerMovement(
        mState,
        {
          moveForward: f,
          jumpHeld: activeInput && !chatOpen && input.isDown("jump"),
          crouched,
          radius: 0.45,
        },
        dtFixed,
      );
      P.set(mState.x, mState.y, mState.z);
      vy = mState.vy;
      grounded = mState.grounded;
      onLadder = mState.onLadder;
    } else {
      vy -= 22 * dtFixed;
      P.y += vy * dtFixed;
      if (P.y <= 0) {
        P.y = 0;
        vy = 0;
        grounded = true;
      } else {
        grounded = false;
      }

      for (const c of cols) {
        const dx = P.x - Math.max(c.x0, Math.min(P.x, c.x1)), dz = P.z - Math.max(c.z0, Math.min(P.z, c.z1));
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.2025 && P.y < c.y1) {
          const d = Math.sqrt(d2) || 0.001;
          P.x += (dx / d) * (0.45 - d);
          P.z += (dz / d) * (0.45 - d);
        }
      }
      P.x = Math.max(-48, Math.min(48, P.x));
      P.z = Math.max(-48, Math.min(48, P.z));
    }
    if (hasMove && grounded) {
      bob += speed * dtFixed;
      const stepIdx = Math.floor(bob / 1.55);
      if (stepIdx !== lastStepIdx) {
        lastStepIdx = stepIdx;
        if (activeState === "play") {
          let surface = "concrete";
          if (onLadder || P.y > 2.5) surface = "metal";
          else if (activeMapId === "harbor") surface = "puddle";
          else if (militaryData && militaryData.samplePuddle && militaryData.samplePuddle(P.x, P.z) > 0.35) {
            surface = "puddle";
          }
          snd.footstep(surface);
        }
      }
    }

    const targetEye = crouched ? EYE_CROUCH : EYE_STAND;
    eyeHeight += (targetEye - eyeHeight) * Math.min(1, 18 * dtFixed);
  }

  function updateGameplay(dt) {
    const nowMs = performance.now();
    const canAct = engineMode === "solo" || (meAlive && activeState === "play");

    if (isControlActive() && !chatOpen) {
      const { dx, dy } = input.consumeMouseDelta();
      const sCfg = settings ? settings.get() : { sens: 1, adsSens: 0.58, invertY: false };
      const sens = 0.0022 * sCfg.sens * lerp(1.0, sCfg.adsSens, ads);
      yaw -= dx * sens;
      const ySign = sCfg.invertY ? -1 : 1;
      pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * sens * ySign));
    }

    if (canAct && isControlActive() && !chatOpen) {
      if (input.wasHit("slot1")) switchWeapon(1);
      else if (input.wasHit("slot2")) switchWeapon(2);
      else if (input.wasHit("slot3")) switchWeapon(3);
      else if (input.wasHit("switchPrev")) switchWeapon(prevSlot);

      const wDir = input.consumeWheel();
      if (wDir !== 0) {
        const nextIdx = (WEAPON_SLOTS.indexOf(activeSlot) + (wDir > 0 ? 1 : -1) + WEAPON_SLOTS.length) % WEAPON_SLOTS.length;
        switchWeapon(WEAPON_SLOTS[nextIdx]);
      }

      if (input.wasHit("reload")) reload();
      if (input.wasHit("laser")) { laserOn = !laserOn; snd.click(1800); }
      if (engineMode === "lan" && input.wasHit("chat")) {
        chatOpen = true;
        input.setTextFocusBlocked(true);
        if (document.pointerLockElement === R.domElement) document.exitPointerLock();
        $("hudChatInput").style.display = "block";
        $("hudChatInput").focus();
      }
    }

    if (engineMode === "lan" && activeState === "play" && isControlActive() && !chatOpen) {
      const showSb = input.isDown("score");
      $("scoreboard").style.display = showSb ? "block" : "none";
      if (showSb) renderScoreboardTable();
    } else {
      $("scoreboard").style.display = "none";
    }

    physicsAccum = Math.min(0.1, physicsAccum + dt);
    while (physicsAccum >= FIXED_DT) {
      stepPhysicsFixed(FIXED_DT, nowMs);
      physicsAccum -= FIXED_DT;
    }

    if (canAct && isControlActive() && !chatOpen) {
      const { cfg } = activeWeapon();
      const wantsFire = cfg.auto ? input.fireHeld : input.fireJustPressed;
      if (wantsFire && !isSprinting) shoot();
    }

    input.endFrame();

    recoil *= 1 - 12 * dt;
    kick = Math.max(0, kick - dt * 0.12);
    flash -= dt;
    const isPistolActive = SLOT_TO_WEAPON_ID[activeSlot] === "pistol";
    mf.visible = flash > 0 && !isPistolActive;
    pistolMuzzleFlash.visible = flash > 0 && isPistolActive;
    pistolFlashMat.opacity = flash > 0 && isPistolActive ? 0.92 : 0;
    flashL.intensity = flash > 0 ? (isPistolActive ? 8.5 : 5) : 0;

    const mvRatio = Math.hypot(velX, velZ) > 0.25 ? 1 : 0;
    const scopedSniper = activeWeapon().cfg.scopeOverlay && ads > 0.72;
    gun.visible = canAct && !scopedSniper;
    if (armsRoot) armsRoot.visible = canAct && !scopedSniper;

    shake = Math.max(0, shake - dt);
    const sk = shake * 0.05;
    cam.position.set(
      P.x + rnd(-sk, sk),
      P.y + (canAct ? eyeHeight : 0.75) + (mvRatio && grounded ? Math.sin(bob * 2) * 0.035 * (1 - 0.7 * ads) : 0),
      P.z,
    );
    cam.rotation.set(pitch + kick + rnd(-sk, sk), yaw, 0);
    gunAnim(dt, canAct ? mvRatio : 0);

    if (engineMode === "lan" && canAct && activeState === "play") {
      if (nowMs - lastInputSentAt >= 50) {
        lastInputSentAt = nowMs;
        net.send(MSG.STATE, {
          pos: { x: P.x, y: P.y, z: P.z },
          yaw,
          pitch,
          flags: curFlags,
          anim: { mv: mvRatio ? (isSprinting ? 1.4 : crouched ? 0.65 : 1) : 0, laser: laserOn },
        });
      }
    }

    if (engineMode === "solo" && activeState === "play") {
      if (drones.length === 0) {
        soloWaveCd -= dt;
        if (soloWaveCd <= 0) { soloWave++; for (let i = 0; i < 2 + soloWave; i++) spawnDrone(); soloWaveCd = 3; hud(); }
      }
      drones.slice().forEach((d) => updDrone(d, dt));
    }

    if (hm > 0) {
      hm = Math.max(0, hm - dt * 5);
      $("hm").style.opacity = hm;
    }
    if (dmgV > 0) {
      dmgV = Math.max(0, dmgV - dt * 1.6);
      $("dmg").style.opacity = dmgV;
    }
    if (killAlertT > 0) { killAlertT -= dt; if (killAlertT <= 0) $("killAlert").style.opacity = "0"; }

    updateCanvasPostGrade(gt);
    if (meAlive && hp <= 30 && activeState === "play") {
      nextHeartbeatAt -= dt;
      if (nextHeartbeatAt <= 0) {
        const distress = Math.max(0, Math.min(1, (32 - hp) / 22));
        snd.heartbeat(0.45 + 0.55 * distress);
        nextHeartbeatAt = 0.98 - 0.34 * distress;
      }
    } else {
      nextHeartbeatAt = 0.15;
    }

    updateRadarAndCrosshair(nowMs);
    hud();
  }

  R.autoClear = false;
  R.shadowMap.autoUpdate = false;
  function renderFrame() {
    if (activeQuality.preset.shadowsEnabled) {
      shadowFrameTick++;
      const hasDynamicCasters = drones.length > 0 || remotePlayers.size > 0;
      if (shadowDirty || (hasDynamicCasters && shadowFrameTick >= activeQuality.preset.shadowUpdateInterval)) {
        R.shadowMap.needsUpdate = true;
        shadowDirty = false;
        shadowFrameTick = 0;
      }
    }
    cam.layers.set(0);
    R.clear();
    R.render(S, cam);
    if (engineMode !== "idle") {
      const bg = S.background;
      S.background = null;
      R.clearDepth();
      vmCam.layers.set(VIEW_LAYER);
      R.render(S, vmCam);
      S.background = bg;
    }
  }

  (function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (activeState === "play") updateGameplay(dt);
    if (engineMode === "lan") updateRemotePlayers(dt);
    tr.forEach((l) => { l.userData.t -= dt; l.material.opacity = Math.max(0, l.userData.t / 0.09); });
    updateWeatherAndRain(dt);
    cam.updateMatrixWorld(true);
    vmCam.position.copy(cam.position);
    vmCam.quaternion.copy(cam.quaternion);
    vmCam.updateMatrixWorld(true);
    laserBeam.visible = laserLens.visible =
      laserOn && engineMode !== "idle" && meAlive && SLOT_TO_WEAPON_ID[activeSlot] === "m416";
    if (laserBeam.visible) {
      getViewmodelWorldPoint(laserOrigin, _lp);
      _ld.set(0, 0, -1).transformDirection(gun.matrixWorld);
      _ls.copy(_lp).addScaledVector(_ld, -0.9);
      let hit = null;
      if (activeCollision) {
        const wh = activeCollision.raycastShot(_ls.x, _ls.y, _ls.z, _ld.x, _ld.y, _ld.z, 81);
        if (wh) hit = { distance: wh.dist, point: new Vec(wh.x, wh.y, wh.z) };
      } else {
        laserRay.set(_ls, _ld);
        laserRay.far = 81;
        hit = laserRay.intersectObjects([ground, ...solid], false)[0] || null;
      }
      const end = hit ? hit.point : _lp.clone().addScaledVector(_ld, 80);
      const bp = laserBeam.geometry.attributes.position;
      laserBeam.visible = !(hit && hit.distance < 0.9);
      bp.setXYZ(0, _lp.x, _lp.y, _lp.z);
      bp.setXYZ(1, end.x, end.y, end.z);
      bp.needsUpdate = true;
      laserDot.visible = !!hit;
      if (hit) { laserDot.position.copy(hit.point).addScaledVector(_ld, -0.02); laserDot.scale.setScalar(0.05 + hit.distance * 0.004); }
    } else {
      laserDot.visible = false;
    }
    renderFrame();
  })();

  function startLanMatch(room, initialSnapshot) {
    initAudio();
    ensureMapActive(room && room.map ? room.map : "military");
    drones.splice(0).forEach((d) => S.remove(d.g));
    clearRemotePlayers();
    engineMode = "lan";
    activeState = "play";
    currentMode = room.mode;
    killLimit = room.killLimit;
    hp = 100;
    meAlive = true;
    activeSlot = 1;
    prevSlot = 2;
    resetAllWeapons();
    applyViewmodelWeapon("m416");
    crouched = false;
    grounded = true;
    onLadder = false;
    eyeHeight = EYE_STAND;
    velX = velZ = vy = ads = bolt = rlp = trigPull = 0;
    chatOpen = testAimHeld = isSprinting = false;
    input.reset();
    $("hudChatInput").style.display = "none";
    $("sniperScope").style.display = "none";
    $("hud").style.display = "block";
    $("pauseOverlay").style.display = "none";

    if (initialSnapshot) {
      const meSnap = initialSnapshot.players.find((p) => p.id === net.playerId);
      if (meSnap) {
        P.set(meSnap.x, meSnap.y, meSnap.z);
        yaw = meSnap.yaw;
        pitch = 0;
        meTeam = meSnap.team || "FFA";
        meAlive = meSnap.alive;
        meInvuln = meSnap.invulnerable;
      }
      applySnapshot(initialSnapshot);
    }
    gunAnim(0, 0);
    hud();
    input.tryLock();
    setTimeout(() => {
      if (engineMode === "lan" && activeState === "play" && !isControlActive() && !chatOpen) {
        onPointerLockFailed();
      }
    }, 90);
  }

  function startSolo(mapId = activeMapId || initialDefaultMap) {
    initAudio();
    ensureMapActive(mapId);
    clearRemotePlayers();
    drones.splice(0).forEach((d) => S.remove(d.g));
    engineMode = "solo";
    activeState = "play";
    hp = 100;
    soloScore = 0; soloWave = 0; soloWaveCd = 1.0;
    meAlive = true; meInvuln = false;
    activeSlot = 1;
    prevSlot = 2;
    resetAllWeapons();
    applyViewmodelWeapon("m416");
    if (mapId === "military") {
      P.set(0, 0, -40);
      yaw = Math.PI;
    } else {
      P.set(0, 0, 0);
      yaw = 0;
    }
    pitch = vy = velX = velZ = ads = bolt = rlp = trigPull = 0;
    crouched = false; grounded = true; onLadder = false; eyeHeight = EYE_STAND;
    chatOpen = testAimHeld = isSprinting = false;
    input.reset();
    $("sniperScope").style.display = "none";
    $("hud").style.display = "block";
    $("pauseOverlay").style.display = "none";
    gunAnim(0, 0);
    hud();
    input.tryLock();
  }

  function stopEngine() {
    activeState = "menu";
    engineMode = "idle";
    chatOpen = testAimHeld = testLocked = false;
    input.setTextFocusBlocked(false);
    input.reset();
    $("hud").style.display = "none";
    $("sniperScope").style.display = "none";
    $("scoreboard").style.display = "none";
    $("pauseOverlay").style.display = "none";
    $("hudChatInput").style.display = "none";
    updateCanvasPostGrade(gt);
    if (document.pointerLockElement === R.domElement) document.exitPointerLock();
    clearRemotePlayers();
    drones.splice(0).forEach((d) => S.remove(d.g));
  }

  window.__fpsReady = true;
  return {
    startLanMatch,
    startSolo,
    stopEngine,
    applySnapshot,
    shoot,
    reload,
    switchWeapon,
    gunAnim,
    renderFrame,
    onPointerLockChanged,
    onPointerUnlocked,
    onPointerLockFailed,
    getState: () => ({
      engineMode,
      activeState,
      P,
      getYaw: () => yaw,
      setPose: (nx, ny, nz, nyaw, npitch) => {
        P.set(nx, ny, nz);
        yaw = nyaw;
        pitch = npitch;
        cam.position.set(nx, ny + eyeHeight, nz);
        cam.rotation.set(npitch, nyaw, 0);
        cam.updateMatrixWorld(true);
        vmCam.position.copy(cam.position);
        vmCam.quaternion.copy(cam.quaternion);
        vmCam.updateMatrixWorld(true);
        if (activeMapId === "military" && militaryData && militaryData.updateAtmosphere) {
          militaryData.updateAtmosphere(gt, cam.position, activeQuality.preset);
        }
        shadowDirty = true;
      },
      getGraphicsQuality: () => ({
        choice: activeQuality.choice,
        detectedTier: activeQuality.detectedTier,
        effectiveTier: activeQuality.effectiveTier,
        preset: activeQuality.preset,
        hwInfo,
        pixelRatio: R.getPixelRatio(),
        cameraFar: cam.far,
        shadowMapEnabled: R.shadowMap.enabled,
        mapQualityStats: militaryData && militaryData.getQualityStats ? militaryData.getQualityStats() : null,
      }),
      setGraphicsQuality: (choice) => {
        if (settings && typeof settings.update === "function") settings.update({ graphicsQuality: choice });
        else applyGraphicsQuality(choice);
        return activeQuality;
      },
      getViewmodelState: () => {
        let skinningEnabled = false;
        if (armsRoot) {
          armsRoot.traverse((o) => {
            if (o.isSkinnedMesh && o.material && o.material.skinning) skinningEnabled = true;
          });
        }
        return {
          vmFov: vmCam.fov,
          vmNear: vmCam.near,
          worldFov: cam.fov,
          armsReady: Boolean(armsCtrl && armsCtrl.ready),
          armsVisible: Boolean(armsRoot && armsRoot.visible),
          skinningEnabled,
          gunPos: { x: gun.position.x, y: gun.position.y, z: gun.position.z },
          gunRot: { x: gun.rotation.x, y: gun.rotation.y, z: gun.rotation.z },
        };
      },
      setTestCombat: (opts = {}) => {
        if (typeof opts.locked === "boolean") {
          testLocked = opts.locked;
          input.active = opts.locked;
        }
        if (typeof opts.aimHeld === "boolean") testAimHeld = opts.aimHeld;
        if (typeof opts.crouched === "boolean") {
          crouched = opts.crouched;
          eyeHeight = opts.crouched ? EYE_CROUCH : EYE_STAND;
        }
        if (typeof opts.hp === "number" && Number.isFinite(opts.hp)) {
          hp = Math.max(1, Math.min(100, opts.hp));
          hud();
          updateCanvasPostGrade(gt);
        }
        if (opts.adsSteps) for (let i = 0; i < opts.adsSteps; i++) gunAnim(0.02, 0);
      },
      getRemotePlayers: () => remotePlayers,
      getWeapons: () => ({ activeSlot, activeWeaponId: SLOT_TO_WEAPON_ID[activeSlot], weapons }),
      getTeamMaterials: () => teamAccentMats,
      getMapInfo: () => ({
        mapId: activeMapId,
        ready: activeMapId === "harbor" || Boolean(militaryData),
        onLadder,
        bounds: activeCollision ? activeCollision.bounds : { minX: -48, maxX: 48, minZ: -48, maxZ: 48 },
        raycastShot: activeCollision ? activeCollision.raycastShot : null,
      }),
      getMe: () => ({
        meAlive, meTeam, hp,
        ammo: activeWeapon().st.mag,
        reloading: activeWeapon().st.reloadEndsAt > performance.now(),
        crouched, grounded, onLadder, isSprinting, ads, flags: curFlags, eyeHeight,
      }),
    }),
  };
}
