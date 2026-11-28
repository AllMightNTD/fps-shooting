/**
 * AAA unit tests for balanced Truy Kích / CS weapon damage, distance falloff,
 * 0-200m STK sweep invariants, weapon move speed multipliers, and equip delays.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FLAG,
  WEAPONS,
  computeFalloffMultiplier,
  computeWeaponDamage,
  getMoveSpeedMultiplier,
} from "../weapons.js";

function shotsToKill(weaponId, part, distMeters) {
  const dmg = computeWeaponDamage(weaponId, part, distMeters);
  return dmg > 0 ? Math.ceil(100 / dmg) : Infinity;
}

test("Truy Kích/CS base damage, mobility & equip roles at close range (0-20m)", () => {
  // Arrange & Act & Assert: M416 balanced rifle (no 1-tap head, 4 body shots close)
  assert.equal(computeWeaponDamage("m416", "head", 0), 90);
  assert.equal(computeWeaponDamage("m416", "body", 0), 27);
  assert.equal(computeWeaponDamage("m416", "limb", 0), 21);
  assert.equal(WEAPONS.m416.equipTimeMs, 520);
  assert.equal(WEAPONS.m416.moveSpeedMult, 0.95);

  // Glock-17: fastest mobility, fastest equip, 2-tap head, 150ms cadence
  assert.equal(computeWeaponDamage("pistol", "head", 10), 72);
  assert.equal(computeWeaponDamage("pistol", "body", 10), 24);
  assert.equal(computeWeaponDamage("pistol", "limb", 10), 18);
  assert.equal(WEAPONS.pistol.fireInterval, 150);
  assert.equal(WEAPONS.pistol.equipTimeMs, 240);
  assert.equal(WEAPONS.pistol.moveSpeedMult, 1.05);

  // AWM: 1-shot upper body & head, limb tag leaves 20 HP (+4 margin for Glock finish)
  assert.equal(computeWeaponDamage("sniper", "head", 10), 180);
  assert.equal(computeWeaponDamage("sniper", "body", 10), 115);
  assert.equal(computeWeaponDamage("sniper", "limb", 10), 80);
  assert.equal(WEAPONS.sniper.equipTimeMs, 780);
  assert.equal(WEAPONS.sniper.moveSpeedMult, 0.84);
  assert.equal(WEAPONS.sniper.ballistics.mode, "projectile");
  assert.equal(WEAPONS.m416.ballistics.mode, "hitscan");
  assert.equal(WEAPONS.pistol.ballistics.mode, "hitscan");

  // Backward-compatible mobility multiplier + weapon-aware mobility multiplier
  assert.equal(getMoveSpeedMultiplier(FLAG.PRONE), 0.3);
  assert.ok(getMoveSpeedMultiplier(0, "pistol") > getMoveSpeedMultiplier(0, "m416"));
  assert.ok(getMoveSpeedMultiplier(0, "m416") > getMoveSpeedMultiplier(0, "sniper"));
});

test("0-200m per-meter sweep locks STK thresholds, damage margins (>= +4 HP), and out-of-range cutoff", () => {
  for (let d = 0; d <= 200; d++) {
    const m4Head = computeWeaponDamage("m416", "head", d);
    const m4Body = computeWeaponDamage("m416", "body", d);
    const glockBody = computeWeaponDamage("pistol", "body", d);
    const awmBody = computeWeaponDamage("sniper", "body", d);
    const awmLimb = computeWeaponDamage("sniper", "limb", d);

    // M416: never 1-tap head; 1 head + 1 body kills up to 72m; 4 body <=57m, 5 body 58..120m (min total >= 105)
    assert.ok(m4Head < 100, `M416 must not 1-tap head at ${d}m (got ${m4Head})`);
    if (d <= 72) {
      assert.ok(m4Head + m4Body >= 100, `M416 head+body failed to kill at ${d}m (${m4Head}+${m4Body})`);
    }
    if (d <= 57) {
      assert.equal(shotsToKill("m416", "body", d), 4, `M416 body STK at ${d}m`);
    } else if (d <= 120) {
      assert.equal(shotsToKill("m416", "body", d), 5, `M416 body STK at ${d}m`);
      assert.ok(m4Body * 5 >= 105, `M416 5-shot margin collapsed at ${d}m (${m4Body * 5})`);
    } else {
      assert.equal(m4Body, 0);
    }

    // Glock-17: smooth 3-tier STK (5 -> 6 -> 7) and AWM-limb + Glock-body finisher up to 44m
    if (d <= 44) {
      assert.equal(shotsToKill("pistol", "body", d), 5, `Glock body STK at ${d}m`);
      assert.ok(awmLimb + glockBody >= 100, `AWM limb + Glock body combo failed at ${d}m`);
    } else if (d <= 60) {
      assert.equal(shotsToKill("pistol", "body", d), 6, `Glock body STK at ${d}m`);
    } else if (d <= 85) {
      assert.equal(shotsToKill("pistol", "body", d), 7, `Glock body STK at ${d}m`);
      assert.ok(glockBody * 7 >= 112, `Glock 7-shot margin too thin at ${d}m`);
    } else {
      assert.equal(glockBody, 0);
    }

    // AWM: 1-shot body everywhere in [0..180] with >= 106 dmg (+6 HP margin), limb never 1-shots
    if (d <= 180) {
      assert.equal(shotsToKill("sniper", "body", d), 1, `AWM body must 1-shot at ${d}m`);
      assert.ok(awmBody >= 106, `AWM body margin too thin at ${d}m (${awmBody})`);
      assert.ok(awmLimb >= 74 && awmLimb < 100, `AWM limb at ${d}m = ${awmLimb}`);
    } else {
      assert.equal(awmBody, 0);
    }
  }
});

test("Falloff curve & invalid inputs degrade cleanly without NaN or negative damage", () => {
  assert.equal(computeFalloffMultiplier("m416", 30), 1);
  assert.equal(computeFalloffMultiplier("m416", 95), 0.78);
  assert.equal(computeFalloffMultiplier("pistol", 20), 1);
  assert.equal(computeFalloffMultiplier("pistol", 65), 0.65);
  assert.equal(computeWeaponDamage("m416", "invalid_part", 10), 0);
  assert.equal(computeWeaponDamage("m416", "body", Number.NaN), 27);
  assert.equal(computeWeaponDamage("m416", "body", -15), 27);
  assert.equal(computeWeaponDamage("unknown", "head", 10), 90);
});

