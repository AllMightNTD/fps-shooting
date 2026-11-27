/**
 * WebAudio Synthesizer, Precomputed Reverb/Noise Buffers & Spatial Audio Engine.
 * Integrates M416 WAV bank while supplying spatialized impacts, footsteps, scope clicks & ambient wind/rain.
 */

import { createWeaponAudioBank } from "/js/weapon_audio.js";

export function createAudioEngine({ THREE, cam, yieldToUI, getActiveMapId }) {
  let AC = null;
  let NB = null;
  let REV = null;
  let ambFilter = null;
  let ambGain = null;
  let ambStarted = false;
  const PRECOMPUTED_AUDIO_SR = 48000;
  let precomputedNoise = null;
  let precomputedRevL = null;
  let precomputedRevR = null;

  const weaponAudio = createWeaponAudioBank({
    getAudioContext: () => AC,
    getReverbNode: () => REV,
  });

  const _audRight = new THREE.Vector3();
  const _audTo = new THREE.Vector3();

  function computeSpatialAudio(worldPos) {
    if (!worldPos) return { dist: 0, att: 1, pan: 0 };
    _audTo.set(worldPos.x - cam.position.x, worldPos.y - cam.position.y, worldPos.z - cam.position.z);
    const dist = _audTo.length();
    const att = Math.max(0.03, Math.min(1.0, 1 / (1 + dist * 0.085)));
    let pan = 0;
    if (dist > 0.25) {
      _audRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
      pan = Math.max(-1, Math.min(1, _audTo.dot(_audRight) / dist));
    }
    return { dist, att, pan };
  }

  function buildAudioGraph() {
    if (!AC || NB) return;
    const n = AC.sampleRate * 2;
    NB = AC.createBuffer(1, n, AC.sampleRate);
    const d = NB.getChannelData(0);
    if (precomputedNoise && precomputedNoise.length === n) {
      d.set(precomputedNoise);
    } else {
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const revLen = Math.floor(AC.sampleRate * 1.3);
    const rb = AC.createBuffer(2, revLen, AC.sampleRate);
    if (precomputedRevL && precomputedRevR && precomputedRevL.length === revLen) {
      rb.getChannelData(0).set(precomputedRevL);
      rb.getChannelData(1).set(precomputedRevR);
    } else {
      for (let c = 0; c < 2; c++) {
        const ch = rb.getChannelData(c);
        for (let i = 0; i < revLen; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / revLen, 3.2);
      }
    }
    REV = AC.createConvolver();
    REV.buffer = rb;
    const g = AC.createGain();
    g.gain.value = 0.45;
    REV.connect(g).connect(AC.destination);
    ambFilter = AC.createBiquadFilter();
    ambFilter.type = "lowpass";
    ambFilter.frequency.value = 420;
    ambGain = AC.createGain();
    ambGain.gain.value = 0.09;
    ambFilter.connect(ambGain).connect(AC.destination);
  }

  async function precomputeAudioBuffersAsync() {
    if (!precomputedNoise) {
      const nLen = PRECOMPUTED_AUDIO_SR * 2;
      const noise = new Float32Array(nLen);
      for (let i = 0; i < nLen; i++) noise[i] = Math.random() * 2 - 1;
      precomputedNoise = noise;
      await yieldToUI();

      const revLen = Math.floor(PRECOMPUTED_AUDIO_SR * 1.3);
      const revL = new Float32Array(revLen);
      const revR = new Float32Array(revLen);
      for (let i = 0; i < revLen; i++) {
        const env = Math.pow(1 - i / revLen, 3.2);
        revL[i] = (Math.random() * 2 - 1) * env;
        revR[i] = (Math.random() * 2 - 1) * env;
      }
      precomputedRevL = revL;
      precomputedRevR = revR;
      await yieldToUI();
    }

    if (!AC) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioCtx === "function") {
          AC = new AudioCtx();
          await yieldToUI();
          buildAudioGraph();
          await yieldToUI();
        }
      } catch {
        AC = null;
      }
    }

    await weaponAudio.preload();
    await yieldToUI();
  }

  function startAmbientLoopOnce() {
    if (!AC || !NB || !ambFilter || ambStarted) return;
    ambStarted = true;
    const r = AC.createBufferSource();
    r.buffer = NB;
    r.loop = true;
    r.connect(ambFilter);
    r.start();
  }

  function syncAmbientAudio() {
    if (!AC || !ambFilter || !ambGain) return;
    const t = AC.currentTime;
    const mapId = typeof getActiveMapId === "function" ? getActiveMapId() : "military";
    if (mapId === "military") {
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
    try {
      if (!AC) {
        AC = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (!NB) buildAudioGraph();
      startAmbientLoopOnce();
      AC.resume().catch(() => {});
      weaponAudio.ensureDecodedOnGesture();
      syncAmbientAudio();
    } catch {
      // Audio blocked until gesture
    }
  }

  function connectAudioOut(node, pan = 0, wet = 0) {
    if (!AC) return;
    let out = node;
    if (Math.abs(pan) > 0.02 && typeof AC.createStereoPanner === "function") {
      const panner = AC.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(panner);
      out = panner;
    }
    out.connect(AC.destination);
    if (wet && REV) {
      const k = AC.createGain();
      k.gain.value = wet;
      out.connect(k).connect(REV);
    }
  }

  function nzPos(dur, f0, f1, v, w = 0, pan = 0, filterType = "lowpass", q = 1.0) {
    if (!AC || !NB || v <= 0.002) return;
    const t = AC.currentTime;
    const s = AC.createBufferSource();
    s.buffer = NB;
    const f = AC.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(40, f0), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = AC.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g);
    connectAudioOut(g, pan, w);
    s.start(0, Math.random());
    s.stop(t + dur);
  }

  function tonePos(f0, f1, dur, v, type = "sine", pan = 0) {
    if (!AC || v <= 0.002) return;
    const t = AC.currentTime;
    const o = AC.createOscillator();
    const g = AC.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    connectAudioOut(g, pan, 0);
    o.start(t);
    o.stop(t + dur);
  }

  const nz = (dur, f0, f1, v, w = 0) => nzPos(dur, f0, f1, v, w, 0, "lowpass", 1.0);
  const tone = (f0, f1, dur, v, type = "sine") => tonePos(f0, f1, dur, v, type, 0);

  const snd = {
    shot() {
      if (!weaponAudio.playShot("m416")) {
        nz(0.06, 9000, 2500, 0.45, 0.15);
        nz(0.28, 3500, 160, 0.55, 0.35);
        tone(140, 32, 0.2, 0.7);
      }
    },
    pistolShot() {
      if (!weaponAudio.playShot("pistol")) {
        nz(0.05, 8200, 2200, 0.36, 0.12);
        nz(0.18, 2800, 220, 0.42, 0.24);
        tone(180, 48, 0.12, 0.52);
      }
    },
    sniperShot() {
      if (!weaponAudio.playShot("sniper")) {
        nz(0.09, 10000, 1800, 0.6, 0.28);
        nz(0.55, 3200, 90, 0.72, 0.48);
        tone(105, 22, 0.36, 0.88);
      }
    },
    dryClick(weaponId = "m416") {
      if (weaponAudio.playDryfire(weaponId)) return;
      if (weaponId === "sniper") {
        tone(1050, 480, 0.028, 0.16, "square");
        tone(1900, 900, 0.016, 0.08, "triangle");
        return;
      }
      tone(1350, 720, 0.032, 0.14, "square");
    },
    hit() { tone(1300, 600, 0.07, 0.16, "square"); },
    headshot() {
      tone(1850, 920, 0.09, 0.25, "triangle");
      setTimeout(() => tone(2450, 1500, 0.11, 0.18, "sine"), 35);
    },
    remoteShot(dist, pan = 0, weaponId = "m416") {
      if (weaponAudio.playRemoteShot(weaponId, dist, pan)) return;
      const a = Math.max(0.05, Math.min(0.6, 9 / (dist + 6)));
      nzPos(0.16, 4800, 260, 0.45 * a, 0.2 * a, pan);
      tonePos(135, 38, 0.14, 0.4 * a, "sine", pan);
    },
    surfaceImpact(surface, worldPos, ricochet = false) {
      const { att, pan } = computeSpatialAudio(worldPos);
      if (att < 0.04) return;
      if (surface === "metal") {
        tonePos(2250, 980, 0.12, 0.18 * att, "triangle", pan);
        tonePos(3680, 1940, 0.08, 0.11 * att, "sine", pan);
        nzPos(0.055, 5800, 1850, 0.18 * att, 0.14 * att, pan, "bandpass", 1.3);
        if (ricochet) {
          tonePos(4200, 1180, 0.28, 0.15 * att, "sine", pan);
          tonePos(2920, 820, 0.24, 0.08 * att, "triangle", pan);
        }
      } else if (surface === "wood") {
        tonePos(260, 92, 0.09, 0.24 * att, "triangle", pan);
        nzPos(0.095, 1950, 420, 0.20 * att, 0.07 * att, pan, "bandpass", 1.5);
      } else if (surface === "dirt") {
        tonePos(128, 46, 0.10, 0.24 * att, "sine", pan);
        nzPos(0.11, 1250, 260, 0.16 * att, 0.04 * att, pan, "lowpass", 1.0);
      } else if (surface === "water") {
        nzPos(0.18, 4200, 820, 0.24 * att, 0.14 * att, pan, "bandpass", 0.9);
        tonePos(460, 185, 0.085, 0.12 * att, "sine", pan);
      } else {
        nzPos(0.085, 3400, 620, 0.22 * att, 0.12 * att, pan, "bandpass", 1.2);
        tonePos(185, 68, 0.07, 0.18 * att, "triangle", pan);
      }
    },
    whizBy(closeness = 0.5, pan = 0) {
      const k = Math.max(0.1, Math.min(1.0, closeness));
      nzPos(0.11, 6800, 1100, 0.14 + 0.26 * k, 0.10, pan, "bandpass", 2.0);
      tonePos(1480 + k * 620, 320, 0.095, 0.09 + 0.14 * k, "sawtooth", pan);
    },
    boom() { nz(0.7, 2500, 80, 0.65); },
    laser() { tone(900, 200, 0.14, 0.09, "sawtooth"); },
    hurt() { tone(120, 60, 0.22, 0.38, "square"); },
    deathImpact() {
      tone(98, 28, 0.62, 0.42, "sine");
      nz(0.45, 520, 45, 0.26, 0.32);
    },
    reload(weaponId = "m416", isTactical = false) {
      if (weaponAudio.playReload(weaponId, { isTactical })) return;
      tone(300, 520, 0.09, 0.12, "square");
    },
    click(f) { tone(f, f * 0.5, 0.04, 0.1, "square"); },
    scopeClick(level = 1, worldPos = null) {
      const f0 = level === 2 ? 2350 : level === 1 ? 1750 : 1220;
      const f1 = level === 2 ? 1280 : level === 1 ? 860 : 540;
      if (worldPos) {
        const { att, pan } = computeSpatialAudio(worldPos);
        if (att < 0.05) return;
        tonePos(f0, f1, 0.032, 0.11 * att, "square", pan);
        tonePos(920, 480, 0.028, 0.08 * att, "triangle", pan);
        return;
      }
      tone(f0, f1, 0.032, 0.11, "square");
      tone(920, 480, 0.028, 0.08, "triangle");
    },
    shell(isPuddle = false, weaponId = "m416") {
      if (weaponAudio.playShell(weaponId, { isPuddle })) return;
      tone(4300, 3200, 0.06, 0.06, "triangle");
    },
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

  function updateAmbientWind(gt) {
    if (!AC || !ambFilter || !ambGain) return;
    const gust = 0.5 + 0.5 * Math.sin(gt * 0.27) * Math.cos(gt * 0.13);
    ambFilter.frequency.setTargetAtTime(210 + gust * 250, AC.currentTime, 0.2);
    ambGain.gain.setTargetAtTime(0.042 + gust * 0.032, AC.currentTime, 0.2);
  }

  return {
    snd,
    weaponAudio,
    isReady: () => Boolean(AC),
    hasAudioContext: () => Boolean(AC),
    precomputeAudioBuffersAsync,
    initAudio,
    syncAmbientAudio,
    updateAmbientWind,
    computeSpatialAudio,
    getCameraRight: () => _audRight.set(1, 0, 0).applyQuaternion(cam.quaternion),
  };
}
