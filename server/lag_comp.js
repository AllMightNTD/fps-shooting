/**
 * Server-side Lag Compensation pose history store with RTT-bounded rewind
 * and respawn-teleport interpolation guards.
 */

export const INTERP_DELAY_MS = 100;
export const MAX_REWIND_MS = 250;
export const MAX_HISTORY_MS = 450;
export const TELEPORT_SNAP_DIST = 4.0;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Compute maximum allowed rewind window from server-measured RTT.
 */
export function computeAllowedRewindMs(rttMs = 0) {
  const safeRtt = Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 0;
  return clamp(INTERP_DELAY_MS + Math.ceil(safeRtt * 0.5) + 40, 120, MAX_REWIND_MS);
}

/**
 * Clamp a client-supplied render timestamp within [now - allowedRewind, now].
 */
export function clampRewindTimestamp(clientTime, now, rttMs = 0) {
  if (!Number.isFinite(now)) return 0;
  if (!Number.isFinite(clientTime)) return now;
  const maxRewind = computeAllowedRewindMs(rttMs);
  return clamp(clientTime, now - maxRewind, now);
}

function cloneSnapshotFromPlayer(p, t) {
  return {
    t,
    id: p.id,
    x: Number.isFinite(p.x) ? p.x : 0,
    y: Number.isFinite(p.y) ? p.y : 0,
    z: Number.isFinite(p.z) ? p.z : 0,
    yaw: Number.isFinite(p.yaw) ? p.yaw : 0,
    flags: p.flags || 0,
    alive: Boolean(p.alive),
    spawnEpoch: Number.isInteger(p.spawnEpoch) ? p.spawnEpoch : 0,
  };
}

/**
 * Rolling 450ms per-player pose ring store used to rewind targets during hit validation.
 */
export function createPoseHistoryStore() {
  const history = new Map();

  function record(player, now) {
    if (!player || !player.id || !Number.isFinite(now)) return;
    let list = history.get(player.id);
    if (!list) {
      list = [];
      history.set(player.id, list);
    }
    const snap = cloneSnapshotFromPlayer(player, now);
    const last = list.length ? list[list.length - 1] : null;
    if (last) {
      if (now < last.t) return;
      if (now === last.t) {
        list[list.length - 1] = snap;
      } else {
        list.push(snap);
      }
    } else {
      list.push(snap);
    }
    const cutoff = now - MAX_HISTORY_MS;
    while (list.length > 2 && list[0].t < cutoff) {
      list.shift();
    }
    while (list.length > 24) {
      list.shift();
    }
  }

  function prune(now) {
    if (!Number.isFinite(now)) return;
    const cutoff = now - MAX_HISTORY_MS;
    for (const [pid, list] of history.entries()) {
      if (!list.length || list[list.length - 1].t < cutoff) {
        history.delete(pid);
        continue;
      }
      while (list.length > 1 && list[0].t < cutoff) {
        list.shift();
      }
    }
  }

  function sample(playerId, evalTime, fallbackPlayer = null) {
    const list = history.get(playerId);
    if (!list || list.length === 0) {
      return fallbackPlayer ? cloneSnapshotFromPlayer(fallbackPlayer, evalTime) : null;
    }
    if (evalTime <= list[0].t) {
      return { ...list[0] };
    }
    const last = list[list.length - 1];
    if (evalTime >= last.t) {
      return { ...last };
    }

    for (let i = 0; i < list.length - 1; i++) {
      const h0 = list[i];
      const h1 = list[i + 1];
      if (evalTime >= h0.t && evalTime <= h1.t) {
        const jumpDist = Math.hypot(h1.x - h0.x, h1.y - h0.y, h1.z - h0.z);
        const epochMismatch = h0.spawnEpoch !== h1.spawnEpoch;
        if (!h0.alive || !h1.alive || epochMismatch || jumpDist > TELEPORT_SNAP_DIST) {
          return {
            t: evalTime,
            id: h1.id,
            x: h1.x,
            y: h1.y,
            z: h1.z,
            yaw: h1.yaw,
            flags: h1.flags,
            alive: Boolean(h0.alive && h1.alive && !epochMismatch),
            spawnEpoch: h1.spawnEpoch,
          };
        }
        const span = h1.t - h0.t;
        const alpha = span > 0 ? clamp((evalTime - h0.t) / span, 0, 1) : 0;
        return {
          t: evalTime,
          id: h1.id,
          x: h0.x + (h1.x - h0.x) * alpha,
          y: h0.y + (h1.y - h0.y) * alpha,
          z: h0.z + (h1.z - h0.z) * alpha,
          yaw: lerpAngle(h0.yaw, h1.yaw, alpha),
          flags: alpha < 0.5 ? h0.flags : h1.flags,
          alive: true,
          spawnEpoch: h1.spawnEpoch,
        };
      }
    }
    return { ...last };
  }

  function clear(playerId = null) {
    if (playerId) history.delete(playerId);
    else history.clear();
  }

  return { record, prune, sample, clear };
}
