/**
 * AAA unit & integration tests for server-authoritative hitbox raycast,
 * AWM ballistics, RTT-bounded lag compensation, 5-layer anti-cheat & Match integration.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { raycastArenaDistance } from "../spawn.js";
import {
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_PRONE,
  EYE_HEIGHT_STAND,
  buildPlayerHitboxes,
  forwardFromYawPitch,
  getEyeHeight,
  rayIntersectsSphere,
  raycastPlayerHitboxes,
  resolveAuthoritativeShot,
} from "../hitreg.js";
import { FLAG, WEAPONS } from "../weapons.js";

test("forwardFromYawPitch and getEyeHeight match Three.js YXZ camera conventions", () => {
  const f0 = forwardFromYawPitch(0, 0);
  assert.ok(Math.abs(f0.x) < 1e-6 && Math.abs(f0.y) < 1e-6 && Math.abs(f0.z + 1) < 1e-6);

  const fLeft = forwardFromYawPitch(Math.PI / 2, 0);
  assert.ok(Math.abs(fLeft.x + 1) < 1e-6 && Math.abs(fLeft.y) < 1e-6 && Math.abs(fLeft.z) < 1e-6);

  const fUp = forwardFromYawPitch(0, Math.PI / 6);
  assert.ok(Math.abs(fUp.y - 0.5) < 1e-6);

  assert.equal(getEyeHeight(0), EYE_HEIGHT_STAND);
  assert.equal(getEyeHeight(FLAG.CROUCH), EYE_HEIGHT_CROUCH);
  assert.equal(getEyeHeight(FLAG.PRONE), EYE_HEIGHT_PRONE);
});

test("Stand/Crouch/Prone hitboxes enforce head > body > limb priority and respect cover height", () => {
  // Standing target at origin facing +Z (yaw = Math.PI)
  const standTarget = { id: "t1", x: 0, y: 0, z: -10, yaw: Math.PI, flags: 0, alive: true };
  assert.equal(raycastPlayerHitboxes(0, 1.62, 0, 0, 0, -1, 50, standTarget).part, "head");
  assert.equal(raycastPlayerHitboxes(0, 1.2, 0, 0, 0, -1, 50, standTarget).part, "body");
  assert.equal(raycastPlayerHitboxes(0, 0.45, 0, 0, 0, -1, 50, standTarget).part, "limb");

  // Arm-through-chest lateral shot: hits left arm first at x=-0.29, then torso -> must upgrade to "body"
  const sideTarget = { id: "t2", x: 0, y: 0, z: -10, yaw: 0, flags: 0, alive: true };
  const armThroughTorso = raycastPlayerHitboxes(-5, 1.2, -10, 1, 0, 0, 20, sideTarget);
  assert.equal(armThroughTorso.part, "body");

  // Crouched target behind 1.45m wall: head at 1.08 + 0.175 = 1.255 < 1.45 -> wall blocks low shot, high shot misses crouched head
  const crouchTarget = { id: "t3", x: 0, y: 0, z: -10, yaw: 0, flags: FLAG.CROUCH, alive: true };
  const arenaWithCover = {
    boxes: [{ x0: -2, x1: 2, y0: 0, y1: 1.45, z0: -6, z1: -5 }],
    obbs: [],
  };
  const highShot = resolveAuthoritativeShot({
    shooterId: "s1",
    weaponCfg: WEAPONS.m416,
    origin: { x: 0, y: 1.62, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    arena: arenaWithCover,
    targets: [crouchTarget],
  });
  assert.equal(highShot.hit, false);

  const lowShot = resolveAuthoritativeShot({
    shooterId: "s1",
    weaponCfg: WEAPONS.m416,
    origin: { x: 0, y: 1.08, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    arena: arenaWithCover,
    targets: [crouchTarget],
  });
  assert.equal(lowShot.hit, false);

  // Prone target rotated along yaw=0 (head forward at -Z, legs at +Z)
  const proneTarget = { id: "t4", x: 0, y: 0, z: -10, yaw: 0, flags: FLAG.PRONE, alive: true };
  const boxes = buildPlayerHitboxes(proneTarget);
  assert.ok(boxes.head.cz < -10.4 && boxes.head.cy < 0.45);
  assert.equal(raycastPlayerHitboxes(0, 0.36, 0, 0, 0, -1, 50, proneTarget).part, "head");
});

test("raycastArenaDistance ignores moveOnly glass/window colliders and AWM projectile simulates gravity drop", () => {
  const arena = {
    boxes: [
      { x0: -1, x1: 1, y0: 0, y1: 3, z0: -5, z1: -4, moveOnly: true },
      { x0: -1, x1: 1, y0: 0, y1: 3, z0: -20, z1: -19 },
    ],
    obbs: [],
  };
  const wallRes = raycastArenaDistance(0, 1.5, 0, 0, 0, -1, 100, arena);
  assert.ok(wallRes && Math.abs(wallRes.dist - 19) < 1e-4);

  // AWM projectile: firing horizontally at 150m drops ~0.13m (hits torso when aimed at 1.62m? head r=0.175 -> borderline; aim at 1.35 hits body at ~1.21)
  const farTarget = { id: "far", x: 0, y: 0, z: -150, yaw: 0, flags: 0, alive: true };
  const awmHit = resolveAuthoritativeShot({
    shooterId: "s1",
    weaponCfg: WEAPONS.sniper,
    origin: { x: 0, y: 1.35, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    arena: { boxes: [], obbs: [] },
    targets: [farTarget],
  });
  assert.equal(awmHit.hit, true);
  assert.equal(awmHit.part, "body");
  assert.ok(awmHit.hitPoint.y < 1.26 && awmHit.hitPoint.y > 1.15, `Expected realistic AWM drop at 150m, got y=${awmHit.hitPoint.y}`);

  // Unhappy paths: NaN / zero dir / null sphere never throw
  assert.equal(rayIntersectsSphere(0, 0, 0, 0, 0, 0, 0, 0, -5, 1, 10), null);
  const badShot = resolveAuthoritativeShot({
    shooterId: "s1",
    weaponCfg: WEAPONS.m416,
    origin: { x: 0, y: 1.7, z: 0 },
    dir: { x: 0, y: Number.NaN, z: 0 },
    arena,
    targets: [farTarget],
  });
  assert.equal(badShot.hit, false);
});

import {
  INTERP_DELAY_MS,
  MAX_REWIND_MS,
  clampRewindTimestamp,
  computeAllowedRewindMs,
  createPoseHistoryStore,
} from "../lag_comp.js";
import { RoomManager } from "../RoomManager.js";

test("RTT-bounded lag compensation window clamps fake-backtrack and future timestamps", () => {
  assert.equal(INTERP_DELAY_MS, 100);
  assert.equal(MAX_REWIND_MS, 250);
  assert.equal(computeAllowedRewindMs(0), 140);
  assert.equal(computeAllowedRewindMs(140), 210);
  assert.equal(computeAllowedRewindMs(500), 250);
  assert.equal(computeAllowedRewindMs(Number.NaN), 140);

  const now = 10_000;
  assert.equal(clampRewindTimestamp(now - 240, now, 10), now - 145);
  assert.equal(clampRewindTimestamp(now + 5000, now, 50), now);
  assert.equal(clampRewindTimestamp(Number.NaN, now, 50), now);
});

test("PoseHistoryStore interpolates movement & yaw wraparound while guarding respawn teleports", () => {
  const store = createPoseHistoryStore();
  store.record({ id: "p1", x: 0, y: 0, z: 0, yaw: Math.PI - 0.1, flags: 0, alive: true }, 1000);
  store.record({ id: "p1", x: 4, y: 0, z: 0, yaw: -Math.PI + 0.1, flags: 0, alive: true }, 1100);

  const mid = store.sample("p1", 1050);
  assert.ok(Math.abs(mid.x - 2.0) < 1e-6);
  assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 1e-4, `Expected shortest yaw wrap near PI, got ${mid.yaw}`);
  assert.equal(mid.alive, true);

  // Teleport / respawn guard (> 4m jump or dead->alive transition never interpolates across map)
  store.record({ id: "p2", x: 10, y: 0, z: 10, yaw: 0, flags: 0, alive: false }, 1000);
  store.record({ id: "p2", x: -30, y: 0, z: -40, yaw: 0, flags: 0, alive: true }, 1100);
  const tpSample = store.sample("p2", 1050);
  assert.equal(tpSample.alive, false);
  assert.notEqual(tpSample.x, -10);
});

test("RoomManager heartbeat measures and bounds player RTT via recordPong", () => {
  let now = 5000;
  const mgr = new RoomManager(() => now);
  const sent = [];
  const ws = {
    closed: false,
    sendText(t) { sent.push(JSON.parse(t)); return true; },
    sendJson(o) { sent.push(o); return true; },
    sendPing() { return true; },
    close() { this.closed = true; },
  };
  const sess = mgr.handleHello(ws, { name: "PingCheck" });
  const room = mgr.createRoom(sess, { allowSoloTest: true }).room;
  const p = room.players.get(sess.id);

  mgr.stepHeartbeat(now);
  now += 48;
  const rtt = mgr.recordPong(sess.id, now);
  assert.equal(rtt, 48);
  assert.equal(sess.rttMs, 48);
  assert.equal(p.rttMs, 48);

  // Outrageous spike clamped to 400ms max
  mgr.stepHeartbeat(now);
  now += 2000;
  mgr.recordPong(sess.id, now);
  assert.ok(sess.rttMs <= 400);
});

import { ERR } from "../protocol.js";
import {
  ANTI_CHEAT_KICK_THRESHOLD,
  ANTI_CHEAT_WARN_THRESHOLD,
  ANTI_CHEAT_WEIGHTS,
  AntiCheatTracker,
  validateShotDirection,
  validateShotOrigin,
} from "../anti_cheat.js";

test("validateShotOrigin and validateShotDirection enforce zero-trust origin & aim-cone bounds", () => {
  assert.equal(ERR.CHEAT_DETECTED, "CHEAT_DETECTED");
  const authEye = { x: 0, y: 1.7, z: 0 };
  const arena = { boxes: [{ x0: -2, x1: 2, y0: 0, y1: 3, z0: -1.0, z1: -0.6 }], obbs: [] };

  // Valid subtle eye offset (head bob / gun barrel) passes cleanly
  const okOrigin = validateShotOrigin(authEye, { x: 0.25, y: 1.65, z: -0.2 }, arena);
  assert.equal(okOrigin.tampered, false);

  // Far origin or wall-peek origin across wall gets flagged and snapped back to authEye
  const farOrigin = validateShotOrigin(authEye, { x: 2.0, y: 1.7, z: 0 }, arena);
  assert.equal(farOrigin.tampered, true);
  assert.deepEqual(farOrigin.origin, authEye);

  const wallPeekOrigin = validateShotOrigin(authEye, { x: 0, y: 1.7, z: -1.2 }, arena);
  assert.equal(wallPeekOrigin.tampered, true);
  assert.deepEqual(wallPeekOrigin.origin, authEye);

  // Aim direction within spread + recoil allowance passes; 90-degree silent aim gets flagged
  const okDir = validateShotDirection(0, 0, { x: 0.03, y: 0.02, z: -1 }, WEAPONS.m416, 0);
  assert.equal(okDir.tampered, false);

  const silentAim = validateShotDirection(0, 0, { x: 1, y: 0, z: 0 }, WEAPONS.m416, 0);
  assert.equal(silentAim.tampered, true);
  assert.ok(silentAim.dir.z < -0.99);

  // Omitted origin/dir defaults safely without false tamper
  assert.equal(validateShotOrigin(authEye, null, arena).tampered, false);
  assert.equal(validateShotDirection(0, 0, undefined, WEAPONS.m416, 0).tampered, false);
});

test("AntiCheatTracker decays clean play, warns at >=40, kicks at >=100, and resists NaN/unknown codes", () => {
  const tracker = new AntiCheatTracker();
  assert.equal(ANTI_CHEAT_WARN_THRESHOLD, 40);
  assert.equal(ANTI_CHEAT_KICK_THRESHOLD, 100);
  assert.equal(ANTI_CHEAT_WEIGHTS.AIM_DIR_TAMPER, 25);

  let now = 1000;
  const r1 = tracker.recordViolation("c1", "AIM_DIR_TAMPER", now);
  assert.equal(r1.score, 25);
  assert.equal(r1.action, "none");

  const r2 = tracker.recordViolation("c1", "ORIGIN_TAMPER", now + 500);
  assert.equal(r2.score, 45);
  assert.equal(r2.action, "warn");

  // 40s clean play decays 20 points (45 -> 25)
  assert.equal(tracker.getScore("c1", now + 40_500), 25);

  // Rapid repeated violations cross 100 -> kick
  tracker.recordViolation("c1", "AIM_DIR_TAMPER", now + 41_000);
  tracker.recordViolation("c1", "AIM_DIR_TAMPER", now + 41_500);
  const rKick = tracker.recordViolation("c1", "AIM_DIR_TAMPER", now + 42_000);
  assert.equal(rKick.score, 100);
  assert.equal(rKick.action, "kick");

  // Unhappy path: unknown violation or NaN timestamp does not corrupt score
  const bad = tracker.recordViolation("c1", "UNKNOWN_CODE", Number.NaN);
  assert.equal(Number.isFinite(bad.score), true);
  assert.equal(bad.action, "none");
});

import { GAME_MODE, MSG, ROOM_STATE } from "../protocol.js";
import { SPAWN_RULES } from "../spawn_rules.js";

test("Match server-authoritative combat: shared TDM/FFA damage, AWM+Glock finisher, equip delay & lag compensation", () => {
  for (const mode of [GAME_MODE.TDM, GAME_MODE.FFA]) {
    const modeRule = SPAWN_RULES[mode];
    let now = 200_000;
    const mgr = new RoomManager(() => now);
    const sentA = [];
    const sentB = [];
    const mkWs = (buf) => ({
      closed: false,
      sendText(t) { buf.push(JSON.parse(t)); return true; },
      sendJson(o) { buf.push(o); return true; },
      sendPing() { return true; },
      close() { this.closed = true; },
    });
    const sA = mgr.handleHello(mkWs(sentA), { name: "Alpha" });
    const sB = mgr.handleHello(mkWs(sentB), { name: "Bravo" });
    const room = mgr.createRoom(sA, { mode, killLimit: 5 }).room;
    mgr.joinRoom(sB, room.id);
    room.setReady(sB.id, true);
    room.startMatch(sA.id, now);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      mgr.stepAll(now);
    }
    now += modeRule.protectMs + 100; // Past spawn shield
    const pA = room.players.get(sA.id);
    const pB = room.players.get(sB.id);

    // 1. M416 at 10m: headshot (90 dmg -> 10 HP) + bodyshot (27 dmg -> 0 HP kill)
    Object.assign(pA, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
    Object.assign(pB, { x: 0, y: 0, z: -10, yaw: Math.PI, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
    room.match.poseHistory.record(pB, now);

    const h1 = room.match.handleFire(pA, {
      origin: { x: 0, y: 1.62, z: 0 },
      dir: { x: 0, y: 0, z: -1 },
      yaw: 0,
      pitch: 0,
      clientTime: now,
    }, now);
    assert.equal(h1.ok, true);
    assert.equal(h1.hit, true);
    assert.equal(h1.part, "head");
    assert.equal(h1.damage, 90);
    assert.equal(pB.hp, 10);

    now += WEAPONS.m416.fireInterval + 5;
    const h2 = room.match.handleFire(pA, {
      origin: { x: 0, y: 1.16, z: 0 },
      dir: { x: 0, y: 0, z: -1 },
      yaw: 0,
      pitch: 0,
      clientTime: now,
    }, now);
    assert.equal(h2.hit, true);
    assert.equal(h2.part, "body");
    assert.equal(h2.damage, 27);
    assert.equal(pB.alive, false);

    // Respawn pB and clear shield
    now += modeRule.respawnDelayMs + 100;
    mgr.stepAll(now);
    now += modeRule.protectMs + 100;
    Object.assign(pA, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
    Object.assign(pB, { x: 0, y: 0, z: -10, yaw: Math.PI, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
    room.match.poseHistory.record(pB, now);

    // 2. AWM limb (80 dmg -> 20 HP) + switch to Glock-17 (equipTime 240ms enforced!) -> body finish (24 dmg -> kill)
    room.match.handleSwitchWeapon(pA, { slot: 3 }, now);
    const earlyAwm = room.match.handleFire(pA, { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0 }, now + 100);
    assert.equal(earlyAwm.ok, false);

    now += WEAPONS.sniper.equipTimeMs + 10;
    const legPitch = Math.atan2(0.45 - 1.7, 10);
    const legDir = forwardFromYawPitch(0, legPitch);
    const awmLimb = room.match.handleFire(pA, {
      origin: { x: 0, y: 1.7, z: 0 },
      dir: legDir,
      yaw: 0,
      pitch: legPitch,
      clientTime: now,
    }, now);
    assert.equal(awmLimb.ok, true);
    assert.equal(awmLimb.hit, true);
    assert.equal(awmLimb.part, "limb");
    assert.equal(awmLimb.damage, 80);
    assert.equal(pB.hp, 20);

    room.match.handleSwitchWeapon(pA, { slot: 2 }, now + 20);
    const earlyGlock = room.match.handleFire(pA, { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0 }, now + 100);
    assert.equal(earlyGlock.ok, false);

    now += 20 + WEAPONS.pistol.equipTimeMs + 10;
    const bodyPitch = Math.atan2(1.16 - 1.7, 10);
    const bodyDir = forwardFromYawPitch(0, bodyPitch);
    const glockFinish = room.match.handleFire(pA, {
      origin: { x: 0, y: 1.7, z: 0 },
      dir: bodyDir,
      yaw: 0,
      pitch: bodyPitch,
      clientTime: now,
    }, now);
    assert.equal(glockFinish.hit, true);
    assert.equal(glockFinish.damage, 24);
    assert.equal(pB.alive, false);

    // 3. Lag compensation rewind: pB runs x=0 -> x=4 in 50ms steps over 200ms; shooting at x=2 with clientTime=now-100 hits!
    now += modeRule.respawnDelayMs + 100;
    mgr.stepAll(now);
    now += modeRule.protectMs + 100;
    Object.assign(pA, { x: 2.0, y: 0, z: 0, yaw: 0, pitch: 0, rttMs: 40, lastStateAt: now });
    room.match.handleSwitchWeapon(pA, { slot: 3 }, now);
    now += WEAPONS.sniper.equipTimeMs + 20;
    for (let stepIdx = 0; stepIdx <= 4; stepIdx++) {
      const tStep = now - 200 + stepIdx * 50;
      Object.assign(pB, { x: stepIdx * 1.0, y: 0, z: -10, yaw: 0, flags: 0, prevFlags: 0, lastStateAt: tStep });
      room.match.poseHistory.record(pB, tStep);
    }

    const bodyAt10Pitch = Math.atan2(1.2 - 1.7, 10);
    const lagHit = room.match.handleFire(pA, {
      origin: { x: 2.0, y: 1.7, z: 0 },
      dir: forwardFromYawPitch(0, bodyAt10Pitch),
      yaw: 0,
      pitch: bodyAt10Pitch,
      clientTime: now - 100,
    }, now);
    assert.equal(lagHit.hit, true);
    assert.equal(lagHit.part, "body");
    assert.equal(lagHit.damage, 115);
    assert.equal(pB.alive, false);
  }
});

test("Anti-cheat blocks legacy MSG.HIT, silent aim, wall-peek, rapid fire, speedhack, and auto-kicks at >=100", () => {
  let now = 300_000;
  const mgr = new RoomManager(() => now);
  const sentCheater = [];
  const sentVictim = [];
  const mkWs = (buf) => ({
    closed: false,
    sendText(t) { buf.push(JSON.parse(t)); return true; },
    sendJson(o) { buf.push(o); return true; },
    sendPing() { return true; },
    close() { this.closed = true; },
  });
  const sC = mgr.handleHello(mkWs(sentCheater), { name: "Cheater" });
  const sV = mgr.handleHello(mkWs(sentVictim), { name: "Victim" });
  const room = mgr.createRoom(sC, { mode: GAME_MODE.TDM, killLimit: 5 }).room;
  mgr.joinRoom(sV, room.id);
  room.setReady(sV.id, true);
  room.startMatch(sC.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  now += SPAWN_RULES.TDM.protectMs + 100;

  const pC = room.players.get(sC.id);
  const pV = room.players.get(sV.id);
  Object.assign(pC, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
  Object.assign(pV, { x: 10, y: 0, z: 0, yaw: Math.PI, pitch: 0, flags: 0, prevFlags: 0, lastStateAt: now });
  room.match.poseHistory.record(pV, now);

  // 1. Legacy MSG.HIT spoof rejected (+15)
  const hitRes = room.match.handleDeprecatedClientHit(pC, now);
  assert.equal(hitRes.ok, false);
  assert.equal(pV.hp, 100);

  // 2. Silent aim: facing -Z (yaw=0) while trying to shoot +X at victim (+25 -> total 40, triggers warn)
  const silentRes = room.match.handleFire(pC, {
    origin: { x: 0, y: 1.62, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    clientTime: now,
  }, now);
  assert.equal(silentRes.hit, false);
  assert.equal(pV.hp, 100);
  assert.equal(sentCheater.some((m) => m.type === MSG.ERROR && m.code === ERR.CHEAT_DETECTED), true);

  // 3. Rapid-fire abuse below fireInterval-25ms blocked (+10)
  const rapidRes = room.match.handleFire(pC, {
    origin: { x: 0, y: 1.7, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    yaw: 0,
    pitch: 0,
  }, now + 30);
  assert.equal(rapidRes.code, ERR.RATE_LIMITED);

  // 4. Speedhack teleport blocked by leaky movement budget (+10)
  room.match.handleState(pC, { pos: { x: 8, y: 0, z: 0 }, flags: 0 }, now + 50);
  assert.ok(pC.x < 2.0, `Speedhack must be clamped, got x=${pC.x}`);

  // 5. Repeat wall-peek / silent aim to cross 100 -> auto-kick & room cleanup
  now += 150;
  room.match.handleFire(pC, { origin: { x: 5, y: 1.7, z: 0 }, dir: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 }, now);
  now += 150;
  room.match.handleFire(pC, { origin: { x: 5, y: 1.7, z: 0 }, dir: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 }, now);

  assert.equal(room.players.has(sC.id), false);
  assert.equal(sC.roomId, null);
  assert.equal(sentCheater.some((m) => m.type === MSG.ROOM_KICKED && m.code === ERR.CHEAT_DETECTED), true);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");

test("Client combat.js and game.js remove client MSG.HIT and sync lag-comp & mobility telemetry", () => {
  const combatSrc = fs.readFileSync(path.join(ROOT_DIR, "public", "js", "combat.js"), "utf8");
  const gameSrc = fs.readFileSync(path.join(ROOT_DIR, "public", "js", "game.js"), "utf8");

  assert.equal(/net\.send\(\s*MSG\.HIT/.test(combatSrc), false, "Client must never send MSG.HIT");
  assert.match(combatSrc, /clientTime:/);
  assert.match(combatSrc, /equipEndsAt/);
  assert.match(combatSrc, /spawnHitSparks/);
  assert.match(gameSrc, /INTERP_DELAY_MS,/);
  assert.match(gameSrc, /getMoveSpeedMultiplier\(\s*curFlags\s*,\s*combat\.activeWeapon\(\)\.cfg\s*\)/);
  assert.match(gameSrc, /combat\.spawnHitSparks\(\s*ev\.hitPoint\s*\)/);
});

test("Critical: high-rate MSG.STATE burst flooding (dt=0ms) cannot bypass speedhack budget", () => {
  let now = 400_000;
  const mgr = new RoomManager(() => now);
  const wsA = { closed: false, sendText() { return true; }, sendJson() { return true; }, sendPing() { return true; }, close() {} };
  const wsB = { closed: false, sendText() { return true; }, sendJson() { return true; }, sendPing() { return true; }, close() {} };
  const sA = mgr.handleHello(wsA, { name: "Flooder" });
  const sB = mgr.handleHello(wsB, { name: "Target" });
  const room = mgr.createRoom(sA, { mode: GAME_MODE.TDM, killLimit: 5 }).room;
  mgr.joinRoom(sB, room.id);
  room.setReady(sB.id, true);
  room.startMatch(sA.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  const pA = room.players.get(sA.id);
  Object.assign(pA, { x: 0, y: 0, z: 0, flags: 0, prevFlags: 0, moveAllowance: 1.2, lastStateAt: now });

  // Attempt 20 micro-warps of 0.14m each at the exact same timestamp (dt=0) -> total 2.8m in 0ms
  for (let i = 1; i <= 20; i++) {
    room.match.handleState(pA, { pos: { x: i * 0.14, y: 0, z: 0 }, flags: 0 }, now);
  }
  assert.ok(pA.x <= 1.25, `Flood bypass must be capped by moveAllowance (<=1.2m), got x=${pA.x}`);
  assert.ok(room.match.antiCheat.getScore(pA.id, now) > 0, "Sustained flood beyond moveAllowance should trigger SPEED_TAMPER");
});

test("Important fixes: AWM quickscope cone, AWM segment-boundary zone priority, kicked rejoin block, weapon moveSpeedMult, malformed payloads & client sync", () => {
  // 1. AWM scoped quickscope/move/air spread (~0.14 rad) does not trigger AIM_DIR_TAMPER, while 25deg (0.44 rad) does
  const quickDir = forwardFromYawPitch(0.13, 0.04);
  assert.equal(validateShotDirection(0, 0, quickDir, WEAPONS.sniper, FLAG.ADS | FLAG.AIR).tampered, false);
  const badScopedDir = forwardFromYawPitch(0.44, 0);
  assert.equal(validateShotDirection(0, 0, badScopedDir, WEAPONS.sniper, FLAG.ADS).tampered, true);

  // 2. AWM projectile crossing 3.64m step boundary through arm (3.58m) into torso (3.71m) upgrades to "body"
  const sideTarget = { id: "t_seg", x: -1.05, y: 0, z: 0, yaw: 0, flags: 0, alive: true };
  const segHit = resolveAuthoritativeShot({
    shooterId: "s1",
    weaponCfg: WEAPONS.sniper,
    origin: { x: -5, y: 1.16, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    arena: { boxes: [], obbs: [] },
    targets: [sideTarget],
  });
  assert.equal(segHit.hit, true);
  assert.equal(segHit.part, "body");

  // 3. lag_comp prune deletes fully expired player histories
  const store = createPoseHistoryStore();
  store.record({ id: "old", x: 1, y: 0, z: 1, yaw: 0, flags: 0, alive: true }, 1000);
  store.prune(2000);
  assert.equal(store.sample("old", 1500, null), null);

  // 4. Match.handleState enforces weapon moveSpeedMult, Room.kickForCheat blocks same-match rejoin, and malformed inputs never yield NaN
  let now = 500_000;
  const mgr = new RoomManager(() => now);
  const mkWs = () => ({ closed: false, sendText() { return true; }, sendJson() { return true; }, sendPing() { return true; }, close() {} });
  const sA = mgr.handleHello(mkWs(), { name: "Mover" });
  const sB = mgr.handleHello(mkWs(), { name: "Foe" });
  const room = mgr.createRoom(sA, { mode: GAME_MODE.TDM, killLimit: 5 }).room;
  mgr.joinRoom(sB, room.id);
  room.setReady(sB.id, true);
  room.startMatch(sA.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  const pA = room.players.get(sA.id);
  const pB = room.players.get(sB.id);

  const measureClampX = (slot) => {
    room.match.handleSwitchWeapon(pA, { slot }, now);
    now += 1000;
    Object.assign(pA, { x: 0, y: 0, z: 0, flags: 0, prevFlags: 0, prevWeaponId: pA.activeWeaponId, moveAllowance: 0, lastStateAt: now });
    room.match.handleState(pA, { pos: { x: 20, y: 0, z: 0 }, flags: 0 }, now + 1000);
    return pA.x;
  };
  const pistolDist = measureClampX(2);
  const m4Dist = measureClampX(1);
  const awmDist = measureClampX(3);
  assert.ok(pistolDist > m4Dist && m4Dist > awmDist, `Expected weapon speed order pistol>m416>awm, got ${pistolDist}>${m4Dist}>${awmDist}`);

  // End-to-end malformed handleState / handleFire never produce NaN HP or coordinates
  room.match.handleState(pA, { pos: { x: Number.NaN, y: Infinity, z: 0 }, yaw: Infinity, flags: 0 }, now + 50);
  assert.ok(Number.isFinite(pA.x) && Number.isFinite(pA.y) && Number.isFinite(pA.yaw));
  const malformedFire = room.match.handleFire(pA, {
    origin: { x: 0, y: 1.7, z: 0 },
    dir: { x: 0, y: 0, z: 0 },
    clientTime: -999999,
  }, now + 100);
  assert.equal(malformedFire.hit, false);
  assert.ok(Number.isFinite(pB.hp));

  // kickForCheat blocks same-match rejoin while room still active; leave clears poseHistory
  room.kickForCheat(sA.id);
  const rejoinBlocked = mgr.joinRoom(sA, room.id);
  assert.equal(rejoinBlocked.ok, false);
  assert.equal(rejoinBlocked.code, ERR.CHEAT_DETECTED);
  room.leave(sB.id, now);
  assert.equal(room.match.poseHistory.sample(sB.id, now, null), null);

  // 5. Client posture flush & non-inflating equipEndsAt guards
  const combatSrc = fs.readFileSync(path.join(ROOT_DIR, "public", "js", "combat.js"), "utf8");
  const gameSrc = fs.readFileSync(path.join(ROOT_DIR, "public", "js", "game.js"), "utf8");
  assert.match(gameSrc, /flushStateBeforeFire/);
  assert.match(combatSrc, /flushStateBeforeFire/);
  assert.match(combatSrc, /Math\.min\(\s*curEquipEnd/);
});
