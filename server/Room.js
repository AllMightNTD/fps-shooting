/**
 * Room lifecycle state machine:
 * WAITING -> STARTING (5s countdown) -> PLAYING -> ENDING (10s results) -> WAITING
 */

import { Match } from "./Match.js";
import { FFAMode } from "./modes/FFA.js";
import { TDMMode } from "./modes/TDM.js";
import { ERR, GAME_MODE, MAP_LIST, MSG, ROOM_STATE, sanitizeText } from "./protocol.js";
import { createDefaultWeaponsState } from "./weapons.js";

export const STARTING_COUNTDOWN_SEC = 5;
export const ENDING_DURATION_MS = 10000;
export const CHAT_COOLDOWN_MS = 650;

const MODE_IMPLS = {
  [GAME_MODE.TDM]: TDMMode,
  [GAME_MODE.FFA]: FFAMode,
};

const VALID_MAPS = new Set(MAP_LIST.map((m) => m.id));

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export class Room {
  constructor(id, hostSession, options = {}, sharedArenaOrArenas, nowFn = Date.now) {
    this.id = id;
    this.now = nowFn;
    if (sharedArenaOrArenas && sharedArenaOrArenas.boxes) {
      this.arenas = { harbor: sharedArenaOrArenas, military: sharedArenaOrArenas };
      this.defaultArena = sharedArenaOrArenas;
    } else {
      this.arenas = sharedArenaOrArenas || {};
      this.defaultArena = this.arenas.military || this.arenas.harbor || { boxes: [], spawns: { A: [], B: [], FFA: [] } };
    }

    this.name = sanitizeText(options.name, `Phòng ${id}`, 24);
    this.hostId = hostSession.id;
    this.password =
      typeof options.password === "string" && options.password.trim()
        ? options.password.trim().slice(0, 24)
        : null;
    this.mode = MODE_IMPLS[options.mode] ? options.mode : GAME_MODE.TDM;
    this.map = VALID_MAPS.has(options.map) ? options.map : "military";
    this.killLimit = clampInt(options.killLimit, 1, 100, this.mode === GAME_MODE.TDM ? 30 : 20);
    this.timeLimit = clampInt(options.timeLimit, 60, 1200, 600);
    this.maxPlayers = clampInt(options.maxPlayers, 2, 18, 16);
    if (this.mode === GAME_MODE.TDM && this.maxPlayers % 2 !== 0) {
      this.maxPlayers = Math.max(2, this.maxPlayers - 1);
    }
    this.allowSoloTest = Boolean(options.allowSoloTest);
    this.onAutoKick = typeof options.onAutoKick === "function" ? options.onAutoKick : null;

    this.state = ROOM_STATE.WAITING;
    this.players = new Map();
    this.teamScores = { A: 0, B: 0 };
    this.countdownSec = 0;
    this.nextCountdownTickAt = 0;
    this.endingEndsAt = 0;
    this.lastWinner = null;
    this.kickedCheatIds = new Set();
    this.match = new Match(this);
  }

  get arena() {
    return this.arenas[this.map] || this.defaultArena;
  }

  get modeImpl() {
    return MODE_IMPLS[this.mode];
  }

  getSummary() {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      map: this.map,
      killLimit: this.killLimit,
      timeLimit: this.timeLimit,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      state: this.state,
      hasPassword: Boolean(this.password),
      allowSoloTest: this.allowSoloTest,
    };
  }

  serializeRoom() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        team: p.team,
        ready: p.ready,
        joinedAt: p.joinedAt,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        alive: p.alive,
        hp: p.hp,
        connected: p.connected,
      });
    }
    return {
      ...this.getSummary(),
      hostId: this.hostId,
      countdownSec: this.countdownSec,
      teamScores: { ...this.teamScores },
      lastWinner: this.lastWinner,
      players,
    };
  }

  sendTo(playerId, obj) {
    const p = this.players.get(playerId);
    if (p && p.connected && p.ws && !p.ws.closed) {
      p.ws.sendJson(obj);
    }
  }

  broadcast(obj, excludeId = null) {
    const raw = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === excludeId || !p.connected || !p.ws || p.ws.closed) continue;
      p.ws.sendText(raw);
    }
  }

  broadcastRoomUpdate() {
    this.broadcast({ type: MSG.ROOM_UPDATE, room: this.serializeRoom() });
  }

  join(session, password = null, preferredTeam = null, now = this.now()) {
    if (this.state === ROOM_STATE.ENDING) {
      return { ok: false, code: ERR.MATCH_ENDED, message: "Trận đấu vừa kết thúc, thử lại sau vài giây" };
    }
    if (this.state === ROOM_STATE.STARTING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Phòng đang đếm ngược, chờ trận bắt đầu để vào giữa trận" };
    }
    if (this.kickedCheatIds.has(session.id)) {
      return {
        ok: false,
        code: ERR.CHEAT_DETECTED,
        message: "Bạn đã bị chặn vào lại trận đấu này do vi phạm Anti-Cheat",
      };
    }
    if (this.players.has(session.id)) {
      return { ok: true, player: this.players.get(session.id) };
    }
    if (this.players.size >= this.maxPlayers) {
      return { ok: false, code: ERR.ROOM_FULL, message: "Phòng đã đầy" };
    }
    if (this.password !== null && String(password || "") !== this.password) {
      return { ok: false, code: ERR.WRONG_PASSWORD, message: "Sai mật khẩu phòng" };
    }

    const team = this.modeImpl.assignTeamOnJoin(this, preferredTeam);
    const player = {
      id: session.id,
      name: session.name,
      team,
      ready: false,
      joinedAt: now,
      kills: 0,
      deaths: 0,
      headshots: 0,
      alive: false,
      hp: 100,
      activeWeaponId: "m416",
      prevWeaponId: "m416",
      weapons: createDefaultWeaponsState(),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      mv: 0,
      ads: false,
      laser: true,
      flags: 0,
      prevFlags: 0,
      respawnAt: 0,
      spawnEpoch: 0,
      spawnedAt: 0,
      iFramesUntil: 0,
      invulnerableUntil: 0,
      spawnOrigin: null,
      adsProtectStartAt: 0,
      lastDeathPos: null,
      lastSpawnReason: "normal",
      lastStateAt: now,
      lastShotAt: 0,
      moveAllowance: 1.2,
      rttMs: session.rttMs || 0,
      lastChatAt: 0,
      connected: session.connected,
      ws: session.ws,
    };

    this.players.set(session.id, player);
    session.roomId = this.id;

    // Mid-match join spawns the newcomer directly into combat
    if (this.state === ROOM_STATE.PLAYING) {
      this.match.spawnPlayer(player, now);
    }

    return { ok: true, player };
  }

  leave(playerId, now = this.now()) {
    const existing = this.players.get(playerId);
    if (!existing) return false;
    this.players.delete(playerId);
    if (this.match && this.match.poseHistory) {
      this.match.poseHistory.clear(playerId);
    }

    if (this.players.size === 0) {
      this.state = ROOM_STATE.WAITING;
      return { empty: true };
    }

    const wasHost = playerId === this.hostId;
    if (wasHost) {
      this._transferHost();
    }

    // Cancel STARTING countdown if Host left or remaining roster violates mode rules
    if (this.state === ROOM_STATE.STARTING && (wasHost || !this.modeImpl.canStart(this).ok)) {
      this.state = ROOM_STATE.WAITING;
      this.countdownSec = 0;
      this.broadcast({
        type: MSG.MATCH_COUNTDOWN,
        secondsLeft: 0,
        cancelled: true,
        reason: wasHost ? "Chủ phòng đã rời đi, hủy đếm ngược" : "Không đủ điều kiện bắt đầu",
      });
    }

    this.broadcastRoomUpdate();
    if (this.state === ROOM_STATE.PLAYING) {
      this.broadcast(this.match.buildSnapshot(now));
    }
    return { empty: false };
  }

  _transferHost() {
    let best = null;
    for (const p of this.players.values()) {
      if (!best) best = p;
      else if (p.connected !== best.connected) {
        if (p.connected) best = p;
      } else if (p.joinedAt < best.joinedAt) {
        best = p;
      }
    }
    if (best) {
      this.hostId = best.id;
      this.broadcast({
        type: MSG.ROOM_HOST_CHANGED,
        hostId: best.id,
        hostName: best.name,
      });
    }
  }

  setTeam(playerId, targetTeam) {
    if (this.state !== ROOM_STATE.WAITING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Chỉ có thể đổi đội khi phòng đang chờ" };
    }
    const player = this.players.get(playerId);
    if (!player) return { ok: false, code: ERR.NOT_IN_ROOM, message: "Bạn không ở trong phòng" };

    const check = this.modeImpl.canSwitchTeam(this, player, targetTeam);
    if (!check.ok) return check;
    if (player.team !== targetTeam) {
      player.team = targetTeam;
      player.ready = false;
      this.broadcastRoomUpdate();
    }
    return { ok: true };
  }

  setReady(playerId, ready) {
    if (this.state !== ROOM_STATE.WAITING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Phòng không ở trạng thái chờ" };
    }
    const player = this.players.get(playerId);
    if (!player) return { ok: false, code: ERR.NOT_IN_ROOM, message: "Bạn không ở trong phòng" };
    player.ready = Boolean(ready);
    this.broadcastRoomUpdate();
    return { ok: true };
  }

  updateSettings(requesterId, settings = {}) {
    if (requesterId !== this.hostId) {
      return { ok: false, code: ERR.NOT_HOST, message: "Chỉ chủ phòng mới sửa được cài đặt" };
    }
    if (this.state !== ROOM_STATE.WAITING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Không thể đổi cài đặt khi đang bắt đầu hoặc đang đấu" };
    }

    if (typeof settings.name === "string") {
      this.name = sanitizeText(settings.name, this.name, 24);
    }
    const prevMode = this.mode;
    if (MODE_IMPLS[settings.mode]) this.mode = settings.mode;
    if (VALID_MAPS.has(settings.map)) this.map = settings.map;
    if (settings.killLimit !== undefined) {
      this.killLimit = clampInt(settings.killLimit, 1, 100, this.killLimit);
    }
    if (settings.timeLimit !== undefined) {
      this.timeLimit = clampInt(settings.timeLimit, 60, 1200, this.timeLimit);
    }
    if (settings.maxPlayers !== undefined) {
      let mp = clampInt(settings.maxPlayers, Math.max(2, this.players.size), 18, this.maxPlayers);
      if (this.mode === GAME_MODE.TDM && mp % 2 !== 0) mp = Math.min(18, mp + 1);
      this.maxPlayers = mp;
    }
    if (settings.password !== undefined) {
      this.password =
        typeof settings.password === "string" && settings.password.trim()
          ? settings.password.trim().slice(0, 24)
          : null;
    }
    if (settings.allowSoloTest !== undefined) {
      this.allowSoloTest = Boolean(settings.allowSoloTest);
    }

    // Reassign teams cleanly if mode changed, and reset Ready for all non-host members
    if (this.mode !== prevMode) {
      let idx = 0;
      for (const p of this.players.values()) {
        p.team = this.mode === GAME_MODE.TDM ? (idx++ % 2 === 0 ? "A" : "B") : null;
      }
    }
    for (const p of this.players.values()) {
      if (p.id !== this.hostId) p.ready = false;
    }

    this.broadcastRoomUpdate();
    return { ok: true };
  }

  kick(requesterId, targetId) {
    if (requesterId !== this.hostId) {
      return { ok: false, code: ERR.NOT_HOST, message: "Chỉ chủ phòng mới có quyền kick" };
    }
    if (targetId === requesterId) {
      return { ok: false, code: ERR.BAD_REQUEST, message: "Không thể tự kick chính mình" };
    }
    const target = this.players.get(targetId);
    if (!target) return { ok: false, code: ERR.BAD_REQUEST, message: "Không tìm thấy người chơi" };

    this.sendTo(targetId, {
      type: MSG.ROOM_KICKED,
      roomId: this.id,
      reason: "Bạn đã bị chủ phòng mời ra khỏi phòng",
    });
    this.leave(targetId);
    return { ok: true, kickedPlayer: target };
  }

  kickForCheat(targetId, reason = "Phát hiện hành vi bất thường (Anti-Cheat)") {
    const target = this.players.get(targetId);
    if (!target) return { ok: false };
    this.kickedCheatIds.add(targetId);
    this.sendTo(targetId, {
      type: MSG.ROOM_KICKED,
      roomId: this.id,
      code: ERR.CHEAT_DETECTED,
      reason,
    });
    this.leave(targetId);
    if (this.onAutoKick) {
      this.onAutoKick(this, targetId, reason);
    }
    return { ok: true };
  }

  startMatch(requesterId, now = this.now()) {
    if (requesterId !== this.hostId) {
      return { ok: false, code: ERR.NOT_HOST, message: "Chỉ chủ phòng mới bắt đầu trận được" };
    }
    if (this.state !== ROOM_STATE.WAITING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Phòng không ở trạng thái chờ" };
    }
    const check = this.modeImpl.canStart(this);
    if (!check.ok) return check;

    this.state = ROOM_STATE.STARTING;
    this.countdownSec = STARTING_COUNTDOWN_SEC;
    this.nextCountdownTickAt = now + 1000;
    this.broadcastRoomUpdate();
    this.broadcast({ type: MSG.MATCH_COUNTDOWN, secondsLeft: this.countdownSec });
    return { ok: true };
  }

  _beginPlaying(now) {
    this.state = ROOM_STATE.PLAYING;
    this.countdownSec = 0;
    this.lastWinner = null;
    this.match.start(now);
    this.broadcastRoomUpdate();
    this.broadcast({
      type: MSG.MATCH_START,
      room: this.serializeRoom(),
      snapshot: this.match.buildSnapshot(now),
    });
  }

  finishMatch(winner, now = this.now()) {
    if (this.state !== ROOM_STATE.PLAYING) return;
    this.state = ROOM_STATE.ENDING;
    this.lastWinner = winner;
    this.endingEndsAt = now + ENDING_DURATION_MS;
    this.broadcastRoomUpdate();
    this.broadcast({
      type: MSG.MATCH_END,
      winner,
      teamScores: { ...this.teamScores },
      scoreboard: this.getScoreboard(),
      returnInSec: Math.round(ENDING_DURATION_MS / 1000),
    });
  }

  returnToWaiting(requesterId = null) {
    if (requesterId && requesterId !== this.hostId) {
      return { ok: false, code: ERR.NOT_HOST, message: "Chỉ chủ phòng có thể đưa cả phòng quay lại ngay" };
    }
    if (this.state !== ROOM_STATE.ENDING) {
      return { ok: false, code: ERR.INVALID_STATE, message: "Trận đấu chưa kết thúc" };
    }
    this._resetToWaiting();
    return { ok: true };
  }

  _resetToWaiting() {
    this.state = ROOM_STATE.WAITING;
    this.countdownSec = 0;
    this.endingEndsAt = 0;
    this.teamScores = { A: 0, B: 0 };
    this.kickedCheatIds.clear();
    for (const p of this.players.values()) {
      p.ready = false;
      p.alive = false;
      p.hp = 100;
      p.flags = 0;
      p.prevFlags = 0;
      p.iFramesUntil = 0;
      p.invulnerableUntil = 0;
      p.spawnOrigin = null;
      p.adsProtectStartAt = 0;
      p.lastDeathPos = null;
      p.activeWeaponId = "m416";
      p.prevWeaponId = "m416";
      p.weapons = createDefaultWeaponsState();
      p.moveAllowance = 1.2;
      p.kills = 0;
      p.deaths = 0;
      p.headshots = 0;
    }
    if (typeof this.match.resetAntiCheatAndHistory === "function") {
      this.match.resetAntiCheatAndHistory();
    }
    this.broadcastRoomUpdate();
  }

  sendChat(playerId, rawText, now = this.now()) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, code: ERR.NOT_IN_ROOM, message: "Bạn chưa vào phòng" };
    if (now - p.lastChatAt < CHAT_COOLDOWN_MS) {
      return { ok: false, code: ERR.RATE_LIMITED, message: "Bạn chat hơi nhanh, vui lòng chờ giây lát" };
    }
    const text = sanitizeText(rawText, "", 120);
    if (!text) return { ok: false, code: ERR.BAD_REQUEST, message: "Tin nhắn rỗng" };
    p.lastChatAt = now;
    this.broadcast({
      type: MSG.CHAT,
      playerId: p.id,
      from: p.name,
      team: p.team,
      text,
      t: now,
    });
    return { ok: true };
  }

  getScoreboard() {
    return Array.from(this.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        headshots: p.headshots,
        alive: p.alive,
        connected: p.connected,
      }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.headshots - a.headshots);
  }

  step(now) {
    if (this.state === ROOM_STATE.STARTING && now >= this.nextCountdownTickAt) {
      this.countdownSec--;
      if (this.countdownSec <= 0) {
        this._beginPlaying(now);
      } else {
        this.nextCountdownTickAt += 1000;
        this.broadcast({ type: MSG.MATCH_COUNTDOWN, secondsLeft: this.countdownSec });
      }
      return;
    }

    if (this.state === ROOM_STATE.PLAYING) {
      this.match.step(now);
      return;
    }

    if (this.state === ROOM_STATE.ENDING && now >= this.endingEndsAt) {
      this._resetToWaiting();
    }
  }
}
