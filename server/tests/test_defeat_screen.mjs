/**
 * AAA unit tests for public/js/defeat_screen.js (Offline Solo "TỬ TRẬN" overlay & 5s Lobby return).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDefeatScreenController } from "../../public/js/defeat_screen.js";

function createFakeEl() {
  const classes = new Set(["hidden-screen"]);
  const listeners = new Map();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    style: {},
    textContent: "",
    offsetWidth: 100,
    addEventListener(evt, fn) {
      listeners.set(evt, fn);
    },
    removeEventListener(evt) {
      listeners.delete(evt);
    },
    click() {
      const fn = listeners.get("click");
      if (fn) fn();
    },
  };
}

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const rafs = new Map();

  return {
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    rafFn: (fn) => {
      const id = nextId++;
      rafs.set(id, fn);
      return id;
    },
    cafFn: (id) => rafs.delete(id),
    step(ms) {
      now += ms;
      for (const [id, t] of Array.from(timers.entries())) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      for (const [id, fn] of Array.from(rafs.entries())) {
        rafs.delete(id);
        fn(now);
      }
    },
    pendingRafCount: () => rafs.size,
  };
}

function createElements() {
  const overlay = createFakeEl();
  const actionArea = createFakeEl();
  actionArea.classList.remove("hidden-screen");
  return {
    overlay,
    canvas: {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        beginPath() {},
        arc() {},
        fill() {},
        fillStyle: "",
        shadowBlur: 0,
        shadowColor: "",
      }),
    },
    impactStage: createFakeEl(),
    redFlash: createFakeEl(),
    lightSweep: createFakeEl(),
    lineTop: createFakeEl(),
    lineBottom: createFakeEl(),
    defeatTitle: createFakeEl(),
    actionArea,
    btnReturnLobby: createFakeEl(),
    btnProgressBar: createFakeEl(),
    progressFill: createFakeEl(),
    countdownSecondsEl: createFakeEl(),
  };
}

test("defeatScreen triggers cinematic reveal, counts down 5s smoothly, auto-returns to lobby, and halts canvas RAF", () => {
  // Arrange
  const clock = createFakeTimers();
  const elements = createElements();
  let lobbyReturns = 0;
  const ctrl = createDefeatScreenController({
    elements,
    windowRef: { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} },
    durationMs: 5000,
    revealDelayMs: 850,
    fadeCallbackMs: 450,
    fadeCompleteMs: 900,
    onReturnToLobby: () => lobbyReturns++,
    ...clock,
  });

  // Act 1: Trigger defeat screen
  ctrl.trigger();

  // Assert immediate impact & title reveal classes active, actionArea hidden until 850ms
  assert.equal(elements.overlay.classList.contains("hidden-screen"), false);
  assert.equal(elements.impactStage.classList.contains("shake-active"), true);
  assert.equal(elements.defeatTitle.classList.contains("reveal-active"), true);
  assert.equal(elements.actionArea.classList.contains("visible"), false);
  assert.equal(elements.countdownSecondsEl.textContent, "5");
  assert.equal(ctrl.getState().atmosphereRunning, true);

  // Act 2: Advance to 850ms -> action button reveals & countdown starts
  clock.step(850);
  assert.equal(elements.actionArea.classList.contains("visible"), true);

  // Act 3: Advance 2.5s into 5s countdown
  clock.step(2500);
  assert.equal(elements.countdownSecondsEl.textContent, "3");
  assert.equal(elements.progressFill.style.transform, "scaleX(0.5)");
  assert.equal(elements.btnProgressBar.style.transform, "scaleX(0.5)");
  assert.equal(lobbyReturns, 0);

  // Act 4: Advance remaining 2.5s -> countdown hits 0 -> fade-out starts
  clock.step(2500);
  assert.equal(elements.countdownSecondsEl.textContent, "0");
  assert.equal(elements.overlay.classList.contains("hidden-screen"), true);
  assert.equal(ctrl.getState().returning, true);

  // Act 5: Advance 450ms -> onReturnToLobby fires; advance another 450ms -> atmosphere canvas stops completely
  clock.step(450);
  assert.equal(lobbyReturns, 1);
  clock.step(450);
  assert.equal(ctrl.getState().active, false);
  assert.equal(ctrl.getState().atmosphereRunning, false);
  assert.equal(clock.pendingRafCount(), 0);
});

test("defeatScreen manual button click returns early once and ignores duplicate clicks", () => {
  // Arrange
  const clock = createFakeTimers();
  const elements = createElements();
  let lobbyReturns = 0;
  const ctrl = createDefeatScreenController({
    elements,
    windowRef: { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} },
    onReturnToLobby: () => lobbyReturns++,
    ...clock,
  });

  // Act: trigger, reveal, click button twice rapidly
  ctrl.trigger();
  clock.step(900);
  elements.btnReturnLobby.click();
  elements.btnReturnLobby.click();
  clock.step(500);
  clock.step(5000);

  // Assert
  assert.equal(lobbyReturns, 1);
  assert.equal(ctrl.getState().active, false);
  assert.equal(ctrl.getState().atmosphereRunning, false);
});

test("defeatScreen handles hideImmediate, missing canvas context, and callback errors safely (unhappy path)", () => {
  // Arrange
  const clock = createFakeTimers();
  const elements = createElements();
  elements.canvas = { width: 0, height: 0, getContext: () => null };
  let lobbyReturns = 0;
  const ctrl = createDefeatScreenController({
    elements,
    windowRef: { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} },
    onReturnToLobby: () => {
      lobbyReturns++;
      throw new Error("Simulated callback failure");
    },
    ...clock,
  });

  // Act 1: Trigger then cancel immediately via hideImmediate -> must NOT call onReturnToLobby
  ctrl.trigger();
  clock.step(400);
  ctrl.hideImmediate();
  clock.step(6000);
  assert.equal(lobbyReturns, 0);
  assert.equal(elements.overlay.classList.contains("hidden-screen"), true);

  // Act 2: Re-trigger with null 2D context & throwing callback -> must not throw unhandled
  ctrl.trigger();
  assert.equal(elements.countdownSecondsEl.textContent, "5");
  assert.equal(elements.progressFill.style.transform, "scaleX(1)");
  ctrl.returnToLobby();
  assert.doesNotThrow(() => clock.step(500));
  assert.equal(lobbyReturns, 1);
  ctrl.destroy();
});

