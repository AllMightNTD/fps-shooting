/**
 * MapCollision: AABB/OBB wall sliding, elevated walkable slabs, ladder climbing,
 * and pure-JS Triangle-BVH raycasting for bullet occlusion through windows & wrecks.
 * Dependency-free ES module (runs identically in Browser and Node.js tests).
 */

export function rayIntersectsAABB(ox, oy, oz, dx, dy, dz, box, maxDist = 200) {
  let tmin = 0.0;
  let tmax = maxDist;
  const axes = [
    [ox, dx, box.x0, box.x1],
    [oy, dy, box.y0, box.y1],
    [oz, dz, box.z0, box.z1],
  ];
  for (let i = 0; i < 3; i++) {
    const o = axes[i][0];
    const d = axes[i][1];
    const b0 = axes[i][2];
    const b1 = axes[i][3];
    if (Math.abs(d) < 1e-8) {
      if (o < b0 || o > b1) return null;
      continue;
    }
    let t1 = (b0 - o) / d;
    let t2 = (b1 - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin <= tmax && tmin >= 0 ? tmin : null;
}

export function rayIntersectsOBB(ox, oy, oz, dx, dy, dz, obb, maxDist = 200) {
  const c = Math.cos(obb.yaw);
  const s = Math.sin(obb.yaw);
  // World -> local (inverse rotation by -yaw around Y)
  const rx = ox - obb.cx;
  const ry = oy - obb.cy;
  const rz = oz - obb.cz;
  const lox = rx * c - rz * s;
  const loz = rx * s + rz * c;
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  return rayIntersectsAABB(
    lox,
    ry,
    loz,
    ldx,
    dy,
    ldz,
    { x0: -obb.hx, x1: obb.hx, y0: -obb.hy, y1: obb.hy, z0: -obb.hz, z1: obb.hz },
    maxDist,
  );
}

/**
 * Build a compact median-split AABB BVH over indexed triangle geometry.
 */
export function buildTriangleBVH(positions, indices, maxLeafTris = 12) {
  const triCount = indices ? (indices.length / 3) | 0 : (positions.length / 9) | 0;
  if (triCount <= 0) return null;

  const triBounds = new Float32Array(triCount * 6);
  const triCentroids = new Float32Array(triCount * 3);
  const triOrder = new Uint32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    triOrder[t] = t;
    const i0 = (indices ? indices[t * 3] : t * 3) * 3;
    const i1 = (indices ? indices[t * 3 + 1] : t * 3 + 1) * 3;
    const i2 = (indices ? indices[t * 3 + 2] : t * 3 + 2) * 3;

    const x0 = positions[i0], y0 = positions[i0 + 1], z0 = positions[i0 + 2];
    const x1 = positions[i1], y1 = positions[i1 + 1], z1 = positions[i1 + 2];
    const x2 = positions[i2], y2 = positions[i2 + 1], z2 = positions[i2 + 2];

    const b = t * 6;
    triBounds[b] = Math.min(x0, x1, x2);
    triBounds[b + 1] = Math.min(y0, y1, y2);
    triBounds[b + 2] = Math.min(z0, z1, z2);
    triBounds[b + 3] = Math.max(x0, x1, x2);
    triBounds[b + 4] = Math.max(y0, y1, y2);
    triBounds[b + 5] = Math.max(z0, z1, z2);

    const c = t * 3;
    triCentroids[c] = (x0 + x1 + x2) / 3;
    triCentroids[c + 1] = (y0 + y1 + y2) / 3;
    triCentroids[c + 2] = (z0 + z1 + z2) / 3;
  }

  const nodes = [];
  function buildNode(start, end) {
    const nodeIdx = nodes.length;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = start; k < end; k++) {
      const b = triOrder[k] * 6;
      if (triBounds[b] < minX) minX = triBounds[b];
      if (triBounds[b + 1] < minY) minY = triBounds[b + 1];
      if (triBounds[b + 2] < minZ) minZ = triBounds[b + 2];
      if (triBounds[b + 3] > maxX) maxX = triBounds[b + 3];
      if (triBounds[b + 4] > maxY) maxY = triBounds[b + 4];
      if (triBounds[b + 5] > maxZ) maxZ = triBounds[b + 5];
    }
    const count = end - start;
    const node = { minX, minY, minZ, maxX, maxY, maxZ, left: -1, right: -1, start, count };
    nodes.push(node);

    if (count <= maxLeafTris) return nodeIdx;

    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const midVal =
      axis === 0 ? 0.5 * (minX + maxX) : axis === 1 ? 0.5 * (minY + maxY) : 0.5 * (minZ + maxZ);

    let i = start;
    let j = end - 1;
    while (i <= j) {
      const cVal = triCentroids[triOrder[i] * 3 + axis];
      if (cVal < midVal) {
        i++;
      } else {
        const tmp = triOrder[i];
        triOrder[i] = triOrder[j];
        triOrder[j] = tmp;
        j--;
      }
    }
    let split = i;
    if (split === start || split === end) {
      split = start + (count >> 1);
    }

    node.left = buildNode(start, split);
    node.right = buildNode(split, end);
    node.count = 0;
    return nodeIdx;
  }

  buildNode(0, triCount);
  return { positions, indices, triOrder, nodes };
}

