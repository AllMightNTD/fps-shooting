/**
 * Loading pipeline primitives for zero-stutter startup & map switching:
 * - yieldToUI(): yields to the browser paint/event loop (with background-tab timer fallback)
 * - createLoadingTracker(): monotonic 0..100% progress reporting across weighted stages
 * - collectSceneTextures() & warmupTexturesChunked(): deduplicated batched VRAM uploads (renderer.initTexture)
 * - compileScenePass(): forward-compatible compileAsync (r161+) with Three.js r128 compile() fallback
 * - createMapSwitchGuard(): map ID cache fast-path (0ms) + generation-guarded async switch (no race)
 */

const MATERIAL_TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "bumpMap",
  "emissiveMap",
  "envMap",
  "alphaMap",
  "lightMap",
  "specularMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
];

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function normalizeMapId(mapId) {
  return mapId === "harbor" ? "harbor" : "military";
}

/**
 * Yields control back to the browser UI thread so progress bars paint smoothly
 * and the tab never triggers "Page Unresponsive". Races rAF with a short timer
 * so background tabs (where rAF is throttled) still finish loading cleanly.
 */
export function yieldToUI(options = {}) {
  const raf =
    options.raf !== undefined
      ? options.raf
      : typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : null;
  const caf =
    options.caf !== undefined
      ? options.caf
      : typeof globalThis.cancelAnimationFrame === "function"
        ? globalThis.cancelAnimationFrame.bind(globalThis)
        : null;
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? Math.max(1, options.maxWaitMs) : 48;

  if (typeof raf !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Promise((resolve) => {
    let settled = false;
    let rafId = null;
    let timerId = null;

    const finish = (fromRaf) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (!fromRaf && rafId !== null && typeof caf === "function") {
        try {
          caf(rafId);
        } catch {
          // Ignore cancel errors in shimmed environments
        }
      }
      rafId = null;
      resolve();
    };

    rafId = raf(() => finish(true));
    timerId = setTimeout(() => finish(false), maxWaitMs);
  });
}

/**
 * Tracks monotonic 0..100% progress within a loading session and creates
 * stage-scoped sub-progress reporters.
 */
export function createLoadingTracker(onUpdate = null) {
  let percent = 0;
  let label = "";
  let detail = "";

  function emit() {
    if (typeof onUpdate === "function") {
      onUpdate({ percent, label, detail });
    }
  }

  function reset(initialLabel = "", initialDetail = "") {
    percent = 0;
    label = String(initialLabel || "");
    detail = String(initialDetail || "");
    emit();
  }

  function report(nextPercent, nextLabel, nextDetail) {
    const clamped = clamp(nextPercent, 0, 100);
    // Keep progress monotonic within a session so the bar never jumps backward
    if (clamped > percent) percent = clamped;
    if (typeof nextLabel === "string" && nextLabel.length > 0) label = nextLabel;
    if (typeof nextDetail === "string") detail = nextDetail;
    emit();
    return percent;
  }

  function subProgress(startPct, endPct, stageLabel) {
    const lo = clamp(startPct, 0, 100);
    const hi = clamp(endPct, lo, 100);
    return (fraction, subDetail = "") => {
      const f = clamp(fraction, 0, 1);
      return report(lo + f * (hi - lo), stageLabel, subDetail);
    };
  }

  function getState() {
    return { percent, label, detail };
  }

  return { reset, report, subProgress, getState };
}

/**
 * Collects all unique Texture instances referenced by Object3D hierarchies,
 * standalone materials, or explicit texture arrays/sets.
 */
export function collectSceneTextures(items = []) {
  const out = new Set();
  if (!Array.isArray(items)) return [];

  const addTex = (tex) => {
    if (tex && typeof tex === "object" && (tex.isTexture || "image" in tex || "mipmaps" in tex)) {
      out.add(tex);
    }
  };

  const scanMaterial = (mat) => {
    if (!mat || typeof mat !== "object") return;
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      if (mat[slot]) addTex(mat[slot]);
    }
    if (mat.uniforms && typeof mat.uniforms === "object") {
      for (const u of Object.values(mat.uniforms)) {
        if (u && u.value) addTex(u.value);
      }
    }
    if (mat.userData && Array.isArray(mat.userData.extraTextures)) {
      for (const t of mat.userData.extraTextures) addTex(t);
    }
  };

  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item) || item instanceof Set) {
      for (const sub of item) addTex(sub);
      continue;
    }
    if (item.isTexture) {
      addTex(item);
      continue;
    }
    if (item.isMaterial) {
      scanMaterial(item);
      continue;
    }
    if (typeof item.traverse === "function") {
      item.traverse((obj) => {
        if (!obj || !obj.material) return;
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) scanMaterial(m);
        } else {
          scanMaterial(obj.material);
        }
      });
    }
  }

  return Array.from(out);
}

