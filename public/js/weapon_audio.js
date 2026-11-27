/**
 * Weapon Audio Bank & Calibrated WebAudio Playback (M416 real outdoor/mechanical WAV assets):
 * - Pure helpers (Node-testable): distance gain, air-absorption lowpass cutoff, jittered pitch,
 *   and tactical/empty reload playback calibration.
 * - Browser engine: pre-fetches & decodes WAV ArrayBuffers during Loading Screen, applies gain
 *   staging + soft DynamicsCompressor headroom, tracks interruptible reload playback, and falls
 *   back gracefully to procedural synth if audio hardware or decode is unavailable.
 */

export const M416_SOUND_PATHS = Object.freeze({
  shot: "/sound/m416/m416_standard_outdoor_shot.wav",
  reload: "/sound/m416/m416_reload.wav",
  shell: "/sound/m416/m416_shell_casing.wav",
  dryfire: "/sound/m416/m416_dryfire.wav",
});

// Gains calibrated directly against actual WAV peak levels so M416 punches cleanly without clipping:
// shot peak=0.30 (-10.4 dBFS), reload peak=0.23, shell peak=0.18, dryfire peak=0.03 (-31 dBFS).
export const M416_SOUND_TUNING = Object.freeze({
  shot: Object.freeze({ gain: 1.95, trimStartSec: 0.0085, reverbWet: 0.16, pitchJitter: 0.032 }),
  remoteShot: Object.freeze({ gain: 1.65, trimStartSec: 0.0085, reverbWet: 0.24, refDist: 10.5 }),
  reload: Object.freeze({ gain: 1.45, trimStartSec: 0.0, reverbWet: 0.04 }),
  shell: Object.freeze({ gain: 0.62, trimStartSec: 0.0, reverbWet: 0.05, delayMin: 0.24, delayMax: 0.34, panRight: 0.30 }),
  dryfire: Object.freeze({ gain: 4.5, trimStartSec: 0.0, reverbWet: 0.02 }),
});

