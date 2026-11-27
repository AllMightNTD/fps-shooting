/**
 * AAA unit & integration tests for Render Free + Cloudflare Pages deployment optimizations:
 * - HTTP Brotli/Gzip compression, ETag 304, Cache-Control policies, Range 206 preservation
 * - Compact 20Hz buildSnapshot() & unpackSnapshot() round-trip + bandwidth savings
 * - /health endpoint, ALLOWED_ORIGIN WebSocket guard, net_utils RTT/2 & URL helpers, build_static.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  computeClockOffsetWithRtt,
  isPrivateOrLocalHost,
  resolveOnlineShareUrl,
  resolveWsUrl,
  sanitizeWsUrl,
} from "../../public/js/net_utils.js";
import { buildStaticSite } from "../../scripts/build_static.mjs";
import { RoomManager } from "../RoomManager.js";
import { createLanServer, isWsOriginAllowed, parseAllowedOrigins } from "../index.js";
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

function rawWsUpgradeProbe(port, originHeader = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let rawResp = "";
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(val);
    };
    sock.on("connect", () => {
      const originLine = originHeader !== null ? `Origin: ${originHeader}\r\n` : "";
      sock.write(
        "GET /ws HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          originLine +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    sock.on("data", (chunk) => {
      rawResp += chunk.toString("utf8");
      if (rawResp.includes("\r\n\r\n")) {
        finish(rawResp.split("\r\n")[0]);
      }
    });
    sock.on("close", () => finish(rawResp.split("\r\n")[0] || "CLOSED"));
    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
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
    assert.match(htmlStr, /<meta\s+name="fps-ws-url"\s+content=""\s*\/>/);

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

test("/health endpoint & ALLOWED_ORIGIN WebSocket guard handle Happy and Unhappy paths", async () => {
  // Arrange: server with strict ALLOWED_ORIGIN
  let now = 50_000;
  const srv = createLanServer({
    tickMs: 1000,
    nowFn: () => now,
    allowedOrigins: "https://fps-online.pages.dev, https://custom.example.com/",
  });
  const port = await srv.start(0, "127.0.0.1");

  try {
    now += 12_345;
    // Act & Assert /health GET + HEAD
    const healthGet = await httpRequestRaw(`http://127.0.0.1:${port}/health`);
    assert.equal(healthGet.status, 200);
    assert.equal(healthGet.headers["cache-control"], "no-store");
    const payload = JSON.parse(healthGet.body.toString("utf8"));
    assert.deepEqual(payload, { ok: true, uptimeSec: 12, rooms: 0, sessions: 0 });

    const healthHead = await httpRequestRaw(`http://127.0.0.1:${port}/health`, {}, "HEAD");
    assert.equal(healthHead.status, 200);
    assert.equal(healthHead.body.length, 0);

    // Act & Assert WS Origin allowlist enforcement
    const okStatus = await rawWsUpgradeProbe(port, "https://fps-online.pages.dev");
    assert.match(okStatus, /^HTTP\/1\.1 101 /);

    const okStatus2 = await rawWsUpgradeProbe(port, "https://CUSTOM.example.com");
    assert.match(okStatus2, /^HTTP\/1\.1 101 /);

    const badOrigin = await rawWsUpgradeProbe(port, "https://evil-site.example.org");
    assert.match(badOrigin, /^HTTP\/1\.1 403 /);

    const missingOrigin = await rawWsUpgradeProbe(port, null);
    assert.match(missingOrigin, /^HTTP\/1\.1 403 /);

    // Pure helper unit assertions
    const parsed = parseAllowedOrigins("https://a.pages.dev/path, invalid-url, http://localhost:8090");
    assert.equal(isWsOriginAllowed("https://a.pages.dev", parsed), true);
    assert.equal(isWsOriginAllowed("http://localhost:8090", parsed), true);
    assert.equal(isWsOriginAllowed("https://other.dev", parsed), false);
    assert.equal(isWsOriginAllowed(undefined, new Set()), true);
  } finally {
    await srv.stop();
  }
});

test("net_utils resolves WS URLs, compensates RTT/2 clock offset, and separates Online vs LAN hosts", () => {
  // 1. WS URL sanitization & priority resolution
  assert.equal(sanitizeWsUrl("wss://fps-srv.onrender.com/ws"), "wss://fps-srv.onrender.com/ws");
  assert.equal(sanitizeWsUrl("ws://192.168.1.20:8090/ws"), "ws://192.168.1.20:8090/ws");
  assert.equal(sanitizeWsUrl("https://fps-srv.onrender.com/ws"), null);
  assert.equal(sanitizeWsUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeWsUrl("wss://user:pass@example.com/ws"), null);
  assert.equal(sanitizeWsUrl('wss://bad"quote.com/ws'), null);

  assert.equal(
    resolveWsUrl({
      metaUrl: "wss://meta.onrender.com/ws",
      globalUrl: "wss://global.onrender.com/ws",
      loc: { protocol: "https:", host: "mygame.pages.dev" },
    }),
    "wss://meta.onrender.com/ws",
  );
  assert.equal(
    resolveWsUrl({
      metaUrl: "",
      globalUrl: "",
      loc: { protocol: "https:", host: "monolith.onrender.com" },
    }),
    "wss://monolith.onrender.com/ws",
  );
  assert.equal(resolveWsUrl({ loc: { protocol: "file:", host: "" } }), null);

  // 2. RTT / 2 clock offset calculation & EMA smoothing
  // Client sends at t=1000, receives at t=1100 (RTT=100ms, one-way=50ms).
  // If clocks are identical, server processed it at 1050 -> serverTime=1050 + 50 - 1100 = 0ms offset!
  const first = computeClockOffsetWithRtt({
    clientSendMs: 1000,
    clientRecvMs: 1100,
    serverTimeMs: 1050,
    hasPrev: false,
  });
  assert.deepEqual(first, { offsetMs: 0, rttMs: 100 });

  // Next sample has +20ms jitter -> smoothed via 0.7 * 0 + 0.3 * 20 = 6ms
  const second = computeClockOffsetWithRtt({
    clientSendMs: 6000,
    clientRecvMs: 6080,
    serverTimeMs: 6060,
    prevOffsetMs: first.offsetMs,
    hasPrev: true,
  });
  assert.deepEqual(second, { offsetMs: 6, rttMs: 80 });
  assert.equal(computeClockOffsetWithRtt({ clientSendMs: 0, clientRecvMs: 100, serverTimeMs: Number.NaN }), null);

  // 3. LAN vs Online hostname detection & share URL
  assert.equal(isPrivateOrLocalHost("localhost"), true);
  assert.equal(isPrivateOrLocalHost("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("192.168.1.55"), true);
  assert.equal(isPrivateOrLocalHost("10.10.0.224"), true);
  assert.equal(isPrivateOrLocalHost("172.20.0.4"), true);
  assert.equal(isPrivateOrLocalHost("172.32.0.4"), false);
  assert.equal(isPrivateOrLocalHost("before-the-breach.pages.dev"), false);
  assert.equal(isPrivateOrLocalHost("fps-server.onrender.com"), false);

  assert.equal(
    resolveOnlineShareUrl({ protocol: "https:", origin: "https://fps.pages.dev", pathname: "/" }),
    "https://fps.pages.dev",
  );
  assert.equal(resolveOnlineShareUrl({ protocol: "file:", origin: "null", pathname: "/FPS.html" }), "");
});

test("buildStaticSite outputs complete Cloudflare Pages bundle without .bundle.js and guards unsafe inputs", () => {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "fps-static-test-"));
  try {
    const res = buildStaticSite({
      outDir: tmpOut,
      wsUrl: "wss://fps-render-demo.onrender.com/ws",
    });
    assert.equal(res.wsUrl, "wss://fps-render-demo.onrender.com/ws");
    assert.ok(res.fileCount >= 35);

    const indexHtml = fs.readFileSync(path.join(tmpOut, "index.html"), "utf8");
    assert.ok(indexHtml.includes('<meta name="fps-ws-url" content="wss://fps-render-demo.onrender.com/ws" />'));
    assert.equal(fs.existsSync(path.join(tmpOut, "FPS.html")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "_headers")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "js", "protocol.js")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "js", "weapons.js")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "js", "net_utils.js")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "js", "game.js")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "assets", "loading_bg.webp")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "shared", "maps", "military_colliders.json")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "sound", "Before_the_Breach.mp3")), true);
    assert.equal(fs.existsSync(path.join(tmpOut, "model", "dist", "m416.glb")), true);

    const distFiles = fs.readdirSync(path.join(tmpOut, "model", "dist"));
    assert.equal(distFiles.some((f) => f.endsWith(".bundle.js")), false);

    // Unhappy paths: invalid WS scheme & unsafe root outDir
    assert.throws(() => buildStaticSite({ outDir: tmpOut, wsUrl: "https://not-websocket.com/ws" }));
    assert.throws(() => buildStaticSite({ outDir: path.resolve(".") }));
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});
