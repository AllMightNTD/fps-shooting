/**
 * AAA unit tests for Khu Quân Sự Cũ v5 procedural alpine environment:
 * - Terrain heightfield stays strictly flat/recessed inside the 70x90m courtyard walls
 * - Sculpted 3-layer mountains form foothills, mid-range eroded peaks, distant alpine silhouettes & scenic valley passes
 * - Finite-difference normals, slopes & baked horizon sun occlusion stay finite and bounded
 * - Generated trees, boulders, power poles & outer fence posts never intrude inside the perimeter walls
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MILITARY_BOUNDS_DEFAULT,
  computeTerrainSunOcclusion,
  distanceOutsideBase,
  generateMilitaryEnvironmentPlacements,
  sampleMilitaryTerrainHeight,
  sampleTerrainNormalAndSlope,
} from "../../public/js/military_environment.js";

test("sampleMilitaryTerrainHeight stays strictly recessed inside and beneath perimeter walls (no courtyard intrusion)", () => {
  // Arrange: sample a dense grid inside [-35..35, -45..45] plus the 1m concrete wall base margin
  const testPts = [
    [0, 0],
    [-35, -45],
    [35, 45],
    [-35.8, 0],
    [35.8, 0],
    [0, -45.8],
    [0, 45.8],
    [-20, -14],
    [22, 26],
  ];

  // Act & Assert
  for (const [x, z] of testPts) {
    const h = sampleMilitaryTerrainHeight(x, z, MILITARY_BOUNDS_DEFAULT);
    assert.ok(Number.isFinite(h), `Height must be finite at (${x}, ${z})`);
    assert.equal(h, -0.04, `Courtyard/wall base at (${x}, ${z}) must stay recessed at -0.04m, got ${h}`);
  }
});

test("sampleMilitaryTerrainHeight sculpts 3 rising alpine layers with eroded relief and scenic valley pass", () => {
  // Arrange & Act: sample across foothill ring (r=75), mid mountain ring (r=185) and far alpine ring (r=335)
  let maxFoothill = -Infinity;
  let maxMid = -Infinity;
  let maxFar = -Infinity;
  const midHeights = [];
  for (let i = 0; i < 64; i++) {
    const ang = (i / 64) * Math.PI * 2;
    maxFoothill = Math.max(maxFoothill, sampleMilitaryTerrainHeight(Math.cos(ang) * 75, Math.sin(ang) * 75));
    const hMid = sampleMilitaryTerrainHeight(Math.cos(ang) * 185, Math.sin(ang) * 185);
    midHeights.push(hMid);
    maxMid = Math.max(maxMid, hMid);
    maxFar = Math.max(maxFar, sampleMilitaryTerrainHeight(Math.cos(ang) * 335, Math.sin(ang) * 335));
  }
  const minMid = Math.min(...midHeights);
  const westPassH = sampleMilitaryTerrainHeight(-185, 0); // West center pass (ang = PI)
  const nwPeakH = sampleMilitaryTerrainHeight(Math.cos(-2.42) * 185, Math.sin(-2.42) * 185);

  // Assert
  assert.ok(maxFoothill >= 4.0 && maxFoothill <= 28.0, `Expected rolling foothills 4..28m, got ${maxFoothill}`);
  assert.ok(maxMid >= 36.0 && maxMid > maxFoothill * 1.8, `Expected mid eroded peaks >=36m, got ${maxMid}`);
  assert.ok(maxFar > maxMid, `Expected far alpine silhouette peaks (${maxFar}) taller than mid range (${maxMid})`);
  assert.ok(maxMid - minMid >= 24.0, `Expected dramatic valley-to-peak relief >=24m, got ${maxMid - minMid}`);
  assert.ok(nwPeakH > westPassH + 14.0, `Expected NW flanking massif (${nwPeakH}) higher than West valley pass (${westPassH})`);
});

test("sampleTerrainNormalAndSlope and computeTerrainSunOcclusion produce valid unit normals and shadow variation", () => {
  // Arrange: pure West afternoon sun direction matching MILITARY_SUN_POS (-56, 38, 0)
  const len = Math.hypot(-56, 38, 0);
  const sunDir = { x: -56 / len, y: 38 / len, z: 0 };

  // Act: test sunlit East-range West-facing slope (faces sun directly) vs leeward valley behind tall NW massif
  const westFacing = sampleTerrainNormalAndSlope(175, -20);
  const nLen = Math.hypot(westFacing.nx, westFacing.ny, westFacing.nz);
  const sunlitH = sampleMilitaryTerrainHeight(175, -20);
  const sunlitVis = computeTerrainSunOcclusion(175, sunlitH, -20, sunDir);
  const leewardVis = computeTerrainSunOcclusion(-115, sampleMilitaryTerrainHeight(-115, -105), -105, sunDir);
  const degSunVis = computeTerrainSunOcclusion(0, 0, 0, { x: 0, y: 1, z: 0 }); // Unhappy/edge: zenith sun

  // Assert
  assert.ok(Math.abs(nLen - 1.0) < 1e-4, `Normal must be unit length, got ${nLen}`);
  assert.ok(westFacing.slope >= 0 && westFacing.slope <= 1);
  assert.ok(sunlitVis >= 0.85 && sunlitVis <= 1.0, `Sun-facing slope should receive direct sunlight: ${sunlitVis}`);
  assert.ok(leewardVis >= 0.32 && leewardVis <= 1.0);
  assert.ok(sunlitVis >= leewardVis, `Expected sunlit face (${sunlitVis}) >= leeward basin (${leewardVis})`);
  assert.equal(degSunVis, 1.0, "Zero-horizontal zenith sun edge case must safely return 1.0");
});

test("generateMilitaryEnvironmentPlacements scatters dense slope conifers & perimeter props strictly outside walls", () => {
  // Arrange & Act
  const p = generateMilitaryEnvironmentPlacements(MILITARY_BOUNDS_DEFAULT);

  // Assert dense coverage matching visual spec
  assert.ok(p.broadleafList.length >= 20, `Expected >=20 broadleaf trees, got ${p.broadleafList.length}`);
  assert.ok(p.pineNearList.length >= 40, `Expected >=40 near perimeter pines, got ${p.pineNearList.length}`);
  assert.ok(p.slopeConiferList.length >= 360, `Expected dense slope conifer carpet >=360, got ${p.slopeConiferList.length}`);
  assert.ok(p.boulderList.length >= 40, `Expected >=40 hillside boulders, got ${p.boulderList.length}`);
  assert.ok(p.powerPoles.length >= 12, `Expected >=12 perimeter power poles, got ${p.powerPoles.length}`);
  assert.ok(p.outerFencePosts.length >= 30, `Expected >=30 outer fence posts, got ${p.outerFencePosts.length}`);

  // Assert ZERO elements ever intrude inside the 70x90m playable perimeter wall
  const allItems = [
    ...p.broadleafList,
    ...p.pineNearList,
    ...p.deadList,
    ...p.bushList,
    ...p.slopeConiferList,
    ...p.boulderList,
    ...p.powerPoles,
    ...p.outerFencePosts,
  ];
  for (const item of allItems) {
    const dOut = distanceOutsideBase(item.x, item.z, MILITARY_BOUNDS_DEFAULT);
    assert.ok(dOut >= 2.0, `Environment prop at (${item.x.toFixed(1)}, ${item.z.toFixed(1)}) intruded within 2m of wall (dOut=${dOut})`);
    assert.ok(Number.isFinite(item.y), `Prop height must be finite`);
  }

  // Assert slope conifers respect timberline (<= 46.5m) and nearest-first sorting for smooth quality count scaling
  for (let i = 1; i < p.slopeConiferList.length; i++) {
    assert.ok(p.slopeConiferList[i].dist >= p.slopeConiferList[i - 1].dist, "slopeConiferList must be sorted nearest-first");
    assert.ok(p.slopeConiferList[i].y <= 47.0, `Slope conifer exceeded timberline: y=${p.slopeConiferList[i].y}`);
  }
});
