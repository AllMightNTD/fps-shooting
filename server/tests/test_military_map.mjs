/**
 * AAA unit & integration tests for Khu Quân Sự Cũ 5v5:
 * - MapCollision (Triangle-BVH raycast, OBB/AABB wall sliding, watchtower ladder & 4m deck)
 * - Server multi-map Room/Match/Spawn integration & /shared/maps/*.json static serving
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildTriangleBVH, createMapCollision, raycastTriangleBVH } from "../../public/js/map_collision.js";
import { RoomManager } from "../RoomManager.js";
import { createLanServer } from "../index.js";
import { GAME_MODE, MSG, ROOM_STATE } from "../protocol.js";
import { hasLineOfSight, loadMilitaryArena } from "../spawn.js";

function makeMockWs() {
  const sent = [];
  return {
    closed: false,
    sent,
    sendText(t) { sent.push(JSON.parse(t)); return true; },
    sendJson(o) { sent.push(o); return true; },
    sendPing() { return true; },
    close() { this.closed = true; },
  };
}

test("Triangle-BVH accurately hits solid triangles and misses open window holes", () => {
  // Arrange: wall with a central window opening (1m..2m Y) built from 2 triangles above and 2 below
  const positions = new Float32Array([
    // Lower sill slab y in [0, 1]
    -2, 0, 0,   2, 0, 0,   2, 1, 0,   -2, 1, 0,
    // Upper lintel slab y in [2, 3]
    -2, 2, 0,   2, 2, 0,   2, 3, 0,   -2, 3, 0,
  ]);
  const indices = new Uint16Array([
    0, 1, 2,  0, 2, 3,
    4, 5, 6,  4, 6, 7,
  ]);

  // Act
  const bvh = buildTriangleBVH(positions, indices, 2);
  const hitSill = raycastTriangleBVH(bvh, 0, 0.5, 5, 0, 0, -1, 20);
  const hitLintel = raycastTriangleBVH(bvh, 0, 2.5, 5, 0, 0, -1, 20);
  const throughWindow = raycastTriangleBVH(bvh, 0, 1.5, 5, 0, 0, -1, 20);

  // Assert
  assert.ok(hitSill && Math.abs(hitSill.dist - 5.0) < 1e-4);
  assert.ok(hitLintel && Math.abs(hitLintel.dist - 5.0) < 1e-4);
  assert.equal(throughWindow, null);
});

test("MapCollision handles watchtower ladder climb to 4m deck, parapet crouch cover, and wall sliding", () => {
  // Arrange
  const arena = loadMilitaryArena();
  const collision = createMapCollision(arena);
  const ladder = arena.ladders[0];
  assert.ok(ladder);

  // Act 1: Approach ladder base and climb up for 1.2s
  const state = { x: ladder.x, y: 0, z: ladder.z, vy: 0, grounded: true, onLadder: false };
  for (let i = 0; i < 80; i++) {
    collision.stepPlayerMovement(state, { moveForward: 1, jumpHeld: false, crouched: false, radius: 0.45 }, 1 / 60);
  }

  // Assert player climbed onto the 4.00m deck cleanly
  assert.ok(state.y >= 3.95 && state.y <= 4.05, `Expected player on 4m watchtower deck, got y=${state.y}`);
  assert.equal(state.grounded, true);
  assert.equal(state.onLadder, false);

  // Act 2: Test watchtower parapet counterplay (0.72m breached flank rail blocks low shot, exposes crouched head!)
  // Low shot aimed at 4.72m from (15, 1.65, 0) intersects +X rail at y=4.42m < 4.72m (blocked)
  const torsoBlocked = collision.raycastShot(15, 1.65, 0, -1, (4.72 - 1.65) / 10.5, 0, 15);
  assert.ok(torsoBlocked && torsoBlocked.dist < 10.4, "Watchtower 0.72m flank rail should block low leg/waist shot");
  // Counter-sniper headshot from Lane B (+19, 1.65, 0) & WH window (-17, 1.65, -18) clears crouched head (4.0, 5.10, 0)
  assert.equal(hasLineOfSight(19, 1.65, 0, 4.0, 5.10, 0, arena), true);
  assert.equal(hasLineOfSight(-17, 1.65, -18, 4.0, 5.10, 0, arena), true);
  // Symmetric watchtower sightline blocks: both Team A & B spawn exits and outer flanks are shielded
  assert.equal(hasLineOfSight(4.0, 5.7, 0, -10, 1.5, -32, arena), false);
  assert.equal(hasLineOfSight(4.0, 5.7, 0, -10, 1.5, 32, arena), false);
  assert.equal(hasLineOfSight(4.0, 5.7, 0, 20, 1.5, -26, arena), false);
  assert.equal(hasLineOfSight(4.0, 5.7, 0, 20, 1.5, 26, arena), false);
  assert.equal(hasLineOfSight(4.0, 5.7, 0, -31, 1.5, 0, arena), false);
  assert.equal(hasLineOfSight(4.0, 5.7, 0, 30, 1.5, 0, arena), false);

  // Act 3: Wall sliding along angled wrecked_truck OBB never traps or explodes coordinates
  const slideState = { x: -6.0, y: 0.0, z: -12.0, vy: 0, grounded: true, onLadder: false };
  collision.resolveHorizontal(slideState, false, 0.45);
  assert.ok(Number.isFinite(slideState.x) && Number.isFinite(slideState.z));
  assert.ok(Math.hypot(slideState.x + 6.0, slideState.z + 12.0) > 0.5);
});

test("Server military arena blocks spawn LoS, allows warehouse window shots, and serves /shared/maps/*.json", async () => {
  // Arrange
  let now = 20_000;
  const mgr = new RoomManager(() => now);
  const wsA = makeMockWs();
  const wsB = makeMockWs();
  const sA = mgr.handleHello(wsA, { name: "Ranger" });
  const sB = mgr.handleHello(wsB, { name: "Sniper" });

  // Default map is military (3A)
  const room = mgr.createRoom(sA, { mode: GAME_MODE.TDM, killLimit: 5 }).room;
  assert.equal(room.map, "military");
  mgr.joinRoom(sB, room.id);
  room.setReady(sB.id, true);
  room.startMatch(sA.id, now);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    mgr.stepAll(now);
  }
  assert.equal(room.state, ROOM_STATE.PLAYING);
  const pA = room.players.get(sA.id);
  const pB = room.players.get(sB.id);

  // Verify TDM spawns start around (0, 0, -40) and (0, 0, +40) with zero spawn-to-spawn LoS
  assert.ok(pA.z < -38 && pB.z > 38);
  assert.equal(hasLineOfSight(pA.x, 1.65, pA.z, pB.x, 1.65, pB.z, room.arena), false);

  // Verify shooting through warehouse #1 window (-17 wall at z = -18.1, y = 1.65) succeeds on server
  now += 3000;
  Object.assign(pA, { x: -20.0, y: 0, z: -18.1, flags: 0, prevFlags: 0, lastStateAt: now });
  Object.assign(pB, { x: -13.0, y: 0, z: -18.1, flags: 0, prevFlags: 0, lastStateAt: now });
  assert.equal(room.match.handleFire(pA, {}, now).ok, true);
  const windowHit = room.match.handleHit(pA, { targetId: pB.id, part: "head" }, now);
  assert.equal(windowHit.ok, true);

  // Verify shooting through truck glassless cab window (-6, 0, -12) at y=1.80 succeeds (moveOnly skipped by LoS)
  now += 200;
  Object.assign(pA, { x: -8.5, y: 0, z: -11.5, flags: 0, prevFlags: 0, lastStateAt: now });
  Object.assign(pB, { x: -3.5, y: 0, z: -13.5, flags: 0, prevFlags: 0, lastStateAt: now });
  pB.hp = 100;
  pB.alive = true;
  pB.invulnerableUntil = 0;
  assert.equal(room.match.handleFire(pA, {}, now).ok, true);
  const cabHit = room.match.handleHit(pA, { targetId: pB.id, part: "body" }, now);
  assert.equal(cabHit.ok, true);

  // Verify watchtower elevated state clamp (climb ladder -> walk onto 4.0m deck)
  Object.assign(pA, { x: 2.44, y: 0.0, z: 0.0, lastStateAt: now });
  room.match.handleState(pA, { pos: { x: 2.44, y: 2.2, z: 0.0 }, flags: 0 }, now + 600);
  room.match.handleState(pA, { pos: { x: 3.1, y: 4.0, z: 0.0 }, flags: 0 }, now + 1100);
  room.match.handleState(pA, { pos: { x: 4.0, y: 4.0, z: 0.0 }, flags: 0 }, now + 1400);
  assert.ok(Math.abs(pA.y - 4.0) < 0.05, `Expected server to preserve 4m watchtower deck y, got ${pA.y}`);

  // Verify HTTP server serves shared/maps/*.json & blocks traversal
  const srv = createLanServer({ tickMs: 50 });
  const port = await srv.start(0, "127.0.0.1");
  try {
    const layoutRes = await fetch(`http://127.0.0.1:${port}/shared/maps/military_layout.json`);
    assert.equal(layoutRes.status, 200);
    const layout = await layoutRes.json();
    assert.equal(layout.mapId, "military");

    const colRes = await fetch(`http://127.0.0.1:${port}/shared/maps/military_colliders.json`);
    assert.equal(colRes.status, 200);

    const mapBundleRes = await fetch(`http://127.0.0.1:${port}/model/dist/map_warehouse.bundle.js`);
    assert.equal(mapBundleRes.status, 200);

    const badJson = await fetch(`http://127.0.0.1:${port}/shared/maps/../../server/index.js`);
    assert.equal(badJson.status, 404);
  } finally {
    await srv.stop();
  }
});
