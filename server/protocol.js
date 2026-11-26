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