function rayAABBNode(ox, oy, oz, invX, invY, invZ, n, maxDist) {
  let t1 = (n.minX - ox) * invX;
  let t2 = (n.maxX - ox) * invX;
  let tmin = Math.min(t1, t2);
  let tmax = Math.max(t1, t2);

  t1 = (n.minY - oy) * invY;
  t2 = (n.maxY - oy) * invY;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));

  t1 = (n.minZ - oz) * invZ;
  t2 = (n.maxZ - oz) * invZ;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));

  return tmax >= Math.max(0.0, tmin) && tmin <= maxDist;
}

/**
 * Raycast against a local-space TriangleBVH using Moller-Trumbore intersection.
 */
export function raycastTriangleBVH(bvh, ox, oy, oz, dx, dy, dz, maxDist = 200) {
  if (!bvh || !bvh.nodes.length) return null;
  const invX = Math.abs(dx) > 1e-10 ? 1.0 / dx : 1e12;
  const invY = Math.abs(dy) > 1e-10 ? 1.0 / dy : 1e12;
  const invZ = Math.abs(dz) > 1e-10 ? 1.0 / dz : 1e12;
  const { positions, indices, triOrder, nodes } = bvh;

  let bestT = maxDist;
  let hitTri = -1;
  let hitNx = 0, hitNy = 1, hitNz = 0;
  const stack = [0];

  while (stack.length > 0) {
    const n = nodes[stack.pop()];
    if (!rayAABBNode(ox, oy, oz, invX, invY, invZ, n, bestT)) continue;

    if (n.count > 0) {
      for (let k = n.start; k < n.start + n.count; k++) {
        const t = triOrder[k];
        const i0 = (indices ? indices[t * 3] : t * 3) * 3;
        const i1 = (indices ? indices[t * 3 + 1] : t * 3 + 1) * 3;
        const i2 = (indices ? indices[t * 3 + 2] : t * 3 + 2) * 3;

        const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
        const e1x = positions[i1] - ax, e1y = positions[i1 + 1] - ay, e1z = positions[i1 + 2] - az;
        const e2x = positions[i2] - ax, e2y = positions[i2 + 1] - ay, e2z = positions[i2 + 2] - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-8) continue;

        const invDet = 1.0 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < 0.0 || u > 1.0) continue;

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < 0.0 || u + v > 1.0) continue;

        const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (dist >= 1e-4 && dist < bestT) {
          bestT = dist;
          hitTri = t;
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const nl = Math.hypot(nx, ny, nz) || 1.0;
          hitNx = nx / nl;
          hitNy = ny / nl;
          hitNz = nz / nl;
        }
      }
    } else {
      if (n.left >= 0) stack.push(n.left);
      if (n.right >= 0) stack.push(n.right);
    }
  }

  return hitTri >= 0 ? { dist: bestT, nx: hitNx, ny: hitNy, nz: hitNz } : null;
}

/**
 * Create a unified collision & raycast controller for a loaded map.
 */
