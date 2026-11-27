/**
 * Main Lobby Background Music Controller (sound/Before_the_Breach.mp3):
 * - Pure helpers (Node-testable): target state evaluation (only plays in Main Lobby when
 *   loading screen is dismissed, tab is visible, and music is enabled), volume clamping, fade lerp.
 * - Browser controller: streams via HTMLAudioElement (zero startup PCM decode hitch), handles
 *   browser autoplay blocking via one-time gesture unlock, smooth fade-in/fade-out transitions,
 *   and instant mute/volume sync with settings.
 */

export const LOBBY_MUSIC_URL = "/sound/Before_the_Breach.mp3";
export const DEFAULT_LOBBY_MUSIC_VOLUME = 0.45;

export function clampMusicVolume(v, fallback = DEFAULT_LOBBY_MUSIC_VOLUME) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

export function shouldLobbyMusicPlay({
  screen = "lobby",
  loadingVisible = false,
  inMatch = false,
  enabled = true,
  tabHidden = false,
} = {}) {
  return Boolean(enabled && !loadingVisible && !inMatch && !tabHidden && screen === "lobby");
}

export function createLobbyMusicController({
  url = LOBBY_MUSIC_URL,
  initialEnabled = true,
  initialVolume = DEFAULT_LOBBY_MUSIC_VOLUME,
  createAudioFn = null,
  fadeMs = 600,
  doc = typeof document !== "undefined" ? document : null,
  win = typeof window !== "undefined" ? window : null,
} = {}) {
  let enabled = Boolean(initialEnabled);
  let targetVolume = clampMusicVolume(initialVolume);
  let screen = "lobby";
  let loadingVisible = true;
  let inMatch = false;
  let tabHidden = Boolean(doc && doc.hidden);
  let blockedByAutoplay = false;
  let audio = null;
  let fadeRaf = 0;
  let fadeStart = 0;
  let fadeFrom = 0;
  let fadeTo = 0;
  let pauseAfterFade = false;
  const listeners = new Set();

  function notify() {
    const st = getState();
    for (const fn of listeners) {
      try {
        fn(st);
      } catch {}
    }
  }

  function ensureAudio() {
    if (audio) return audio;
    const make =
      createAudioFn ||
      (typeof globalThis.Audio === "function" ? (src) => new globalThis.Audio(src) : null);
    if (!make) return null;
    try {
      audio = make(url);
      audio.loop = true;
      audio.preload = "auto";
      audio.volume = 0;
    } catch {
      audio = null;
    }
    return audio;
  }

  function stopFade() {
    if (fadeRaf && win && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(fadeRaf);
    }
    fadeRaf = 0;
  }

  function runFade(nextVol, shouldPauseAfter = false) {
    if (!audio) return;
    stopFade();
    const clampedTo = Math.max(0, Math.min(1, nextVol));
    if (fadeMs <= 0 || !win || typeof win.requestAnimationFrame !== "function") {
      audio.volume = clampedTo;
      if (shouldPauseAfter) audio.pause();
      return;
    }
    fadeFrom = Number.isFinite(audio.volume) ? audio.volume : 0;
    fadeTo = clampedTo;
    pauseAfterFade = shouldPauseAfter;
    fadeStart = typeof performance !== "undefined" ? performance.now() : Date.now();

    const step = (nowTs) => {
      if (!audio) {
        fadeRaf = 0;
        return;
      }
      const now = Number.isFinite(nowTs) ? nowTs : (typeof performance !== "undefined" ? performance.now() : Date.now());
      const t = Math.max(0, Math.min(1, (now - fadeStart) / fadeMs));
      audio.volume = fadeFrom + (fadeTo - fadeFrom) * t;
      if (t < 1) {
        fadeRaf = win.requestAnimationFrame(step);
      } else {
        fadeRaf = 0;
        audio.volume = fadeTo;
        if (pauseAfterFade) audio.pause();
      }
    };
    fadeRaf = win.requestAnimationFrame(step);
  }

  function sync() {
    const wantPlay = shouldLobbyMusicPlay({
      screen,
      loadingVisible,
      inMatch,
      enabled,
      tabHidden,
    });
    if (!wantPlay) {
      if (audio && !audio.paused) {
        runFade(0, true);
      } else {
        stopFade();
        if (audio) audio.volume = 0;
      }
      notify();
      return;
    }

    const a = ensureAudio();
    if (!a) {
      notify();
      return;
    }
    if (a.paused) {
      a.volume = 0;
      try {
        const res = a.play();
        if (res && typeof res.then === "function") {
          res
            .then(() => {
              blockedByAutoplay = false;
              runFade(targetVolume, false);
              notify();
            })
            .catch(() => {
              blockedByAutoplay = true;
              notify();
            });
        } else {
          blockedByAutoplay = false;
          runFade(targetVolume, false);
        }
      } catch {
        blockedByAutoplay = true;
      }
    } else {
      runFade(targetVolume, false);
    }
    notify();
  }

  function unlockOnGesture() {
    if (!blockedByAutoplay) return;
    if (shouldLobbyMusicPlay({ screen, loadingVisible, inMatch, enabled, tabHidden })) {
      sync();
    }
  }

  function onVisibilityChange() {
    tabHidden = Boolean(doc && doc.hidden);
    sync();
  }

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("pointerdown", unlockOnGesture, { passive: true });
    win.addEventListener("keydown", unlockOnGesture, { passive: true });
  }
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("visibilitychange", onVisibilityChange);
  }

  function getState() {
    return {
      url,
      enabled,
      volume: targetVolume,
      screen,
      loadingVisible,
      inMatch,
      tabHidden,
      blockedByAutoplay,
      shouldPlay: shouldLobbyMusicPlay({ screen, loadingVisible, inMatch, enabled, tabHidden }),
      isPlaying: Boolean(audio && !audio.paused),
      currentAudioVolume: audio ? Number(audio.volume.toFixed(3)) : 0,
    };
  }

  return {
    setScreen(nextScreen) {
      screen = String(nextScreen || "lobby");
      sync();
    },
    setLoadingVisible(visible) {
      loadingVisible = Boolean(visible);
      sync();
    },
    setInMatch(active) {
      inMatch = Boolean(active);
      sync();
    },
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      sync();
    },
    setVolume(nextVolume) {
      targetVolume = clampMusicVolume(nextVolume, targetVolume);
      sync();
    },
    applySettings({ lobbyMusicEnabled, lobbyMusicVolume } = {}) {
      if (typeof lobbyMusicEnabled === "boolean") enabled = lobbyMusicEnabled;
      if (lobbyMusicVolume !== undefined) targetVolume = clampMusicVolume(lobbyMusicVolume, targetVolume);
      sync();
    },
    unlock() {
      blockedByAutoplay = true;
      unlockOnGesture();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState,
    destroy() {
      stopFade();
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener("pointerdown", unlockOnGesture);
        win.removeEventListener("keydown", unlockOnGesture);
      }
      if (doc && typeof doc.removeEventListener === "function") {
        doc.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (audio) {
        try {
          audio.pause();
        } catch {}
      }
      listeners.clear();
    },
  };
}

