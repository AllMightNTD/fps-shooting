/**
 * Central RoomManager: session identity (playerId + 30s token reconnect),
 * unique callsign deduplication, heartbeat checks, room registry, and quick join.
 */

import crypto from "node:crypto";

import { Room } from "./Room.js";
import { ERR, GAME_MODE, MSG, ROOM_STATE, sanitizeText } from "./protocol.js";
import { buildHarborMap, generateSpawnPoints, loadMilitaryArena } from "./spawn.js";

export const PING_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 15000;
export const RECONNECT_GRACE_MS = 30000;

export class RoomManager {
  constructor(nowFn = Date.now) {
    this.now = nowFn;
    const harborBase = buildHarborMap();
    this.arenas = {
      harbor: {
        mapId: "harbor",
        bounds: { minX: -48, maxX: 48, minZ: -48, maxZ: 48 },
        boxes: harborBase.boxes,
        obbs: [],
        walkableSlabs: [],
        ladders: [],
        spawns: generateSpawnPoints(harborBase.boxes),
      },
      military: loadMilitaryArena(),
    };
    this.sharedArena = this.arenas.military;
    this.rooms = new Map();
    this.sessions = new Map(); // playerId -> session
    this.tokens = new Map(); // token -> playerId
    this.nextRoomSeq = 1;
    this.nextPlayerSeq = 1;
  }

  _uniqueName(desiredName, excludeId = null) {
    const base = sanitizeText(desiredName, "ChiếnBinh", 16);
    const activeNames = new Set();
    for (const s of this.sessions.values()) {
      if (s.id !== excludeId) activeNames.add(s.name);
    }
    if (!activeNames.has(base)) return base;
    let n = 2;
    while (n < 999) {
      const suffix = ` #${n}`;
      const candidate = base.slice(0, 16 - suffix.length) + suffix;
      if (!activeNames.has(candidate)) return candidate;
      n++;
    }
    return `${base.slice(0, 11)}_${this.nextPlayerSeq}`;
  }

  handleHello(ws, msg = {}) {
    const now = this.now();
    const token = typeof msg.token === "string" ? msg.token.trim() : "";

    if (token && this.tokens.has(token)) {
      const pid = this.tokens.get(token);
      const session = this.sessions.get(pid);
      if (session) {
        // Rebind WebSocket cleanly if client reconnected with valid session token
        if (session.ws && session.ws !== ws && !session.ws.closed) {
          session.ws.close(4000, "Session resumed elsewhere");
        }
        session.ws = ws;
        session.connected = true;
        session.lastSeenAt = now;
        session.disconnectDeadline = 0;

        const room = session.roomId ? this.rooms.get(session.roomId) : null;
        if (room && room.players.has(session.id)) {
          const p = room.players.get(session.id);
          p.ws = ws;
          p.connected = true;
        } else {
          session.roomId = null;
        }

        ws.sendJson({
          type: MSG.WELCOME,
          playerId: session.id,
          token: session.token,
          name: session.name,
          resumed: true,
          rooms: this.listRooms(),
        });

        if (room && room.players.has(session.id)) {
          const p = room.players.get(session.id);
          ws.sendJson({
            type: MSG.ROOM_JOINED,
            room: room.serializeRoom(),
            snapshot:
              room.state === ROOM_STATE.PLAYING ? room.match.buildSnapshot(now) : null,
          });
          if (room.state === ROOM_STATE.PLAYING) {
            room.match.syncPlayerWeapons(p, now);
          }
          room.broadcastRoomUpdate();
        }
        return session;
      }
    }

    const playerId = `p${this.nextPlayerSeq++}`;
    const newToken = crypto.randomUUID();
    const uniqueName = this._uniqueName(msg.name, playerId);
    const session = {
      id: playerId,
      token: newToken,
      name: uniqueName,
      ws,
      connected: true,
      roomId: null,
      lastSeenAt: now,
      disconnectDeadline: 0,
    };
    this.sessions.set(playerId, session);
    this.tokens.set(newToken, playerId);

    ws.sendJson({
      type: MSG.WELCOME,
      playerId: session.id,
      token: session.token,
      name: session.name,
      resumed: false,
      rooms: this.listRooms(),
    });
    return session;
  }

  markDisconnected(playerId, wsRef = null) {
    const session = this.sessions.get(playerId);
    if (!session) return;
    if (wsRef && session.ws !== wsRef) return;

    const now = this.now();
    session.connected = false;
    session.disconnectDeadline = now + RECONNECT_GRACE_MS;

    const room = session.roomId ? this.rooms.get(session.roomId) : null;
    if (room && room.players.has(session.id)) {
      const p = room.players.get(session.id);
      p.connected = false;
      room.broadcastRoomUpdate();
    }
  }

  leaveRoom(session) {
    if (!session.roomId) return;
    const roomId = session.roomId;
    session.roomId = null;
    const room = this.rooms.get(roomId);
    if (!room) return;

    const res = room.leave(session.id, this.now());
    if (res && res.empty) {
      this.rooms.delete(roomId);
    }
    this.broadcastLobbyList();
  }

