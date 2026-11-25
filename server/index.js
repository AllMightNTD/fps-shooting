/**
 * LAN HTTP Static Server & RFC 6455 WebSocket Multiplayer Entry Point (Truy Kích v2).
 * Usage: node server/index.js [--port 8090] [--host 0.0.0.0]
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PING_INTERVAL_MS, RoomManager } from "./RoomManager.js";
import { ERR, MSG, ROOM_STATE } from "./protocol.js";
import { upgradeHttpToWs } from "./ws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_PORT = 8090;
export const TICK_MS = 50; // 20 Hz snapshot & room loop

const MODEL_ASSET_RE = /^\/model\/dist\/([a-z0-9_]+)\.(glb|bundle\.js)$/;
const PUBLIC_JS_RE = /^\/js\/([a-z0-9_]+)\.js$/;

export function getLanUrls(port) {
  const ifaces = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === "IPv4" && !info.internal) {
        urls.push(`http://${info.address}:${port}/FPS.html`);
      }
    }
  }
  urls.push(`http://localhost:${port}/FPS.html`);
  return urls;
}

export function createLanServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const publicDir = path.join(rootDir, "public");
  const publicJsDir = path.join(publicDir, "js");
  const fpsPath = path.join(publicDir, "FPS.html");
  const protocolPath = path.join(rootDir, "server", "protocol.js");
  const weaponsPath = path.join(rootDir, "server", "weapons.js");
  const distDir = path.resolve(rootDir, "model", "dist");
  const nowFn = options.nowFn || Date.now;
  const tickMs = options.tickMs || TICK_MS;

  const roomManager = new RoomManager(nowFn);

  function sendError(ws, code, message) {
    if (ws && !ws.closed) {
      ws.sendJson({ type: MSG.ERROR, code, message });
    }
  }

  function routeMessage(state, rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      sendError(state.ws, ERR.BAD_REQUEST, "Malformed JSON");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    const now = nowFn();
    if (state.session) state.session.lastSeenAt = now;

    if (msg.type === MSG.PING) {
      if (state.session) state.session.lastSeenAt = now;
      state.ws.sendJson({ type: MSG.PONG, t: msg.t, serverTime: now });
      return;
    }

    if (msg.type === MSG.HELLO) {
      state.session = roomManager.handleHello(state.ws, msg);
      return;
    }

    const session = state.session;
    if (!session) {
      sendError(state.ws, ERR.BAD_REQUEST, "Cần gửi gói hello trước");
      return;
    }

    if (msg.type === MSG.ROOM_LIST) {
      state.ws.sendJson({ type: MSG.ROOM_LIST, rooms: roomManager.listRooms() });
      return;
    }

    if (msg.type === MSG.ROOM_CREATE) {
      const res = roomManager.createRoom(session, msg);
      if (!res.ok) sendError(state.ws, res.code, res.message);
      return;
    }

    if (msg.type === MSG.ROOM_JOIN) {
      const res = roomManager.joinRoom(session, msg.roomId, msg.password, msg.team, msg.playerName);
      if (!res.ok) {
        sendError(state.ws, res.code, res.message);
        if (res.code === ERR.ROOM_NOT_FOUND) {
          state.ws.sendJson({ type: MSG.ROOM_LIST, rooms: roomManager.listRooms() });
        }
      }
      return;
    }

    if (msg.type === MSG.ROOM_QUICK) {
      const res = roomManager.quickJoin(session, msg.playerName);
      if (!res.ok) sendError(state.ws, res.code, res.message);
      return;
    }

    if (msg.type === MSG.ROOM_LEAVE) {
      roomManager.leaveRoom(session);
      state.ws.sendJson({ type: MSG.ROOM_LIST, rooms: roomManager.listRooms() });
      return;
    }

    const room = session.roomId ? roomManager.rooms.get(session.roomId) : null;
    if (!room) {
      sendError(state.ws, ERR.NOT_IN_ROOM, "Bạn chưa tham gia phòng nào");
      return;
    }

    switch (msg.type) {
      case MSG.ROOM_TEAM: {
        const res = room.setTeam(session.id, msg.team);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        break;
      }
      case MSG.ROOM_READY: {
        const res = room.setReady(session.id, msg.ready);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        break;
      }
      case MSG.ROOM_SETTINGS: {
        const res = room.updateSettings(session.id, msg);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        else roomManager.broadcastLobbyList();
        break;
      }
      case MSG.ROOM_KICK: {
        const res = roomManager.kickPlayer(session, msg.targetId);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        break;
      }
      case MSG.ROOM_START: {
        const res = room.startMatch(session.id, now);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        else roomManager.broadcastLobbyList();
        break;
      }
      case MSG.ROOM_RETURN: {
        const res = room.returnToWaiting(session.id);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        else roomManager.broadcastLobbyList();
        break;
      }
      case MSG.CHAT: {
        const res = room.sendChat(session.id, msg.text, now);
        if (!res.ok) sendError(state.ws, res.code, res.message);
        break;
      }
      case MSG.STATE: {
        const p = room.players.get(session.id);
        if (p) room.match.handleState(p, msg, now);
        break;
      }
      case MSG.RELOAD: {
        const p = room.players.get(session.id);
        if (p) room.match.handleReload(p, now);
        break;
      }
      case MSG.SWITCH_WEAPON: {
        const p = room.players.get(session.id);
        if (p) room.match.handleSwitchWeapon(p, msg, now);
        break;
      }
      case MSG.FIRE: {
        const p = room.players.get(session.id);
        if (p) {
          const res = room.match.handleFire(p, msg, now);
          if (!res.ok && res.code === ERR.MATCH_ENDED) {
            sendError(state.ws, res.code, res.message);
          }
        }
        break;
      }
      case MSG.HIT: {
        const p = room.players.get(session.id);
        if (p) {
          const res = room.match.handleHit(p, msg, now);
          if (!res.ok && res.code === ERR.MATCH_ENDED) {
            sendError(state.ws, res.code, res.message);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function sendJsonHttp(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function streamFile(res, method, filePath, contentType, cacheControl) {
    if (!fs.existsSync(filePath)) {
      sendJsonHttp(res, 404, { error: "Not found" });
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cacheControl,
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJsonHttp(res, 405, { error: "Method Not Allowed" });
      return;
    }

    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
    } catch {
      sendJsonHttp(res, 400, { error: "Bad Request" });
      return;
    }

    if (pathname === "/api/lan-info") {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : DEFAULT_PORT;
      sendJsonHttp(res, 200, {
        port,
        urls: getLanUrls(port),
        rooms: roomManager.listRooms(),
      });
      return;
    }

    if (pathname === "/" || pathname === "/FPS.html" || pathname === "/public/FPS.html") {
      streamFile(res, req.method, fpsPath, "text/html; charset=utf-8", "no-store");
      return;
    }

    if (pathname === "/js/protocol.js") {
      streamFile(res, req.method, protocolPath, "application/javascript; charset=utf-8", "no-store");
      return;
    }

    if (pathname === "/js/weapons.js") {
      streamFile(res, req.method, weaponsPath, "application/javascript; charset=utf-8", "no-store");
      return;
    }

    const jsMatch = PUBLIC_JS_RE.exec(pathname);
    if (jsMatch) {
      const candidate = path.resolve(publicJsDir, `${jsMatch[1]}.js`);
      if (candidate.startsWith(publicJsDir + path.sep)) {
        streamFile(res, req.method, candidate, "application/javascript; charset=utf-8", "no-store");
        return;
      }
    }

    const assetMatch = MODEL_ASSET_RE.exec(pathname);
    if (assetMatch) {
      const filename = `${assetMatch[1]}.${assetMatch[2]}`;
      const candidate = path.resolve(distDir, filename);
      if (candidate.startsWith(distDir + path.sep)) {
        const mime =
          assetMatch[2] === "glb"
            ? "model/gltf-binary"
            : "application/javascript; charset=utf-8";
        streamFile(res, req.method, candidate, mime, "public, max-age=60");
        return;
      }
    }

    sendJsonHttp(res, 404, { error: "Not found" });
  });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ws = upgradeHttpToWs(req, socket, head);
    if (!ws) return;

    const connState = { ws, session: null };
    ws.on("pong", () => {
      if (connState.session) connState.session.lastSeenAt = nowFn();
    });
    ws.on("message", (text) => routeMessage(connState, text));
    ws.on("close", () => {
      if (connState.session) {
        roomManager.markDisconnected(connState.session.id, ws);
      }
    });
  });

  const tickTimer = setInterval(() => roomManager.stepAll(nowFn()), tickMs);
  tickTimer.unref();

  const heartbeatTimer = setInterval(() => roomManager.stepHeartbeat(nowFn()), PING_INTERVAL_MS);
  heartbeatTimer.unref();

  return {
    httpServer,
    roomManager,
    start(port = DEFAULT_PORT, host = "0.0.0.0", { autoFallback = false, maxAttempts = 20 } = {}) {
      return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryBind = (candidate) => {
          const onError = (err) => {
            httpServer.removeListener("listening", onListening);
            if (
              err &&
              err.code === "EADDRINUSE" &&
              autoFallback &&
              candidate > 0 &&
              candidate < 65535 &&
              attempt + 1 < maxAttempts
            ) {
              attempt++;
              tryBind(candidate + 1);
              return;
            }
            reject(err);
          };
          const onListening = () => {
            httpServer.removeListener("error", onError);
            const addr = httpServer.address();
            resolve(typeof addr === "object" && addr ? addr.port : candidate);
          };
          httpServer.once("error", onError);
          httpServer.once("listening", onListening);
          httpServer.listen(candidate, host);
        };
        tryBind(port);
      });
    },
    stop() {
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      for (const s of roomManager.sessions.values()) {
        if (s.ws && !s.ws.closed) s.ws.close(1001, "Server stopping");
      }
      roomManager.sessions.clear();
      roomManager.tokens.clear();
      if (!httpServer.listening) return Promise.resolve();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function parseCliArgs(argv) {
  const envPort = Number(process.env.PORT);
  const hasEnvPort = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535;
  let port = hasEnvPort ? envPort : DEFAULT_PORT;
  let explicitPort = hasEnvPort;
  let host = "0.0.0.0";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) {
        port = p;
        explicitPort = true;
      }
    } else if (argv[i] === "--host" && argv[i + 1]) {
      host = argv[++i];
    }
  }
  return { port, host, explicitPort };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { port, host, explicitPort } = parseCliArgs(process.argv.slice(2));
  const app = createLanServer();
  app
    .start(port, host, { autoFallback: !explicitPort })
    .then((boundPort) => {
      console.log(`\n=== Bến Cảng Mưa - Máy chủ Truy Kích Mạng LAN v2 ===`);
      if (boundPort !== port) {
        console.log(`[!] Cổng ${port} đang bận, đã tự động chuyển sang cổng ${boundPort}.`);
      }
      console.log(`Đang lắng nghe trên ${host}:${boundPort}`);
      console.log(`Chia sẻ một trong các đường dẫn sau cho máy cùng mạng Wi-Fi/LAN:`);
      for (const u of getLanUrls(boundPort)) {
        console.log(`  -> ${u}`);
      }
      console.log(`Lưu ý Windows Firewall: mở cổng TCP ${boundPort} cho mạng Private nếu bạn bè chưa vào được.`);
      console.log(`Nhấn Ctrl+C để dừng server.\n`);
    })
    .catch((err) => {
      console.error(
        `\n[Lỗi] Không thể mở cổng ${port} (${err.code || err.message}).\n` +
          `Hãy chạy với cổng khác, ví dụ: node server/index.js --port ${port + 1}\n`,
      );
      app.stop().finally(() => process.exit(1));
    });

  const shutdown = () => app.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

