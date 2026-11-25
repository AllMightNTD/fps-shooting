/**
 * Zero-dependency RFC 6455 WebSocket handshake, framing codec, and flood guard.
 */

import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export function computeAcceptKey(key) {
  return crypto.createHash("sha1").update(String(key).trim() + WS_GUID).digest("base64");
}

export function encodeWsFrame(opcode, payload = Buffer.alloc(0)) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

export function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  if ((b0 & 0x70) !== 0) throw new Error("Unsupported WebSocket RSV bits");

  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const bigLen = buf.readBigUInt64BE(offset);
    if (bigLen > BigInt(MAX_WS_PAYLOAD_BYTES)) {
      throw new Error("WebSocket frame exceeds max payload limit");
    }
    len = Number(bigLen);
    offset += 8;
  }

  if (len > MAX_WS_PAYLOAD_BYTES) {
    throw new Error("WebSocket frame exceeds max payload limit");
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;

  let payload;
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      payload[i] = buf[offset + i] ^ mask[i & 3];
    }
  } else {
    payload = Buffer.from(buf.subarray(offset, offset + len));
  }

  return {
    frame: { fin, opcode, masked, payload },
    bytesConsumed: offset + len,
  };
}

export class WsConnection {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.fragOpcode = null;
    this.fragChunks = [];
    this.fragBytes = 0;
    this.handlers = { message: [], close: [], pong: [] };
    this.msgWindowStart = Date.now();
    this.msgCount = 0;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._emitClose(1006, "Socket closed"));
    socket.on("error", () => this._emitClose(1006, "Socket error"));

    if (this.buffer.length > 0) {
      queueMicrotask(() => this._drainBuffer());
    }
  }

  on(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  }

  sendText(text) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeWsFrame(OP_TEXT, text));
    return true;
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  sendPing(data = Buffer.from("ka")) {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeWsFrame(OP_PING, data));
    return true;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.socket.destroyed) {
        const reasonBuf = Buffer.from(String(reason).slice(0, 64), "utf8");
        const body = Buffer.allocUnsafe(2 + reasonBuf.length);
        body.writeUInt16BE(code, 0);
        reasonBuf.copy(body, 2);
        this.socket.end(encodeWsFrame(OP_CLOSE, body));
      }
    } catch {
      // Ignore write failures during socket teardown
    }
    this._emitClose(code, reason);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_WS_PAYLOAD_BYTES * 2) {
      this.close(1009, "Buffer overflow");
      return;
    }
    this._drainBuffer();
  }

  _drainBuffer() {
    while (!this.closed && this.buffer.length >= 2) {
      let decoded;
      try {
        decoded = decodeWsFrame(this.buffer);
      } catch {
        this.close(1009, "Protocol error");
        return;
      }
      if (!decoded) break;

      this.buffer = this.buffer.subarray(decoded.bytesConsumed);
      const { fin, opcode, payload } = decoded.frame;

      if (opcode === OP_CLOSE) {
        this.close(1000, "Client closed");
        return;
      }
      if (opcode === OP_PING) {
        if (!this.socket.destroyed) this.socket.write(encodeWsFrame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_PONG) {
        for (const fn of this.handlers.pong) fn();
        continue;
      }

      if (opcode === OP_TEXT) {
        if (fin) {
          this._emitMessage(payload.toString("utf8"));
        } else {
          this.fragOpcode = OP_TEXT;
          this.fragChunks = [payload];
          this.fragBytes = payload.length;
        }
        continue;
      }

      if (opcode === OP_CONT && this.fragOpcode === OP_TEXT) {
        this.fragBytes += payload.length;
        if (this.fragBytes > MAX_WS_PAYLOAD_BYTES) {
          this.close(1009, "Fragmented message too large");
          return;
        }
        this.fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragChunks).toString("utf8");
          this.fragOpcode = null;
          this.fragChunks = [];
          this.fragBytes = 0;
          this._emitMessage(full);
        }
      }
    }
  }

  _emitMessage(text) {
    const now = Date.now();
    if (now - this.msgWindowStart >= 1000) {
      this.msgWindowStart = now;
      this.msgCount = 0;
    }
    this.msgCount++;
    if (this.msgCount > 160) {
      // Drop excessive message flood per second cleanly
      return;
    }
    for (const fn of this.handlers.message) fn(text);
  }

  _emitClose(code, reason) {
    if (!this.closed) this.closed = true;
    const fns = this.handlers.close.splice(0);
    for (const fn of fns) fn(code, reason);
  }
}

export function upgradeHttpToWs(req, socket, head) {
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  const key = req.headers["sec-websocket-key"];
  if (upgrade !== "websocket" || !key || typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = computeAcceptKey(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket, head);
}

