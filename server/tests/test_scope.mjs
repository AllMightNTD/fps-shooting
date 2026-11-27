/**
 * AAA unit & integration tests for AWM Scope System (public/js/scope.js),
 * Toggle/Double-Zoom behavior, Ballistic Drop + Zeroing, and LAN MSG.EVENT_SCOPE audio cue.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MSG, ROOM_STATE } from "../protocol.js";
import { WEAPONS } from "../weapons.js";
import { Match } from "../Match.js";
import {
  AWM_SCOPE_PROFILE,
  STANCE,
  createScopeController,
  simulateHeightAtDistance,
  solveZeroAngleDeg,
  stepBallisticStep,
  toHorizontalFov,
  toVerticalFov,
} from "../../public/js/scope.js";

test("Valorant Double Zoom toggles 0 -> 1 (2.5x) -> 2 (5.0x) -> 0 with focal-length FOV & monitor-distance sens", () => {
  // Arrange
  const ctrl = createScopeController(AWM_SCOPE_PROFILE);

  // Act 1: Unscoped -> Level 1 (2.5x)
  const r1 = ctrl.toggleDoubleZoom(1.0, true);
  let out1 = null;
  for (let i = 0; i < 40; i++) {
    out1 = ctrl.tick({ dt: 0.016, nowSec: 1.0 + i * 0.016, baseVFovDeg: 75, aspect: 16 / 9 });
  }

  // Assert 1
  assert.equal(r1.changed, true);
  assert.equal(r1.level, 1);
  assert.equal(out1.targetZoom, 2.5);
  assert.ok(Math.abs(out1.zoom - 2.5) < 0.02);
  assert.ok(Math.abs(out1.sensMultiplier - 1 / 2.5) < 0.01);
  const expectedHFov1 =
    (2 * Math.atan(Math.tan((toHorizontalFov(75, 16 / 9) * Math.PI) / 360) / 2.5) * 180) / Math.PI;
  assert.ok(Math.abs(out1.hFov - expectedHFov1) < 0.15);
  assert.ok(Math.abs(out1.vFov - toVerticalFov(expectedHFov1, 16 / 9)) < 0.15);

  // Act 2: Level 1 -> Level 2 (5.0x)
  const r2 = ctrl.toggleDoubleZoom(1.7, true);
  let out2 = null;
  for (let i = 0; i < 40; i++) {
    out2 = ctrl.tick({ dt: 0.016, nowSec: 1.7 + i * 0.016, baseVFovDeg: 75, aspect: 16 / 9 });
  }
  assert.equal(r2.level, 2);
  assert.equal(out2.targetZoom, 5.0);
  assert.ok(Math.abs(out2.zoom - 5.0) < 0.05);
  assert.ok(Math.abs(out2.sensMultiplier - 0.2) < 0.01);

  // Act 3: Level 2 -> Unscoped (0)
  const r3 = ctrl.toggleDoubleZoom(2.5, true);
  assert.equal(r3.level, 0);
  let out3 = null;
  for (let i = 0; i < 30; i++) {
    out3 = ctrl.tick({ dt: 0.016, nowSec: 2.5 + i * 0.016, baseVFovDeg: 75, aspect: 16 / 9 });
  }
  assert.equal(out3.scoped, false);
  assert.equal(out3.overlayAlpha, 0);
});

test("Scope Blur & quickscope delay reflect velocity + settle time, then sharpen on counter-strafe stop", () => {
  // Arrange
  const ctrl = createScopeController(AWM_SCOPE_PROFILE);
  ctrl.toggleDoubleZoom(0, true);

  // Advance just enough for adsT to reach 1.0 (adsTime = 0.32s) -> settleTimer is ~0 (quickscope delay!)
  let outQuick = null;
  for (let i = 0; i < 9; i++) {
    outQuick = ctrl.tick({ dt: 0.04, nowSec: (i + 1) * 0.04, horizSpeed: 0, grounded: true });
  }
  assert.ok(outQuick.adsT >= 1.0);
  assert.ok(outQuick.blur01 > 0.7, `Expected initial quickscope blur, got ${outQuick.blur01}`);
  assert.ok(outQuick.scopedSpread > 0.02);

  // Wait past settleTime (0.5s) while stationary -> sharp crosshair & pinpoint spread
  let outSettled = null;
  for (let i = 0; i < 15; i++) {
    outSettled = ctrl.tick({ dt: 0.04, nowSec: 0.36 + (i + 1) * 0.04, horizSpeed: 0, grounded: true });
  }
  assert.equal(outSettled.blur01, 0);
  assert.equal(outSettled.scopedSpread, AWM_SCOPE_PROFILE.settledSpread);

  // Start moving fast -> Scope Blur & spread rise; counter-strafe back to 0 -> sharp again
  const outMoving = ctrl.tick({ dt: 0.016, nowSec: 0.98, horizSpeed: 5.5, grounded: true });
  assert.ok(outMoving.blur01 > 0.9);
  assert.ok(outMoving.scopedSpread > outSettled.scopedSpread * 50);

  const outStopped = ctrl.tick({ dt: 0.016, nowSec: 1.0, horizSpeed: 0, grounded: true });
  assert.equal(outStopped.blur01, 0);
});

test("Sway + Shift Hold Breath reduce sway 10x up to holdMax=3.5s, trigger fatigue, and regenerate cleanly", () => {
  // Arrange
  const ctrl = createScopeController(AWM_SCOPE_PROFILE);
  ctrl.toggleDoubleZoom(0, true);
  for (let i = 0; i < 20; i++) {
    ctrl.tick({ dt: 0.05, nowSec: (i + 1) * 0.05 });
  }

  // Measure sway amplitude when not holding breath vs holding breath
  let maxSwayFree = 0;
  for (let i = 0; i < 60; i++) {
    const o = ctrl.tick({ dt: 0.05, nowSec: 1.05 + i * 0.05, holdBreath: false, stance: STANCE.STAND });
    maxSwayFree = Math.max(maxSwayFree, Math.hypot(o.sway.x, o.sway.y));
  }

  let maxSwayHeld = 0;
  for (let i = 0; i < 20; i++) {
    const o = ctrl.tick({ dt: 0.05, nowSec: 4.05 + i * 0.05, holdBreath: true, stance: STANCE.STAND });
    assert.equal(o.holding, true);
    maxSwayHeld = Math.max(maxSwayHeld, Math.hypot(o.sway.x, o.sway.y));
  }
  assert.ok(maxSwayHeld < maxSwayFree * 0.25, `Hold breath failed to damp sway: ${maxSwayHeld} vs ${maxSwayFree}`);

  // Deplete remaining breath past 3.5s -> enters fatigue state, then regenerates after fatigueTime
  let outFatigued = null;
  for (let i = 0; i < 80; i++) {
    outFatigued = ctrl.tick({ dt: 0.05, nowSec: 5.05 + i * 0.05, holdBreath: true, stance: STANCE.STAND });
    if (outFatigued.fatigued) break;
  }
  assert.equal(outFatigued.fatigued, true);
  assert.equal(outFatigued.holding, false);

  let outRegen = null;
  for (let i = 0; i < 40; i++) {
    outRegen = ctrl.tick({ dt: 0.05, nowSec: 9.0 + i * 0.05, holdBreath: false });
  }
  assert.ok(outRegen.breath01 > 0);
});

test("Ballistic Zeroing solves bore elevation for drag + gravity and projectile drops physically over distance", () => {
  // Arrange: Test 300m zeroing solver & 100m default stepBallisticStep
  const angle300 = solveZeroAngleDeg(300, AWM_SCOPE_PROFILE);
  const yAt300 = simulateHeightAtDistance((angle300 * Math.PI) / 180, 300, AWM_SCOPE_PROFILE);

  // Act: Launch level projectile (0 deg) for 100m at 910 m/s
  const pos = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: -AWM_SCOPE_PROFILE.muzzleVelocity };
  for (let i = 0; i < 60; i++) {
    stepBallisticStep(pos, vel, 0.002, AWM_SCOPE_PROFILE);
  }

  // Assert: Zeroing solver hits < 0.01m error at 300m; level projectile loses speed (drag) and drops (gravity)
  assert.ok(angle300 > 0.05 && angle300 < 0.25);
  assert.ok(Math.abs(yAt300) < 0.015, `Zeroing height drift at 300m too high: ${yAt300}`);
  assert.ok(-vel.z < AWM_SCOPE_PROFILE.muzzleVelocity);
  assert.ok(pos.y < -0.05, `Expected gravitational drop, got y=${pos.y}`);
});

test("Bolt-action Auto Re-scope restores Level 2 zoom after cycle and Quick-switch cancels Auto Re-scope", () => {
  // Arrange
  const ctrl = createScopeController(AWM_SCOPE_PROFILE);
  ctrl.toggleDoubleZoom(1.0, true); // L1
  ctrl.toggleDoubleZoom(1.1, true); // L2 (5.0x)
  assert.equal(ctrl.getState().level, 2);

  // Act 1: Fire at t=2.0 -> immediately unscoped, cycling bolt, saved pendingRescopeLevel=2
  ctrl.onShotFired(2.0);
  assert.equal(ctrl.getState().scoped, false);
  assert.equal(ctrl.canFire(2.5), false);
  // Blocked from manual toggle during bolt cycle
  assert.equal(ctrl.toggleDoubleZoom(2.5, true).changed, false);

  // Advance past boltCycleTime (1.30s) -> Auto Re-scopes back to Level 2 (5.0x)!
  const outRescoped = ctrl.tick({ dt: 0.016, nowSec: 3.35 });
  assert.equal(outRescoped.autoRescopedLevel, 2);
  assert.equal(outRescoped.level, 2);
  assert.equal(ctrl.canFire(3.35), true);

  // Act 2: Fire again at t=4.0, then quick-switch (cancelAutoRescope) -> stays unscoped after bolt time
  ctrl.onShotFired(4.0);
  ctrl.cancelAutoRescope();
  const outAfterQuickSwitch = ctrl.tick({ dt: 0.016, nowSec: 5.5 });
  assert.equal(outAfterQuickSwitch.autoRescopedLevel, 0);
  assert.equal(outAfterQuickSwitch.scoped, false);
});

test("Match.handleScope broadcasts MSG.EVENT_SCOPE for nearby enemy audio cue and blocks dead players", () => {
  // Arrange
  const broadcasts = [];
  const room = {
    state: ROOM_STATE.PLAYING,
    broadcast(pkt) { broadcasts.push(pkt); },
  };
  const match = new Match(room);
  const alivePlayer = { id: "p1", alive: true, activeWeaponId: "sniper", x: 5.123, y: 0, z: -12.456 };
  const deadPlayer = { id: "p2", alive: false, activeWeaponId: "sniper", x: 0, y: 0, z: 0 };

  // Act & Assert Happy + Unhappy paths
  assert.equal(match.handleScope(alivePlayer, { level: 2, weapon: "sniper" }), true);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, MSG.EVENT_SCOPE);
  assert.equal(broadcasts[0].level, 2);
  assert.equal(broadcasts[0].x, 5.12);
  assert.equal(match.handleScope(deadPlayer, { level: 1, weapon: "sniper" }), false);

  // Unhappy-path zeroing / dt guards on scope controller
  const ctrl = createScopeController(AWM_SCOPE_PROFILE);
  assert.equal(ctrl.cycleZero(-99).distance, 100);
  assert.equal(ctrl.cycleZero(99).distance, 800);
  const nanOut = ctrl.tick({ dt: -1, nowSec: Number.NaN });
  assert.ok(Number.isFinite(nanOut.hFov) && Number.isFinite(nanOut.vFov));
});