export function createMapCollision({
  bounds = { minX: -35, maxX: 35, minZ: -45, maxZ: 45 },
  boxes = [],
  obbs = [],
  walkableSlabs = [],
  ladders = [],
  bvhEntries = [],
} = {}) {
  const bvhTags = new Set(["warehouse_wall", "warehouse_lintel", "warehouse_sill", "warehouse_roof", "truck_hood", "truck_cab_lower", "truck_cab_roof", "truck_bed", "watchtower_leg", "watchtower_deck", "watchtower_parapet", "watchtower_roof"]);

  function getSupportFloorY(x, z, curY) {
    let floorY = 0.0;
    for (let i = 0; i < walkableSlabs.length; i++) {
      const s = walkableSlabs[i];
      if (
        x >= s.x0 - 0.22 &&
        x <= s.x1 + 0.22 &&
        z >= s.z0 - 0.22 &&
        z <= s.z1 + 0.22 &&
        curY >= s.y1 - 0.45
      ) {
        if (s.y1 > floorY) floorY = s.y1;
      }
    }
    return floorY;
  }

  function findLadder(x, y, z) {
    for (let i = 0; i < ladders.length; i++) {
      const l = ladders[i];
      const d = Math.hypot(x - l.x, z - l.z);
      if (d <= (l.radius || 0.72) && y >= l.minY - 0.15 && y <= l.maxY + 0.15) {
        return l;
      }
    }
    return null;
  }

  function resolveHorizontal(pos, crouched, radius = 0.45) {
    const pHeight = crouched ? 1.22 : 1.78;
    const minFootClear = pos.y + 0.36;
    const maxHeadY = pos.y + pHeight;

    // 2-pass push-out prevents corner snagging at warehouse doors and L-walls
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.bulletOnly) continue;
        const by0 = b.y0 ?? 0;
        if (maxHeadY <= by0 + 0.04 || minFootClear >= b.y1) continue;
        const cx = Math.max(b.x0, Math.min(pos.x, b.x1));
        const cz = Math.max(b.z0, Math.min(pos.z, b.z1));
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x += (dx / d) * (radius - d);
            pos.z += (dz / d) * (radius - d);
          } else {
            // Inside box fallback: push out along minimum penetration axis
            const ox0 = Math.abs(pos.x - b.x0);
            const ox1 = Math.abs(b.x1 - pos.x);
            const oz0 = Math.abs(pos.z - b.z0);
            const oz1 = Math.abs(b.z1 - pos.z);
            const m = Math.min(ox0, ox1, oz0, oz1);
            if (m === ox0) pos.x = b.x0 - radius;
            else if (m === ox1) pos.x = b.x1 + radius;
            else if (m === oz0) pos.z = b.z0 - radius;
            else pos.z = b.z1 + radius;
          }
        }
      }

      for (let i = 0; i < obbs.length; i++) {
        const o = obbs[i];
        if (o.bulletOnly) continue;
        if (maxHeadY <= o.cy - o.hy + 0.04 || minFootClear >= o.cy + o.hy) continue;
        const c = Math.cos(o.yaw);
        const s = Math.sin(o.yaw);
        const rx = pos.x - o.cx;
        const rz = pos.z - o.cz;
        const lx = rx * c - rz * s;
        const lz = rx * s + rz * c;
        const clx = Math.max(-o.hx, Math.min(lx, o.hx));
        const clz = Math.max(-o.hz, Math.min(lz, o.hz));
        const dx = lx - clx;
        const dz = lz - clz;
        const d2 = dx * dx + dz * dz;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2) || 0.001;
          const pushL = radius - d;
          const plx = (dx / d) * pushL;
          const plz = (dz / d) * pushL;
          pos.x += plx * c + plz * s;
          pos.z += -plx * s + plz * c;
        }
      }
    }

    pos.x = Math.max(bounds.minX + radius, Math.min(bounds.maxX - radius, pos.x));
    pos.z = Math.max(bounds.minZ + radius, Math.min(bounds.maxZ - radius, pos.z));
  }

  function canStandUp(x, y, z, radius = 0.42) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.bulletOnly) continue;
      if (x >= b.x0 - radius && x <= b.x1 + radius && z >= b.z0 - radius && z <= b.z1 + radius) {
        const baseY = b.y0 ?? 0;
        if (baseY > y + 1.05 && baseY < y + 1.85) return false;
      }
    }
    return true;
  }

  /**
   * Step vertical motion, walkable slab landings, ladder climb, and wall sliding.
   */
  function stepPlayerMovement(state, { moveForward = 0, jumpHeld = false, crouched = false, radius = 0.45 }, dt) {
    const ladder = findLadder(state.x, state.y, state.z);
    if (ladder && (state.onLadder || (moveForward > 0.1 || jumpHeld) || (state.y > 0.2 && moveForward < -0.1))) {
      state.onLadder = true;
      const climbInput = jumpHeld ? 1 : moveForward;
      state.vy = climbInput > 0.1 ? 3.8 : climbInput < -0.1 ? -3.4 : 0.0;
      state.y += state.vy * dt;
      // Gently center player onto ladder axis while climbing
      state.x += (ladder.x - state.x) * Math.min(1, 10 * dt);
      state.z += (ladder.z - state.z) * Math.min(1, 10 * dt);
      state.grounded = false;

      if (state.y >= ladder.maxY - 0.04 && climbInput > 0) {
        state.y = ladder.maxY;
        state.x = ladder.exitX;
        state.z = ladder.exitZ;
        state.vy = 0;
        state.onLadder = false;
        state.grounded = true;
      } else if (state.y <= ladder.minY) {
        state.y = ladder.minY;
        state.vy = 0;
        state.onLadder = false;
        state.grounded = true;
      }
      return;
    }

    state.onLadder = false;
    state.vy -= 22 * dt;
    state.y += state.vy * dt;

    const floorY = getSupportFloorY(state.x, state.z, state.y);
    if (state.y <= floorY) {
      state.y = floorY;
      state.vy = 0;
      state.grounded = true;
    } else {
      state.grounded = false;
    }

    resolveHorizontal(state, crouched, radius);
  }

  /**
   * Raycast shot against ground, static AABBs, and exact Triangle-BVH entries.
   */
  function raycastShot(ox, oy, oz, dx, dy, dz, maxDist = 200) {
    let bestDist = maxDist;
    let bestHit = null;

    if (dy < -1e-6 && oy > 0) {
      const tGround = -oy / dy;
      if (tGround >= 0 && tGround < bestDist) {
        bestDist = tGround;
        bestHit = {
          dist: tGround,
          x: ox + dx * tGround,
          y: 0,
          z: oz + dz * tGround,
          nx: 0,
          ny: 1,
          nz: 0,
          tag: "ground",
        };
      }
    }

    const useBvh = bvhEntries.length > 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.moveOnly) continue;
      if (useBvh && b.tag && bvhTags.has(b.tag)) continue;
      const t = rayIntersectsAABB(ox, oy, oz, dx, dy, dz, b, bestDist);
      if (t !== null && t < bestDist) {
        bestDist = t;
        bestHit = {
          dist: t,
          x: ox + dx * t,
          y: oy + dy * t,
          z: oz + dz * t,
          nx: -dx,
          ny: -dy,
          nz: -dz,
          tag: b.tag || "box",
        };
      }
    }

    if (useBvh) {
      for (let i = 0; i < bvhEntries.length; i++) {
        const entry = bvhEntries[i];
        if (entry.worldBox) {
          const tb = rayIntersectsAABB(ox, oy, oz, dx, dy, dz, entry.worldBox, bestDist);
          if (tb === null) continue;
        }
        // Transform ray to mesh local space via inverse 4x4 matrix array (column-major)
        const m = entry.invMatrix;
        const lox = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
        const loy = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
        const loz = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
        const ldx = m[0] * dx + m[4] * dy + m[8] * dz;
        const ldy = m[1] * dx + m[5] * dy + m[9] * dz;
        const ldz = m[2] * dx + m[6] * dy + m[10] * dz;
        const scaleLen = Math.hypot(ldx, ldy, ldz) || 1.0;
        const hit = raycastTriangleBVH(
          entry.bvh,
          lox,
          loy,
          loz,
          ldx / scaleLen,
          ldy / scaleLen,
          ldz / scaleLen,
          bestDist * scaleLen,
        );
        if (hit) {
          const wDist = hit.dist / scaleLen;
          if (wDist < bestDist) {
            bestDist = wDist;
            bestHit = {
              dist: wDist,
              x: ox + dx * wDist,
              y: oy + dy * wDist,
              z: oz + dz * wDist,
              nx: -dx,
              ny: -dy,
              nz: -dz,
              tag: entry.tag || "bvh",
            };
          }
        }
      }
    }

    return bestHit;
  }

  return {
    bounds,
    boxes,
    obbs,
    walkableSlabs,
    ladders,
    bvhEntries,
    getSupportFloorY,
    findLadder,
    resolveHorizontal,
    canStandUp,
    stepPlayerMovement,
    raycastShot,
  };
}

