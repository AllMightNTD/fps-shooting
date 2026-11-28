/**
 * Graphics Quality Presets (Low / Medium / High + Auto hardware detection).
 * Controls resolution scale, shadow maps, post-processing, grass density,
 * tree draw distance, and fog distance at runtime without reloading.
 */

export const QUALITY_LEVELS = Object.freeze(["low", "medium", "high"]);
export const QUALITY_CHOICES = Object.freeze(["auto", "low", "medium", "high"]);

export const QUALITY_LABELS = Object.freeze({
  auto: "Tự động",
  low: "Thấp",
  medium: "Vừa",
  high: "Cao",
});

export const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({
    id: "low",
    label: "Thấp",
    pixelRatioScale: 0.78,
    maxPixelRatio: 1.0,
    shadowsEnabled: false,
    shadowMapSize: 16,
    shadowType: "pcf",
    shadowExtent: 20,
    shadowUpdateInterval: 8,
    postGradeEnabled: false,
    vignetteEnabled: false,
    lowHpBlurEnabled: false,
    godRaysEnabled: false,
    cloudsEnabled: true,
    cloudDetail: 0.25,
    dustEnabled: false,
    sunFlareEnabled: false,
    valleyMistEnabled: false,
    windEnabled: false,
    grassDensity: 0.25,
    rubbleDensity: 0.35,
    treeDrawDistance: 56,
    slopeForestDensity: 0.0,
    showDeadTrees: false,
    showBushes: false,
    cameraFar: 350,
    fogDensity: 0.0058,
    fogNearStart: 10.0,
    fogNearEnd: 24.0,
    fogDistBase: 0.0040,
    fogHeightAmp: 0.0042,
    maxAnisotropy: 2,
    vfxScale: 0.45,
    maxBulletHoles: 32,
    muzzleSmokeEnabled: false,
    waterRipplesEnabled: false,
  }),
  medium: Object.freeze({
    id: "medium",
    label: "Vừa",
    pixelRatioScale: 1.0,
    maxPixelRatio: 1.25,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    shadowType: "pcf",
    shadowExtent: 22,
    shadowUpdateInterval: 5,
    postGradeEnabled: false,
    vignetteEnabled: true,
    lowHpBlurEnabled: false,
    godRaysEnabled: false,
    cloudsEnabled: true,
    cloudDetail: 0.65,
    dustEnabled: false,
    sunFlareEnabled: true,
    valleyMistEnabled: true,
    windEnabled: true,
    grassDensity: 0.60,
    rubbleDensity: 0.70,
    treeDrawDistance: 120,
    slopeForestDensity: 0.48,
    showDeadTrees: true,
    showBushes: false,
    cameraFar: 410,
    fogDensity: 0.0042,
    fogNearStart: 12.0,
    fogNearEnd: 30.0,
    fogDistBase: 0.0028,
    fogHeightAmp: 0.0034,
    maxAnisotropy: 8,
    vfxScale: 0.75,
    maxBulletHoles: 64,
    muzzleSmokeEnabled: true,
    waterRipplesEnabled: true,
  }),
  high: Object.freeze({
    id: "high",
    label: "Cao",
    pixelRatioScale: 1.0,
    maxPixelRatio: 1.75,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    shadowType: "pcf",
    shadowExtent: 24,
    shadowUpdateInterval: 2,
    postGradeEnabled: true,
    vignetteEnabled: true,
    lowHpBlurEnabled: true,
    godRaysEnabled: true,
    cloudsEnabled: true,
    cloudDetail: 1.0,
    dustEnabled: true,
    sunFlareEnabled: true,
    valleyMistEnabled: true,
    windEnabled: true,
    grassDensity: 1.0,
    rubbleDensity: 1.0,
    treeDrawDistance: 215,
    slopeForestDensity: 1.0,
    showDeadTrees: true,
    showBushes: true,
    cameraFar: 480,
    fogDensity: 0.0034,
    fogNearStart: 14.0,
    fogNearEnd: 34.0,
    fogDistBase: 0.0022,
    fogHeightAmp: 0.0030,
    maxAnisotropy: 16,
    vfxScale: 1.0,
    maxBulletHoles: 96,
    muzzleSmokeEnabled: true,
    waterRipplesEnabled: true,
  }),
});

