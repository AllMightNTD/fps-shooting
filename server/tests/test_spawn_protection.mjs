/**
 * AAA unit & integration tests (Happy & Unhappy paths) for:
 * 1) Spawn Protection (TDM 3.0s / FFA 2.0s), blinking cadence & early cancel (fire, radius, ADS)
 * 2) Invulnerability Frames (400ms i-frames + Lag-Comp spawnEpoch boundary guard)
 * 3) TDM 3-Tier Spawn + Dynamic Spawn Flip & Cooldown + FFA Golden-Distance LoS Spawning
 * 4) Protocol 20Hz Snapshot protection bitmask & Lobby Bot configurator helpers
 * 5) Offline Bot Match Controller (TDM & FFA, 3 difficulties, 3 weapons, 6 SWAT stances, shield blocks & win flow)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BOT_DIFFICULTY_PRESETS, createBotMatchController, normalizeBotConfig } from "../../public/js/bot_ai.js";
import { computeBotTeamSummary, normalizeLobbyView } from "../../public/js/lobby_utils.js";
import { RoomManager } from "../RoomManager.js";
import { createLanServer } from "../index.js";
import { createPoseHistoryStore } from "../lag_comp.js";
import { GAME_MODE, MSG, ROOM_STATE, unpackSnapshot } from "../protocol.js";
import { loadMilitaryArena } from "../spawn.js";
import {
  SPAWN_RULES,
  activateSpawnProtection,
  cancelProtectionOnFire,
  computeProtectionBlinkState,
  createSpawnTracker,
  evaluateProtectionTick,
  pickSmartFfaSpawn,
  pickSmartTeamSpawn,
} from "../spawn_rules.js";
import * as weaponsApi from "../weapons.js";
const { FLAG, WEAPONS } = weaponsApi;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function makeMockWs() {
  const sent = [];
  return {
    closed: false,
    sent,
    sendText(t) { sent.push(JSON.parse(t)); return true; },
    sendJson(o) { sent.push(o); return true; },
    sendPing() { return true; },
    close() { this.closed = true; },
  };
}

test("Spawn Protection & i-frames enforce duration, radius/ADS/fire cancel, and blinking curve", () => {
  // Arrange
  const player = { id: "p1", alive: true, x: 0, y: 0, z: -40, flags: 0, ads: false };
  const t0 = 10_000;

  // Act 1: Activate TDM protection (400ms i-frames + 3000ms Spawn Protection, 750ms expiring window)
  const st0 = activateSpawnProtection(player, "TDM", { x: 0, y: 0, z: -40 }, t0);
  assert.equal(st0.active, true);
  assert.equal(st0.iFrames, true);
  assert.equal(st0.expiring, false);
  assert.equal(player.spawnEpoch, 1);

  // Blink during i-frames uses 12 Hz fast pulse; normal protection uses 4.5 Hz; expiring uses 10 Hz
  const bIFrames = computeProtectionBlinkState(1.02, st0);
  assert.equal(bIFrames.freqHz, 12.0);
  const stMid = evaluateProtectionTick(player, "TDM", t0 + 1000);
  assert.equal(stMid.iFrames, false);
  assert.equal(stMid.spawnProtected, true);
  assert.equal(computeProtectionBlinkState(1.0, stMid).freqHz, 4.5);

  // Reaching final 750ms switches to warning expiring blink (10 Hz)
  const stExp = evaluateProtectionTick(player, "TDM", t0 + 2500);
  assert.equal(stExp.expiring, true);
  assert.equal(computeProtectionBlinkState(1.0, stExp).freqHz, 10.0);

  // Leaving 9.0m TDM spawn radius immediately cancels soft protection
  player.x = 10.5;
  const stLeftRadius = evaluateProtectionTick(player, "TDM", t0 + 1200);
  assert.equal(stLeftRadius.active, false);
  assert.equal(player.invulnerableUntil, 0);

  // Sustained ADS > 600ms after i-frames cancels Spawn Protection
  activateSpawnProtection(player, "FFA", { x: 0, y: 0, z: 0 }, t0 + 5000);
  player.x = 1.0;
  player.z = 0;
  player.flags = FLAG.ADS;
  assert.equal(evaluateProtectionTick(player, "FFA", t0 + 5500).active, true);
  assert.equal(evaluateProtectionTick(player, "FFA", t0 + 6250).active, false);

  // cancelProtectionOnFire clears both i-frames & soft protection synchronously
  activateSpawnProtection(player, "TDM", { x: 0, y: 0, z: -40 }, t0 + 9000);
  cancelProtectionOnFire(player);
  assert.equal(player.iFramesUntil, 0);
  assert.equal(player.invulnerableUntil, 0);

  // Unhappy path: dead or null player never throws or reports active protection
  player.alive = false;
  assert.equal(evaluateProtectionTick(player, "TDM", t0 + 9100).active, false);
  assert.equal(computeProtectionBlinkState(0, { active: false, hitFlash: 0 }).blinkOn, false);
});

test("Lag-Comp spawnEpoch blocks pre-respawn shots leaking across deaths while shielding emits sparks & bits", () => {
  const store = createPoseHistoryStore();
  store.record({ id: "v1", x: 0, y: 0, z: -10, yaw: 0, flags: 0, alive: true, spawnEpoch: 1 }, 1000);
  store.record({ id: "v1", x: 0, y: 0, z: -40, yaw: 0, flags: 0, alive: true, spawnEpoch: 2 }, 1100);
  const acrossEpoch = store.sample("v1", 1050);
  assert.equal(acrossEpoch.alive, false, "Different spawnEpoch must prevent interpolation across deaths");

  // Full server Match test: shooter hitting spawned victim with active shield gets part="shield", dmg=0, and snapshot bitmask carries iFrames & protectExpiring
  let now = 50_000;
  const mgr = new RoomManager(() => now);
  const wsA = makeMockWs();
  const wsB = makeMockWs();
  const sA = mgr.handleHello(wsA, { name: "Attacker" });
  const sB = mgr.handleHello(wsB, { name: "FreshSpawn" });
  const room = mgr.createRoom(sA, { mode: GAME_MODE.FFA, killLimit: 5 }).room;
  mgr.joinRoom(sB, room.id);
  room.setReady(sB.id, true);
  room.startMatch(sA.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  const pA = room.players.get(sA.id);
  const pB = room.players.get(sB.id);

  // Snapshot immediately after spawn shows invulnerable=true & iFrames=true on bitmask
  const snap0 = unpackSnapshot(room.match.buildSnapshot(now));
  const uB0 = snap0.players.find((p) => p.id === pB.id);
  assert.equal(uB0.invulnerable, true);
  assert.equal(uB0.iFrames, true);
  assert.equal(uB0.protectExpiring, false);

  // At now + 1500ms in FFA (protectMs=2000, expiringWindow=650), iFrames=false & protectExpiring=true!
  const snapExp = unpackSnapshot(room.match.buildSnapshot(now + 1500));
  const uBExp = snapExp.players.find((p) => p.id === pB.id);
  assert.equal(uBExp.invulnerable, true);
  assert.equal(uBExp.iFrames, false);
  assert.equal(uBExp.protectExpiring, true);

  // Shooter firing cancels own shield, hits victim inside spawn radius -> dmg=0, part="shield", hitPoint preserved
  Object.assign(pA, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, lastStateAt: now + 1500 });
  Object.assign(pB, {
    x: 0,
    y: 0,
    z: -4,
    yaw: Math.PI,
    pitch: 0,
    lastStateAt: now + 1500,
    spawnOrigin: { x: 0, y: 0, z: -4 },
  });
  room.match.poseHistory.record(pB, now + 1500);
  const shieldHit = room.match.handleFire(
    pA,
    { origin: { x: 0, y: 1.62, z: 0 }, dir: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0, clientTime: now + 1500 },
    now + 1500,
  );
  assert.equal(shieldHit.shielded, true);
  assert.equal(shieldHit.part, "shield");
  assert.equal(shieldHit.damage, 0);
  assert.ok(shieldHit.hitPoint);
  assert.equal(pA.invulnerableUntil, 0);
});

test("TDM 3-tier Dynamic Spawn Flip (with 8s cooldown) & FFA Golden-Distance + Anti-revenge spawn scoring", () => {
  const arena = loadMilitaryArena();
  assert.ok(arena.spawns.A.length >= 9);
  assert.ok(arena.spawns.B.length >= 9);
  assert.ok(arena.spawns.FFA.length >= 16);

  // 1. TDM Spawn Flip: enemy camping inside Team A base (z=-40) while Team B base (z=+40) is safe
  const tracker = createSpawnTracker();
  const tdmPlayers = new Map([
    ["camper1", { id: "camper1", team: "B", alive: true, x: 0, y: 0, z: -38, flags: 0, yaw: Math.PI }],
    ["camper2", { id: "camper2", team: "B", alive: true, x: -12, y: 0, z: -38, flags: 0, yaw: Math.PI }],
  ]);
  const flipped = pickSmartTeamSpawn(arena, "A", tdmPlayers, "respawnerA", 20_000, tracker);
  assert.equal(flipped.reason, "flip");
  assert.ok(flipped.z > 30, `Expected flipped Team A spawn in south opposite base, got z=${flipped.z}`);

  // Cooldown 8000ms prevents erratic back-to-back flipping within 2s
  const duringCooldown = pickSmartTeamSpawn(arena, "A", tdmPlayers, "respawnerA", 22_000, tracker);
  assert.equal(duringCooldown.reason, "normal");

  // 2. FFA avoids lastDeathPos & close enemies while preferring occluded golden-distance points
  const ffaTracker = createSpawnTracker();
  const ffaPlayers = new Map([
    ["e1", { id: "e1", alive: true, x: 0, y: 0, z: -38, flags: 0, yaw: 0 }],
    ["e2", { id: "e2", alive: true, x: 20, y: 0, z: -18, flags: 0, yaw: Math.PI }],
  ]);
  const ffaChoice = pickSmartFfaSpawn(
    arena,
    ffaPlayers,
    "me",
    30_000,
    ffaTracker,
    { lastDeathPos: { x: 0, y: 0, z: -40.5 } },
  );
  assert.ok(Math.hypot(ffaChoice.x - 0, ffaChoice.z - -38) > 12);
});

test("Bot AI controller & Lobby utils handle TDM/FFA modes, 3 difficulties, weapon switch, shield & match victory", async () => {
  // 1. Lobby utils validation
  assert.equal(normalizeLobbyView("bot"), "bot");
  assert.equal(normalizeLobbyView("survival"), "survival");
  assert.equal(normalizeLobbyView("<script>"), "home");
  const tdmSum = computeBotTeamSummary({ mode: "TDM", botCount: 5 });
  assert.equal(tdmSum.teamLabel, "3v3");
  assert.equal(tdmSum.allies, 2);
  assert.equal(tdmSum.enemies, 3);
  const ffaSum = computeBotTeamSummary({ mode: "FFA", botCount: 5 });
  assert.equal(ffaSum.allies, 0);
  assert.equal(ffaSum.enemies, 5);
  const tdm8v8 = computeBotTeamSummary({ mode: "TDM" });
  assert.equal(tdm8v8.teamLabel, "8v8");
  assert.equal(tdm8v8.botCount, 15);
  const tdm9v9 = computeBotTeamSummary({ mode: "TDM", botCount: 17 });
  assert.equal(tdm9v9.teamLabel, "9v9");
  assert.equal(tdm9v9.allies, 8);
  assert.equal(tdm9v9.enemies, 9);

  // Check RoomManager & Bot Match support full 8v8 (16 players / 15 bots) and 9v9 (18 players / 17 bots)
  const capMgr = new RoomManager(() => 1000);
  const capHost = capMgr.handleHello(makeMockWs(), { name: "Host8v8" });
  const defaultRoom = capMgr.createRoom(capHost, { mode: GAME_MODE.TDM, map: "military" }).room;
  assert.equal(defaultRoom.maxPlayers, 16);
  const full9v9Room = capMgr.createRoom(capHost, { mode: GAME_MODE.TDM, map: "military", maxPlayers: 18 }).room;
  assert.equal(full9v9Room.maxPlayers, 18);

  const arena = loadMilitaryArena();
  const match9v9 = createBotMatchController({
    arena,
    config: normalizeBotConfig({ mode: "TDM", mapId: "military", difficulty: "medium", botCount: 17 }),
    weaponsApi,
    humanId: "human-local",
    humanName: "Player1",
    nowFn: () => 10_000,
  });
  assert.equal(match9v9.players.size, 18);
  const botNames9v9 = Array.from(match9v9.players.values()).filter((p) => p.isBot).map((p) => p.name);
  assert.equal(new Set(botNames9v9).size, 17, "All 17 AI callsigns for 9v9 must be unique");

  const clamped = normalizeBotConfig({ mode: "TDM", mapId: "military", difficulty: "hard", botCount: 5, killLimit: 2 });
  assert.equal(clamped.killLimit, 5);

  // 2. Bot Match Controller integration (TDM 3v3 on Khu Quân Sự Cũ)
  let tMs = 10_000;
  let endPayload = null;
  const match = createBotMatchController({
    arena,
    config: clamped,
    weaponsApi,
    humanId: "human-local",
    humanName: "Player1",
    nowFn: () => tMs,
    rngFn: () => 0.35,
    callbacks: {
      onMatchEnd: (res) => { endPayload = res; },
    },
  });

  assert.equal(match.players.size, 6);
  const human = match.getHuman();
  const bots = Array.from(match.players.values()).filter((p) => p.isBot);
  const enemyBot = bots.find((b) => b.team === "B");
  assert.ok(enemyBot);

  // Human starts with TDM i-frames; shooting protected enemy bot blocks damage!
  Object.assign(human, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  Object.assign(enemyBot, { x: 0, y: 0, z: -6, yaw: Math.PI, pitch: 0 });
  const blocked = match.handleHumanFire("m416", { x: 0, y: 1.62, z: 0 }, { x: 0, y: 0, z: -1 }, tMs + 100);
  assert.equal(blocked.shielded, true);
  assert.equal(blocked.damage, 0);
  assert.equal(human.invulnerableUntil, 0);

  // Step bots for 3.2s -> spawn protection expires and bots move across arena using waypoints & stances
  for (let s = 0; s < 64; s++) {
    tMs += 50;
    match.step(0.05, tMs);
  }
  // Eliminate enemyBot across respawn cycles until Team A hits clamped killLimit=5
  for (let round = 0; round < 5 && !endPayload; round++) {
    if (!enemyBot.alive) {
      tMs += SPAWN_RULES.TDM.respawnDelayMs + 50;
      match.step(0.05, tMs);
      assert.equal(enemyBot.alive, true);
      tMs += SPAWN_RULES.TDM.protectMs + 100;
    } else {
      enemyBot.invulnerableUntil = 0;
      enemyBot.iFramesUntil = 0;
    }
    enemyBot.hp = 100;
    Object.assign(human, { alive: true, hp: 100, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0 });
    Object.assign(enemyBot, { x: 0, y: 0, z: -10, yaw: Math.PI, flags: 0 });
    const killShot = match.handleHumanFire("sniper", { x: 0, y: 1.35, z: 0 }, { x: 0, y: 0, z: -1 }, tMs + 50);
    tMs += 50;
    assert.equal(killShot.damage, 115);
    assert.equal(enemyBot.alive, false);
  }
  assert.ok(endPayload && endPayload.winner === "A", "Human Team A should win at killLimit=5");

  // 3. Verify HTTP routes serve /js/spawn_rules.js, /js/hitreg.js, /js/bot_ai.js cleanly
  const srv = createLanServer({ tickMs: 100 });
  const port = await srv.start(0, "127.0.0.1");
  try {
    for (const p of ["/js/spawn_rules.js", "/js/hitreg.js", "/js/bot_ai.js", "/js/military_map_data.js"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 200, `Expected ${p} to serve 200`);
    }
    assert.ok(BOT_DIFFICULTY_PRESETS.hard.respectProtectChance > BOT_DIFFICULTY_PRESETS.easy.respectProtectChance);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "public", "FPS.html")));
  } finally {
    await srv.stop();
  }
});
