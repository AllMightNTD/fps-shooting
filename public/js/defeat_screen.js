/**
 * Minimalist cinematic "TỬ TRẬN" (Defeat) overlay controller for Offline Solo Survival mode.
 * - Fullscreen dark atmosphere with ash/crimson ember & fog canvas (RAF runs ONLY while active)
 * - Impact shake, crimson flash, horizontal light sweep, tracking-expanding RGB-glitch title
 * - Single tactical "QUAY VỀ SẢNH" button + smooth 5-second auto-return countdown & fade-out to Lobby
 */

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_REVEAL_DELAY_MS = 850;
const DEFAULT_FADE_CALLBACK_MS = 450;
const DEFAULT_FADE_COMPLETE_MS = 900;

export function createDefeatScreenController(options = {}) {
  const doc = options.documentRef || (typeof document !== "undefined" ? document : null);
  const win = options.windowRef || (typeof window !== "undefined" ? window : globalThis);
  const nowFn = typeof options.nowFn === "function" ? options.nowFn : () => performance.now();
  const rafFn =
    typeof options.rafFn === "function"
      ? options.rafFn
      : typeof win.requestAnimationFrame === "function"
        ? win.requestAnimationFrame.bind(win)
        : (cb) => setTimeout(() => cb(nowFn()), 16);
  const cafFn =
    typeof options.cafFn === "function"
      ? options.cafFn
      : typeof win.cancelAnimationFrame === "function"
        ? win.cancelAnimationFrame.bind(win)
        : (id) => clearTimeout(id);
  const setTimer = typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const clearTimer = typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn : clearTimeout;

  const durationMs =
    Number.isFinite(Number(options.durationMs)) && Number(options.durationMs) > 0
      ? Number(options.durationMs)
      : DEFAULT_DURATION_MS;
  const revealDelayMs =
    Number.isFinite(Number(options.revealDelayMs)) && Number(options.revealDelayMs) >= 0
      ? Number(options.revealDelayMs)
      : DEFAULT_REVEAL_DELAY_MS;
  const fadeCallbackMs =
    Number.isFinite(Number(options.fadeCallbackMs)) && Number(options.fadeCallbackMs) >= 0
      ? Number(options.fadeCallbackMs)
      : DEFAULT_FADE_CALLBACK_MS;
  const fadeCompleteMs =
    Number.isFinite(Number(options.fadeCompleteMs)) && Number(options.fadeCompleteMs) >= fadeCallbackMs
      ? Number(options.fadeCompleteMs)
      : Math.max(DEFAULT_FADE_COMPLETE_MS, fadeCallbackMs + 400);
  const onReturnToLobby = typeof options.onReturnToLobby === "function" ? options.onReturnToLobby : null;

  const getEl = (id) => (doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null);

  const overlay = options.elements?.overlay || getEl("defeatOverlay");
  const canvas = options.elements?.canvas || getEl("defeatAtmosphereCanvas");
  const impactStage = options.elements?.impactStage || getEl("defeatImpactStage");
  const redFlash = options.elements?.redFlash || getEl("defeatRedFlash");
  const lightSweep = options.elements?.lightSweep || getEl("defeatLightSweep");
  const lineTop = options.elements?.lineTop || getEl("defeatLineTop");
  const lineBottom = options.elements?.lineBottom || getEl("defeatLineBottom");
  const defeatTitle = options.elements?.defeatTitle || getEl("defeatTitle");
  const actionArea = options.elements?.actionArea || getEl("defeatActionArea");
  const btnReturnLobby = options.elements?.btnReturnLobby || getEl("btnDefeatReturnLobby");
  const btnProgressBar = options.elements?.btnProgressBar || getEl("defeatBtnProgressBar");
  const progressFill = options.elements?.progressFill || getEl("defeatProgressFill");
  const countdownSecondsEl = options.elements?.countdownSecondsEl || getEl("defeatCountdownSeconds");

  const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

  let seq = 0;
  let isActive = false;
  let isReturning = false;
  let remainingMs = durationMs;
  let countdownRafId = null;
  let canvasRafId = null;
  let revealTimerId = null;
  let returnCbTimerId = null;
  let stopCanvasTimerId = null;
  let ashParticles = [];
  let fogBlobs = [];

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = Number(win.innerWidth) || 1280;
    canvas.height = Number(win.innerHeight) || 720;
  }

  function initAtmosphere() {
    if (!canvas || !ctx) return;
    resizeCanvas();
    ashParticles = [];
    fogBlobs = [];

    const ashCount = Math.min(55, Math.max(24, Math.floor(canvas.width / 28)));
    for (let i = 0; i < ashCount; i++) {
      const isEmber = Math.random() < 0.28;
      ashParticles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: isEmber ? Math.random() * 1.8 + 0.7 : Math.random() * 1.4 + 0.5,
        vx: (Math.random() - 0.45) * 0.32,
        vy: -(Math.random() * 0.42 + 0.12),
        alpha: isEmber ? Math.random() * 0.55 + 0.25 : Math.random() * 0.25 + 0.08,
        swayOffset: Math.random() * Math.PI * 2,
        isEmber,
      });
    }

    for (let i = 0; i < 5; i++) {
      fogBlobs.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 340 + 240,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.12,
        alpha: Math.random() * 0.045 + 0.02,
        tintRed: i % 2 === 0,
      });
    }
  }

  function stopAtmosphereLoop() {
    if (canvasRafId !== null) {
      cafFn(canvasRafId);
      canvasRafId = null;
    }
  }

  function startAtmosphereLoop(runId) {
    stopAtmosphereLoop();
    if (!canvas || !ctx) return;
    initAtmosphere();

    const frame = (time) => {
      if (runId !== seq) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const fog of fogBlobs) {
        fog.x += fog.vx;
        fog.y += fog.vy;
        if (fog.x < -fog.r) fog.x = canvas.width + fog.r;
        if (fog.x > canvas.width + fog.r) fog.x = -fog.r;
        if (fog.y < -fog.r) fog.y = canvas.height + fog.r;
        if (fog.y > canvas.height + fog.r) fog.y = -fog.r;

        const grad = ctx.createRadialGradient(fog.x, fog.y, 10, fog.x, fog.y, fog.r);
        grad.addColorStop(0, fog.tintRed ? `rgba(127, 29, 29, ${fog.alpha})` : `rgba(51, 65, 85, ${fog.alpha})`);
        grad.addColorStop(1, "rgba(5, 6, 8, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(fog.x, fog.y, fog.r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const p of ashParticles) {
        p.x += p.vx + Math.sin(time * 0.0008 + p.swayOffset) * 0.18;
        p.y += p.vy;
        if (p.y < -10) {
          p.y = canvas.height + 10;
          p.x = Math.random() * canvas.width;
        }
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;

        if (p.isEmber) {
          // Soft outer ember halo + crisp core (20x faster than Canvas2D shadowBlur Gaussian filter)
          ctx.beginPath();
          ctx.fillStyle = `rgba(220, 38, 38, ${(p.alpha * 0.28).toFixed(3)})`;
          ctx.arc(p.x, p.y, p.radius * 2.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = `rgba(239, 68, 68, ${p.alpha})`;
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.fillStyle = `rgba(203, 213, 225, ${p.alpha})`;
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      canvasRafId = rafFn(frame);
    };

    canvasRafId = rafFn(frame);
  }

  function stopCountdown() {
    if (countdownRafId !== null) {
      cafFn(countdownRafId);
      countdownRafId = null;
    }
  }

  function clearPendingTimers() {
    if (revealTimerId !== null) { clearTimer(revealTimerId); revealTimerId = null; }
    if (returnCbTimerId !== null) { clearTimer(returnCbTimerId); returnCbTimerId = null; }
    if (stopCanvasTimerId !== null) { clearTimer(stopCanvasTimerId); stopCanvasTimerId = null; }
  }

  function setProgressRatio(ratio) {
    const clamped = Math.max(0, Math.min(1, ratio));
    const tf = `scaleX(${clamped})`;
    if (progressFill) progressFill.style.transform = tf;
    if (btnProgressBar) btnProgressBar.style.transform = tf;
  }

  function startCountdown(runId) {
    stopCountdown();
    const startTime = nowFn();

    const update = (now) => {
      if (runId !== seq || isReturning) return;
      const curNow = Number.isFinite(now) ? now : nowFn();
      const elapsed = Math.max(0, curNow - startTime);
      remainingMs = Math.max(0, durationMs - elapsed);
      const ratio = remainingMs / durationMs;

      if (countdownSecondsEl) {
        countdownSecondsEl.textContent = String(Math.ceil(remainingMs / 1000));
      }
      setProgressRatio(ratio);

      if (remainingMs > 0) {
        countdownRafId = rafFn(update);
      } else {
        if (countdownSecondsEl) countdownSecondsEl.textContent = "0";
        returnToLobby();
      }
    };

    countdownRafId = rafFn(update);
  }

  function returnToLobby() {
    if (!isActive || isReturning) return false;
    isReturning = true;
    const runId = seq;
    stopCountdown();
    if (revealTimerId !== null) {
      clearTimer(revealTimerId);
      revealTimerId = null;
    }

    if (overlay) overlay.classList.add("hidden-screen");

    returnCbTimerId = setTimer(() => {
      returnCbTimerId = null;
      if (runId !== seq) return;
      if (onReturnToLobby) {
        try {
          onReturnToLobby();
        } catch (err) {
          console.error("Defeat screen onReturnToLobby callback error:", err);
        }
      }
    }, fadeCallbackMs);

    stopCanvasTimerId = setTimer(() => {
      stopCanvasTimerId = null;
      if (runId !== seq) return;
      isActive = false;
      isReturning = false;
      stopAtmosphereLoop();
    }, fadeCompleteMs);

    return true;
  }

  function hideImmediate() {
    seq++;
    isActive = false;
    isReturning = false;
    remainingMs = durationMs;
    stopCountdown();
    stopAtmosphereLoop();
    clearPendingTimers();
    if (overlay) overlay.classList.add("hidden-screen");
    if (actionArea) actionArea.classList.remove("visible");
  }

  function trigger() {
    const runId = ++seq;
    isActive = true;
    isReturning = false;
    remainingMs = durationMs;
    stopCountdown();
    clearPendingTimers();

    if (overlay) overlay.classList.remove("hidden-screen");

    if (impactStage) impactStage.classList.remove("shake-active");
    if (redFlash) redFlash.classList.remove("flash-active");
    if (lightSweep) lightSweep.classList.remove("sweep-active");
    if (lineTop) lineTop.classList.remove("expanded");
    if (lineBottom) lineBottom.classList.remove("expanded");
    if (defeatTitle) defeatTitle.classList.remove("reveal-active");
    if (actionArea) actionArea.classList.remove("visible");

    setProgressRatio(1);
    if (countdownSecondsEl) {
      countdownSecondsEl.textContent = String(Math.ceil(durationMs / 1000));
    }

    // Force style reflow so CSS keyframe animations restart cleanly on repeat runs
    if (impactStage) void impactStage.offsetWidth;

    startAtmosphereLoop(runId);

    // Stage 1: Impact shake, crimson flash & horizontal light sweep
    if (impactStage) impactStage.classList.add("shake-active");
    if (redFlash) redFlash.classList.add("flash-active");
    if (lightSweep) lightSweep.classList.add("sweep-active");

    // Stage 2: Blurred-to-sharp tracking-expanding "TỬ TRẬN" + hairline dividers
    if (defeatTitle) defeatTitle.classList.add("reveal-active");
    if (lineTop) lineTop.classList.add("expanded");
    if (lineBottom) lineBottom.classList.add("expanded");

    // Stage 3: Reveal tactical return button & begin 5s auto-return countdown
    revealTimerId = setTimer(() => {
      revealTimerId = null;
      if (runId !== seq || isReturning) return;
      if (actionArea) actionArea.classList.add("visible");
      startCountdown(runId);
    }, revealDelayMs);

    return true;
  }

  const onButtonClick = () => returnToLobby();
  const onWindowResize = () => {
    if (isActive) resizeCanvas();
  };

  if (btnReturnLobby && typeof btnReturnLobby.addEventListener === "function") {
    btnReturnLobby.addEventListener("click", onButtonClick);
  }
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("resize", onWindowResize);
  }

  function destroy() {
    hideImmediate();
    if (btnReturnLobby && typeof btnReturnLobby.removeEventListener === "function") {
      btnReturnLobby.removeEventListener("click", onButtonClick);
    }
    if (win && typeof win.removeEventListener === "function") {
      win.removeEventListener("resize", onWindowResize);
    }
  }

  return {
    trigger,
    returnToLobby,
    hideImmediate,
    destroy,
    getState: () => ({
      active: isActive,
      returning: isReturning,
      remainingMs,
      atmosphereRunning: canvasRafId !== null,
    }),
  };
}

