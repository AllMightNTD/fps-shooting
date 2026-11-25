/**
 * Three.js Rainy Harbor FPS Engine (Truy Kích LAN PvP + Offline Solo Drone):
 * - Shared weapons.js state machine (M416, Glock-17 Pistol, AWM Sniper; infinite reserve)
 * - 3-layer Input (BIND, e.code, Hold/Toggle, key rebind, Alt+Tab safety) & 60Hz fixed physics
 * - Crouch (ceiling raycast + lowered capsule), Jump buffer/coyote/anti-bhop, Sprint/Reload/ADS rules
 * - TeamColor shared PBR materials (A=#2F80FF ▲, B=#FF4D2E ●, FFA=#8A8F98), teammate nameplates & Radar
 */

import { MSG, sanitizeText } from "/js/protocol.js";
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

  // ---------- Renderer, scene, camera ----------
  const R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(devicePixelRatio, 2));
  R.setSize(innerWidth, innerHeight);
  R.shadowMap.enabled = true;
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = 1.08;
  document.body.prepend(R.domElement);

  const S = new THREE.Scene();
  S.background = new THREE.Color(0x070d14);
  S.fog = new THREE.FogExp2(0x070d14, 0.03);

  const cam = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, 200);
  cam.rotation.order = "YXZ";
  S.add(cam);
  addEventListener("resize", () => {
    R.setSize(innerWidth, innerHeight);
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
  });

  // ---------- Lights & Lamp halos ----------
  const hemi = new THREE.HemisphereLight(0x4d7094, 0x0b1016, 0.55);
  S.add(hemi);
  const moon = new THREE.DirectionalLight(0x88b0d8, 0.55);
  moon.position.set(-30, 50, 20);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  Object.assign(moon.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, far: 140 });
  S.add(moon);

  const lampHaloTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(220,235,255,.95)");
    gr.addColorStop(0.18, "rgba(170,205,240,.42)");
    gr.addColorStop(0.55, "rgba(110,145,180,.10)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();

  const lamps = [];
  for (const [x, z] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]]) {
    const L = new THREE.PointLight(0xcfe4ff, 2.1, 36, 1.45);
    L.position.set(x, 6.2, z);
    S.add(L);
    lamps.push(L);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 6.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x1b2128, metalness: 0.6, roughness: 0.5 }),
    );
    pole.position.set(x, 3.1, z);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xe8f3ff }),
    );
    bulb.position.set(x, 6.2, z);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: lampHaloTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }),
    );
    halo.position.set(x, 6.2, z);
    halo.scale.set(7.5, 7.5, 1);
    S.add(pole, bulb, halo);
  }

  function tex(w, h, fn, rep) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    fn(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (rep) t.repeat.set(rep, rep);
    t.anisotropy = 4;
    return t;
  }

  // ---------- Wet asphalt harbor floor + deterministic container layout ----------
  const puddleGrid = new Float32Array(256 * 256);
  const gtex = tex(256, 256, (g, w, h) => {
    g.fillStyle = "#10151b";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7000; i++) {
      const v = (11 + sr() * 18) | 0;
      g.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
      g.fillRect(sr() * w, sr() * h, 1.5, 1.5);
    }
    for (let i = 0; i < 18; i++) {
      const px = sr() * w, py = sr() * h, rx = 24 + sr() * 46, ry = 14 + sr() * 30;
      const gr = g.createRadialGradient(px, py, 4, px, py, rx);
      gr.addColorStop(0, "rgba(4,7,11,.68)");
      gr.addColorStop(0.55, "rgba(7,12,18,.30)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(px, py, rx, ry, sr() * 3, 0, 7);
      g.fill();
    }
    const im = g.getImageData(0, 0, w, h).data;
    for (let i = 0; i < puddleGrid.length; i++) {
      puddleGrid[i] = Math.max(0, Math.min(1, (22 - im[i * 4]) / 14));
    }
  }, 14);

  const gNormTex = tex(256, 256, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    for (let i = 0; i < puddleGrid.length; i++) {
      const wet = puddleGrid[i];
      d[i * 4] = wet > 0.45 ? 128 : 120 + ((sr() * 16) | 0);
      d[i * 4 + 1] = wet > 0.45 ? 128 : 120 + ((sr() * 16) | 0);
      d[i * 4 + 2] = 255;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }, 14);

  const gRoughTex = tex(256, 256, (g, w, h) => {
    const im = g.createImageData(w, h), d = im.data;
    for (let i = 0; i < puddleGrid.length; i++) {
      const r = Math.round((0.78 - puddleGrid[i] * 0.7) * 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = r;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }, 14);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(130, 130),
    new THREE.MeshStandardMaterial({
      map: gtex,
      normalMap: gNormTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: gRoughTex,
      roughness: 1,
      metalness: 0.26,
      envMapIntensity: 0.95,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  S.add(ground);

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
      const gr = g.createLinearGradient(0, h, 0, h * 0.55);
      gr.addColorStop(0, "rgba(35,25,15,.6)");
      gr.addColorStop(1, "rgba(35,25,15,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
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
    });
  }

  const cMats = [0x8c3a2b, 0x2c5878, 0x3b6a4a, 0xb08428, 0x6a7077, 0x6e3f55].map((c) => {
    const col = "#" + c.toString(16).padStart(6, "0");
    const mk = (k) => {
      const t = cTex(col, k);
      return new THREE.MeshStandardMaterial({
        map: t,
        bumpMap: t,
        bumpScale: 1.4,
        roughness: 0.62,
        metalness: 0.35,
      });
    };
    const side = mk(0);
    return [mk(1), mk(2), mk(3), new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.9 }), side, side];
  });

  const cGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
  let mapSeed = 11042026;
  const msr = () => (mapSeed = (mapSeed * 16807) % 2147483647) / 2147483647;
  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      if ((gx === 0 && gz === 0) || msr() < 0.42) continue;
      const x = gx * 13 + (msr() - 0.5) * 3;
      const z = gz * 13 + (msr() - 0.5) * 3;
      const rot = msr() < 0.5;
      const mat = cMats[(msr() * cMats.length) | 0];
      const stacked = msr() < 0.3;
      const m = new THREE.Mesh(cGeo, mat);
      m.position.set(x, 1.3, z);
      m.rotation.y = rot ? Math.PI / 2 : 0;
      m.castShadow = m.receiveShadow = true;
      S.add(m);
      solid.push(m);
      if (stacked) {
        const t = m.clone();
        t.position.y = 3.9;
        S.add(t);
        solid.push(t);
      }
      const hx = rot ? 1.22 : 3.05, hz = rot ? 3.05 : 1.22;
      cols.push({ x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz, y1: stacked ? 5.2 : 2.6 });
    }
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2128, roughness: 0.9 });
  for (const [x, z, w, d] of [[0, -52, 100, 1], [0, 52, 100, 1], [-52, 0, 1, 100], [52, 0, 1, 100]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 10, d), wallMat);
    m.position.set(x, 5, z);
    S.add(m);
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
    panel(2.2, 2.8, 3.6, 14, 5, 0, 15, -4);
    for (const [x, y, z] of [[-10, 6, -9], [10, 6, -9], [-9, 5, 10], [11, 5, 9], [0, 14, -11]]) {
      panel(7.5, 8.5, 10, 1.6, 1.6, x, y, z);
    }
    const pm = new THREE.PMREMGenerator(R), rt = pm.fromScene(es, 0.025);
    pm.dispose();
    return rt.texture;
  })();
  ground.material.envMap = envMap;
  ground.material.needsUpdate = true;

  const mistTex = tex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, "rgba(170,200,225,.35)");
    gr.addColorStop(0.5, "rgba(120,155,185,.12)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  for (const [x, y, z] of [[-7, 1.8, -14], [8, 1.9, -18], [0, 2.1, -24], [-15, 2.0, -22], [14, 1.8, -12]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.42, depthWrite: false }));
    sp.position.set(x, y, z);
    sp.scale.set(16, 6, 1);
    S.add(sp);
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
  const splash = mkPS(240, 0xcfe6f5, 0.045);

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
    const b = rd[i * 4 + 3] * 0.5;
    rc2.set([0, 0, 0, b * 0.55, b * 0.68, b * 0.82], i * 6);
  }
  const rg2 = new THREE.BufferGeometry();
  rg2.setAttribute("position", new THREE.BufferAttribute(rp2, 3));
  rg2.setAttribute("color", new THREE.BufferAttribute(rc2, 3));
  const rain2 = new THREE.LineSegments(rg2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  rain2.frustumCulled = false;
  S.add(rain2);

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
  function initAudio() {
    if (AC) { AC.resume().catch(() => {}); return; }
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
      const f = AC.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 420;
      const gg = AC.createGain();
      gg.gain.value = 0.09;
      r.connect(f).connect(gg).connect(AC.destination);
      r.start();
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

  const vmKey = new THREE.PointLight(0xd8e8ff, 0.72, 2.4, 1.1);
  vmKey.position.set(-0.35, 0.55, 0.25);
  const vmFill = new THREE.PointLight(0xffa658, 0.34, 2.0, 1.2);
  vmFill.position.set(0.45, -0.2, -0.1);
  cam.add(vmKey, vmFill, gun);

  function decodeBase64ToArrayBuffer(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function hydratePbrMaterial(src, objName = "", envScale = 1.45) {
    const phys = (src.userData && src.userData.pbrPhysical) || {};
    if (phys.unlit) {
      const col = src.emissive && src.emissive.getHex() ? src.emissive : src.color;
      const isOverlayReticle = objName === "reticle_group";
      return new THREE.MeshBasicMaterial({
        color: col,
        side: src.side,
        fog: false,
        toneMapped: false,
        depthWrite: !isOverlayReticle,
      });
    }
    const isGlass = phys.transmission > 0 || src.transparent;
    const isSkin = src.name === "Arms_WetSkin" || src.name === "Soldier_Skin";
    const isGlove = src.name === "Arms_TacticalGlove" || src.name === "Soldier_Glove";
    const mat = new THREE.MeshPhysicalMaterial({
      color: src.color,
      map: src.map || null,
      metalness: src.metalness,
      roughness: src.roughness,
      roughnessMap: src.roughnessMap || null,
      metalnessMap: src.metalnessMap || null,
      normalMap: src.normalMap || null,
      normalScale: src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1),
      envMap,
      envMapIntensity: isGlass ? 1.8 : isSkin ? 0.45 : isGlove ? 0.55 : envScale,
      clearcoat: phys.clearcoat || 0,
      clearcoatRoughness: phys.clearcoatRoughness || 0,
      transparent: isGlass,
      opacity: isGlass ? 0.26 : 1,
      depthWrite: !isGlass,
      side: src.side,
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
  let m416WorldProto = null, pistolWorldProto = null, soldierProto = null;
  const pistolMuzAnchorPos = new Vec(0, 0.0495, -0.172);
  let pistolSlideOffset = 0, pistolRecoilPitch = 0, pistolRecoilKickZ = 0, pistolTrigPull = 0;

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
  const sniperChassis = new THREE.Mesh(
    new THREE.BoxGeometry(0.048, 0.072, 0.56),
    new THREE.MeshStandardMaterial({ color: 0x2f3b2c, metalness: 0.18, roughness: 0.72 }),
  );
  sniperChassis.position.set(0, 0.01, -0.22);
  const sniperBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.018, 0.72, 12),
    new THREE.MeshStandardMaterial({ color: 0x1b2026, metalness: 0.82, roughness: 0.28 }),
  );
  sniperBarrel.rotation.x = Math.PI / 2;
  sniperBarrel.position.set(0, 0.026, -0.68);
  const sniperScopeTube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.024, 0.024, 0.34, 14),
    new THREE.MeshStandardMaterial({ color: 0x14181d, metalness: 0.78, roughness: 0.3 }),
  );
  sniperScopeTube.rotation.x = Math.PI / 2;
  sniperScopeTube.position.set(0, 0.088, -0.21);
  const sniperMagMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.085, 0.095),
    new THREE.MeshStandardMaterial({ color: 0x20252a, metalness: 0.65, roughness: 0.35 }),
  );
  sniperMagMesh.position.set(0, -0.045, -0.18);
  sniperViewGroup.add(sniperChassis, sniperBarrel, sniperScopeTube, sniperMagMesh);
  sniperViewGroup.traverse((o) => o.layers.set(VIEW_LAYER));
  sniperViewGroup.visible = false;

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
      muz.position.set(0, 0.026, -1.04);
      mf.position.set(0, 0.026, -1.04);
      flashL.position.set(0, 0.026, -1.1);
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

  const _euPose = new THREE.Euler(0, 0, 0, "XYZ");
  const makePose = (p, r) => ({ p: new Vec(...p), q: new THREE.Quaternion().setFromEuler(_euPose.set(r[0], r[1], r[2])) });
  const makeBasisPose = (p, yDir, zDir) => {
    const yV = new Vec(...yDir).normalize();
    const zV = new Vec(...zDir);
    zV.addScaledVector(yV, -zV.dot(yV)).normalize();
    const xV = new Vec().crossVectors(yV, zV).normalize();
    const m4 = new THREE.Matrix4().makeBasis(xV, yV, zV);
    return { p: new Vec(...p), q: new THREE.Quaternion().setFromRotationMatrix(m4) };
  };
  const CH_REST_Z = 0.118, MAG_REST = new Vec(0, -0.042, -0.064);
  const LEFT_ELBOW = new Vec(-0.3, -0.3, 0.22), RIGHT_ELBOW = new Vec(0.17, -0.28, 0.48);
  const leftWristLocal = new Vec(0, 0.042, 0), rightWristLocal = new Vec(0.008, -0.036, 0.024);
  let INDEX_BASE_ROT_X = -Math.PI * 0.5 + 0.1;
  const POSE = {
    grip: makePose([-0.042, -0.022, -0.236], [-0.4, 0.9, -2.0]),
    mag: makePose([-0.044, -0.118, -0.078], [-0.4, 0.8, -1.6]),
    out: makePose([-0.088, -0.182, -0.042], [-0.4, 0.8, -1.6]),
    ch: makePose([-0.064, 0.032, 0.122], [-0.3, 0.6, -1.5]),
    chPulled: makePose([-0.064, 0.032, 0.177], [-0.3, 0.6, -1.5]),
    rightGrip: makePose([0.012, -0.07, 0.068], [0.34, 0.1, 0.14]),
  };
  // Two-handed thumbs-forward Tactical Pistol poses tailored to the 18-deg Glock Gen4/Gen5 frame
  const PISTOL_POSE = {
    grip: makeBasisPose([-0.024, -0.048, 0.018], [-0.56, -0.28, 0.78], [-0.78, 0.36, -0.51]),
    mag: makeBasisPose([-0.026, -0.068, 0.036], [-0.76, -0.22, 0.61], [-0.56, 0.35, -0.75]),
    out: makeBasisPose([-0.052, -0.198, 0.078], [-0.76, -0.22, 0.61], [-0.56, 0.35, -0.75]),
    ch: makeBasisPose([-0.024, 0.052, 0.014], [-0.80, -0.44, 0.40], [-0.28, 0.76, 0.58]),
    chPulled: makeBasisPose([-0.024, 0.052, 0.057], [-0.80, -0.44, 0.40], [-0.28, 0.76, 0.58]),
    rightGrip: makePose([0.008, -0.036, 0.038], [0.31, 0.05, 0.10]),
  };
  let leftHand = new THREE.Group(), rightHand = new THREE.Group(), leftArmRig = new THREE.Group(), rightArmRig = new THREE.Group();
  let leftForearmMesh = new THREE.Object3D(), rightForearmMesh = new THREE.Object3D(), leftWatch = null, indexJoint = new THREE.Group();

  loadModelAsset("m416", "/model/dist/m416.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      if (!matCache.has(obj.material)) matCache.set(obj.material, hydratePbrMaterial(obj.material, obj.name, 1.55));
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
    const muzNode = root.getObjectByName("muzzle_anchor"), lasNode = root.getObjectByName("laser_origin");
    if (muzNode && SLOT_TO_WEAPON_ID[activeSlot] === "m416") muz.position.copy(muzNode.position);
    if (lasNode) laserOrigin.position.copy(lasNode.position);
    m416ViewGroup.add(root);
    applyViewmodelWeapon(SLOT_TO_WEAPON_ID[activeSlot] || "m416");
    upgradeRemoteWeapons();
    window.__m416Loaded = true;
  });

  loadModelAsset("pistol", "/model/dist/pistol.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 1.62));
      obj.material = matCache.get(ck);
    });
    pistolWorldProto = root.clone();
    pistolSlideNode = root.getObjectByName("pistol_slide") || pistolSlideNode;
    pistolTriggerNode = root.getObjectByName("pistol_trigger") || pistolTriggerNode;
    pistolMagNode = root.getObjectByName("pistol_mag") || pistolMagNode;
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

  loadModelAsset("fps_arms", "/model/dist/fps_arms.glb", (gltf) => {
    const root = gltf.scene, matCache = new Map();
    root.traverse((obj) => {
      obj.layers.set(VIEW_LAYER);
      if (!obj.isMesh) return;
      obj.castShadow = obj.receiveShadow = true;
      const ck = `${obj.material.uuid}:${obj.name === "watch_dial" ? 1 : 0}`;
      if (!matCache.has(ck)) matCache.set(ck, hydratePbrMaterial(obj.material, obj.name, 1.15));
      obj.material = matCache.get(ck);
    });
    const meta = (root.getObjectByName("arms_root") || root).userData || {};
    if (Array.isArray(meta.leftElbow)) LEFT_ELBOW.set(...meta.leftElbow);
    if (Array.isArray(meta.rightElbow)) RIGHT_ELBOW.set(...meta.rightElbow);
    if (Array.isArray(meta.leftWristLocal)) leftWristLocal.set(...meta.leftWristLocal);
    if (Array.isArray(meta.rightWristLocal)) rightWristLocal.set(...meta.rightWristLocal);
    if (typeof meta.indexBaseRotX === "number") INDEX_BASE_ROT_X = meta.indexBaseRotX;
    if (meta.poses) {
      for (const [k, v] of Object.entries(meta.poses)) {
        if (v && Array.isArray(v.p) && Array.isArray(v.r)) POSE[k] = makePose(v.p, v.r);
      }
    }
    leftHand = root.getObjectByName("left_hand_group") || leftHand;
    rightHand = root.getObjectByName("right_hand_group") || rightHand;
    leftArmRig = root.getObjectByName("left_arm_rig") || leftArmRig;
    rightArmRig = root.getObjectByName("right_arm_rig") || rightArmRig;
    leftForearmMesh = root.getObjectByName("left_arm_rig_forearm") || leftForearmMesh;
    rightForearmMesh = root.getObjectByName("right_arm_rig_forearm") || rightForearmMesh;
    leftWatch = root.getObjectByName("left_watch") || leftWatch;
    indexJoint = root.getObjectByName("right_index_joint_0") || indexJoint;
    gun.add(root);
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
    const isPistol = av.weaponId === "pistol";
    if (av.m416Mesh) av.m416Mesh.visible = !isPistol;
    if (av.pistolMesh) av.pistolMesh.visible = isPistol;
    av.muzNode = isPistol ? (av.pistolMuzNode || av.m416MuzNode) : av.m416MuzNode;
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
    av.weaponAttached = Boolean(av.m416Mesh || av.pistolMesh);
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
      shieldDome, muzFlash, muzNode: null, m416Mesh: null, pistolMesh: null, m416MuzNode: null, pistolMuzNode: null,
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
    av.muzNode = av.m416Mesh = av.pistolMesh = av.m416MuzNode = av.pistolMuzNode = null;
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
      if (pose.weaponId && pose.weaponId !== av.weaponId) {
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

  // ---------- Viewmodel & Animation ----------
  const _armDir = new Vec(), _wristPos = new Vec();
  function aimForearm(armRig, forearmMesh, handGroup, wristLocal, watchNode) {
    _wristPos.copy(wristLocal).applyQuaternion(handGroup.quaternion).add(handGroup.position);
    _armDir.subVectors(_wristPos, armRig.position);
    const len = Math.max(0.05, _armDir.length());
    armRig.quaternion.setFromUnitVectors(UP, _armDir.multiplyScalar(1 / len));
    forearmMesh.scale.set(1, len, 1);
    if (watchNode) watchNode.position.y = Math.max(0.14, len - 0.032);
  }

  const HIP_POS = new Vec(0.155, -0.14, -0.395), ADS_POS = new Vec(0, -OPTIC_Y, -0.165);
  const PISTOL_HIP_POS = new Vec(0.098, -0.098, -0.255), PISTOL_ADS_POS = new Vec(0, -0.0671, -0.205);
  const lerp = THREE.MathUtils.lerp;
  const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const LEFT_TRACK = [
    [0, "grip"], [0.05, "grip"], [0.22, "mag"], [0.29, "mag"], [0.44, "out"],
    [0.52, "out"], [0.66, "mag"], [0.72, "mag"], [0.8, "ch"], [0.83, "ch"],
    [0.9, "chPulled"], [0.93, "chPulled"], [1, "grip"],
  ];
  const leftPose = { p: new Vec(), q: new THREE.Quaternion() };
  function sampleLeftTrack(t, poseSet = POSE, isTacticalReload = false) {
    const effT = isTacticalReload && t > 0.74 ? 1.0 - (1.0 - t) * (0.28 / 0.26) : t;
    if (isTacticalReload && t > 0.74) {
      const kBack = smooth01((t - 0.74) / 0.24);
      leftPose.p.lerpVectors(poseSet.mag.p, poseSet.grip.p, kBack);
      leftPose.q.copy(poseSet.mag.q).slerp(poseSet.grip.q, kBack);
      return leftPose;
    }
    let i = 0;
    while (i < LEFT_TRACK.length - 2 && effT > LEFT_TRACK[i + 1][0]) i++;
    const [t0, a] = LEFT_TRACK[i], [t1, b] = LEFT_TRACK[i + 1], k = smooth01((effT - t0) / (t1 - t0 || 1));
    leftPose.p.lerpVectors(poseSet[a].p, poseSet[b].p, k);
    leftPose.q.copy(poseSet[a].q).slerp(poseSet[b].q, k);
    return leftPose;
  }

  // ---------- Gameplay State ----------
  const P = new Vec();
  let engineMode = "idle"; // "idle" | "lan" | "solo"
  let activeState = "menu"; // "menu" | "play" | "over"
  let testLocked = false;
  let currentMode = "TDM";
  let killLimit = 30;
  let timeLeftSec = 600;
  let teamScores = { A: 0, B: 0 };
  let lastPlayers = [];
  let meTeam = "A";
  let meAlive = true;
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

  let hp = 100;
  let yaw = 0, pitch = 0, vy = 0, velX = 0, velZ = 0, eyeHeight = EYE_STAND;
  let crouched = false, grounded = true, isSprinting = false, sprintBrokenUntilShiftUp = false;
  let lastGroundedAt = 0, jumpBufferedUntil = 0, nextJumpAllowedAt = 0, physicsAccum = 0;
  let bob = 0, lyaw = 0, lpit = 0, swx = 0, swy = 0, spr = 0;
  let recoil = 0, kick = 0, flash = 0, bolt = 0, rlp = 0, ads = 0, trigPull = 0;
  let hm = 0, dmgV = 0, shake = 0, killAlertT = 0, soloScore = 0, soloWave = 0, soloWaveCd = 0;
  let laserOn = true, chatOpen = false, curFlags = 0, testAimHeld = false;
  let lastInputSentAt = 0;
  const drones = [], ray = new THREE.Raycaster(), lr = new THREE.Raycaster(), laserRay = new THREE.Raycaster(), upRay = new THREE.Raycaster();
  const _lp = new Vec(), _ls = new Vec(), _ld = new Vec();

  gun.position.copy(HIP_POS);
  gun.traverse((o) => o.layers.set(VIEW_LAYER));
  S.traverse((o) => { if (o.isLight) o.layers.enableAll(); });
  vmKey.layers.set(VIEW_LAYER);
  vmFill.layers.set(VIEW_LAYER);

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
    const activePoseSet = isPistol ? PISTOL_POSE : POSE;
    const tl = rl > 0 ? Math.min(1, rl / 0.1, (1 - rl) / 0.1) : 0;
    const pose = sampleLeftTrack(rl, activePoseSet, Boolean(st.isTactical));
    leftHand.position.copy(pose.p);
    leftHand.quaternion.copy(pose.q);
    rightHand.position.copy(activePoseSet.rightGrip.p);
    rightHand.quaternion.copy(activePoseSet.rightGrip.q);

    mag.position.copy(MAG_REST);
    sniperMagMesh.position.set(0, -0.045, -0.18);
    if (rl > 0.28 && rl < 0.72) {
      if (cfg.id === "m416") mag.position.add(pose.p).sub(POSE.mag.p);
      else if (cfg.id === "sniper") sniperMagMesh.position.y -= Math.sin(((rl - 0.28) / 0.44) * Math.PI) * 0.16;
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
        pistolReloadTiltZ = kDrop * 0.30;
      } else if (rl >= 0.46 && rl < 0.74) {
        const kIns = smooth01((rl - 0.46) / 0.28);
        pistolMagDrop = (1 - kIns) * 0.14;
        pistolReloadTiltZ = (1 - kIns) * 0.30;
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
    indexJoint.rotation.x = INDEX_BASE_ROT_X + (isPistol ? pistolTrigPull * 0.82 : trigPull * 0.34);

    const hip = 1 - ads, calm = 1 - 0.78 * ads, bobK = mv * (1 - 0.88 * ads);
    const dropW = rl > 0.22 && rl < 0.72 ? smooth01(Math.min((rl - 0.22) / 0.15, (0.72 - rl) / 0.15)) : 0;
    const chW = !st.isTactical && rl > 0.74 && rl < 0.98 ? smooth01(Math.min((rl - 0.74) / 0.09, (0.98 - rl) / 0.08)) : 0;
    const baseHip = isPistol ? PISTOL_HIP_POS : HIP_POS;
    const targetAdsX = isPistol ? PISTOL_ADS_POS.x : ADS_POS.x;
    const adsPosY = isPistol ? PISTOL_ADS_POS.y : cfg.id === "sniper" ? ADS_POS.y : ADS_POS.y;
    const adsPosZ = isPistol ? PISTOL_ADS_POS.z : cfg.id === "sniper" ? -0.14 : ADS_POS.z;
    gun.position.set(
      lerp(baseHip.x, targetAdsX, ads) + (swx + Math.sin(bob) * 0.006 * bobK) * calm - (isPistol ? 0.028 : 0.05) * tl,
      lerp(baseHip.y, adsPosY, ads) + (swy + Math.sin(bob * 2) * 0.008 * bobK) * calm - 0.06 * spr + 0.02 * tl + Math.sin(gt * 1.6) * 0.0018 * hip,
      lerp(baseHip.z, adsPosZ, ads) + recoil * (isPistol ? 0.35 : 1.15 - 0.8 * ads) + 0.03 * tl - (isPistol ? 0.024 : 0.048) * chW,
    );
    gun.rotation.set(
      (recoil * (isPistol ? 0.9 : 2.1) + swy * 2) * calm - 0.22 * spr + (isPistol ? 0.10 : 0.18) * tl + (isPistol ? 0.025 * hip : 0),
      (0.52 * spr + swx * 2) * calm + (isPistol ? -0.045 : 0.04) * hip + (isPistol ? 0.14 : 0.24) * tl,
      (swx * 1.5 + (isPistol ? 0.02 : -0.03)) * calm - (isPistol ? 0.12 : 0.32) * tl,
    );
    leftArmRig.position.set(LEFT_ELBOW.x - 0.07 * chW, LEFT_ELBOW.y - 0.16 * dropW - 0.03 * chW, LEFT_ELBOW.z + 0.06 * chW);
    rightArmRig.position.copy(RIGHT_ELBOW);
    aimForearm(rightArmRig, rightForearmMesh, rightHand, rightWristLocal, null);
    aimForearm(leftArmRig, leftForearmMesh, leftHand, leftWristLocal, leftWatch);
  }

  function hud() {
    const nowMs = performance.now();
    const { cfg, st } = activeWeapon();
    const isReloading = st.reloadEndsAt > nowMs;

    $("hpb").style.width = Math.max(0, hp) + "%";
    $("hpb").style.background = meInvuln ? "#64c8ff" : hp > 35 ? "#4ec3b0" : "#e85445";

    const isLow = st.mag <= Math.ceil(cfg.magSize * 0.3);
    $("am").textContent = isReloading ? "Nạp đạn…" : `${st.mag} / ∞`;
    $("am").classList.toggle("amLow", isLow && !isReloading);
    $("reloadHint").style.display = isLow && !isReloading && activeState === "play" && meAlive ? "block" : "none";

    for (const s of WEAPON_SLOTS) {
      const pNode = $(`slotPill${s}`);
      if (pNode) pNode.classList.toggle("active", s === activeSlot);
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
    $("postureBadge").textContent = `${cfg.name} • ${postureLabel}`;

    $("top").style.display = engineMode === "solo" ? "block" : "none";
    $("pvpTop").style.display = engineMode === "lan" ? "flex" : "none";
    $("radarCanvas").style.display = engineMode === "lan" ? "block" : "none";
    $("wv").textContent = soloWave;
    $("sc").textContent = soloScore;
    if (engineMode === "lan") {
      if (!meAlive && activeState === "play") {
        $("respawnBanner").style.display = "block";
        $("respawnBanner").textContent = `Đã bị hạ — Hồi sinh sau ${(respawnMs / 1000).toFixed(1)}s`;
      } else {
        $("respawnBanner").style.display = "none";
      }
      if (currentMode === "TDM") {
        $("scA").textContent = teamScores.A;
        $("scB").textContent = teamScores.B;
        $("pvpMeta").textContent = `${formatClock(timeLeftSec)} | ${killLimit} Mạng`;
      } else {
        const topP = lastPlayers.slice().sort((a, b) => b.kills - a.kills)[0];
        $("scA").textContent = topP ? topP.kills : 0;
        $("scB").textContent = killLimit;
        $("pvpMeta").textContent = `FFA ${formatClock(timeLeftSec)} | Dẫn đầu: ${topP ? topP.name : "-"}`;
      }
    } else {
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
    g.position.set(Math.cos(a) * 42, 6.5, Math.sin(a) * 42);
    S.add(g);
    const d = { g, body, ring, hp: 3, st: "patrol", tgt: new Vec(rnd(-35, 35), 6.5, rnd(-35, 35)), cd: rnd(1, 2), los: false, losT: 0, hitT: 0, sd: Math.random() < 0.5 ? 1 : -1 };
    body.userData.drone = d;
    drones.push(d);
  }
  function canSee(a, b) {
    const d = b.clone().sub(a), L = d.length();
    lr.set(a, d.normalize());
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
    applyViewmodelWeapon(wid);
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
    const candidates = engineMode === "solo" ? [ground, ...solid, ...drones.map((d) => d.body)] : [ground, ...solid, ...enemyMeshes];
    const hit = ray.intersectObjects(candidates, false)[0];
    const from = muz.getWorldPosition(new Vec());
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
  let gt = 0, ltn = rnd(8, 16), lt = 0;
  const clock = new THREE.Clock();

  function updateWeatherAndRain(dt) {
    gt += dt;
    const wind = Math.sin(gt * 0.23) * 0.6 + Math.sin(gt * 0.71) * 0.25;
    const px = P.x, pz = P.z;
    for (let i = 0; i < ND2; i++) {
      const k = i * 4, v = rd[k + 3], sp = 24 + 16 * v;
      let x = rd[k] + wind * 3 * dt, y = rd[k + 1] - sp * dt, z = rd[k + 2];
      if (x - px > 24) x -= 48; else if (x - px < -24) x += 48;
      if (z - pz > 24) z -= 48; else if (z - pz < -24) z += 48;
      if (y < 0) { y += 26; if (i % 6 === 0 && Math.abs(x - px) < 12 && Math.abs(z - pz) < 12) splash.emit(x, 0.03, z, 2, 2.2, 0.5); }
      rd[k] = x; rd[k + 1] = y; rd[k + 2] = z;
      rp2.set([x - wind * 0.07, y + sp * 0.022, z, x, y, z], i * 6);
    }
    rg2.attributes.position.needsUpdate = true;
    splash.upd(dt);
    sparks.upd(dt);

    ltn -= dt;
    if (ltn <= 0) { ltn = rnd(12, 26); lt = 0.4; setTimeout(() => snd.thunder(), rnd(500, 2200)); }
    lt = Math.max(0, lt - dt);
    const b = lt > 0.28 || (lt < 0.2 && lt > 0.1) ? 1 : lt > 0 ? 0.3 : 0;
    hemi.intensity = 0.55 + b * 2.1;
    moon.intensity = 0.55 + b * 1.8;
    S.fog.color.setRGB(0.027 + b * 0.25, 0.051 + b * 0.28, 0.078 + b * 0.34);
    S.background.copy(S.fog.color);
  }

  function canStandUp() {
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
    const hover = ray.intersectObjects([ground, ...solid, ...enemyMeshes], false)[0];
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

    isSprinting = rawShift && !sprintBrokenUntilShiftUp && !crouched && grounded && hasMove;
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
    if (hasMove && grounded) bob += speed * dtFixed;

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
    gunAnim(dt, canAct ? mvRatio : 0);

    shake = Math.max(0, shake - dt);
    const sk = shake * 0.05;
    cam.position.set(
      P.x + rnd(-sk, sk),
      P.y + (canAct ? eyeHeight : 0.75) + (mvRatio && grounded ? Math.sin(bob * 2) * 0.035 * (1 - 0.7 * ads) : 0),
      P.z,
    );
    cam.rotation.set(pitch + kick + rnd(-sk, sk), yaw, 0);

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

    hm = Math.max(0, hm - dt * 5);
    $("hm").style.opacity = hm;
    dmgV = Math.max(0, dmgV - dt * 1.6);
    $("dmg").style.opacity = dmgV;
    if (killAlertT > 0) { killAlertT -= dt; if (killAlertT <= 0) $("killAlert").style.opacity = "0"; }

    updateRadarAndCrosshair(nowMs);
    hud();
  }

  R.autoClear = false;
  R.shadowMap.autoUpdate = false;
  function renderFrame() {
    R.shadowMap.needsUpdate = true;
    cam.layers.set(0);
    R.clear();
    R.render(S, cam);
    if (engineMode !== "idle") {
      const bg = S.background;
      S.background = null;
      R.clearDepth();
      cam.layers.set(VIEW_LAYER);
      R.render(S, cam);
      S.background = bg;
    }
    cam.layers.set(0);
  }

  (function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (activeState === "play") updateGameplay(dt);
    if (engineMode === "lan") updateRemotePlayers(dt);
    tr.forEach((l) => { l.userData.t -= dt; l.material.opacity = Math.max(0, l.userData.t / 0.09); });
    updateWeatherAndRain(dt);
    cam.updateMatrixWorld(true);
    laserBeam.visible = laserLens.visible =
      laserOn && engineMode !== "idle" && meAlive && SLOT_TO_WEAPON_ID[activeSlot] === "m416";
    if (laserBeam.visible) {
      laserOrigin.getWorldPosition(_lp);
      _ld.set(0, 0, -1).transformDirection(gun.matrixWorld);
      _ls.copy(_lp).addScaledVector(_ld, -0.9);
      laserRay.set(_ls, _ld);
      laserRay.far = 81;
      const hit = laserRay.intersectObjects([ground, ...solid], false)[0];
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

  function startSolo() {
    initAudio();
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
    P.set(0, 0, 0);
    yaw = pitch = vy = velX = velZ = ads = bolt = rlp = trigPull = 0;
    crouched = false; grounded = true; eyeHeight = EYE_STAND;
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
        if (opts.adsSteps) for (let i = 0; i < opts.adsSteps; i++) gunAnim(0.02, 0);
      },
      getRemotePlayers: () => remotePlayers,
      getWeapons: () => ({ activeSlot, activeWeaponId: SLOT_TO_WEAPON_ID[activeSlot], weapons }),
      getTeamMaterials: () => teamAccentMats,
      getMe: () => ({
        meAlive, meTeam, hp,
        ammo: activeWeapon().st.mag,
        reloading: activeWeapon().st.reloadEndsAt > performance.now(),
        crouched, grounded, isSprinting, ads, flags: curFlags, eyeHeight,
      }),
    }),
  };
}
