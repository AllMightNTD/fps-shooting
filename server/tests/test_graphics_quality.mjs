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
  assert.ok(med.shadowMapSize < high.shadowMapSize);
  assert.equal(low.vignetteEnabled, false);
  assert.equal(low.postGradeEnabled, false);
  assert.equal(high.postGradeEnabled, true);
  assert.ok(low.grassDensity < med.grassDensity && med.grassDensity < high.grassDensity);
  assert.ok(low.treeDrawDistance < med.treeDrawDistance && med.treeDrawDistance < high.treeDrawDistance);
  assert.ok(low.cameraFar < med.cameraFar && med.cameraFar < high.cameraFar);
  assert.ok(low.fogDensity > med.fogDensity && med.fogDensity > high.fogDensity);
  assert.equal(computeEffectivePixelRatio(low, Number.NaN), 0.78);
});