const SOFTWARE_GPU_RE = /(swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render|subzero|software rasterizer)/i;
const WEAK_GPU_RE =
  /(intel.*(hd graphics|uhd graphics|gma|bay trail|cherry trail|celeron|pentium)|mali-[gt]?[4-7]|adreno.*(3\d\d|4\d\d|5\d\d|61\d)|powervr|tegra)/i;
const STRONG_GPU_RE =
  /(nvidia.*(rtx|gtx|titan|quadro|tesla|geforce (rtx|gtx))|radeon.*(rx\s*[5-9]\d{2,3}|pro|vega 56|vega 64|vii)|apple m[1-9]\s*(pro|max|ultra)|arc\s*a[57]\d\d)/i;

export function normalizeQualityChoice(raw) {
  return QUALITY_CHOICES.includes(raw) ? raw : "auto";
}

/**
 * Pure deterministic hardware classifier for unit testing & runtime auto-selection.
 * Weak GPUs / software renderers / <=4 cores / <=4 GB RAM automatically select "low".
 */
export function detectHardwareTier(hwInfo) {
  if (!hwInfo || typeof hwInfo !== "object") return "medium";

  const rendererStr = typeof hwInfo.rendererString === "string" ? hwInfo.rendererString.trim() : "";
  const cores = Number.isFinite(Number(hwInfo.cores)) ? Number(hwInfo.cores) : 0;
  const mem = Number.isFinite(Number(hwInfo.deviceMemory)) ? Number(hwInfo.deviceMemory) : 0;
  const maxTex = Number.isFinite(Number(hwInfo.maxTextureSize)) ? Number(hwInfo.maxTextureSize) : 0;
  const isMobile = Boolean(hwInfo.isMobile);

  if (SOFTWARE_GPU_RE.test(rendererStr)) return "low";
  if (WEAK_GPU_RE.test(rendererStr)) return "low";
  if (isMobile) return "low";
  if (cores > 0 && cores <= 4) return "low";
  if (mem > 0 && mem <= 4) return "low";
  if (maxTex > 0 && maxTex < 4096) return "low";

  if (STRONG_GPU_RE.test(rendererStr)) {
    const hasEnoughCpu = cores === 0 || cores >= 6;
    const hasEnoughMem = mem === 0 || mem >= 8;
    if (hasEnoughCpu && hasEnoughMem) return "high";
  }

  return "medium";
}

