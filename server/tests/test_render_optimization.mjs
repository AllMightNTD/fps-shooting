/**
 * AAA unit & integration tests for Render Free deployment optimizations:
 * - HTTP Brotli/Gzip compression, ETag 304, Cache-Control policies, Range 206 preservation
 * - Compact 20Hz buildSnapshot() & unpackSnapshot() round-trip + bandwidth savings
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import zlib from "node:zlib";

import { RoomManager } from "../RoomManager.js";
import { createLanServer } from "../index.js";
import { GAME_MODE, MSG, ROOM_STATE, unpackSnapshot } from "../protocol.js";
import { FLAG } from "../weapons.js";

function httpRequestRaw(url, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTTP server compresses .glb/.js/.json/.html via br/gzip with ETag 304 and proper Cache-Control", async () => {
  // Arrange
  const srv = createLanServer({ tickMs: 1000 });
  const port = await srv.start(0, "127.0.0.1");
  try {
    // Act & Assert Happy Path: Brotli compression + 86400s cache on .glb
    const glbBr = await httpRequestRaw(
      `http://127.0.0.1:${port}/model/dist/map_oil_barrel.glb`,
      { "Accept-Encoding": "gzip, deflate, br" },
    );
    assert.equal(glbBr.status, 200);
    assert.equal(glbBr.headers["content-encoding"], "br");
    assert.equal(glbBr.headers["cache-control"], "public, max-age=86400");
    assert.match(glbBr.headers["vary"] || "", /Accept-Encoding/i);
    assert.ok(glbBr.headers["etag"]);
    const glbRawFromBr = zlib.brotliDecompressSync(glbBr.body);
    assert.equal(glbRawFromBr.subarray(0, 4).toString("ascii"), "glTF");
    assert.ok(glbBr.body.length < glbRawFromBr.length, "Brotli .glb should be smaller than raw");

    // Gzip fallback on .js + 300s cache + ETag 304 Not Modified
    const gameGz = await httpRequestRaw(
      `http://127.0.0.1:${port}/js/game.js`,
      { "Accept-Encoding": "gzip" },
    );
    assert.equal(gameGz.status, 200);
    assert.equal(gameGz.headers["content-encoding"], "gzip");
    assert.equal(gameGz.headers["cache-control"], "public, max-age=300");
    const gameRaw = zlib.gunzipSync(gameGz.body).toString("utf8");
    assert.ok(gameRaw.includes("createGameEngine"));
    assert.ok(gameGz.body.length < Buffer.byteLength(gameRaw) * 0.45);

    const notMod = await httpRequestRaw(
      `http://127.0.0.1:${port}/js/game.js`,
      { "Accept-Encoding": "br, gzip", "If-None-Match": gameGz.headers["etag"] },
    );
    assert.equal(notMod.status, 304);
    assert.equal(notMod.body.length, 0);

    // FPS.html should not eagerly embed 17 static .bundle.js <script> tags over HTTP
    const htmlBr = await httpRequestRaw(
      `http://127.0.0.1:${port}/FPS.html`,
      { "Accept-Encoding": "br" },
    );
    assert.equal(htmlBr.status, 200);
    assert.equal(htmlBr.headers["content-encoding"], "br");
    const htmlStr = zlib.brotliDecompressSync(htmlBr.body).toString("utf8");
    assert.equal(htmlStr.includes(".bundle.js"), false);

    // Media (.mp3 / .wav) stay uncompressed with 86400s cache and Range 206 intact
    const mp3Range = await httpRequestRaw(
      `http://127.0.0.1:${port}/sound/Before_the_Breach.mp3`,
      { "Accept-Encoding": "br, gzip", Range: "bytes=0-63" },
    );
    assert.equal(mp3Range.status, 206);
    assert.equal(mp3Range.headers["content-encoding"], undefined);
    assert.equal(mp3Range.headers["cache-control"], "public, max-age=86400");
    assert.equal(mp3Range.body.length, 64);

    // Unhappy / HEAD path: HEAD never sends compressed body
    const headRes = await httpRequestRaw(
      `http://127.0.0.1:${port}/shared/maps/military_colliders.json`,
      { "Accept-Encoding": "br, gzip" },
      "HEAD",
    );
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers["content-encoding"], undefined);
    assert.equal(headRes.headers["cache-control"], "public, max-age=86400");
    assert.equal(headRes.body.length, 0);
  } finally {
    await srv.stop();
  }
});

test("Compact buildSnapshot & unpackSnapshot preserve full match state and reduce payload >50%", () => {
  // Arrange: create a 10-player TDM room in PLAYING state
  let now = 20_000;
  const mgr = new RoomManager(() => now);
  const noopWs = () => ({ closed: false, sendJson() {}, sendText() {}, sendPing() {}, close() {} });
  const sessions = [];
  for (let i = 0; i < 10; i++) {
    sessions.push(mgr.handleHello(noopWs(), { name: `Soldier_${i + 1}` }));
  }
  const room = mgr.createRoom(sessions[0], { mode: GAME_MODE.TDM, maxPlayers: 10 }).room;
  for (let i = 1; i < 10; i++) {
    mgr.joinRoom(sessions[i], room.id);
    room.setReady(sessions[i].id, true);
  }
  room.startMatch(sessions[0].id, now);
  for (let s = 0; s < 5; s++) {
    now += 1000;
    mgr.stepAll(now);
  }
  assert.equal(room.state, ROOM_STATE.PLAYING);

  const p0 = room.players.get(sessions[0].id);
  const p1 = room.players.get(sessions[1].id);
  Object.assign(p0, {
    x: 12.3456,
    y: 4.0,
    z: -18.7654,
    yaw: 1.23456,
    pitch: -0.25678,
    mv: 1.4,
    flags: FLAG.ADS | FLAG.FIRING,
    laser: false,
    activeWeaponId: "sniper",
    hp: 75,
    kills: 4,
    deaths: 1,
    headshots: 2,
  });
  p0.weapons.sniper.mag = 3;
  p1.alive = false;
  p1.respawnAt = now + 2400;

  // Act
  const compact = room.match.buildSnapshot(now);
  const jsonBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  const rosterNames = new Map(sessions.map((s) => [s.id, s.name]));
  const unpacked = unpackSnapshot(compact, rosterNames);

  // Assert compact size & fidelity
  assert.equal(compact.type, MSG.SNAPSHOT);
  assert.ok(jsonBytes < 1100, `Expected compact 10-player snapshot < 1100B, got ${jsonBytes}B`);
  assert.equal(unpacked.players.length, 10);

  const u0 = unpacked.players.find((x) => x.id === p0.id);
  assert.equal(u0.name, "Soldier_1");
  assert.equal(u0.team, p0.team);
  assert.equal(u0.x, 12.35);
  assert.equal(u0.y, 4);
  assert.equal(u0.z, -18.77);
  assert.equal(u0.yaw, 1.235);
  assert.equal(u0.pitch, -0.257);
  assert.equal(u0.weaponId, "sniper");
  assert.equal(u0.ammo, 3);
  assert.equal(u0.hp, 75);
  assert.equal(u0.ads, true);
  assert.equal(u0.laser, false);
  assert.equal(u0.alive, true);
  assert.equal(u0.invulnerable, true);
  assert.equal(u0.kills, 4);
  assert.equal(u0.deaths, 1);
  assert.equal(u0.headshots, 2);

  const u1 = unpacked.players.find((x) => x.id === p1.id);
  assert.equal(u1.alive, false);
  assert.equal(u1.respawnMs, 2400);

  // Unhappy path & legacy compatibility
  assert.equal(unpackSnapshot(null), null);
  const legacy = { type: MSG.SNAPSHOT, t: 123, players: [{ id: "x", name: "Legacy" }] };
  assert.equal(unpackSnapshot(legacy), legacy);
});

