/**
 * Pure network & environment helpers for Online / CDN + LAN hybrid deployment.
 * Dependency-free so both browser ES modules and Node.js unit tests can import directly.
 */

const IPV4_PRIVATE_RE =
  /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/;

/**
 * Validate and normalize an explicit WebSocket endpoint URL (`ws://` or `wss://` only).
 * Rejects credentials, non-WS schemes, and malformed strings.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeWsUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\s<>"'`]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    if (parsed.username || parsed.password || !parsed.host) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Resolve target WebSocket URL with priority:
 * 1. `<meta name="fps-ws-url" content="...">`
 * 2. `window.FPS_WS_URL`
 * 3. Same-origin `${ws|wss}://${location.host}/ws` fallback for LAN / monolithic Render
 * @param {{ metaUrl?: unknown, globalUrl?: unknown, loc?: { protocol?: string, host?: string } | null }} opts
 * @returns {string | null}
 */
export function resolveWsUrl({ metaUrl = "", globalUrl = "", loc = null } = {}) {
  const fromMeta = sanitizeWsUrl(metaUrl);
  if (fromMeta) return fromMeta;

  const fromGlobal = sanitizeWsUrl(globalUrl);
  if (fromGlobal) return fromGlobal;

  if (
    loc &&
    typeof loc.protocol === "string" &&
    loc.protocol.startsWith("http") &&
    typeof loc.host === "string" &&
    loc.host
  ) {
    const proto = loc.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${loc.host}/ws`;
  }
  return null;
}

/**
 * Compute server-client clock offset accounting for one-way network latency (`RTT / 2`),
 * with EMA smoothing to suppress jitter spikes on Wi-Fi/4G links.
 * @param {{
 *   clientSendMs: number,
 *   clientRecvMs: number,
 *   serverTimeMs: number,
 *   prevOffsetMs?: number,
 *   hasPrev?: boolean
 * }} params
 * @returns {{ offsetMs: number, rttMs: number } | null}
 */
export function computeClockOffsetWithRtt({
  clientSendMs,
  clientRecvMs,
  serverTimeMs,
  prevOffsetMs = 0,
  hasPrev = false,
} = {}) {
  if (!Number.isFinite(serverTimeMs) || !Number.isFinite(clientRecvMs)) return null;
  const hasValidSend = Number.isFinite(clientSendMs) && clientRecvMs >= clientSendMs;
  const rttMs = hasValidSend ? Math.min(5000, clientRecvMs - clientSendMs) : 0;
  const sampleOffset = serverTimeMs + rttMs * 0.5 - clientRecvMs;

  if (!hasPrev || !Number.isFinite(prevOffsetMs) || Math.abs(sampleOffset - prevOffsetMs) > 500) {
    return { offsetMs: Math.round(sampleOffset), rttMs: Math.round(rttMs) };
  }
  const smoothed = prevOffsetMs * 0.7 + sampleOffset * 0.3;
  return { offsetMs: Math.round(smoothed), rttMs: Math.round(rttMs) };
}

/**
 * Check whether a hostname belongs to localhost or RFC1918 LAN private ranges.
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isPrivateOrLocalHost(hostname) {
  if (typeof hostname !== "string") return false;
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".local")) return true;
  return IPV4_PRIVATE_RE.test(h);
}

/**
 * Build a clean public invite URL for online deployments (Cloudflare Pages / Render).
 * @param {{ protocol?: string, origin?: string, pathname?: string } | null} loc
 * @returns {string}
 */
export function resolveOnlineShareUrl(loc) {
  if (!loc || typeof loc.protocol !== "string" || !loc.protocol.startsWith("http")) return "";
  if (typeof loc.origin !== "string" || !loc.origin || loc.origin === "null") return "";
  const pathPart =
    typeof loc.pathname === "string" && loc.pathname && loc.pathname !== "/" && loc.pathname !== "/index.html"
      ? loc.pathname
      : "";
  return `${loc.origin}${pathPart}`;
}