export function probeHardwareInfo(gl) {
  let rendererString = "";
  let maxTextureSize = 0;
  try {
    if (gl) {
      const dbg = gl.getExtension && gl.getExtension("WEBGL_debug_renderer_info");
      rendererString = String(
        (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || "",
      );
      maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    }
  } catch {
    // Ignore blocked WebGL debug info
  }
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  return {
    rendererString,
    cores: Number(nav.hardwareConcurrency) || 0,
    deviceMemory: Number(nav.deviceMemory) || 0,
    maxTextureSize,
    isMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
  };
}

export function resolveQualityPreset(choice, detectedTier = "medium") {
  const safeChoice = normalizeQualityChoice(choice);
  const safeDetected = QUALITY_LEVELS.includes(detectedTier) ? detectedTier : "medium";
  const effectiveTier = safeChoice === "auto" ? safeDetected : safeChoice;
  return {
    choice: safeChoice,
    detectedTier: safeDetected,
    effectiveTier,
    preset: QUALITY_PRESETS[effectiveTier],
  };
}

export function computeEffectivePixelRatio(preset, devicePixelRatio = 1) {
  const dpr = Number.isFinite(Number(devicePixelRatio)) && Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1;
  const maxDpr = preset && Number.isFinite(preset.maxPixelRatio) ? preset.maxPixelRatio : 1.5;
  const scale = preset && Number.isFinite(preset.pixelRatioScale) ? preset.pixelRatioScale : 1.0;
  return Math.max(0.5, Number((Math.min(dpr, maxDpr) * scale).toFixed(3)));
}

export function formatQualitySummary(resolved) {
  const p = resolved.preset;
  const resPct = Math.round(p.pixelRatioScale * 100);
  const shLabel = p.shadowsEnabled ? `Bóng ${p.shadowMapSize}px` : "Tắt bóng động";
  const grassPct = Math.round(p.grassDensity * 100);
  const fxLabel = p.postGradeEnabled ? "Hậu kỳ đầy đủ" : p.vignetteEnabled ? "Hậu kỳ nhẹ" : "Tắt hậu kỳ";
  const prefix =
    resolved.choice === "auto"
      ? `Tự động → ${p.label}`
      : `Mức ${p.label}`;
  return `${prefix} (${resPct}% tỉ lệ • ${shLabel} • ${fxLabel} • Cỏ ${grassPct}% • Cây ${p.treeDrawDistance}m)`;
}

/**
 * Updates texture anisotropy directly on existing WebGLTextures via gl.texParameterf()
 * without setting texture.needsUpdate = true (avoids 50+ texImage2D + generateMipmap stalls).
 * Textures not yet uploaded to GPU still receive the updated .anisotropy field for first upload.
 */
export function updateTexturesAnisotropyInPlace(renderer, textures, targetAniso) {
  const list = textures ? Array.from(textures).filter(Boolean) : [];
  if (list.length === 0) {
    return { updated: 0, glUpdated: 0, anisotropy: 1 };
  }

  const gl = renderer && typeof renderer.getContext === "function" ? renderer.getContext() : null;
  let ext = null;
  if (renderer && renderer.extensions && typeof renderer.extensions.get === "function") {
    ext = renderer.extensions.get("EXT_texture_filter_anisotropic");
  }
  if (!ext && gl && typeof gl.getExtension === "function") {
    ext =
      gl.getExtension("EXT_texture_filter_anisotropic") ||
      gl.getExtension("MOZ_EXT_texture_filter_anisotropic") ||
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
  }

  let hwMax = 1;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === "function") {
    hwMax = Math.max(1, Number(renderer.capabilities.getMaxAnisotropy()) || 1);
  } else if (ext && gl && typeof gl.getParameter === "function" && ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) {
    hwMax = Math.max(1, Number(gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1);
  }

  const req = Number.isFinite(Number(targetAniso)) ? Number(targetAniso) : 1;
  const clamped = Math.max(1, Math.min(hwMax, req));
  const props = renderer && renderer.properties && typeof renderer.properties.get === "function" ? renderer.properties : null;

  const canPatchGl = Boolean(
    gl &&
      ext &&
      ext.TEXTURE_MAX_ANISOTROPY_EXT &&
      props &&
      typeof gl.bindTexture === "function" &&
      typeof gl.texParameterf === "function" &&
      typeof gl.getParameter === "function",
  );

  let updated = 0;
  let glUpdated = 0;
  let prevTex = null;
  let didBind = false;

  try {
    for (const tex of list) {
      if (tex.anisotropy === clamped) continue;
      tex.anisotropy = clamped;
      updated++;
      if (!canPatchGl) continue;
      const texProps = props.get(tex);
      const webglTex = texProps && texProps.__webglTexture;
      if (!webglTex) continue;
      if (!didBind) {
        prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
        didBind = true;
      }
      gl.bindTexture(gl.TEXTURE_2D, webglTex);
      gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, clamped);
      glUpdated++;
    }
  } catch (err) {
    console.warn("In-place texture anisotropy update skipped:", err);
  } finally {
    if (didBind && gl && typeof gl.bindTexture === "function") {
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
    }
  }

  return { updated, glUpdated, anisotropy: clamped };
}

