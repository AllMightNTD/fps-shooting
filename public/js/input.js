/**
 * Three-layer Input Architecture (Device -> BIND Action Map -> Game State):
 * - Uses physical e.code so Vietnamese IME / keyboard layouts never break WASD.
 * - Active strictly during Pointer Lock (with Alt+Tab/blur reset & browser guardrails).
 * - Prevents the pointer-lock click itself from triggering an accidental shot.
 */

const SYSTEM_PASSTHROUGH_CODES = new Set(["F5", "F11", "F12", "Escape"]);

export class InputController {
  constructor({ settings, onLockChange, onPauseMenu, onLockError }) {
    this.settings = settings;
    this.onLockChange = onLockChange || (() => {});
    this.onPauseMenu = onPauseMenu || (() => {});
    this.onLockError = onLockError || (() => {});

    this.canvas = null;
    this.active = false;
    this.textFocusBlocked = false;
    this.held = new Set();
    this.pressed = new Set();
    this.fireHeld = false;
    this.fireJustPressed = false;
    this.adsHeld = false;
    this.adsToggled = false;
    this.adsJustPressed = false;
    this.crouchToggled = false;
    this.dx = 0;
    this.dy = 0;
    this.wheelDir = 0;
    this.lockIgnoreFireUntil = 0;
    this.captureCallback = null;
    this._attached = false;
  }

  captureNextKey(cb) {
    this.captureCallback = cb;
  }

  cancelKeyCapture() {
    this.captureCallback = null;
  }

  setTextFocusBlocked(blocked) {
    this.textFocusBlocked = Boolean(blocked);
    if (blocked) this.reset();
  }

  tryLock() {
    if (!this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          try {
            const p2 = this.canvas.requestPointerLock();
            if (p2 && typeof p2.catch === "function") p2.catch(() => {});
          } catch {
            // Ignored
          }
        });
      }
    } catch {
      try {
        const p2 = this.canvas.requestPointerLock();
        if (p2 && typeof p2.catch === "function") p2.catch(() => {});
      } catch {
        // Browser blocked lock outside user gesture
      }
    }
  }

  _tryKeyboardLock() {
    try {
      if (
        document.fullscreenElement &&
        navigator.keyboard &&
        typeof navigator.keyboard.lock === "function"
      ) {
        navigator.keyboard.lock(["ControlLeft"]).catch(() => {});
      }
    } catch {
      // Non-Chromium or insecure context
    }
  }

  attach(canvas) {
    if (this._attached) return;
    this._attached = true;
    this.canvas = canvas;

    addEventListener("keydown", (e) => {
      if (this.captureCallback) {
        e.preventDefault();
        const cb = this.captureCallback;
        this.captureCallback = null;
        cb(e.code);
        return;
      }

      if (SYSTEM_PASSTHROUGH_CODES.has(e.code) || e.altKey || e.metaKey) {
        return;
      }

      if (!this.active || this.textFocusBlocked) return;
      e.preventDefault();
      if (e.repeat) return;

      this.held.add(e.code);
      this.pressed.add(e.code);

      const bind = this.settings.getBindings();
      if (
        this.settings.get().crouchMode === "toggle" &&
        bind.crouch &&
        bind.crouch.includes(e.code)
      ) {
        this.crouchToggled = !this.crouchToggled;
      }
    });

    addEventListener("keyup", (e) => {
      this.held.delete(e.code);
    });

    addEventListener("mousedown", (e) => {
      if (!this.active || this.textFocusBlocked) return;
      if (e.button === 0) {
        if (performance.now() < this.lockIgnoreFireUntil) return;
        this.fireHeld = true;
        this.fireJustPressed = true;
      } else if (e.button === 2) {
        this.adsJustPressed = true;
        if (this.settings.get().adsMode === "toggle") {
          this.adsToggled = !this.adsToggled;
          this.adsHeld = this.adsToggled;
        } else {
          this.adsHeld = true;
        }
      }
    });

    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2 && this.settings.get().adsMode !== "toggle") {
        this.adsHeld = false;
      }
    });

    addEventListener("mousemove", (e) => {
      if (!this.active || this.textFocusBlocked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });

    addEventListener(
      "wheel",
      (e) => {
        if (!this.active || this.textFocusBlocked) return;
        e.preventDefault();
        if (Math.abs(e.deltaY) >= 4) {
          this.wheelDir += e.deltaY > 0 ? 1 : -1;
        }
      },
      { passive: false },
    );

    addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("blur", () => this.reset());
    document.addEventListener("visibilitychange", () => this.reset());
    document.addEventListener("fullscreenchange", () => this._tryKeyboardLock());

    document.addEventListener("pointerlockerror", () => {
      this.onLockError();
    });

    document.addEventListener("pointerlockchange", () => {
      const nowActive = document.pointerLockElement === this.canvas;
      this.active = nowActive;
      if (!nowActive) {
        this.reset();
        this.onLockChange(false);
        this.onPauseMenu();
      } else {
        this.lockIgnoreFireUntil = performance.now() + 120;
        this.fireHeld = false;
        this.fireJustPressed = false;
        this._tryKeyboardLock();
        this.onLockChange(true);
      }
    });
  }

  isDown(action) {
    if (!this.active || this.textFocusBlocked) return false;
    const codes = this.settings.getBindings()[action];
    return Array.isArray(codes) && codes.some((c) => this.held.has(c));
  }

  wasHit(action) {
    if (!this.active || this.textFocusBlocked) return false;
    const codes = this.settings.getBindings()[action];
    return Array.isArray(codes) && codes.some((c) => this.pressed.has(c));
  }

  isCrouchActive() {
    if (!this.active || this.textFocusBlocked) return false;
    return this.settings.get().crouchMode === "toggle"
      ? this.crouchToggled
      : this.isDown("crouch");
  }

  isAdsActive() {
    if (!this.active || this.textFocusBlocked) return false;
    return this.settings.get().adsMode === "toggle"
      ? this.adsToggled
      : this.adsHeld;
  }

  clearAds() {
    this.adsHeld = false;
    this.adsToggled = false;
    this.adsJustPressed = false;
  }

  consumeAdsJustPressed() {
    const p = this.adsJustPressed;
    this.adsJustPressed = false;
    return p;
  }

  consumeWheel() {
    const d = this.wheelDir;
    this.wheelDir = 0;
    return d;
  }

  consumeMouseDelta() {
    const out = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  endFrame() {
    this.pressed.clear();
    this.fireJustPressed = false;
    this.adsJustPressed = false;
    this.dx = 0;
    this.dy = 0;
  }

  reset() {
    this.held.clear();
    this.pressed.clear();
    this.fireHeld = false;
    this.fireJustPressed = false;
    this.adsHeld = false;
    this.adsToggled = false;
    this.adsJustPressed = false;
    this.crouchToggled = false;
    this.wheelDir = 0;
    this.dx = 0;
    this.dy = 0;
  }
}

