/**
 * Shared client/server WebSocket protocol constants, limits, and error codes.
 * Must stay dependency-free so both Node.js and browser ES modules can import it.
 */

import { WEAPONS } from "./weapons.js";

export const ROOM_STATE = Object.freeze({
  WAITING: "WAITING",
  STARTING: "STARTING",
  PLAYING: "PLAYING",
  ENDING: "ENDING",
});

export const GAME_MODE = Object.freeze({
  TDM: "TDM",
  FFA: "FFA",
});

export const MAP_LIST = Object.freeze([
  { id: "military", name: "Khu Quân Sự Cũ" },
  { id: "harbor", name: "Bến Cảng Mưa" },
]);

export const WEAPON_STATS = Object.freeze({
  M416: Object.freeze({
    ...WEAPONS.m416,
    maxAmmo: WEAPONS.m416.magSize,
    cooldownMs: WEAPONS.m416.fireInterval,
    reloadMs: WEAPONS.m416.reloadTime,
  }),
  m416: WEAPONS.m416,
  pistol: WEAPONS.pistol,
  sniper: WEAPONS.sniper,
});

export const MSG = Object.freeze({
  // Client -> Server
  HELLO: "hello",
  ROOM_LIST: "room.list",
  ROOM_CREATE: "room.create",
  ROOM_JOIN: "room.join",
  ROOM_QUICK: "room.quick",
  ROOM_TEAM: "room.team",
  ROOM_READY: "room.ready",
  ROOM_SETTINGS: "room.settings",
  ROOM_KICK: "room.kick",
  ROOM_START: "room.start",
  ROOM_LEAVE: "room.leave",
  ROOM_RETURN: "room.return",
  CHAT: "chat",
  STATE: "state",
  FIRE: "fire",
  HIT: "hit",
  RELOAD: "reload",
  SWITCH_WEAPON: "switchWeapon",
  SCOPE: "scope",
  PING: "ping",

  // Server -> Client
  WELCOME: "welcome",
  ROOM_JOINED: "room.joined",
  ROOM_UPDATE: "room.update",
  ROOM_HOST_CHANGED: "room.hostChanged",
  ROOM_KICKED: "room.kicked",
  ROOM_CLOSED: "room.closed",
  SNAPSHOT: "snapshot",
  EVENT_FIRE: "event.fire",
  EVENT_HIT: "event.hit",
  EVENT_KILL: "event.kill",
  EVENT_RESPAWN: "event.respawn",
  EVENT_RELOAD: "event.reload",
  EVENT_SCOPE: "event.scope",
  AMMO: "ammo",
  MATCH_COUNTDOWN: "match.countdown",
  MATCH_START: "match.start",
  MATCH_SCORE: "match.score",
  MATCH_END: "match.end",
  PONG: "pong",
  ERROR: "error",
});

export const ERR = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST",
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  ROOM_FULL: "ROOM_FULL",
  WRONG_PASSWORD: "WRONG_PASSWORD",
  NOT_HOST: "NOT_HOST",
  NOT_IN_ROOM: "NOT_IN_ROOM",
  INVALID_STATE: "INVALID_STATE",
  TEAM_FULL: "TEAM_FULL",
  TEAM_IMBALANCE: "TEAM_IMBALANCE",
  NOT_READY: "NOT_READY",
  NOT_ENOUGH_PLAYERS: "NOT_ENOUGH_PLAYERS",
  MATCH_ENDED: "MATCH_ENDED",
  RATE_LIMITED: "RATE_LIMITED",
  KICKED: "KICKED",
});

/**
 * Strip unsafe HTML/control characters and bound label length.
 * @param {unknown} raw
 * @param {string} fallback
 * @param {number} maxLen
 */
export function sanitizeText(raw, fallback, maxLen = 16) {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .replace(/[<>&"'`\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

export const SNAPSHOT_WEAPONS = Object.freeze(["m416", "pistol", "sniper"]);
export const SNAPSHOT_WEAPON_CODE = Object.freeze({ m416: 0, pistol: 1, sniper: 2 });

/**
 * Unpack compact 20Hz tuple snapshots into normalized player objects while remaining
 * backward-compatible with verbose legacy snapshot payloads.
 */
export function unpackSnapshot(snap, rosterNames = null) {
  if (!snap || typeof snap !== "object") return null;
  if (Array.isArray(snap.players)) {
    return snap;
  }
  const tuples = Array.isArray(snap.p) ? snap.p : [];
  const players = new Array(tuples.length);
  for (let idx = 0; idx < tuples.length; idx++) {
    const row = tuples[idx];
    if (!Array.isArray(row)) continue;
    const id = row[0];
    const teamCode = row[1];
    const flags = row[8] || 0;
    const st = row[9] || 0;
    const wCode = row[10] || 0;
    players[idx] = {
      id,
      name: (rosterNames && rosterNames.get(id)) || id,
      team: teamCode === 0 ? "A" : teamCode === 1 ? "B" : null,
      x: row[2] || 0,
      y: row[3] || 0,
      z: row[4] || 0,
      yaw: row[5] || 0,
      pitch: row[6] || 0,
      mv: row[7] || 0,
      ads: Boolean(flags & 2),
      laser: Boolean(st & 4),
      flags,
      weaponId: SNAPSHOT_WEAPONS[wCode] || "m416",
      alive: Boolean(st & 1),
      hp: row[11] ?? 100,
      ammo: row[12] ?? 0,
      reloading: Boolean(flags & 32),
      invulnerable: Boolean(st & 2),
      respawnMs: row[13] || 0,
      kills: row[14] || 0,
      deaths: row[15] || 0,
      headshots: row[16] || 0,
    };
  }
  const ts = Array.isArray(snap.ts) ? snap.ts : [0, 0];
  return {
    type: snap.type || MSG.SNAPSHOT,
    t: snap.t || 0,
    timeLeftSec: snap.tl || 0,
    teamScores: { A: ts[0] || 0, B: ts[1] || 0 },
    players,
  };
}

