/**
 * AAA unit tests for public/js/loading_manager.js:
 * - yieldToUI() rAF + background-tab timer fallback
 * - createLoadingTracker() monotonic progress & stage ranges
 * - collectSceneTextures() & warmupTexturesChunked() deduplication, batching, error resilience
 * - compileScenePass() async vs r128 sync fallback
 * - createMapSwitchGuard() 0ms cache hit, rapid switch race guard, duplicate build dedup, error recovery
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSceneTextures,
  compileScenePass,
  createLoadingTracker,
  createMapSwitchGuard,
  normalizeMapId,
  warmupTexturesChunked,
  yieldToUI,
} from "../../public/js/loading_manager.js";

test("yieldToUI uses requestAnimationFrame when available and falls back safely if rAF stalls", async () => {
  // Arrange: fast rAF
  let rafCalled = false;
  await yieldToUI({
    raf: (cb) => {
      rafCalled = true;
      setTimeout(() => cb(16), 1);
      return 1;
    },
    caf: () => {},
    maxWaitMs: 100,
  });

  // Assert
  assert.equal(rafCalled, true);

  // Arrange: stalled background-tab rAF (never fires) -> must resolve via maxWaitMs fallback
  let cancelledId = null;
  const t0 = Date.now();
  await yieldToUI({
    raf: () => 42,
    caf: (id) => {
      cancelledId = id;
    },
    maxWaitMs: 15,
  });
  const elapsed = Date.now() - t0;

  // Assert
  assert.equal(cancelledId, 42);
  assert.ok(elapsed >= 10 && elapsed < 250, `Expected timer fallback around 15ms, got ${elapsed}ms`);

  // Arrange: Node/headless environment without rAF
  await yieldToUI({ raf: null });
});

test("createLoadingTracker enforces monotonic progress 0..100 and maps stage sub-ranges accurately", () => {
  // Arrange
  const events = [];
  const tracker = createLoadingTracker((ev) => events.push({ ...ev }));

  // Act
  tracker.reset("Khởi động", "Chuẩn bị");
  const mapStage = tracker.subProgress(0, 50, "Dựng bản đồ");
  mapStage(0.5, "Mặt đất");
  mapStage(0.2, "Giật lùi bị chặn"); // must not decrease percent
  mapStage(1.5, "Hoàn tất map"); // clamped to 50
  tracker.report(Number.NaN, "Lỗi NaN"); // safely ignored
  tracker.report(120, "Xong", "Sẵn sàng"); // clamped to 100

  // Assert
  assert.equal(tracker.getState().percent, 100);
  assert.equal(tracker.getState().label, "Xong");
  assert.equal(events[1].percent, 25);
  assert.equal(events[2].percent, 25, "Progress must stay monotonic");
  assert.equal(events[3].percent, 50);
  assert.equal(events[5].percent, 100);
});

test("collectSceneTextures deduplicates nested textures and warmupTexturesChunked uploads in yielded batches", async () => {
  // Arrange
  const texA = { isTexture: true, name: "albedo" };
  const texB = { isTexture: true, name: "normal" };
  const texC = { isTexture: true, name: "worldMask" };
  const texBad = { isTexture: true, name: "broken" };
  const texD = { isTexture: true, name: "sky" };
  const fakeGroup = {
    traverse(fn) {
      fn({ material: { map: texA, normalMap: texB, userData: { extraTextures: [texC] } } });
      fn({ material: [{ map: texA, envMap: texD }, { map: texBad }] });
    },
  };

  const uploadedOrder = [];
  let yieldCount = 0;
  const uploadedSet = new Set();
  const mockRenderer = {
    initTexture(t) {
      if (t === texBad) throw new Error("Simulated GPU upload error");
      uploadedOrder.push(t.name);
    },
  };

  // Act: first warmup uploads 5 unique textures in batches of 2 (1 simulated failure shouldn't crash)
  const collected = collectSceneTextures([fakeGroup, [texC, null]]);
  const res1 = await warmupTexturesChunked({
    renderer: mockRenderer,
    textures: collected,
    batchSize: 2,
    yieldFn: async () => {
      yieldCount++;
    },
    uploadedSet,
  });

  // Act: second warmup with same uploadedSet skips already uploaded textures
  const res2 = await warmupTexturesChunked({
    renderer: mockRenderer,
    textures: [texA, texB, texC, texD],
    batchSize: 2,
    yieldFn: async () => {
      yieldCount++;
    },
    uploadedSet,
  });

  // Assert
  assert.equal(collected.length, 5);
  assert.equal(res1.uploaded, 4);
  assert.equal(res1.failed, 1);
  assert.equal(yieldCount, 2, "5 textures in batches of 2 should yield twice between batches");
  assert.deepEqual(uploadedOrder.sort(), ["albedo", "normal", "sky", "worldMask"]);
  assert.equal(res2.uploaded, 0);
  assert.equal(res2.skipped, 4);
});

test("compileScenePass prefers compileAsync when available and falls back to Three.js r128 sync compile", async () => {
  // Arrange
  const scene = { id: "S" };
  const cam = { id: "C" };
  const calls = [];
  const asyncRenderer = {
    async compileAsync(s, c) {
      calls.push(["async", s.id, c.id]);
    },
    compile() {
      calls.push(["sync-should-not-run"]);
    },
  };
  const r128Renderer = {
    compile(s, c) {
      calls.push(["sync", s.id, c.id]);
    },
  };

  // Act
  const mode1 = await compileScenePass({ renderer: asyncRenderer, scene, camera: cam });
  const mode2 = await compileScenePass({ renderer: r128Renderer, scene, camera: cam });
  const mode3 = await compileScenePass({ renderer: null, scene, camera: cam });

  // Assert
  assert.equal(mode1, "async");
  assert.equal(mode2, "sync");
  assert.equal(mode3, "noop");
  assert.deepEqual(calls, [
    ["async", "S", "C"],
    ["sync", "S", "C"],
  ]);
});

test("createMapSwitchGuard achieves 0ms cache hit, prevents stale dropdown races, and recovers from build errors", async () => {
  // Arrange
  const cache = new Set(["military"]);
  let activeMap = "military";
  let activateCount = 0;
  let harborBuildCount = 0;
  let resolveHarborBuild = null;
  let shouldFailHarbor = false;

  const guard = createMapSwitchGuard({
    isMapReady: (id) => cache.has(id),
    getActiveMapId: () => activeMap,
    activateCached: (id) => {
      activeMap = id;
      activateCount++;
    },
    buildAndWarmup: (id) => {
      if (id === "harbor") {
        harborBuildCount++;
        if (shouldFailHarbor) {
          return Promise.reject(new Error("Simulated harbor load error"));
        }
        return new Promise((resolve) => {
          resolveHarborBuild = () => {
            cache.add("harbor");
            resolve();
          };
        });
      }
      cache.add(id);
      return Promise.resolve();
    },
  });

  // Act 1 (Happy path - Step 2): same active map -> 0ms no-op (activateCached NOT called again!)
  assert.equal(normalizeMapId("unknown"), "military");
  const sameRes = await guard.ensureMapReady("military");
  assert.equal(sameRes.status, "already-active");
  assert.equal(sameRes.sync, true);
  assert.equal(activateCount, 0);

  // Act 2 (Race condition - Step 4): user picks harbor, then immediately switches back to military before harbor finishes
  const harborProm = guard.ensureMapReady("harbor");
  assert.equal(guard.isBusy(), true);
  const backToMil = guard.activateSyncIfCached("military");
  assert.equal(backToMil.status, "already-active");

  // Harbor build finishes in background -> populates cache, MUST NOT hijack activeMap!
  resolveHarborBuild();
  const staleRes = await harborProm;
  assert.equal(staleRes.status, "stale");
  assert.equal(activeMap, "military");
  assert.equal(harborBuildCount, 1);

  // Act 3: switching to harbor now hits cache synchronously (0ms!)
  const cachedHarbor = guard.activateSyncIfCached("harbor");
  assert.equal(cachedHarbor.status, "activated-cached");
  assert.equal(activeMap, "harbor");
  assert.equal(guard.isActiveAndReady("harbor"), true);

  // Act 4 (Unhappy path): failed build does not leave guard permanently stuck
  cache.delete("harbor");
  activeMap = "military";
  shouldFailHarbor = true;
  await assert.rejects(() => guard.ensureMapReady("harbor"), /Simulated harbor load error/);
  assert.equal(guard.isBusy(), false);
});
