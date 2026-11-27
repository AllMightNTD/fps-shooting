/**
 * AAA unit tests for Graphics Quality 3-tier presets & automatic weak-hardware detection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  computeEffectivePixelRatio,
  detectHardwareTier,
  formatQualitySummary,
  normalizeQualityChoice,
  resolveQualityPreset,
  updateTexturesAnisotropyInPlace,
} from "../../public/js/graphics_quality.js";

test("detectHardwareTier automatically selects low on software renderers, weak iGPUs, mobile, or low RAM/CPU", () => {
  // Arrange
  const weakProfiles = [
    { rendererString: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", cores: 12, deviceMemory: 16, maxTextureSize: 8192 },
    { rendererString: "llvmpipe (LLVM 15.0.7, 256 bits)", cores: 8, deviceMemory: 16, maxTextureSize: 8192 },
    { rendererString: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)", cores: 8, deviceMemory: 8, maxTextureSize: 16384 },
    { rendererString: "ANGLE (Intel, Intel(R) HD Graphics 520)", cores: 4, deviceMemory: 8, maxTextureSize: 8192 },
    { rendererString: "Mali-G52 MC2", cores: 8, deviceMemory: 6, maxTextureSize: 4096, isMobile: true },
    { rendererString: "ANGLE (AMD, Radeon Graphics)", cores: 4, deviceMemory: 8, maxTextureSize: 16384 },
    { rendererString: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650)", cores: 6, deviceMemory: 4, maxTextureSize: 16384 },
    { rendererString: "Generic GPU", cores: 8, deviceMemory: 8, maxTextureSize: 2048 },
  ];

  // Act & Assert
  for (const profile of weakProfiles) {
    assert.equal(detectHardwareTier(profile), "low", `Expected low tier for ${JSON.stringify(profile)}`);
  }
});

test("detectHardwareTier selects high on strong discrete GPUs and medium on balanced mid-range hardware", () => {
  // Arrange
  const strongProfiles = [
    { rendererString: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)", cores: 12, deviceMemory: 16, maxTextureSize: 16384 },
    { rendererString: "ANGLE (AMD, AMD Radeon RX 6700 XT)", cores: 8, deviceMemory: 16, maxTextureSize: 16384 },
    { rendererString: "Apple M3 Pro", cores: 12, deviceMemory: 16, maxTextureSize: 16384 },
  ];
  const mediumProfiles = [
    { rendererString: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)", cores: 8, deviceMemory: 8, maxTextureSize: 16384 },
    { rendererString: "ANGLE (AMD, AMD Radeon(TM) Graphics)", cores: 8, deviceMemory: 16, maxTextureSize: 16384 },
    { rendererString: "Unknown Desktop Renderer", cores: 8, deviceMemory: 8, maxTextureSize: 8192 },
  ];

  // Act & Assert
  for (const profile of strongProfiles) {
    assert.equal(detectHardwareTier(profile), "high", `Expected high tier for ${profile.rendererString}`);
  }
  for (const profile of mediumProfiles) {
    assert.equal(detectHardwareTier(profile), "medium", `Expected medium tier for ${profile.rendererString}`);
  }
});

test("detectHardwareTier & resolveQualityPreset handle null/invalid inputs safely (unhappy path)", () => {
  // Arrange & Act
  const tierNull = detectHardwareTier(null);
  const tierEmpty = detectHardwareTier({});
  const badChoice = normalizeQualityChoice("ultra_999");
  const resolvedBad = resolveQualityPreset("invalid", "unknown_tier");
  const resolvedAutoWeak = resolveQualityPreset("auto", "low");
  const resolvedManualHigh = resolveQualityPreset("high", "low");

  // Assert
  assert.equal(tierNull, "medium");
  assert.equal(tierEmpty, "medium");
  assert.equal(badChoice, "auto");
  assert.equal(resolvedBad.choice, "auto");
  assert.equal(resolvedBad.effectiveTier, "medium");
  assert.equal(resolvedAutoWeak.effectiveTier, "low");
  assert.equal(resolvedManualHigh.effectiveTier, "high");
  assert.match(formatQualitySummary(resolvedAutoWeak), /Tự động → Thấp/);
});

test("QUALITY_PRESETS strictly increase visual fidelity across low < medium < high on all 6 dimensions", () => {
  // Arrange
  const [low, med, high] = QUALITY_LEVELS.map((k) => QUALITY_PRESETS[k]);

  // Act
  const prLow = computeEffectivePixelRatio(low, 2.0);
  const prMed = computeEffectivePixelRatio(med, 2.0);
  const prHigh = computeEffectivePixelRatio(high, 2.0);

  // Assert resolution, shadows, post-FX, grass, tree draw distance, and fog distance scale monotonically
  assert.ok(prLow < prMed && prMed < prHigh, `Expected pixelRatio low<med<high, got ${prLow}/${prMed}/${prHigh}`);
  assert.equal(low.shadowsEnabled, false);
  assert.equal(med.shadowsEnabled, true);
  assert.equal(high.shadowsEnabled, true);
  assert.equal(low.shadowMapSize, 16);
  assert.ok(med.shadowMapSize < high.shadowMapSize);
  // Shadow shader mode must stay invariant ("pcf") across all tiers to guarantee 0 shader recompiles
  assert.equal(low.shadowType, "pcf");
  assert.equal(med.shadowType, "pcf");
  assert.equal(high.shadowType, "pcf");
  assert.equal(low.vignetteEnabled, false);
  assert.equal(low.postGradeEnabled, false);
  assert.equal(high.postGradeEnabled, true);
  assert.ok(low.grassDensity < med.grassDensity && med.grassDensity < high.grassDensity);
  assert.ok(low.treeDrawDistance < med.treeDrawDistance && med.treeDrawDistance < high.treeDrawDistance);
  assert.ok(low.cloudDetail < med.cloudDetail && med.cloudDetail < high.cloudDetail);
  assert.ok(low.slopeForestDensity < med.slopeForestDensity && med.slopeForestDensity < high.slopeForestDensity);
  assert.ok(low.vfxScale < med.vfxScale && med.vfxScale < high.vfxScale);
  assert.ok(low.maxBulletHoles < med.maxBulletHoles && med.maxBulletHoles < high.maxBulletHoles);
  assert.equal(low.waterRipplesEnabled, false);
  assert.equal(high.waterRipplesEnabled, true);
  assert.ok(low.cameraFar < med.cameraFar && med.cameraFar < high.cameraFar);
  assert.ok(high.cameraFar >= 460, `High cameraFar must cover 3-layer alpine horizon, got ${high.cameraFar}`);
  assert.ok(low.fogDensity > med.fogDensity && med.fogDensity > high.fogDensity);
  assert.equal(computeEffectivePixelRatio(low, Number.NaN), 0.78);
});

test("updateTexturesAnisotropyInPlace patches WebGL anisotropy via gl.texParameterf without triggering needsUpdate", () => {
  // Arrange
  const prevBound = { id: "prev-bound-tex" };
  const gpuTexA = { id: "gpu-tex-a" };
  const bindCalls = [];
  const paramCalls = [];
  let needsUpdateSetCount = 0;

  const makeTex = (initialAniso) => {
    const t = { anisotropy: initialAniso };
    Object.defineProperty(t, "needsUpdate", {
      set() {
        needsUpdateSetCount++;
      },
      get() {
        return false;
      },
    });
    return t;
  };

  const texUploaded = makeTex(2);
  const texNotUploaded = makeTex(2);
  const texAlreadyAtMax = makeTex(8);

  const propMap = new WeakMap([
    [texUploaded, { __webglTexture: gpuTexA }],
    [texNotUploaded, {}],
    [texAlreadyAtMax, { __webglTexture: { id: "gpu-tex-c" } }],
  ]);

  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    getParameter(pname) {
      return pname === 0x8069 ? prevBound : 0;
    },
    bindTexture(target, handle) {
      bindCalls.push([target, handle]);
    },
    texParameterf(target, pname, val) {
      paramCalls.push([target, pname, val]);
    },
  };
  const renderer = {
    getContext: () => gl,
    capabilities: { getMaxAnisotropy: () => 8 },
    extensions: {
      get: (name) =>
        name === "EXT_texture_filter_anisotropic"
          ? { TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff }
          : null,
    },
    properties: { get: (tex) => propMap.get(tex) || {} },
  };

  // Act
  const result = updateTexturesAnisotropyInPlace(
    renderer,
    new Set([texUploaded, texNotUploaded, texAlreadyAtMax]),
    16,
  );

  // Assert
  assert.equal(result.anisotropy, 8);
  assert.equal(result.updated, 2);
  assert.equal(result.glUpdated, 1);
  assert.equal(texUploaded.anisotropy, 8);
  assert.equal(texNotUploaded.anisotropy, 8);
  assert.equal(texAlreadyAtMax.anisotropy, 8);
  assert.equal(needsUpdateSetCount, 0, "Must never set tex.needsUpdate = true");
  assert.deepEqual(paramCalls, [[0x0de1, 0x84fe, 8]]);
  assert.deepEqual(bindCalls, [
    [0x0de1, gpuTexA],
    [0x0de1, prevBound],
  ]);
});

test("updateTexturesAnisotropyInPlace handles missing renderer, missing extension, and GL errors safely (unhappy path)", () => {
  // Arrange
  const texA = { anisotropy: 4 };
  const texB = { anisotropy: 2 };
  const prevBound = { id: "saved" };
  const restored = [];
  const throwingRenderer = {
    getContext: () => ({
      TEXTURE_2D: 0x0de1,
      TEXTURE_BINDING_2D: 0x8069,
      getParameter: () => prevBound,
      bindTexture: (_t, h) => restored.push(h),
      texParameterf: () => {
        throw new Error("Simulated context lost");
      },
    }),
    capabilities: { getMaxAnisotropy: () => 16 },
    extensions: { get: () => ({ TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe }) },
    properties: { get: () => ({ __webglTexture: { id: "gpu" } }) },
  };

  // Act
  const emptyRes = updateTexturesAnisotropyInPlace(null, [], 4);
  const noRendererRes = updateTexturesAnisotropyInPlace(null, [texA], Number.NaN);
  const errRes = updateTexturesAnisotropyInPlace(throwingRenderer, [texB], 8);

  // Assert
  assert.deepEqual(emptyRes, { updated: 0, glUpdated: 0, anisotropy: 1 });
  assert.equal(noRendererRes.updated, 1);
  assert.equal(noRendererRes.glUpdated, 0);
  assert.equal(texA.anisotropy, 1);
  assert.equal(errRes.glUpdated, 0);
  assert.equal(texB.anisotropy, 8);
  assert.equal(restored[restored.length - 1], prevBound, "Previous TEXTURE_BINDING_2D must be restored even on GL error");
});

