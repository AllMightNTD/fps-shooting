/**
 * Automatic LAN WebSocket client:
 * - Zero manual URL inputs: derives ws(s)://${location.host}/ws from loaded HTTP page.
 * - Auto-connects on load, pings every 5s, reconnects automatically on drop.
 * - Persists player token in sessionStorage (per tab) and 30s localStorage handoff on tab close.
 */

import { MSG } from "/js/protocol.js";

const SESSION_TOKEN_KEY = "fps_lan_token_v2";
const CLOSED_TOKEN_KEY = "fps_lan_closed_token_v2";
const CLOSED_GRACE_MS = 28000;

function takeRecoverableToken() {
  try {
    const tabTok = sessionStorage.getItem(SESSION_TOKEN_KEY);
    const raw = localStorage.getItem(CLOSED_TOKEN_KEY);
    if (tabTok) {
      // Tab reloaded (F5): clean up any pagehide handoff copy of our own token so new tabs get fresh seats
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.token === tabTok) localStorage.removeItem(CLOSED_TOKEN_KEY);
      }
      return tabTok;
    }

    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.token && Date.now() - Number(parsed.closedAt || 0) <= CLOSED_GRACE_MS) {
      localStorage.removeItem(CLOSED_TOKEN_KEY);
      sessionStorage.setItem(SESSION_TOKEN_KEY, parsed.token);
      return parsed.token;
    }
    localStorage.removeItem(CLOSED_TOKEN_KEY);
  } catch {
    // Storage disabled or private browsing
  }
  return null;
}

export function createNetClient(getNickFn) {
  let ws = null;
  let connected = false;
  let playerId = null;
  let token = takeRecoverableToken();
  let playerName = "ChiếnBinh";
  let clockOffsetMs = 0;
  let retryAttempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let closedManually = false;

  const handlers = new Map();
  const statusListeners = new Set();

  function notifyStatus(state, detail) {
    for (const fn of statusListeners) fn(state, detail);
  }

  function persistToken(newTok) {
    token = newTok;
    try {
      sessionStorage.setItem(SESSION_TOKEN_KEY, newTok);
      const raw = localStorage.getItem(CLOSED_TOKEN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.token === newTok) localStorage.removeItem(CLOSED_TOKEN_KEY);
      }
    } catch {
      // Ignore storage failures
    }
  }

  // Allow reopening a closed tab within 30s to reclaim seat & match stats
  window.addEventListener("pagehide", () => {
    if (!token) return;
    try {
      localStorage.setItem(
        CLOSED_TOKEN_KEY,
        JSON.stringify({ token, closedAt: Date.now() }),
      );
    } catch {
      // Ignore storage failures
    }
  });

  function clearTimers() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function dispatch(msg) {
    if (msg.type === MSG.WELCOME) {
      connected = true;
      retryAttempt = 0;
      playerId = msg.playerId;
      playerName = msg.name;
      if (msg.token) persistToken(msg.token);
      notifyStatus("connected", msg.resumed ? "Đã khôi phục kết nối LAN" : "Đã kết nối LAN");
    } else if (msg.type === MSG.PONG && Number.isFinite(msg.serverTime)) {
      clockOffsetMs = msg.serverTime - Date.now();
    }

    const list = handlers.get(msg.type);
    if (list) {
      for (const fn of list) fn(msg);
    }
  }

  function scheduleReconnect() {
    if (closedManually || retryTimer) return;
    const delayMs = Math.min(4000, 900 + retryAttempt * 700);
    retryAttempt++;
    notifyStatus("reconnecting", `Mất kết nối — tự nối lại sau ${(delayMs / 1000).toFixed(1)}s...`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delayMs);
  }

  function connect() {
    if (!location.protocol.startsWith("http") || !location.host) {
      notifyStatus("offline", "Đang mở qua file:// — chỉ dùng được Luyện tập Offline (Drone).");
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    closedManually = false;
    clearTimers();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    notifyStatus("connecting", "Đang tự động kết nối LAN...");

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      const nick = typeof getNickFn === "function" ? getNickFn() : "ChiếnBinh";
      ws.send(JSON.stringify({ type: MSG.HELLO, name: nick, token }));
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: MSG.PING, t: Date.now() }));
        }
      }, 5000);
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === "string") dispatch(msg);
    };

    ws.onclose = () => {
      connected = false;
      clearTimers();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles reconnect cleanly
    };
  }

  return {
    connect,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    send(type, payload = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type, ...payload }));
      return true;
    },
    get playerId() {
      return playerId;
    },
    get playerName() {
      return playerName;
    },
    get connected() {
      return connected;
    },
    get clockOffsetMs() {
      return clockOffsetMs;
    },
  };
}