/**
 * Uploads textures to GPU VRAM in small batches via renderer.initTexture(tex),
 * yielding between batches so the browser UI stays responsive.
 */
export async function warmupTexturesChunked({
  renderer,
  textures = [],
  batchSize = 3,
  yieldFn = yieldToUI,
  onProgress = null,
  uploadedSet = null,
} = {}) {
  const list = Array.isArray(textures) ? textures.filter(Boolean) : [];
  const pending = uploadedSet ? list.filter((t) => !uploadedSet.has(t)) : list.slice();
  const total = pending.length;

  if (!renderer || typeof renderer.initTexture !== "function" || total === 0) {
    if (typeof onProgress === "function") onProgress(1, { uploaded: 0, total });
    return { uploaded: 0, skipped: list.length - total, failed: 0, total };
  }

  const chunk = Math.max(1, Math.floor(batchSize) || 3);
  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < total; i += chunk) {
    const end = Math.min(total, i + chunk);
    for (let j = i; j < end; j++) {
      const tex = pending[j];
      try {
        renderer.initTexture(tex);
        if (uploadedSet) uploadedSet.add(tex);
        uploaded++;
      } catch (err) {
        failed++;
        console.warn("Texture VRAM warmup skipped:", err);
      }
    }
    if (typeof onProgress === "function") {
      onProgress(end / total, { uploaded, total, failed });
    }
    if (end < total && typeof yieldFn === "function") {
      await yieldFn();
    }
  }

  return { uploaded, skipped: list.length - total, failed, total };
}

/**
 * Compiles WebGL programs for a (scene, camera) pass using compileAsync when available
 * (Three.js r161+) or falling back cleanly to synchronous compile() on Three.js r128.
 */
export async function compileScenePass({ renderer, scene, camera }) {
  if (!renderer || !scene || !camera) return "noop";
  if (typeof renderer.compileAsync === "function") {
    await renderer.compileAsync(scene, camera);
    return "async";
  }
  if (typeof renderer.compile === "function") {
    renderer.compile(scene, camera);
    return "sync";
  }
  return "noop";
}

/**
 * Coordinates cached map activation (0ms synchronous fast-path) and async map
 * preloading/switching with generation-counter protection against rapid dropdown toggles.
 */
export function createMapSwitchGuard({
  normalize = normalizeMapId,
  isMapReady,
  getActiveMapId,
  activateCached,
  buildAndWarmup,
}) {
  let requestSeq = 0;
  let busyCount = 0;
  const inFlightBuilds = new Map();

  function isActiveAndReady(mapId) {
    const target = normalize(mapId);
    return getActiveMapId() === target && Boolean(isMapReady(target));
  }

  function isCached(mapId) {
    return Boolean(isMapReady(normalize(mapId)));
  }

  function activateSyncIfCached(mapId) {
    const target = normalize(mapId);
    if (!isMapReady(target)) return { ok: false, mapId: target, status: "not-cached" };
    requestSeq++;
    if (getActiveMapId() === target) {
      return { ok: true, mapId: target, status: "already-active" };
    }
    activateCached(target);
    return { ok: true, mapId: target, status: "activated-cached" };
  }

  async function ensureMapReady(mapId, opts = {}) {
    const target = normalize(mapId);
    const seq = ++requestSeq;

    // Step 2 fast-path: exact cache hit -> 0ms no-op!
    if (getActiveMapId() === target && isMapReady(target)) {
      return { ok: true, mapId: target, status: "already-active", sync: true };
    }

    // Cached inactive map -> 0ms synchronous activation!
    if (isMapReady(target)) {
      activateCached(target);
      return { ok: true, mapId: target, status: "activated-cached", sync: true };
    }

    busyCount++;
    try {
      let buildProm = inFlightBuilds.get(target);
      if (!buildProm) {
        buildProm = (async () =>
          buildAndWarmup(target, {
            ...opts,
            isStale: () => seq !== requestSeq,
          }))().finally(() => {
          inFlightBuilds.delete(target);
        });
        inFlightBuilds.set(target, buildProm);
      }
      await buildProm;

      if (seq !== requestSeq) {
        return { ok: false, mapId: target, status: "stale", sync: false };
      }
      if (!isMapReady(target)) {
        return { ok: false, mapId: target, status: "build-incomplete", sync: false };
      }
      activateCached(target);
      return { ok: true, mapId: target, status: "built-and-activated", sync: false };
    } finally {
      busyCount = Math.max(0, busyCount - 1);
    }
  }

  return {
    isActiveAndReady,
    isCached,
    isBusy: () => busyCount > 0,
    activateSyncIfCached,
    ensureMapReady,
  };
}
