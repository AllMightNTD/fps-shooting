/**
 * Weapon Audio Bank & Calibrated WebAudio Playback (M416, Pistol & AWM real WAV assets):
 * - Pure helpers (Node-testable): distance gain, air-absorption lowpass cutoff, jittered pitch,
 *   per-weapon tactical/empty reload playback calibration, and flatline/DC buffer guard.
 * - Browser engine: pre-fetches & decodes WAV ArrayBuffers during Loading Screen, applies per-WAV
 *   gain staging + soft DynamicsCompressor headroom + DC high-pass on hot assets, tracks
 *   interruptible reload playback, and falls back gracefully to procedural synth on missing/corrupt audio.
 */

export const M416_SOUND_PATHS = Object.freeze({
  shot: "/sound/m416/m416_standard_outdoor_shot.wav",
  reload: "/sound/m416/m416_reload.wav",
  shell: "/sound/m416/m416_shell_casing.wav",
  dryfire: "/sound/m416/m416_dryfire.wav",
});

export const PISTOL_SOUND_PATHS = Object.freeze({
  shot: "/sound/pistol/pistol_standard_outdoor_shot.wav",
  reload: "/sound/pistol/pistol_reload.wav",
  shell: "/sound/pistol/pistol_shell_casing.wav",
});

export const AWM_SOUND_PATHS = Object.freeze({
  shot: "/sound/awm/awm_brake_outdoor_shot.wav",
  reload: "/sound/awm/awm_reload.wav",
  shell: "/sound/awm/awm_shell.wav",
  dryfire: "/sound/awm/awm_dryfire.wav",
});

// Gains calibrated directly against actual WAV peak levels and lead silence:
// - M416:   shot peak=0.30, reload peak=0.23, shell peak=0.18, dryfire peak=0.03
// - Pistol: shot peak=0.24, reload peak=0.28, shell peak=0.13
// - AWM:    shot peak=0.94 (hot normalized), reload peak=0.94 (66.5ms lead), shell peak=0.94, dryfire DC-flat
export const WEAPON_SOUND_BANKS = Object.freeze({
  m416: Object.freeze({
    paths: M416_SOUND_PATHS,
    tuning: Object.freeze({
      shot: Object.freeze({ gain: 1.95, trimStartSec: 0.0085, reverbWet: 0.16, pitchJitter: 0.032 }),
      remoteShot: Object.freeze({ gain: 1.65, trimStartSec: 0.0085, reverbWet: 0.24, refDist: 10.5 }),
      reload: Object.freeze({ gain: 1.45, trimStartSec: 0.0, reverbWet: 0.04, emptyRate: 0.80, tactRate: 0.96, tactMaxSec: 0.95, defaultDur: 1.394 }),
      shell: Object.freeze({ gain: 0.62, trimStartSec: 0.0, reverbWet: 0.05, delayMin: 0.24, delayMax: 0.34, panRight: 0.30 }),
      dryfire: Object.freeze({ gain: 4.5, trimStartSec: 0.0, reverbWet: 0.02 }),
    }),
  }),
  pistol: Object.freeze({
    paths: PISTOL_SOUND_PATHS,
    tuning: Object.freeze({
      shot: Object.freeze({ gain: 1.82, trimStartSec: 0.0085, reverbWet: 0.14, pitchJitter: 0.04 }),
      remoteShot: Object.freeze({ gain: 1.45, trimStartSec: 0.0085, reverbWet: 0.22, refDist: 9.0 }),
      reload: Object.freeze({ gain: 1.28, trimStartSec: 0.0, reverbWet: 0.04, emptyRate: 0.74, tactRate: 0.90, tactMaxSec: 0.80, defaultDur: 1.094 }),
      shell: Object.freeze({ gain: 0.78, trimStartSec: 0.0, reverbWet: 0.05, delayMin: 0.22, delayMax: 0.30, panRight: 0.32 }),
    }),
  }),
  sniper: Object.freeze({
    paths: AWM_SOUND_PATHS,
    tuning: Object.freeze({
      shot: Object.freeze({ gain: 0.82, trimStartSec: 0.0145, reverbWet: 0.26, pitchJitter: 0.024, dcHighpassHz: 35 }),
      remoteShot: Object.freeze({ gain: 0.72, trimStartSec: 0.0145, reverbWet: 0.32, refDist: 16.0, dcHighpassHz: 35 }),
      reload: Object.freeze({ gain: 0.42, trimStartSec: 0.055, reverbWet: 0.05, emptyRate: 0.76, tactRate: 0.92, tactMaxSec: 1.38, defaultDur: 2.15, dcHighpassHz: 35 }),
      shell: Object.freeze({ gain: 0.16, trimStartSec: 0.014, reverbWet: 0.06, delayMin: 0.58, delayMax: 0.68, panRight: 0.34, dcHighpassHz: 35 }),
      dryfire: Object.freeze({ gain: 0.45, trimStartSec: 0.0, reverbWet: 0.02, dcHighpassHz: 35 }),
    }),
  }),
});