export function extractAudioAssetPaths() {
  return Object.values(M416_SOUND_PATHS);
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
 * Compute playbackRate and optional early cutoff for m416_reload.wav (1.394s natural length):
 * - Empty reload (2.40s): slightly stretched (0.80x -> 1.74s) so bolt pull aligns cleanly.
 * - Tactical reload (1.85s, no bolt rack): plays mag-out + mag-in cleanly and fades before bolt rack (~0.94s).
 */
export function computeReloadPlaybackConfig(rawDurationSec = 1.394, isTactical = false) {
  const dur = Number.isFinite(rawDurationSec) && rawDurationSec > 0.2 ? rawDurationSec : 1.394;
  if (isTactical) {
    return {
      playbackRate: 0.96,
      maxPlaySec: Math.min(dur / 0.96, 0.95),
    };
  }
  return {
    playbackRate: 0.80,
    maxPlaySec: dur / 0.80,
  };
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

  function routeGainNode(ac, gainNode, pan = 0, reverbWet = 0) {
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
      Object.entries(M416_SOUND_PATHS).map(async ([key, url]) => {
        if (rawBytesCache.has(key) || decodedCache.has(key)) return;
        try {
          const res = await doFetch(url);
          if (!res || !res.ok) return;
          const buf = await res.arrayBuffer();
          if (buf && buf.byteLength > 44) {
            rawBytesCache.set(key, buf);
          }
        } catch (err) {
          console.warn(`M416 audio fetch skipped for ${key}:`, err);
        }
      }),
    );
  }

  async function decodeAll() {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    if (!ac || typeof ac.decodeAudioData !== "function") return 0;
    await fetchAllBytes();
    await Promise.all(
      Array.from(rawBytesCache.entries()).map(async ([key, arrBuf]) => {
        if (decodedCache.has(key)) return;
        try {
          // Clone slice because WebAudio decodeAudioData detaches the passed ArrayBuffer
          const audioBuf = await ac.decodeAudioData(arrBuf.slice(0));
          if (audioBuf) decodedCache.set(key, audioBuf);
        } catch (err) {
          console.warn(`M416 audio decode skipped for ${key}:`, err);
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
    if (ac && decodedCache.size < Object.keys(M416_SOUND_PATHS).length) {
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
    if (decodedCache.size < Object.keys(M416_SOUND_PATHS).length && !decodePromise) {
      decodePromise = decodeAll().finally(() => {
        decodePromise = null;
      });
    }
  }

  function playM416Shot() {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const buf = decodedCache.get("shot");
    if (!ac || !buf) {
      ensureDecodedOnGesture();
      return false;
    }
    const cfg = M416_SOUND_TUNING.shot;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, cfg.pitchJitter, Math.random());

    const g = ac.createGain();
    g.gain.value = cfg.gain;
    src.connect(g);
    routeGainNode(ac, g, 0, cfg.reverbWet);

    const t = ac.currentTime;
    const trim = Math.min(cfg.trimStartSec, Math.max(0, buf.duration - 0.05));
    src.start(t, trim);
    return true;
  }

  function playM416RemoteShot(dist = 0, pan = 0) {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const buf = decodedCache.get("shot");
    if (!ac || !buf) {
      ensureDecodedOnGesture();
      return false;
    }
    const cfg = M416_SOUND_TUNING.remoteShot;
    const att = computeDistanceGain(dist, cfg.refDist);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, 0.04, Math.random());

    const lpf = ac.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = computeDistanceAirCutoffHz(dist);

    const g = ac.createGain();
    g.gain.value = cfg.gain * att;
    src.connect(lpf).connect(g);
    routeGainNode(ac, g, pan, cfg.reverbWet * att);

    const t = ac.currentTime;
    const trim = Math.min(cfg.trimStartSec, Math.max(0, buf.duration - 0.05));
    src.start(t, trim);
    return true;
  }

  function playM416Shell({ isPuddle = false } = {}) {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const buf = decodedCache.get("shell");
    if (!ac || !buf) {
      ensureDecodedOnGesture();
      return false;
    }
    const cfg = M416_SOUND_TUNING.shell;
    const delayMs = (cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin)) * 1000;
    const tid = setTimeout(() => {
      activeTimers.delete(tid);
      const curAc = typeof getAudioContext === "function" ? getAudioContext() : null;
      const curBuf = decodedCache.get("shell");
      if (!curAc || !curBuf) return;

      const src = curAc.createBufferSource();
      src.buffer = curBuf;
      src.playbackRate.value = computeAutoPitch(isPuddle ? 0.88 : 1.0, 0.07, Math.random());

      let tailNode = src;
      if (isPuddle) {
        const lpf = curAc.createBiquadFilter();
        lpf.type = "lowpass";
        lpf.frequency.value = 1800;
        src.connect(lpf);
        tailNode = lpf;
      }

      const g = curAc.createGain();
      g.gain.value = cfg.gain * (isPuddle ? 0.55 : 0.88 + Math.random() * 0.24);
      tailNode.connect(g);
      routeGainNode(curAc, g, cfg.panRight, cfg.reverbWet);
      src.start(curAc.currentTime, cfg.trimStartSec);
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

  function playM416Reload({ isTactical = false } = {}) {
    stopReload();
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const buf = decodedCache.get("reload");
    if (!ac || !buf) {
      ensureDecodedOnGesture();
      return false;
    }
    const cfg = M416_SOUND_TUNING.reload;
    const timing = computeReloadPlaybackConfig(buf.duration, isTactical);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = timing.playbackRate;

    const g = ac.createGain();
    const t = ac.currentTime;
    g.gain.setValueAtTime(cfg.gain, t);
    if (isTactical && timing.maxPlaySec < buf.duration / timing.playbackRate - 0.05) {
      g.gain.setValueAtTime(cfg.gain, t + Math.max(0.05, timing.maxPlaySec - 0.06));
      g.gain.linearRampToValueAtTime(0.0001, t + timing.maxPlaySec);
    }

    src.connect(g);
    routeGainNode(ac, g, 0.05, cfg.reverbWet);

    const token = { src, gain: g, ac };
    activeReload = token;
    src.onended = () => {
      if (activeReload === token) activeReload = null;
    };
    src.start(t, cfg.trimStartSec, timing.maxPlaySec);
    return true;
  }

  function playM416Dryfire() {
    const ac = typeof getAudioContext === "function" ? getAudioContext() : null;
    const buf = decodedCache.get("dryfire");
    if (!ac || !buf) {
      ensureDecodedOnGesture();
      return false;
    }
    const cfg = M416_SOUND_TUNING.dryfire;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = computeAutoPitch(1.0, 0.04, Math.random());

    const g = ac.createGain();
    g.gain.value = cfg.gain;
    src.connect(g);
    routeGainNode(ac, g, 0, cfg.reverbWet);
    src.start(ac.currentTime, cfg.trimStartSec);
    return true;
  }

  function clearScheduledTimers() {
    for (const tid of activeTimers) clearTimeout(tid);
    activeTimers.clear();
    stopReload();
  }

  function getStats() {
    const keys = Object.keys(M416_SOUND_PATHS);
    const loadedKeys = keys.filter((k) => decodedCache.has(k));
    const fetchedKeys = keys.filter((k) => rawBytesCache.has(k) || decodedCache.has(k));
    return {
      totalCount: keys.length,
      fetchedCount: fetchedKeys.length,
      loadedCount: loadedKeys.length,
      loadedKeys,
      reloadPlaying: Boolean(activeReload),
    };
  }

  return {
    preload,
    ensureDecodedOnGesture,
    playM416Shot,
    playM416RemoteShot,
    playM416Shell,
    playM416Reload,
    stopReload,
    playM416Dryfire,
    clearScheduledTimers,
    isReloadPlaying: () => Boolean(activeReload),
    hasBuffer: (key) => decodedCache.has(key),
    getStats,
  };
}

