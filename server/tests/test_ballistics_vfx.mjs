/**
 * AAA unit tests for Ballistics VFX math, true surface normals (AABB/OBB/BVH),
 * 5-surface classification, tactical tracer cadence, ricochet, bullet whiz-by,
 * and Match.js LAN shot seed relay.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SURFACE_FX,
  SURFACE_TYPES,
  computeBulletWhizBy,
  computeReflectionDir,
  computeRicochetEligibility,
  resolveSurfaceType,
  seededUnit,
  shouldSpawnTracer,
} from "../../public/js/ballistics_vfx.js";
import {
  buildTriangleBVH,
  createMapCollision,
  rayIntersectsAABBWithNormal,
  rayIntersectsOBBWithNormal,
} from "../../public/js/map_collision.js";
import { Match } from "../Match.js";
import { MSG, ROOM_STATE } from "../protocol.js";
import { createDefaultWeaponsState } from "../weapons.js";

test("rayIntersectsAABBWithNormal returns exact outward normals on all 6 faces and handles misses", () => {
  // Arrange
  const box = { x0: -2, x1: 2, y0: 0, y1: 4, z0: -3, z1: 3 };

  // Act
  const hitNegX = rayIntersectsAABBWithNormal(-10, 2, 0, 1, 0, 0, box, 20);
  const hitPosX = rayIntersectsAABBWithNormal(10, 2, 0, -1, 0, 0, box, 20);
  const hitPosY = rayIntersectsAABBWithNormal(0, 10, 0, 0, -1, 0, box, 20);
  const hitNegZ = rayIntersectsAABBWithNormal(0, 2, -10, 0, 0, 1, box, 20);
  const hitPosZ = rayIntersectsAABBWithNormal(0, 2, 10, 0, 0, -1, box, 20);
  const missShort = rayIntersectsAABBWithNormal(-10, 2, 0, 1, 0, 0, box, 5);
  const missAway = rayIntersectsAABBWithNormal(-10, 2, 0, -1, 0, 0, box, 20);

  // Assert
  assert.ok(hitNegX && Math.abs(hitNegX.dist - 8) < 1e-6);
  assert.deepEqual([hitNegX.nx, hitNegX.ny, hitNegX.nz], [-1, 0, 0]);
  assert.deepEqual([hitPosX.nx, hitPosX.ny, hitPosX.nz], [1, 0, 0]);
  assert.deepEqual([hitPosY.nx, hitPosY.ny, hitPosY.nz], [0, 1, 0]);
  assert.deepEqual([hitNegZ.nx, hitNegZ.ny, hitNegZ.nz], [0, 0, -1]);
  assert.deepEqual([hitPosZ.nx, hitPosZ.ny, hitPosZ.nz], [0, 0, 1]);
  assert.equal(missShort, null);
  assert.equal(missAway, null);
});

test("rayIntersectsOBBWithNormal returns true rotated world normal for angled OBB", () => {
  // Arrange: 45-degree rotated OBB centered at origin
  const obb = {
    cx: 0,
    cy: 1.5,
    cz: 0,
    hx: 2,
    hy: 1.5,
    hz: 1,
    yaw: Math.PI / 4,
  };

  // Act: shoot straight along -X/-Z diagonal into the rotated face
  const dirX = -Math.SQRT1_2;
  const dirZ = -Math.SQRT1_2;
  const hit = rayIntersectsOBBWithNormal(6 * Math.SQRT1_2, 1.5, 6 * Math.SQRT1_2, dirX, 0, dirZ, obb, 20);

  // Assert: outward normal must oppose incoming ray and be unit length
  assert.ok(hit, "Expected ray to hit rotated OBB");
  assert.ok(Math.abs(Math.hypot(hit.nx, hit.ny, hit.nz) - 1) < 1e-5);
  assert.ok(hit.nx * dirX + hit.nz * dirZ < -0.5, `Normal must oppose incoming ray: ${JSON.stringify(hit)}`);
});

test("createMapCollision.raycastShot provides outward normals for ground, AABB, OBB, and BVH triangles", () => {
  // Arrange: tilted BVH triangle facing +Z and +Y
  const positions = new Float32Array([
    -1, 0, -10,
    1, 0, -10,
    0, 2, -11,
  ]);
  const bvh = buildTriangleBVH(positions, null);
  const col = createMapCollision({
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
    boxes: [{ x0: -2, x1: 2, y0: 0, y1: 3, z0: 8, z1: 10, tag: "concrete_wall" }],
    obbs: [{ cx: 12, cy: 1.25, cz: 0, hx: 1.5, hy: 1.25, hz: 1.5, yaw: 0.4, tag: "container" }],
    ladders: [],
    bvhEntries: [
      {
        bvh,
        invMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        tag: "watchtower_roof",
      },
    ],
  });

  // Act
  const wallHit = col.raycastShot(0, 1.5, 0, 0, 0, 1, 30);
  const groundHit = col.raycastShot(0, 2.0, 0, 0, -1, 0, 10);
  const obbHit = col.raycastShot(4, 1.2, 0, 1, 0, 0, 20);
  const bvhHit = col.raycastShot(0, 0.8, -5, 0, 0, -1, 20);

  // Assert
  assert.equal(wallHit.tag, "concrete_wall");
  assert.deepEqual([wallHit.nx, wallHit.ny, wallHit.nz], [0, 0, -1]);
  assert.equal(groundHit.tag, "ground");
  assert.deepEqual([groundHit.nx, groundHit.ny, groundHit.nz], [0, 1, 0]);
  assert.equal(obbHit.tag, "container");
  assert.ok(obbHit.nx < -0.5 && Math.abs(Math.hypot(obbHit.nx, obbHit.ny, obbHit.nz) - 1) < 1e-5);
  assert.equal(bvhHit.tag, "watchtower_roof");
  assert.ok(bvhHit.nz > 0.5 && Math.abs(Math.hypot(bvhHit.nx, bvhHit.ny, bvhHit.nz) - 1) < 1e-5);
});

test("resolveSurfaceType classifies all 5 physical materials accurately including ground puddles/dirt and invalid fallback", () => {
  // Arrange
  const wetSampler = () => 0.82;
  const drySampler = () => 0.05;
  const dirtSampler = () => 0.78;
  const cleanSampler = () => 0.12;

  // Act & Assert
  assert.deepEqual([...SURFACE_TYPES], ["concrete", "metal", "wood", "dirt", "water"]);
  assert.equal(resolveSurfaceType({ tag: "container" }), "metal");
  assert.equal(resolveSurfaceType({ tag: "oil_barrel" }), "metal");
  assert.equal(resolveSurfaceType({ tag: "watchtower_deck" }), "metal");
  assert.equal(resolveSurfaceType({ tag: "truck_hood" }), "metal");
  assert.equal(resolveSurfaceType({ tag: "wood_crate" }), "wood");
  assert.equal(resolveSurfaceType({ tag: "sandbag" }), "dirt");
  assert.equal(resolveSurfaceType({ tag: "concrete_wall" }), "concrete");
  assert.equal(resolveSurfaceType({ tag: "warehouse_wall" }), "concrete");
  assert.equal(resolveSurfaceType({ tag: "ground", samplePuddle: wetSampler, sampleDirt: dirtSampler }), "water");
  assert.equal(resolveSurfaceType({ tag: "ground", samplePuddle: drySampler, sampleDirt: dirtSampler }), "dirt");
  assert.equal(resolveSurfaceType({ tag: "ground", samplePuddle: drySampler, sampleDirt: cleanSampler }), "concrete");
  assert.equal(resolveSurfaceType({ objectSurface: "metal" }), "metal");
  // Unhappy path: null/unknown inputs safely default to concrete
  assert.equal(resolveSurfaceType({ tag: null, objectSurface: "plasma_unknown" }), "concrete");
  assert.equal(resolveSurfaceType(), "concrete");
  assert.equal(SURFACE_FX.dirt.holeTile, -1);
  assert.equal(SURFACE_FX.water.holeTile, -1);
  assert.equal(SURFACE_FX.water.waterRipple, true);
});

test("shouldSpawnTracer enforces tactical sparsity per weapon and low-ammo last-5 cue", () => {
  // Arrange & Act & Assert
  assert.equal(shouldSpawnTracer({ weaponId: "sniper", shotIndex: 2, magRemaining: 4 }), true);
  assert.equal(shouldSpawnTracer({ weaponId: "pistol", shotIndex: 1, magRemaining: 11 }), true);
  assert.equal(shouldSpawnTracer({ weaponId: "pistol", shotIndex: 2, magRemaining: 10 }), true);
  assert.equal(shouldSpawnTracer({ weaponId: "pistol", shotIndex: 3, magRemaining: 9 }), false);
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 1, magRemaining: 29 }), true);
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 2, magRemaining: 28 }), false);
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 3, magRemaining: 27 }), true);
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 4, magRemaining: 5 }), true); // Final 5 tracer cue
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 2, isRemote: true }), false);
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: 3, isRemote: true }), true);
  // Unhappy path: invalid shot index clamps cleanly
  assert.equal(shouldSpawnTracer({ weaponId: "m416", shotIndex: Number.NaN, magRemaining: 20 }), true);
});

test("computeReflectionDir and computeRicochetEligibility obey physical grazing rules", () => {
  // Arrange: 45-degree incoming shot downward onto horizontal floor (N = 0,1,0)
  const refl = computeReflectionDir(Math.SQRT1_2, -Math.SQRT1_2, 0, 0, 1, 0);

  // Act
  const grazingMetalOk = computeRicochetEligibility(0.95, -0.31, 0, 0, 1, 0, "metal", 0.12);
  const grazingMetalFailRoll = computeRicochetEligibility(0.95, -0.31, 0, 0, 1, 0, "metal", 0.90);
  const directMetalBlocked = computeRicochetEligibility(0, -1, 0, 0, 1, 0, "metal", 0.01);
  const concreteNever = computeRicochetEligibility(0.95, -0.31, 0, 0, 1, 0, "concrete", 0.01);
  const safeZero = computeReflectionDir(0, 0, 0, 0, 1, 0);

  // Assert
  assert.ok(Math.abs(refl.x - Math.SQRT1_2) < 1e-5 && Math.abs(refl.y - Math.SQRT1_2) < 1e-5);
  assert.equal(grazingMetalOk, true);
  assert.equal(grazingMetalFailRoll, false);
  assert.equal(directMetalBlocked, false);
  assert.equal(concreteNever, false);
  assert.ok(Number.isFinite(safeZero.x) && Number.isFinite(safeZero.y) && Number.isFinite(safeZero.z));
  assert.ok(seededUnit(12345, 31) >= 0 && seededUnit(12345, 31) <= 1);
  assert.equal(seededUnit(12345, 31), seededUnit(12345, 31));
});

test("computeBulletWhizBy calculates accurate stereo pan, closeness, and rejects invalid/distant shots", () => {
  // Arrange
  const listenerPos = { x: 0, y: 1.7, z: 0 };
  const listenerRight = { x: 1, y: 0, z: 0 };

  // Act
  const passRight = computeBulletWhizBy({ x: 2, y: 1.7, z: -20 }, { x: 2, y: 1.7, z: 20 }, listenerPos, listenerRight);
  const passLeft = computeBulletWhizBy({ x: -1.5, y: 1.7, z: -20 }, { x: -1.5, y: 1.7, z: 20 }, listenerPos, listenerRight);
  const tooFar = computeBulletWhizBy({ x: 9, y: 1.7, z: -20 }, { x: 9, y: 1.7, z: 20 }, listenerPos, listenerRight);
  const tooShort = computeBulletWhizBy({ x: 1, y: 1.7, z: -0.5 }, { x: 1, y: 1.7, z: 0.5 }, listenerPos, listenerRight);
  const fromSelf = computeBulletWhizBy({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: 30 }, listenerPos, listenerRight);
  const badNull = computeBulletWhizBy(null, null, listenerPos, listenerRight);

  // Assert
  assert.ok(passRight && passRight.pan > 0.9 && Math.abs(passRight.dist - 2.0) < 1e-5);
  assert.ok(passLeft && passLeft.pan < -0.9 && passLeft.closeness > passRight.closeness);
  assert.equal(tooFar, null);
  assert.equal(tooShort, null);
  assert.equal(fromSelf, null);
  assert.equal(badNull, null);
});

test("Match.handleFire relays sanitized integer seed in MSG.EVENT_FIRE and generates fallback seed on invalid client input", () => {
  // Arrange
  const broadcasts = [];
  const room = {
    id: "room-vfx",
    state: ROOM_STATE.PLAYING,
    players: new Map(),
    sendTo() {},
    broadcast(msg) {
      broadcasts.push(msg);
    },
  };
  const match = new Match(room);
  const player = {
    id: "p_alpha",
    x: 0,
    y: 0,
    z: 0,
    flags: 0,
    alive: true,
    activeWeaponId: "m416",
    weapons: createDefaultWeaponsState(),
    invulnerableUntil: 0,
    lastShotAt: 0,
    pendingHitCredit: 0,
  };
  room.players.set(player.id, player);

  // Act: Happy path with valid client integer seed, then unhappy path with invalid/malicious seed
  const r1 = match.handleFire(
    player,
    { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 }, seed: 424242 },
    1000,
  );
  const r2 = match.handleFire(
    player,
    { origin: { x: 0, y: 1.7, z: 0 }, dir: { x: 0, y: 0, z: -1 }, seed: "bad_seed" },
    1300,
  );

  // Assert
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const fireEvs = broadcasts.filter((b) => b.type === MSG.EVENT_FIRE);
  assert.equal(fireEvs.length, 2);
  assert.equal(fireEvs[0].seed, 424242);
  assert.ok(Number.isInteger(fireEvs[1].seed) && fireEvs[1].seed >= 0 && fireEvs[1].seed < 1000000);
});
