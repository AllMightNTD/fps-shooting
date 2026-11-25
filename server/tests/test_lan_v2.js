/**
 * AAA unit & integration tests for LAN v2 Server:
 * - RFC 6455, Spawn LoS, TDM/FFA rules
 * - Complete lifecycle WAITING -> STARTING -> PLAYING -> ENDING -> WAITING
 * - All 6 edge cases from Section 10 + HTTP OWASP allowlist checks
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENDING_DURATION_MS } from "../Room.js";
import { RECONNECT_GRACE_MS, RoomManager } from "../RoomManager.js";
import { DEFAULT_ROOT, createLanServer } from "../index.js";
import { ERR, GAME_MODE, MSG, ROOM_STATE } from "../protocol.js";
import { buildHarborMap, generateSpawnPoints, hasLineOfSight, pickFfaSpawn } from "../spawn.js";
import { FLAG, WEAPONS } from "../weapons.js";
import { OP_CLOSE, OP_TEXT, computeAcceptKey, decodeWsFrame } from "../ws.js";

function encodeMaskedClientFrame(opcode, payloadText) {
  const data = Buffer.from(payloadText, "utf8");
  const mask = crypto.randomBytes(4);
  const len = data.length;
  const hdr = len < 126 ? Buffer.allocUnsafe(2) : Buffer.allocUnsafe(4);
  hdr[0] = 0x80 | opcode;
  hdr[1] = len < 126 ? 0x80 | len : 0x80 | 126;
  if (len >= 126) hdr.writeUInt16BE(len, 2);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([hdr, mask, masked]);
}

async function openWs(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const queue = [];
    const waiters = [];

    const push = (obj) => {
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i](obj)) {
          waiters.splice(i, 1);
          return;
        }
      }
      queue.push(obj);
    };

    sock.on("connect", () => {
      sock.write(
        "GET /ws HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString("utf8");
        assert.ok(head.includes(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`));
        buf = buf.subarray(idx + 4);
        upgraded = true;
        resolve({
          send(obj) {
            sock.write(encodeMaskedClientFrame(OP_TEXT, JSON.stringify(obj)));
          },
          next(pred, timeoutMs = 2000) {
            const matchFn = typeof pred === "string" ? (m) => m.type === pred : pred;
            const hitIdx = queue.findIndex(matchFn);
            if (hitIdx !== -1) return Promise.resolve(queue.splice(hitIdx, 1)[0]);
            return new Promise((res, rej) => {
              const timer = setTimeout(() => rej(new Error("Timeout waiting for WS message")), timeoutMs);
              waiters.push((m) => {
                if (!matchFn(m)) return false;
                clearTimeout(timer);
                res(m);
                return true;
              });
            });
          },
          close() {
            sock.end(encodeMaskedClientFrame(OP_CLOSE, ""));
          },
          destroy() {
            sock.destroy();
          },
        });
      }

      while (buf.length >= 2) {
        const dec = decodeWsFrame(buf);
        if (!dec) break;
        buf = buf.subarray(dec.bytesConsumed);
        if (dec.frame.opcode === OP_TEXT) {
          push(JSON.parse(dec.frame.payload.toString("utf8")));
        }
      }
    });

    sock.on("error", reject);
  });
}

function makeMockWs() {
  const sent = [];
  const ws = {
    closed: false,
    sent,
    sendText(t) {
      sent.push(JSON.parse(t));
      return true;
    },
    sendJson(o) {
      sent.push(o);
      return true;
    },
    sendPing() {
      return true;
    },
    close() {
      this.closed = true;
    },
  };
  return ws;
}

test("FFA spawn prefers point hidden behind container LoS from active enemy", () => {
  // Arrange
  const map = buildHarborMap();
  const arena = { boxes: map.boxes, spawns: generateSpawnPoints(map.boxes) };
  const players = new Map([
    ["e1", { id: "e1", alive: true, x: 0, y: 0, z: 0 }],
  ]);

  // Act
  const chosen = pickFfaSpawn(arena, players, "me");

  // Assert chosen spawn is blocked by at least one container or far perimeter
  const losVisible = hasLineOfSight(0, 1.65, 0, chosen.x, 1.55, chosen.z, arena.boxes);
  assert.equal(losVisible, false);
});

test("Room lifecycle WAITING -> STARTING -> PLAYING -> ENDING -> WAITING & host/ready/kick/chat rules", () => {
  // Arrange
  let now = 10_000;
  const mgr = new RoomManager(() => now);
  const wsHost = makeMockWs();
  const wsG1 = makeMockWs();
  const wsG2 = makeMockWs();

  const sHost = mgr.handleHello(wsHost, { name: "Captain" });
  const sG1 = mgr.handleHello(wsG1, { name: "SoldierA" });
  const sG2 = mgr.handleHello(wsG2, { name: "Rookie" });

  // Host creates password-protected TDM room keeping exact custom name
  const created = mgr.createRoom(sHost, {
    name: "Cảng Mưa TDM",
    mode: GAME_MODE.TDM,
    killLimit: 1,
    password: "123",
    maxPlayers: 4,
  });
  assert.equal(created.ok, true);
  const room = created.room;
  assert.equal(room.name, "Cảng Mưa TDM");
  assert.equal(room.getSummary().hasPassword, true);

  // Wrong password rejected cleanly
  const badPw = mgr.joinRoom(sG1, room.id, "wrong");
  assert.equal(badPw.code, ERR.WRONG_PASSWORD);

  // Guests join with valid password -> balanced teams (Host=A, G1=B, G2=A)
  assert.equal(mgr.joinRoom(sG1, room.id, "123").ok, true);
  assert.equal(mgr.joinRoom(sG2, room.id, "123").ok, true);
  assert.equal(room.players.get(sHost.id).team, "A");
  assert.equal(room.players.get(sG1.id).team, "B");
  assert.equal(room.players.get(sG2.id).team, "A");

  // Team cap guard (maxPlayers=4 -> Team A cap=2 -> TEAM_FULL); raising maxPlayers=10 hits TEAM_IMBALANCE
  assert.equal(room.setTeam(sG1.id, "A").code, ERR.TEAM_FULL);
  room.updateSettings(sHost.id, { maxPlayers: 10 });
  assert.equal(room.setTeam(sG1.id, "A").code, ERR.TEAM_IMBALANCE);

  // Host kicks Rookie
  assert.equal(room.kick(sG1.id, sG2.id).code, ERR.NOT_HOST);
  assert.equal(room.kick(sHost.id, sG2.id).ok, true);
  assert.equal(wsG2.sent.some((m) => m.type === MSG.ROOM_KICKED), true);

  // Non-host cannot start; host cannot start while G1 not ready
  assert.equal(room.startMatch(sG1.id, now).code, ERR.NOT_HOST);
  assert.equal(room.startMatch(sHost.id, now).code, ERR.NOT_READY);

  // Guest ready -> Host updates settings -> ready resets cleanly!
  room.setReady(sG1.id, true);
  assert.equal(room.players.get(sG1.id).ready, true);
  room.updateSettings(sHost.id, { killLimit: 2 });
  assert.equal(room.players.get(sG1.id).ready, false);

  // Chat rate limit + clean sanitization
  assert.equal(room.sendChat(sG1.id, "<script>hi</script>", now).ok, true);
  assert.equal(room.sendChat(sG1.id, "spam", now + 100).code, ERR.RATE_LIMITED);

  // Ready & start 5s countdown
  room.setReady(sG1.id, true);
  assert.equal(room.startMatch(sHost.id, now).ok, true);
  assert.equal(room.state, ROOM_STATE.STARTING);
  assert.equal(room.countdownSec, 5);

  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  assert.equal(room.state, ROOM_STATE.PLAYING);
  const pHost = room.players.get(sHost.id);
  const pG1 = room.players.get(sG1.id);
  assert.equal(pHost.alive, true);

  // Firing cancels invulnerability; hit head when target shield expired wins match (killLimit=2)
  now += 2600;
  Object.assign(pHost, { x: 6, y: 0, z: 0, yaw: 0, pitch: 0, lastStateAt: now });
  Object.assign(pG1, { x: 6, y: 0, z: -5, yaw: Math.PI, pitch: 0, lastStateAt: now });
  room.match.handleFire(pHost, { origin: { x: 6, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 } }, now);
  assert.equal(pHost.invulnerableUntil, 0);
  const hit1 = room.match.handleHit(pHost, { targetId: pG1.id, part: "head" }, now);
  assert.equal(hit1.damage, 100);
  assert.equal(room.teamScores.A, 1);

  // Respawn pG1 after 4000ms, wait past 2500ms shield, score winning kill #2
  now += 4000;
  mgr.stepAll(now);
  assert.equal(pG1.alive, true);
  now += 2600;
  Object.assign(pHost, { x: 6, y: 0, z: 0, yaw: 0, pitch: 0, lastStateAt: now });
  Object.assign(pG1, { x: 6, y: 0, z: -5, yaw: Math.PI, pitch: 0, lastStateAt: now });
  room.match.handleFire(pHost, { origin: { x: 6, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 } }, now);
  room.match.handleHit(pHost, { targetId: pG1.id, part: "head" }, now);

  assert.equal(room.state, ROOM_STATE.ENDING);
  assert.equal(room.lastWinner, "A");

  // Auto-return to WAITING after 10s without reload
  now += ENDING_DURATION_MS;
  mgr.stepAll(now);
  assert.equal(room.state, ROOM_STATE.WAITING);
  assert.equal(pHost.kills, 0);
});

test("Edge cases Mục 10: last slot race, host leave in STARTING, mutual fire, 30s reconnect & duplicate names", () => {
  let now = 50_000;
  const mgr = new RoomManager(() => now);
  const ws1 = makeMockWs();
  const ws2 = makeMockWs();
  const ws3 = makeMockWs();

  // 10.6 Duplicate names deduplicated
  const s1 = mgr.handleHello(ws1, { name: "Linh" });
  const s2 = mgr.handleHello(ws2, { name: "Linh" });
  const s3 = mgr.handleHello(ws3, { name: "Linh" });
  assert.equal(s1.name, "Linh");
  assert.equal(s2.name, "Linh #2");
  assert.equal(s3.name, "Linh #3");

  // 10.1 Two players join last slot of maxPlayers=2 room
  const r1 = mgr.createRoom(s1, { mode: GAME_MODE.FFA, maxPlayers: 2, killLimit: 1 }).room;
  assert.equal(mgr.joinRoom(s2, r1.id).ok, true);
  assert.equal(mgr.joinRoom(s3, r1.id).code, ERR.ROOM_FULL);

  // 10.2 Host leaves during STARTING countdown -> transfers host & cancels countdown
  r1.setReady(s2.id, true);
  assert.equal(r1.startMatch(s1.id, now).ok, true);
  assert.equal(r1.state, ROOM_STATE.STARTING);
  mgr.leaveRoom(s1);
  assert.equal(r1.hostId, s2.id);
  assert.equal(r1.state, ROOM_STATE.WAITING);
  assert.equal(ws2.sent.some((m) => m.type === MSG.ROOM_HOST_CHANGED && m.hostId === s2.id), true);

  // 10.4 Simultaneous fire at killLimit=1 -> clean single ENDING, late hit gets MATCH_ENDED
  mgr.joinRoom(s3, r1.id);
  r1.setReady(s3.id, true);
  r1.startMatch(s2.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  assert.equal(r1.state, ROOM_STATE.PLAYING);
  now += 2600;
  const p2 = r1.players.get(s2.id);
  const p3 = r1.players.get(s3.id);
  Object.assign(p2, { x: 6, y: 0, z: 0, lastStateAt: now });
  Object.assign(p3, { x: 6, y: 0, z: -4, lastStateAt: now });
  r1.match.handleFire(p2, { origin: { x: 6, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 } }, now);
  r1.match.handleFire(p3, { origin: { x: 6, y: 1.7, z: -4 }, dir: { x: 0, y: 0, z: 1 } }, now);
  assert.equal(r1.match.handleHit(p2, { targetId: p3.id, part: "head" }, now).ok, true);
  assert.equal(r1.state, ROOM_STATE.ENDING);
  const lateHit = r1.match.handleHit(p3, { targetId: p2.id, part: "head" }, now);
  assert.equal(lateHit.code, ERR.MATCH_ENDED);

  // 10.3 & 10.5 Disconnect & reconnect via token within 30s preserves score/seat; >30s removes & frees host
  now += ENDING_DURATION_MS;
  mgr.stepAll(now);
  assert.equal(r1.state, ROOM_STATE.WAITING);
  mgr.markDisconnected(s2.id, ws2);
  now += 10_000;
  mgr.stepAll(now);
  assert.equal(r1.players.has(s2.id), true); // Held within 30s grace period

  const ws2Reconnected = makeMockWs();
  mgr.handleHello(ws2Reconnected, { name: "Linh", token: s2.token });
  assert.equal(ws2Reconnected.sent.some((m) => m.type === MSG.WELCOME && m.resumed === true), true);
  assert.equal(ws2Reconnected.sent.some((m) => m.type === MSG.ROOM_JOINED && m.room.id === r1.id), true);

  // Disconnect permanently past 30s -> removes s2 and promotes s3 to host
  mgr.markDisconnected(s2.id, ws2Reconnected);
  now += RECONNECT_GRACE_MS + 100;
  mgr.stepAll(now);
  assert.equal(r1.players.has(s2.id), false);
  assert.equal(r1.hostId, s3.id);
});

test("HTTP static server serves public/FPS.html, arm_rig.js & fps_arms.bundle.js, blocks traversal, and runs quickJoin E2E", async () => {
  const srv = createLanServer({ tickMs: 40 });
  const port = await srv.start(0, "127.0.0.1");

  try {
    const protoRes = await fetch(`http://127.0.0.1:${port}/js/protocol.js`);
    assert.equal(protoRes.status, 200);
    const weaponsRes = await fetch(`http://127.0.0.1:${port}/js/weapons.js`);
    assert.equal(weaponsRes.status, 200);
    const armRigRes = await fetch(`http://127.0.0.1:${port}/js/arm_rig.js`);
    assert.equal(armRigRes.status, 200);
    assert.match(armRigRes.headers.get("content-type") || "", /application\/javascript/);
    assert.ok((await armRigRes.text()).includes("createSkinnedArmsController"));
    const armsBundlePath = path.join(DEFAULT_ROOT, "model", "dist", "fps_arms.bundle.js");
    if (fs.existsSync(armsBundlePath)) {
      const armsBundleRes = await fetch(`http://127.0.0.1:${port}/model/dist/fps_arms.bundle.js`);
      assert.equal(armsBundleRes.status, 200);
      assert.match(armsBundleRes.headers.get("content-type") || "", /application\/javascript/);
      const armsBundleText = await armsBundleRes.text();
      assert.ok(armsBundleText.length > 0 && armsBundleText.includes('FPS_MODELS["fps_arms"]'));
    }
    const gameJsRes = await fetch(`http://127.0.0.1:${port}/js/game.js`);
    assert.equal(gameJsRes.status, 200);
    assert.match(gameJsRes.headers.get("content-type") || "", /application\/javascript/);
    const gameJsText = await gameJsRes.text();
    assert.match(gameJsText, /from\s+["']\/js\/arm_rig\.js["']/);
    assert.ok(gameJsText.includes("createSkinnedArmsController"));
    assert.ok(gameJsText.includes("SKINNED_ARM_POSES"));
    const blockedServer = await fetch(`http://127.0.0.1:${port}/server/Room.js`);
    assert.equal(blockedServer.status, 404);
    const blockedEnv = await fetch(`http://127.0.0.1:${port}/.env`);
    assert.equal(blockedEnv.status, 404);

    const ws1 = await openWs(port);
    const ws2 = await openWs(port);

    ws1.send({ type: MSG.HELLO, name: "HostE2E" });
    const w1 = await ws1.next(MSG.WELCOME);
    assert.ok(w1.token);

    ws2.send({ type: MSG.HELLO, name: "GuestE2E" });
    await ws2.next(MSG.WELCOME);

    ws1.send({ type: MSG.ROOM_QUICK });
    const j1 = await ws1.next(MSG.ROOM_JOINED);
    ws2.send({ type: MSG.ROOM_QUICK });
    const j2 = await ws2.next(MSG.ROOM_JOINED);
    assert.equal(j1.room.id, j2.room.id);

    ws1.close();
    ws2.close();
  } finally {
    await srv.stop();
  }
});

test("HTTP static server serves model/dist/fps_arms.bundle.js hermetically from rootDir", async () => {
  // Arrange
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fps-lan-v2-"));
  const distDir = path.join(tmpDir, "model", "dist");
  const fixturePayload = 'window.FPS_MODELS = window.FPS_MODELS || {}; FPS_MODELS["fps_arms"] = "hermetic";\n';
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "fps_arms.bundle.js"), fixturePayload, "utf8");
  const srv = createLanServer({ rootDir: tmpDir, tickMs: 40 });
  const port = await srv.start(0, "127.0.0.1");

  try {
    // Act
    const res = await fetch(`http://127.0.0.1:${port}/model/dist/fps_arms.bundle.js`);
    const body = await res.text();

    // Assert
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(body, fixturePayload);
  } finally {
    await srv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Server weapon reload/switch/TOL-80ms, sprint block, crouch hitbox & mid-match token mag sync", () => {
  let now = 100_000;
  const mgr = new RoomManager(() => now);
  const wsA = makeMockWs();
  const wsB = makeMockWs();
  const sA = mgr.handleHello(wsA, { name: "Alpha" });
  const sB = mgr.handleHello(wsB, { name: "Bravo" });

  const room = mgr.createRoom(sA, { mode: GAME_MODE.TDM, killLimit: 5 }).room;
  mgr.joinRoom(sB, room.id);
  room.setReady(sB.id, true);
  room.startMatch(sA.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  assert.equal(room.state, ROOM_STATE.PLAYING);
  const pA = room.players.get(sA.id);
  const pB = room.players.get(sB.id);

  // Sprinting cannot shoot and sends authoritative AMMO
  const sprintShot = room.match.handleFire(pA, { flags: FLAG.SPRINT }, now);
  assert.equal(sprintShot.ok, false);
  assert.equal(pA.weapons.m416.mag, WEAPONS.m416.magSize);

  // Fire 5 bullets then trigger tactical reload (faster than empty reload)
  for (let i = 0; i < 5; i++) {
    now += WEAPONS.m416.fireInterval + 5;
    assert.equal(room.match.handleFire(pA, {}, now).ok, true);
  }
  assert.equal(pA.weapons.m416.mag, 25);
  assert.equal(room.match.handleReload(pA, now), true);
  const evRel = wsB.sent.filter((m) => m.type === MSG.EVENT_RELOAD).pop();
  assert.equal(evRel.id, "m416");
  assert.equal(evRel.dur, WEAPONS.m416.tacticalReloadTime);

  // Cannot shoot while reloading
  assert.equal(room.match.handleFire(pA, {}, now + 300).ok, false);

  // Switch to pistol mid-reload -> cancels reload & preserves 25 mag on m416
  assert.equal(room.match.handleSwitchWeapon(pA, { slot: 2 }, now + 500), true);
  assert.equal(pA.activeWeaponId, "pistol");
  assert.equal(pA.weapons.m416.reloadEndsAt, 0);
  assert.equal(pA.weapons.m416.mag, 25);

  // Switch back to slot 1 (m416) -> still at 25 and not magically reloaded
  assert.equal(room.match.handleSwitchWeapon(pA, { slot: 1 }, now + 600), true);
  assert.equal(pA.weapons.m416.mag, 25);

  // Empty m416 completely -> auto-reload with full reloadTime (2400ms), then test TOL = 80ms
  for (let i = 0; i < 25; i++) {
    now += WEAPONS.m416.fireInterval + 5;
    assert.equal(room.match.handleFire(pA, {}, now).ok, true);
  }
  assert.equal(pA.weapons.m416.mag, 0);
  assert.ok(pA.weapons.m416.reloadEndsAt > now);
  const fullReloadEnd = pA.weapons.m416.reloadEndsAt;
  assert.equal(pA.weapons.m416.reloadDuration, WEAPONS.m416.reloadTime);

  // Firing 75ms before reloadEndsAt succeeds cleanly thanks to TOL = 80ms!
  now = fullReloadEnd - 75;
  assert.equal(room.match.handleFire(pA, {}, now).ok, true);
  assert.equal(pA.weapons.m416.mag, 29);

  // Mid-match token reconnect preserves exact weapon mags & active weapon
  now += 200;
  mgr.markDisconnected(sA.id, wsA);
  const wsAReconnect = makeMockWs();
  mgr.handleHello(wsAReconnect, { name: "Alpha", token: sA.token });
  const ammoSync = wsAReconnect.sent.filter((m) => m.type === MSG.AMMO).pop();
  assert.equal(ammoSync.activeWeaponId, "m416");
  assert.equal(ammoSync.weapons.m416, 29);
  assert.equal(ammoSync.weapons.pistol, WEAPONS.pistol.magSize);

  // Crouch posture: test crouch speed clamp and 1.45m chest-high cover LoS protection
  now += 3000; // Wait past spawn shield
  Object.assign(pB, { x: 6, y: 0, z: 0, flags: FLAG.CROUCH, prevFlags: FLAG.CROUCH, lastStateAt: now });
  Object.assign(pA, { x: 6, y: 0, z: -5, lastStateAt: now });
  // Attempt to warp 15m over 1s while crouched -> server clamps move strictly below standing/sprint speeds
  room.match.handleState(pB, { pos: { x: 21, y: 0, z: 0 }, flags: FLAG.CROUCH }, now + 1000);
  assert.ok(pB.x < 11.5, `Expected crouch speed clamp, got x=${pB.x}`);
  Object.assign(pB, { x: 6, y: 0, z: 0, flags: FLAG.CROUCH, prevFlags: FLAG.CROUCH, lastStateAt: now });

  // Cover height 1.45m: standing head (1.63m) exposes above it, crouched head (1.08m) hides cleanly!
  room.arena.boxes.push({ x0: 4, x1: 8, y0: 0, y1: 1.45, z0: -3, z1: -2 });
  assert.equal(room.match.handleFire(pA, { origin: { x: 6, y: 1.7, z: -5 }, dir: { x: 0, y: 0, z: 1 } }, now).ok, true);
  const blockedCrouchHit = room.match.handleHit(pA, { targetId: pB.id, part: "head" }, now);
  assert.equal(blockedCrouchHit.ok, false); // Crouched head behind 1.45m cover cannot be hit!
  room.arena.boxes.pop();

  // Standing pB without cover takes sniper headshot (160 dmg -> kills even while pB reloading!)
  now += WEAPONS.sniper.fireInterval + 50;
  Object.assign(pB, { flags: 0, prevFlags: 0, lastStateAt: now });
  room.match.handleFire(pB, {}, now + 50);
  room.match.handleReload(pB, now + 50);
  assert.ok(pB.weapons.m416.reloadEndsAt > 0);
  room.match.handleSwitchWeapon(pA, { slot: 3 }, now + 100);
  assert.equal(room.match.handleFire(pA, {}, now + 200).ok, true);
  const sniperHead = room.match.handleHit(pA, { targetId: pB.id, part: "head" }, now + 200);
  assert.equal(sniperHead.damage, WEAPONS.sniper.damage.head);
  assert.equal(pB.alive, false);
  assert.equal(pB.weapons.m416.reloadEndsAt, 0); // Death cancelled reload!

  // Respawn restores full mag on all weapons
  now += 4300;
  mgr.stepAll(now);
  assert.equal(pB.alive, true);
  assert.equal(pB.weapons.m416.mag, WEAPONS.m416.magSize);
  assert.equal(pB.weapons.pistol.mag, WEAPONS.pistol.magSize);
  assert.equal(pB.weapons.sniper.mag, WEAPONS.sniper.magSize);
});