  _syncPlayerName(session, playerName) {
    if (typeof playerName === "string" && playerName.trim()) {
      session.name = this._uniqueName(playerName, session.id);
    }
  }

  createRoom(session, msg = {}) {
    if (session.roomId) this.leaveRoom(session);
    if (this.rooms.size >= 16) {
      return { ok: false, code: ERR.ROOM_FULL, message: "Server đang đạt giới hạn 16 phòng" };
    }
    this._syncPlayerName(session, msg.playerName);
    const id = `r${this.nextRoomSeq++}`;
    const room = new Room(id, session, msg, this.arenas, this.now);
    const joinRes = room.join(session, room.password, msg.team, this.now());
    if (!joinRes.ok) return joinRes;

    this.rooms.set(id, room);
    session.ws.sendJson({
      type: MSG.ROOM_JOINED,
      room: room.serializeRoom(),
      snapshot: null,
    });
    this.broadcastLobbyList();
    return { ok: true, room };
  }

  joinRoom(session, roomId, password = null, preferredTeam = null, playerName = null) {
    const room = this.rooms.get(String(roomId || ""));
    if (!room) {
      return { ok: false, code: ERR.ROOM_NOT_FOUND, message: "Phòng không còn tồn tại" };
    }
    if (session.roomId && session.roomId !== room.id) {
      this.leaveRoom(session);
    }
    this._syncPlayerName(session, playerName);
    const now = this.now();
    const res = room.join(session, password, preferredTeam, now);
    if (!res.ok) return res;

    session.ws.sendJson({
      type: MSG.ROOM_JOINED,
      room: room.serializeRoom(),
      snapshot: room.state === ROOM_STATE.PLAYING ? room.match.buildSnapshot(now) : null,
    });
    if (room.state === ROOM_STATE.PLAYING && res.player) {
      room.match.syncPlayerWeapons(res.player, now);
    }
    room.broadcastRoomUpdate();
    this.broadcastLobbyList();
    return { ok: true, room };
  }

  quickJoin(session, playerName = null, preferredMode = null) {
    this._syncPlayerName(session, playerName);
    const modeFilter =
      preferredMode === GAME_MODE.FFA || preferredMode === GAME_MODE.TDM ? preferredMode : null;
    let best = null;
    for (const r of this.rooms.values()) {
      if (r.password !== null) continue;
      if (modeFilter && r.mode !== modeFilter) continue;
      if (r.state !== ROOM_STATE.WAITING && r.state !== ROOM_STATE.PLAYING) continue;
      if (r.players.size >= r.maxPlayers) continue;
      if (!best || r.players.size > best.players.size) best = r;
    }
    if (best) {
      return this.joinRoom(session, best.id);
    }
    const targetMode = modeFilter || GAME_MODE.TDM;
    return this.createRoom(session, {
      name: `Khu Quân Sự ${targetMode} #${this.nextRoomSeq}`,
      mode: targetMode,
      map: "military",
      killLimit: 30,
      maxPlayers: 10,
    });
  }

  kickPlayer(session, targetId) {
    const room = session.roomId ? this.rooms.get(session.roomId) : null;
    if (!room) return { ok: false, code: ERR.NOT_IN_ROOM, message: "Bạn chưa ở trong phòng" };
    const res = room.kick(session.id, targetId);
    if (!res.ok) return res;

    const targetSess = this.sessions.get(targetId);
    if (targetSess) targetSess.roomId = null;
    if (room.players.size === 0) this.rooms.delete(room.id);
    this.broadcastLobbyList();
    return res;
  }

  listRooms() {
    return Array.from(this.rooms.values()).map((r) => r.getSummary());
  }

  broadcastLobbyList() {
    const msg = JSON.stringify({ type: MSG.ROOM_LIST, rooms: this.listRooms() });
    for (const s of this.sessions.values()) {
      if (!s.roomId && s.connected && s.ws && !s.ws.closed) {
        s.ws.sendText(msg);
      }
    }
  }

  stepHeartbeat(now = this.now()) {
    for (const s of this.sessions.values()) {
      if (s.connected && s.ws && !s.ws.closed) {
        if (now - s.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
          s.ws.close(1001, "Heartbeat timeout");
          this.markDisconnected(s.id, s.ws);
        } else {
          s.ws.sendPing();
        }
      }
    }
  }

  stepAll(now = this.now()) {
    // Expire disconnected player seats after 30s grace period
    for (const s of Array.from(this.sessions.values())) {
      if (!s.connected && s.disconnectDeadline > 0 && now >= s.disconnectDeadline) {
        this.leaveRoom(s);
        this.tokens.delete(s.token);
        this.sessions.delete(s.id);
      }
    }

    for (const room of Array.from(this.rooms.values())) {
      const prevState = room.state;
      room.step(now);
      if (room.state !== prevState) {
        this.broadcastLobbyList();
      }
    }
  }
}

