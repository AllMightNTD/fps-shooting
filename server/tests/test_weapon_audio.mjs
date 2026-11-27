/**
 * AAA unit & integration tests for M416 weapon audio bank (public/js/weapon_audio.js)
 * and static WAV serving + path traversal protection in server/index.js.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createLanServer } from "../index.js";
import {
  M416_SOUND_PATHS,
  computeAutoPitch,
  computeDistanceAirCutoffHz,
  computeDistanceGain,
  computeReloadPlaybackConfig,
  createWeaponAudioBank,
  extractAudioAssetPaths,
} from "../../public/js/weapon_audio.js";
import {
  LOBBY_MUSIC_URL,
  clampMusicVolume,
  createLobbyMusicController,
  shouldLobbyMusicPlay,
} from "../../public/js/lobby_music.js";
import { filterRoomsByMode, normalizeLobbyView } from "../../public/js/lobby_utils.js";
import { RoomManager } from "../RoomManager.js";

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    }).on("error", reject);
  });
}

function makeFakeAudioContext() {
  const started = [];
  const makeParam = (initial = 1) => ({
    value: initial,
    setValueAtTime(v) {
      this.value = v;
    },
    linearRampToValueAtTime(v) {
      this.value = v;
    },
    cancelScheduledValues() {},
  });
  const ac = {
    currentTime: 10.0,
    destination: { id: "dest" },
    createDynamicsCompressor: () => ({
      threshold: makeParam(-7),
      knee: makeParam(8),
      ratio: makeParam(6),
      attack: makeParam(0.002),
      release: makeParam(0.09),
      connect() {
        return this;
      },
    }),
    createBiquadFilter: () => ({
      type: "lowpass",
      frequency: makeParam(10000),
      connect(next) {
        return next;
      },
    }),
    createStereoPanner: () => ({
      pan: makeParam(0),
      connect(next) {
        return next;
      },
    }),
    createGain: () => ({
      gain: makeParam(1),
      connect(next) {
        return next;
      },
    }),
    createBufferSource: () => {
      const node = {
        buffer: null,
        playbackRate: makeParam(1),
        onended: null,
        connect(next) {
          return next;
        },
        start(when, offset, duration) {
          started.push({ kind: "start", when, offset, duration, rate: node.playbackRate.value, buf: node.buffer });
        },
        stop(when) {
          started.push({ kind: "stop", when });
        },
      };
      return node;
    },
    async decodeAudioData(arrBuf) {
      return { duration: 1.394, byteLength: arrBuf.byteLength };
    },
  };
  return { ac, started };
}

test("Pure M416 audio math helpers handle valid and extreme/NaN inputs safely", () => {
  // Arrange & Act
  const pMin = computeAutoPitch(1.0, 0.03, 0);
  const pMax = computeAutoPitch(1.0, 0.03, 1);
  const pBad = computeAutoPitch(Number.NaN, -1, 9);
  const nearGain = computeDistanceGain(0, 10.5);
  const farGain = computeDistanceGain(60, 10.5);
  const nearCut = computeDistanceAirCutoffHz(0);
  const farCut = computeDistanceAirCutoffHz(90);
  const emptyReload = computeReloadPlaybackConfig(1.394, false);
  const tactReload = computeReloadPlaybackConfig(1.394, true);
  const paths = extractAudioAssetPaths();

  // Assert
  assert.ok(Math.abs(pMin - 0.97) < 1e-6 && Math.abs(pMax - 1.03) < 1e-6);
  assert.equal(pBad, 1.0);
  assert.equal(nearGain, 1.0);
  assert.ok(farGain < 0.25 && farGain >= 0.03);
  assert.ok(nearCut > farCut && farCut >= 850);
  assert.equal(emptyReload.playbackRate, 0.8);
  assert.ok(emptyReload.maxPlaySec > 1.7);
  assert.equal(tactReload.playbackRate, 0.96);
  assert.ok(tactReload.maxPlaySec <= 0.96);
  assert.equal(paths.length, 4);
});

test("createWeaponAudioBank preloads, plays M416 shot/reload/shell/dryfire, interrupts reload cleanly, and falls back on errors", async () => {
  // Arrange
  const { ac, started } = makeFakeAudioContext();
  const fakeFetch = async (url) => ({
    ok: true,
    async arrayBuffer() {
      const buf = new ArrayBuffer(128);
      new Uint8Array(buf)[0] = url.length;
      return buf;
    },
  });
  const bank = createWeaponAudioBank({
    getAudioContext: () => ac,
    fetchFn: fakeFetch,
  });

  // Act (Happy path)
  const stats = await bank.preload();
  const okShot = bank.playM416Shot();
  const okRemote = bank.playM416RemoteShot(24, -0.75);
  const okReload = bank.playM416Reload({ isTactical: false });
  const playingBeforeStop = bank.isReloadPlaying();
  bank.stopReload();
  const playingAfterStop = bank.isReloadPlaying();
  const okDry = bank.playM416Dryfire();

  // Assert (Happy path)
  assert.equal(stats.loadedCount, 4);
  assert.equal(okShot, true);
  assert.equal(okRemote, true);
  assert.equal(okReload, true);
  assert.equal(playingBeforeStop, true);
  assert.equal(playingAfterStop, false);
  assert.equal(okDry, true);
  assert.ok(started.some((s) => s.kind === "start" && s.offset > 0.008)); // Trim lead silence on shot
  assert.ok(started.some((s) => s.kind === "stop")); // Interrupted reload stopped cleanly

  // Arrange & Act (Unhappy path: fetch fails & AudioContext unavailable)
  const brokenBank = createWeaponAudioBank({
    getAudioContext: () => null,
    fetchFn: async () => {
      throw new Error("Offline");
    },
  });
  const brokenStats = await brokenBank.preload();
  assert.equal(brokenStats.loadedCount, 0);
  assert.equal(brokenBank.playM416Shot(), false);
  assert.equal(brokenBank.playM416Reload({ isTactical: true }), false);
  assert.equal(brokenBank.playM416Dryfire(), false);
  brokenBank.clearScheduledTimers();
});

test("HTTP server serves all 4 M416 WAV files with audio/wav MIME + RIFF header and blocks traversal", async () => {
  // Arrange
  const srv = createLanServer({ tickMs: 1000 });
  const port = await srv.start(0, "127.0.0.1");
  try {
    // Act & Assert Happy Path for all 4 manifest paths
    for (const urlPath of Object.values(M416_SOUND_PATHS)) {
      const res = await httpGetRaw(`http://127.0.0.1:${port}${urlPath}`);
      assert.equal(res.status, 200, `Expected 200 for ${urlPath}`);
      assert.equal(res.headers["content-type"], "audio/wav");
      assert.equal(res.body.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(res.body.subarray(8, 12).toString("ascii"), "WAVE");
    }

    // Act & Assert Unhappy Path (path traversal & invalid extension / missing asset)
    const travRes = await httpGetRaw(`http://127.0.0.1:${port}/sound/../server/index.js`);
    const extRes = await httpGetRaw(`http://127.0.0.1:${port}/sound/m416/m416_reload.mp3`);
    const missingRes = await httpGetRaw(`http://127.0.0.1:${port}/sound/m416/nonexistent.wav`);
    assert.equal(travRes.status, 404);
    assert.equal(extRes.status, 404);
    assert.equal(missingRes.status, 404);

    // Act & Assert Lobby MP3 streaming (200 full + 206 byte range)
    const mp3Res = await httpGetRaw(`http://127.0.0.1:${port}${LOBBY_MUSIC_URL}`);
    assert.equal(mp3Res.status, 200);
    assert.equal(mp3Res.headers["content-type"], "audio/mpeg");
    assert.equal(mp3Res.headers["accept-ranges"], "bytes");
    assert.ok(mp3Res.body.length > 1_000_000);

    const rangeRes = await new Promise((resolve, reject) => {
      http.get(
        `http://127.0.0.1:${port}${LOBBY_MUSIC_URL}`,
        { headers: { Range: "bytes=0-127" } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      ).on("error", reject);
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.body.length, 128);
    assert.match(rangeRes.headers["content-range"], /^bytes 0-127\//);
  } finally {
    await srv.stop();
  }
});

test("Lobby music controller plays Before_the_Breach.mp3 strictly in Main Lobby and handles autoplay block safely", async () => {
  // Arrange
  let playShouldReject = true;
  let fakeAudio = null;
  const listeners = new Map();
  const fakeWin = {
    addEventListener(ev, fn) { listeners.set(ev, fn); },
    removeEventListener(ev) { listeners.delete(ev); },
  };
  const makeFakeAudio = (src) => {
    fakeAudio = {
      src,
      loop: false,
      preload: "",
      volume: 1,
      paused: true,
      playCalled: 0,
      pauseCalled: 0,
      play() {
        this.playCalled++;
        if (playShouldReject) return Promise.reject(new Error("NotAllowedError"));
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
        this.pauseCalled++;
      },
    };
    return fakeAudio;
  };

  // Act & Assert pure helpers (Happy + Unhappy)
  assert.equal(clampMusicVolume(Number.NaN, 0.45), 0.45);
  assert.equal(clampMusicVolume(2.5), 1);
  assert.equal(clampMusicVolume(-0.4), 0);
  assert.equal(shouldLobbyMusicPlay({ screen: "lobby", loadingVisible: false, inMatch: false, enabled: true }), true);
  assert.equal(shouldLobbyMusicPlay({ screen: "room", loadingVisible: false, inMatch: false, enabled: true }), false);
  assert.equal(shouldLobbyMusicPlay({ screen: "lobby", loadingVisible: true, inMatch: false, enabled: true }), false);
  assert.equal(shouldLobbyMusicPlay({ screen: "lobby", loadingVisible: false, inMatch: true, enabled: true }), false);

  const ctrl = createLobbyMusicController({
    createAudioFn: makeFakeAudio,
    fadeMs: 0,
    doc: null,
    win: fakeWin,
  });

  // Loading dismissed on Lobby with autoplay initially blocked -> waits cleanly for gesture unlock
  ctrl.setLoadingVisible(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctrl.getState().blockedByAutoplay, true);
  assert.equal(ctrl.getState().isPlaying, false);

  // User clicks in Lobby -> gesture unlocks playback of Before_the_Breach.mp3
  playShouldReject = false;
  listeners.get("pointerdown")();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctrl.getState().blockedByAutoplay, false);
  assert.equal(ctrl.getState().isPlaying, true);
  assert.equal(fakeAudio.src, LOBBY_MUSIC_URL);
  assert.equal(fakeAudio.volume, 0.45);

  // Entering Solo/Match or Room pauses lobby music; returning to Lobby resumes it
  ctrl.setInMatch(true);
  assert.equal(ctrl.getState().isPlaying, false);
  ctrl.setInMatch(false);
  ctrl.setScreen("lobby");
  await Promise.resolve();
  assert.equal(ctrl.getState().isPlaying, true);
  ctrl.destroy();
});

test("Lobby mode filter, view normalization, and RoomManager.quickJoin mode targeting handle Happy & Unhappy paths", () => {
  // Arrange
  const rooms = [
    { id: "r1", mode: "TDM", name: "Team 1" },
    { id: "r2", mode: "FFA", name: "Solo 1" },
    { id: "r3", mode: "TDM", name: "Team 2" },
  ];

  // Act & Assert pure UI filters
  assert.deepEqual(filterRoomsByMode(rooms, "FFA").map((r) => r.id), ["r2"]);
  assert.deepEqual(filterRoomsByMode(rooms, "TDM").map((r) => r.id), ["r1", "r3"]);
  assert.equal(filterRoomsByMode(rooms, "ALL").length, 3);
  assert.deepEqual(filterRoomsByMode(null, "FFA"), []);
  assert.equal(normalizeLobbyView("practice"), "practice");
  assert.equal(normalizeLobbyView("lan"), "lan");
  assert.equal(normalizeLobbyView("bogus_view"), "home");

  // Act & Assert RoomManager.quickJoin honors preferredMode (FFA vs TDM)
  const mgr = new RoomManager(() => 1000);
  const s1 = { id: "s1", name: "Alpha", token: "t1", connected: true, roomId: null, ws: { closed: false, sendJson() {}, sendText() {} } };
  const s2 = { id: "s2", name: "Bravo", token: "t2", connected: true, roomId: null, ws: { closed: false, sendJson() {}, sendText() {} } };
  mgr.sessions.set("s1", s1);
  mgr.sessions.set("s2", s2);

  const qFfa = mgr.quickJoin(s1, "Alpha", "FFA");
  assert.equal(qFfa.ok, true);
  assert.equal(qFfa.room.mode, "FFA");

  // Joining TDM does not match existing FFA room; creates/joins a TDM room instead
  const qTdm = mgr.quickJoin(s2, "Bravo", "TDM");
  assert.equal(qTdm.ok, true);
  assert.equal(qTdm.room.mode, "TDM");
});