export const M416_SOUND_TUNING = WEAPON_SOUND_BANKS.m416.tuning;

export function normalizeWeaponAudioKey(weaponId = "m416") {
  const k = String(weaponId || "").toLowerCase();
  if (k === "pistol" || k === "glock" || k === "glock-17") return "pistol";
  if (k === "sniper" || k === "awm") return "sniper";
  return "m416";
}

export function extractAudioAssetPaths(weaponId = null) {
  if (weaponId) {
    const bank = WEAPON_SOUND_BANKS[normalizeWeaponAudioKey(weaponId)];
    return bank ? Object.values(bank.paths) : [];
  }
  const out = [];
  for (const bank of Object.values(WEAPON_SOUND_BANKS)) {
    out.push(...Object.values(bank.paths));
  }
  return out;
}

export function computeAutoPitch(basePitch = 1.0, jitter = 0.03, rand01 = 0.5) {
  const b = Number.isFinite(basePitch) ? Math.max(0.25, Math.min(2.5, basePitch)) : 1.0;
  const j = Number.isFinite(jitter) ? Math.max(0, Math.min(0.4, jitter)) : 0;
  const r = Number.isFinite(rand01) ? Math.max(0, Math.min(1, rand01)) : 0.5;
  return b + (r * 2 - 1) * j;
}

export function computeDistanceGain(dist = 0, refDist = 10.5) {
  const d = Number.isFinite(dist) ? Math.max(0, dist) : 0;
  const ref = Number.isFinite(refDist) && refDist > 0 ? refDist : 10.5;
  return Math.max(0.03, Math.min(1.0, ref / (d + ref)));
}

export function computeDistanceAirCutoffHz(dist = 0) {
  const d = Number.isFinite(dist) ? Math.max(0, dist) : 0;
  return Math.round(Math.max(850, Math.min(16000, 14500 * Math.exp(-d * 0.028))));
}

/**
 * Compute playbackRate and optional early cutoff matched to weapon empty/tactical reload durations.
 */
export function computeReloadPlaybackConfig(rawDurationSec = 1.394, isTactical = false, weaponId = "m416") {
  const wKey = normalizeWeaponAudioKey(weaponId);
  const cfg = WEAPON_SOUND_BANKS[wKey].tuning.reload;
  const trim = cfg.trimStartSec || 0;
  const rawDur = Number.isFinite(rawDurationSec) && rawDurationSec > 0.2 ? rawDurationSec : cfg.defaultDur;
  const effectiveDur = Math.max(0.2, rawDur - trim);
  if (isTactical) {
    return {
      playbackRate: cfg.tactRate,
      maxPlaySec: Math.min(effectiveDur / cfg.tactRate, cfg.tactMaxSec),
    };
  }
  return {
    playbackRate: cfg.emptyRate,
    maxPlaySec: effectiveDur / cfg.emptyRate,
  };
}

/**
 * Guard against flat DC-only or silent decoded AudioBuffers (e.g. constant -0.944 DC asset).
 * Mock AudioBuffers without getChannelData() are trusted for pure Node unit tests.
 */
export function isAudibleWaveform(audioBuf) {
  if (!audioBuf) return false;
  if (typeof audioBuf.getChannelData !== "function") return true;
  const data = audioBuf.getChannelData(0);
  if (!data || data.length === 0) return false;
  let min = data[0];
  let max = data[0];
  const step = Math.max(1, Math.floor(data.length / 512));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min > 0.002;
}

