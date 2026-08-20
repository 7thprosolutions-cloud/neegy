// Minimal RFC 6455 WebSocket server, attached to an existing node:http server.
//
// Written by hand rather than pulling in `ws` because this repo gitignores
// package.json -- npm state is not tracked, so a dependency is a deployment
// hazard here. We only need what a game client actually uses: the handshake,
// text frames (with fragmentation), ping/pong, and close. Binary frames are
// accepted and handed over as Buffers but the game protocol is JSON text.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// A frame's payload is capped so one bad/hostile client cannot make us buffer
// unbounded memory. Game messages are a few hundred bytes at most.
const MAX_PAYLOAD = 256 * 1024;

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.open = true;
    this.isAlive = true;

    this._buffer = Buffer.alloc(0);
    // set while a fragmented message is in flight
    this._fragmentOpcode = null;
    this._fragments = [];

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => {
      if (this.open) {
        this.open = false;
        this.emit("close");
      }
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // A single chunk can hold several frames, or a fraction of one.
    while (this.open) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  // Returns null when the buffer does not yet hold a complete frame.
  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, "message too big"); return null; }
      length = Number(big);
      offset += 8;
    }

    if (length > MAX_PAYLOAD) { this.close(1009, "message too big"); return null; }

    // Every client-to-server frame must be masked (RFC 6455 s5.1).
    if (!masked) { this.close(1002, "unmasked frame"); return null; }
    if (buf.length < offset + 4) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + length) return null;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];

    this._buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) return this.close();
    if (opcode === OP_PING) return this._send(OP_PONG, payload);
    if (opcode === OP_PONG) { this.isAlive = true; return; }

    if (opcode === OP_CONTINUATION) {
      if (this._fragmentOpcode === null) return this.close(1002, "unexpected continuation");
      this._fragments.push(payload);
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this._fragmentOpcode !== null) return this.close(1002, "interleaved fragments");
      if (!fin) { this._fragmentOpcode = opcode; this._fragments = [payload]; return; }
      return this._deliver(opcode, payload);
    } else {
      return this.close(1002, "bad opcode");
    }

    if (fin) {
      const complete = Buffer.concat(this._fragments);
      const op = this._fragmentOpcode;
      this._fragmentOpcode = null;
      this._fragments = [];
      this._deliver(op, complete);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_BINARY) return this.emit("binary", payload);
    this.emit("message", payload.toString("utf8"));
  }

  _send(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    // server-to-client frames are never masked
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.close();
    }
  }

  send(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    this._send(OP_TEXT, Buffer.from(text, "utf8"));
  }

  ping() {
    this._send(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    if (!this.open) return;
    this.open = false;
    try {
      const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      this._send(OP_CLOSE, body);
      this.socket.end();
    } catch {
      /* socket already gone */
    }
    this.emit("close");
  }
}

// Attaches to an http.Server. `onConnection(conn, request)` fires once the
// handshake completes. `shouldAccept(request)` may veto the upgrade.
export function attachWebSocketServer(httpServer, { path = "/ws", onConnection, heartbeatMs = 30000 } = {}) {
  const connections = new Set();

  httpServer.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== path) return socket.destroy();

    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      return socket.destroy();
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    // Game traffic is many small messages; Nagle would add latency for nothing.
    socket.setNoDelay(true);

    const conn = new WebSocketConnection(socket, req);
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    onConnection?.(conn, req);
  });

  // Drop connections that stopped answering pings, so rooms do not fill up
  // with ghosts from closed laptops and dead tabs.
  const timer = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) { conn.close(1001, "no heartbeat"); continue; }
      conn.isAlive = false;
      conn.ping();
    }
  }, heartbeatMs);
  timer.unref?.();

  return { connections };
}
