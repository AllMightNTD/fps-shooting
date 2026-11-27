/**
 * AAA unit tests for M416 Recoil System (public/js/recoil.js)
 * and WEAPONS.m416 configuration in server/weapons.js.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WEAPONS } from "../weapons.js";
import {
  M416_RECOIL_PROFILE,
  computeRecoilModifiers,
  createRecoilController,
  evalAnimationCurve,
  hashShotRand,
  smoothDampScalar,
} from "../../public/js/recoil.js";

test("M416_RECOIL_PROFILE and WEAPONS.m416 synchronize 700 RPM and animation curve keyframes", () => {
  // Arrange & Act
  const rpmIntervalMs = Math.round(60000 / M416_RECOIL_PROFILE.fireRateRPM);

  // Assert
  assert.equal(M416_RECOIL_PROFILE.fireRateRPM, 700);
  assert.equal(M416_RECOIL_PROFILE.magazineSize, 30);
  assert.equal(WEAPONS.m416.fireInterval, rpmIntervalMs);
  assert.ok(Math.abs(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 0) - 0.34) < 1e-6);
  assert.ok(Math.abs(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 3) - 0.42) < 1e-6);
  assert.ok(Math.abs(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 10) - 0.38) < 1e-6);
  assert.ok(Math.abs(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 20) - 0.34) < 1e-6);
  assert.ok(Math.abs(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 29) - 0.30) < 1e-6);
  // Clamps past ends cleanly
  assert.equal(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, -5), 0.34);
  assert.equal(evalAnimationCurve(M416_RECOIL_PROFILE.verticalByShot, 99), 0.30);
});

test("hashShotRand produces deterministic order-independent seeded noise within [-1, 1]", () => {
  // Arrange & Act
  const a1 = hashShotRand(98765, 4);
  const a2 = hashShotRand(98765, 4);
  const b = hashShotRand(12345, 4);

  // Assert
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  for (let i = 0; i < 60; i++) {
    const v = hashShotRand(4242, i);
    assert.ok(Number.isFinite(v) && v >= -1 && v <= 1, `out of range: ${v}`);
  }
  assert.ok(Number.isFinite(hashShotRand(Number.NaN, Number.NaN)));
});

test("RecoilController handles spray accumulation, SmoothDamp, pull absorption, 35% partial recovery, and pattern reset (AAA)", () => {
  // Arrange
  const ctrl = createRecoilController(M416_RECOIL_PROFILE);
  ctrl.resetMagazine(777);
  const dt = 1 / 60;
  let now = 10.0;

  // Act 1: Fire 10 rounds at 700 RPM (~0.086s apart)
  let totalDeltaX = 0;
  let totalDeltaY = 0;
  for (let s = 0; s < 10; s++) {
    ctrl.onShotFired(now, computeRecoilModifiers({ crouched: false, ads: false, grounded: true }));
    for (let f = 0; f < 5; f++) {
      const d = ctrl.tick(now + f * dt, dt);
      totalDeltaX += d.x;
      totalDeltaY += d.y;
    }
    now += M416_RECOIL_PROFILE.shotInterval;
  }
  // Settle spring while still firing
  for (let f = 0; f < 20; f++) {
    const d = ctrl.tick(now + f * dt, dt);
    totalDeltaX += d.x;
    totalDeltaY += d.y;
  }

  // Assert 1: Accumulated upward kick ~3.8° for 10 rounds and spring matches target
  const stPeak = ctrl.getState();
  assert.equal(stPeak.shotIndex, 10);
  assert.ok(stPeak.pitchDebt > 3.5 && stPeak.pitchDebt < 4.5, `unexpected pitchDebt: ${stPeak.pitchDebt}`);
  assert.ok(Math.abs(totalDeltaY - stPeak.target.y) < 0.05, `spring failed to converge: ${totalDeltaY} vs ${stPeak.target.y}`);
  assert.ok(Math.abs(totalDeltaX - stPeak.target.x) < 0.05);

  // Act 2: Player pulls mouse down 1.5° during spray, then releases trigger and waits past recoveryDelay
  const absorbed = ctrl.absorbPlayerPull(1.5);
  const debtAfterPull = ctrl.getState().pitchDebt;
  ctrl.onTriggerReleased();
  const expectedRecovery = debtAfterPull * M416_RECOIL_PROFILE.recoverFraction;

  // Before recoveryDelay (0.12s), target.y must NOT recover yet
  const targetBeforeDelay = ctrl.getState().target.y;
  ctrl.tick(stPeak.lastShotTime + 0.05, dt);
  assert.equal(ctrl.getState().target.y, targetBeforeDelay);

  // Advance 1.5s past recoveryDelay so partial recovery finishes completely
  let recoveredDeltaY = 0;
  let simTime = stPeak.lastShotTime + 0.14;
  for (let f = 0; f < 90; f++) {
    const d = ctrl.tick(simTime, dt);
    recoveredDeltaY += d.y;
    simTime += dt;
  }

  // Assert 2: Recovers strictly ~35% of remaining uncompensated pitchDebt (never overshoots downward)
  assert.ok(Math.abs(absorbed - 1.5) < 1e-6);
  assert.ok(
    Math.abs(-recoveredDeltaY - expectedRecovery) < 0.05,
    `expected ~${expectedRecovery.toFixed(3)}° recovery, got ${(-recoveredDeltaY).toFixed(3)}°`,
  );

  // Assert 3: Waiting > patternResetTime (0.30s) resets shotIndex back to 0 on next shot
  ctrl.onShotFired(simTime + 0.35, { vertical: 1, horizontal: 1 });
  assert.equal(ctrl.getState().shotIndex, 1);

  // Assert 4: Fully compensating downward pull leaves recoveryBudget at 0 (no forced downward drag)
  ctrl.absorbPlayerPull(100);
  ctrl.onTriggerReleased();
  assert.equal(ctrl.getState().pitchDebt, 0);
  assert.equal(ctrl.getState().recoveryBudget, 0);
});

test("computeRecoilModifiers and unhappy-path guards handle crouch/ADS/air and invalid inputs cleanly", () => {
  // Arrange & Act
  const stand = computeRecoilModifiers({ crouched: false, ads: false, grounded: true });
  const crouch = computeRecoilModifiers({ crouched: true, ads: false, grounded: true });
  const crouchAds = computeRecoilModifiers({ crouched: true, ads: true, grounded: true });
  const air = computeRecoilModifiers({ crouched: false, ads: false, grounded: false });

  // Assert modifiers
  assert.deepEqual(stand, { vertical: 1, horizontal: 1 });
  assert.equal(crouch.vertical, 0.85);
  assert.equal(crouch.horizontal, 0.85);
  assert.ok(Math.abs(crouchAds.vertical - 0.7225) < 1e-6);
  assert.equal(air.vertical, 1.2);

  // Assert unhappy-path resilience
  const ctrl = createRecoilController(M416_RECOIL_PROFILE);
  ctrl.resetMagazine(Number.NaN);
  assert.deepEqual(ctrl.tick(Number.NaN, 0), { x: 0, y: 0 });
  assert.deepEqual(ctrl.tick(1, -0.5), { x: 0, y: 0 });
  assert.equal(ctrl.absorbPlayerPull(-2), 0);
  assert.equal(ctrl.absorbPlayerPull(Number.NaN), 0);
  const vel = { v: 0 };
  assert.equal(smoothDampScalar(1, 2, vel, "v", 0.045, 0), 1);
  assert.equal(evalAnimationCurve([], 5), 0);
});