export function createWeaponAudioBank({
  getAudioContext,
  getReverbNode = null,
  fetchFn = null,
} = {}) {
  const rawBytesCache = new Map();
  const decodedCache = new Map();
  let preloadPromise = null;
  let decodePromise = null;
  let masterBus = null;
  let compressor = null;
  let busCtx = null;

  let activeReload = null;
  const activeTimers = new Set();

  const allEntries = [];
  for (const [wKey, bank] of Object.entries(WEAPON_SOUND_BANKS)) {
    for (const [sType, url] of Object.entries(bank.paths)) {
      allEntries.push([wKey, sType, `${wKey}:${sType}`, url]);
    }
  }

  function ensureMasterBus(ac) {
    if (!ac) return null;
    if (busCtx !== ac || !masterBus) {
      busCtx = ac;
      if (typeof ac.createDynamicsCompressor === "function") {
        compressor = ac.createDynamicsCompressor();
        compressor.threshold.value = -7;
        compressor.knee.value = 8;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.002;
        compressor.release.value = 0.09;
        compressor.connect(ac.destination);
        masterBus = compressor;
      } else {
        masterBus = ac.destination;
      }
    }
    return masterBus;
  }

  function connectSourceChain(ac, src, gainNode, { dcHighpassHz = 0, pan = 0, reverbWet = 0, preGainNode = null } = {}) {
    let head = src;
    if (dcHighpassHz > 0 && typeof ac.createBiquadFilter === "function") {
      const hpf = ac.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = dcHighpassHz;
      head.connect(hpf);
      head = hpf;
    }
    if (preGainNode) {
      head.connect(preGainNode);
      head = preGainNode;
    }
    head.connect(gainNode);

    const dest = ensureMasterBus(ac) || ac.destination;
    let out = gainNode;
    if (Math.abs(pan) > 0.02 && typeof ac.createStereoPanner === "function") {
      const panner = ac.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gainNode.connect(panner);
      out = panner;
    }
    out.connect(dest);
    const rev = typeof getReverbNode === "function" ? getReverbNode() : null;
    if (reverbWet > 0.005 && rev) {
      const wetGain = ac.createGain();
      wetGain.gain.value = reverbWet;
      out.connect(wetGain).connect(rev);
    }
  }

  async function fetchAllBytes() {
    const doFetch = fetchFn || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    if (!doFetch) return;
    await Promise.all(
      allEntries.map(async ([, , cacheKey, url]) => {
        if (rawBytesCache.has(cacheKey) || decodedCache.has(cacheKey)) return;
        try {
          const res = await doFetch(url);
          if (!res || !res.ok) return;
          const buf = await res.arrayBuffer();
          if (buf && buf.byteLength > 44) {
            rawBytesCache.set(cacheKey, buf);
          }
        } catch (err) {
          console.warn(`Weapon audio fetch skipped for ${cacheKey}:`, err);
        }
      }),
    );
  }

  async function decodeAll() {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    if (!ac || typeof ac.decodeAudioData !== "function") return 0;
    await fetchAllBytes();
    await Promise.all(
      Array.from(rawBytesCache.entries()).map(async ([cacheKey, arrBuf]) => {
        if (decodedCache.has(cacheKey)) return;
        try {
          // Clone slice because WebAudio decodeAudioData detaches the passed ArrayBuffer
          const audioBuf = await ac.decodeAudioData(arrBuf.slice(0));
          if (audioBuf) decodedCache.set(cacheKey, audioBuf);
        } catch (err) {
          console.warn(`Weapon audio decode skipped for ${cacheKey}:`, err);
        }
      }),
    );
    return decodedCache.size;
  }

  async function preload() {
    if (!preloadPromise) {
      preloadPromise = fetchAllBytes();
    }
    await preloadPromise;
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    if (ac && decodedCache.size < allEntries.length) {
      if (!decodePromise) {
        decodePromise = decodeAll().finally(() => {
          decodePromise = null;
        });
      }
      await decodePromise;
    }
    return getStats();
  }

  function ensureDecodedOnGesture() {
    if (decodedCache.size < allEntries.length && !decodePromise) {
      decodePromise = decodeAll().finally(() => {
        decodePromise = null;
      });
    }
  }

  function getWeaponEntry(weaponId, soundType) {
    const wKey = normalizeWeaponAudioKey(weaponId);
    const bank = WEAPON_SOUND_BANKS[wKey];
    const cfg = bank && bank.tuning[soundType];
    if (!cfg) return null;
    const cacheKey = `${wKey}:${soundType}`;
    const buf = decodedCache.get(cacheKey);
    return { wKey, cfg, buf };
  }

  function playShot(weaponId = "m416") {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const entry = getWeaponEntry(weaponId, "shot");
    if (!ac || !entry || !isAudibleWaveform(entry.buf)) {
      ensureDecodedOnGesture();
      return false;
    }
    const { cfg, buf } = entry;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, cfg.pitchJitter, Math.random());

    const g = ac.createGain();
    g.gain.value = cfg.gain;
    connectSourceChain(ac, src, g, { dcHighpassHz: cfg.dcHighpassHz || 0, pan: 0, reverbWet: cfg.reverbWet });

    const trim = Math.min(cfg.trimStartSec, Math.max(0, buf.duration - 0.05));
    src.start(ac.currentTime, trim);
    return true;
  }

  function playRemoteShot(weaponId = "m416", dist = 0, pan = 0) {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const wKey = normalizeWeaponAudioKey(weaponId);
    const bank = WEAPON_SOUND_BANKS[wKey];
    const cfg = bank && bank.tuning.remoteShot;
    const buf = decodedCache.get(`${wKey}:shot`);
    if (!ac || !cfg || !isAudibleWaveform(buf)) {
      ensureDecodedOnGesture();
      return false;
    }
    const att = computeDistanceGain(dist, cfg.refDist);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, 0.04, Math.random());

    const lpf = ac.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = computeDistanceAirCutoffHz(dist);

    const g = ac.createGain();
    g.gain.value = cfg.gain * att;
    connectSourceChain(ac, src, g, {
      dcHighpassHz: cfg.dcHighpassHz || 0,
      preGainNode: lpf,
      pan,
      reverbWet: cfg.reverbWet * att,
    });

    const trim = Math.min(cfg.trimStartSec, Math.max(0, buf.duration - 0.05));
    src.start(ac.currentTime, trim);
    return true;
  }

  function playShell(weaponId = "m416", { isPuddle = false } = {}) {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const entry = getWeaponEntry(weaponId, "shell");
    if (!ac || !entry || !isAudibleWaveform(entry.buf)) {
      ensureDecodedOnGesture();
      return false;
    }
    const { wKey, cfg } = entry;
    const delayMs = (cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000;
    const tid = setTimeout(() => {
      activeTimers.delete(tid);
      const curAc = typeof getAudioContext === "function" ? getAudioContext() : null;
      const curBuf = decodedCache.get(`${wKey}:shell`);
      if (!curAc || !isAudibleWaveform(curBuf)) return;

      const src = curAc.createBufferSource();
      src.buffer = curBuf;
      src.playbackRate.value = computeAutoPitch(isPuddle ? 0.88 : 1.0, 0.07, Math.random());

      let preFilter = null;
      if (isPuddle && typeof curAc.createBiquadFilter === "function") {
        preFilter = curAc.createBiquadFilter();
        preFilter.type = "lowpass";
        preFilter.frequency.value = 1800;
      }

      const g = curAc.createGain();
      g.gain.value = cfg.gain * (isPuddle ? 0.55 : 0.88 + Math.random() * 0.24);
      connectSourceChain(curAc, src, g, {
        dcHighpassHz: cfg.dcHighpassHz || 0,
        preGainNode: preFilter,
        pan: cfg.panRight,
        reverbWet: cfg.reverbWet,
      });
      const trim = Math.min(cfg.trimStartSec, Math.max(0, curBuf.duration - 0.04));
      src.start(curAc.currentTime, trim);
    }, delayMs);
    activeTimers.add(tid);
    return true;
  }

  function stopReload() {
    if (!activeReload) return;
    const { src, gain, ac } = activeReload;
    activeReload = null;
    try {
      const t = ac.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0.0001, t + 0.035);
      src.stop(t + 0.045);
    } catch {
      try {
        src.stop();
      } catch {}
    }
  }

  function playReload(weaponId = "m416", { isTactical = false } = {}) {
    stopReload();
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const entry = getWeaponEntry(weaponId, "reload");
    if (!ac || !entry || !isAudibleWaveform(entry.buf)) {
      ensureDecodedOnGesture();
      return false;
    }
    const { wKey, cfg, buf } = entry;
    const timing = computeReloadPlaybackConfig(buf.duration, isTactical, wKey);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = timing.playbackRate;

    const g = ac.createGain();
    const t = ac.currentTime;
    g.gain.setValueAtTime(cfg.gain, t);
    const effectivePlayDur = Math.max(0.1, buf.duration - cfg.trimStartSec) / timing.playbackRate;
    if (isTactical && timing.maxPlaySec < effectivePlayDur - 0.05) {
      g.gain.setValueAtTime(cfg.gain, t + Math.max(0.05, timing.maxPlaySec - 0.06));
      g.gain.linearRampToValueAtTime(0.0001, t + timing.maxPlaySec);
    }

    connectSourceChain(ac, src, g, { dcHighpassHz: cfg.dcHighpassHz || 0, pan: 0.05, reverbWet: cfg.reverbWet });

    const token = { src, gain: g, ac };
    activeReload = token;
    src.onended = () => {
      if (activeReload === token) activeReload = null;
    };
    const trim = Math.min(cfg.trimStartSec, Math.max(0, buf.duration - 0.1));
    src.start(t, trim, timing.maxPlaySec);
    return true;
  }

  function playDryfire(weaponId = "m416") {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const entry = getWeaponEntry(weaponId, "dryfire");
    if (!ac || !entry || !isAudibleWaveform(entry.buf)) {
      ensureDecodedOnGesture();
      return false;
    }
    const { cfg, buf } = entry;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, 0.04, Math.random());

    const g = ac.createGain();
    g.gain.value = cfg.gain;
    connectSourceChain(ac, src, g, { dcHighpassHz: cfg.dcHighpassHz || 0, pan: 0, reverbWet: cfg.reverbWet });
    src.start(ac.currentTime, cfg.trimStartSec);
    return true;
  }

  function clearScheduledTimers() {
    for (const tid of activeTimers) clearTimeout(tid);
    activeTimers.clear();
    stopReload();
  }

  function hasBuffer(weaponIdOrKey, maybeSoundType) {
    if (typeof maybeSoundType === "string") {
      const wKey = normalizeWeaponAudioKey(weaponIdOrKey);
      const buf = decodedCache.get(`${wKey}:${maybeSoundType}`);
      return isAudibleWaveform(buf);
    }
    return isAudibleWaveform(decodedCache.get(`m416:${weaponIdOrKey}`));
  }

  function getStats() {
    const loadedKeys = [];
    const fetchedKeys = [];
    const byWeapon = {};
    for (const [wKey, bank] of Object.entries(WEAPON_SOUND_BANKS)) {
      const types = Object.keys(bank.paths);
      const wLoaded = types.filter((t) => decodedCache.has(`${wKey}:${t}`));
      const wAudible = types.filter((t) => isAudibleWaveform(decodedCache.get(`${wKey}:${t}`)));
      const wFetched = types.filter((t) => rawBytesCache.has(`${wKey}:${t}`) || decodedCache.has(`${wKey}:${t}`));
      for (const t of wLoaded) loadedKeys.push(`${wKey}:${t}`);
      for (const t of wFetched) fetchedKeys.push(`${wKey}:${t}`);
      byWeapon[wKey] = {
        totalCount: types.length,
        fetchedCount: wFetched.length,
        loadedCount: wLoaded.length,
        audibleCount: wAudible.length,
        loadedKeys: wLoaded,
      };
    }
    return {
      totalCount: allEntries.length,
      fetchedCount: fetchedKeys.length,
      loadedCount: loadedKeys.length,
      loadedKeys,
      byWeapon,
      reloadPlaying: Boolean(activeReload),
    };
  }

  return {
    preload,
    ensureDecodedOnGesture,
    playShot,
    playRemoteShot,
    playShell,
    playReload,
    playDryfire,
    playM416Shot: () => playShot("m416"),
    playM416RemoteShot: (dist = 0, pan = 0) => playRemoteShot("m416", dist, pan),
    playM416Shell: (opts = {}) => playShell("m416", opts),
    playM416Reload: (opts = {}) => playReload("m416", opts),
    playM416Dryfire: () => playDryfire("m416"),
    stopReload,
    clearScheduledTimers,
    isReloadPlaying: () => Boolean(activeReload),
    hasBuffer,
    getStats,
  };
}
