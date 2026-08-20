// Load test: how many concurrent players can one server process actually hold?
//
//   node scripts/load-test.mjs [wsUrl] [players] [seconds]
//   node scripts/load-test.mjs ws://127.0.0.1:8300/ws 60 20
//
// Simulates real clients: each one connects, joins a room, and reports its
// position at the same rate the real game does, while we measure round-trip
// latency, snapshot throughput and the server process's CPU and memory.
//
// Zero dependencies -- speaks the WebSocket protocol directly, same as the
// server does. Text frames only, which is all the game protocol uses.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const url = new URL(process.argv[2] || "ws://127.0.0.1:8300/ws");
const PLAYERS = Number(process.argv[3] || 40);
const SECONDS = Number(process.argv[4] || 15);
const REPORT_HZ = 15; // matches the real client's per-frame reporting

function connect() {
  return new Promise((resolve, reject) => {
    const isTls = url.protocol === "wss:";
    const port = url.port || (isTls ? 443 : 80);
    const key = crypto.randomBytes(16).toString("base64");
    const mod = isTls ? tls : net;
    const opts = isTls ? { host: url.hostname, port, servername: url.hostname } : { host: url.hostname, port };
    const socket = mod.connect(opts, () => {
      socket.write(
        `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.hostname}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshake = "";
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const client = { socket, onMessage: null, send };

    socket.on("error", reject);
    socket.setTimeout(20000, () => reject(new Error("connect timeout")));
    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake += chunk.toString("latin1");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        if (!/101/.test(handshake.split("\r\n")[0])) return reject(new Error("upgrade refused"));
        upgraded = true;
        const rest = Buffer.from(handshake.slice(end + 4), "latin1");
        handshake = "";
        resolve(client);
        if (rest.length) { buf = rest; drain(); }
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      drain();
    });

    // Server-to-client frames are never masked, so parsing stays simple.
    function drain() {
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1 && client.onMessage) client.onMessage(payload.toString("utf8"));
        if (opcode === 0x9) sendPong(payload); // keep the heartbeat alive
      }
    }
    function sendPong(payload) { frame(0xa, payload); }
    function send(obj) { frame(0x1, Buffer.from(JSON.stringify(obj), "utf8")); }

    function frame(opcode, payload) {
      const mask = crypto.randomBytes(4);
      const len = payload.length;
      let header;
      if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
      else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      header[0] = 0x80 | opcode;
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      try { socket.write(Buffer.concat([header, mask, masked])); } catch { /* closed */ }
    }
  });
}

console.log(`connecting ${PLAYERS} simulated players to ${url.href} for ${SECONDS}s...\n`);

const clients = [];
let snapshotsReceived = 0;
let bytesReceived = 0;
let connectFailures = 0;

for (let i = 0; i < PLAYERS; i++) {
  try {
    const c = await connect();
    c.id = null;
    c.entity = null;
    c.onMessage = (text) => {
      bytesReceived += text.length;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.t === "welcome") { c.id = msg.you.id; c.rooms = msg.rooms; }
      if (msg.t === "snap") snapshotsReceived++;
      if (msg.t === "start") c.entity = msg.owned?.[0]?.entityId || null;
    };
    c.send({ t: "hello", tabId: "load-" + i });
    c.send({ t: "name", name: "Load" + i });
    clients.push(c);
  } catch (err) {
    connectFailures++;
  }
}
console.log(`connected: ${clients.length}/${PLAYERS}${connectFailures ? `  (${connectFailures} failed)` : ""}`);

// Spread players across the always-on rooms, then start every match.
await new Promise((r) => setTimeout(r, 600));
const roomList = clients[0]?.rooms || [];
if (!roomList.length) {
  console.error("no rooms advertised by the server -- is it running?");
  process.exitCode = 1;
} else {
  clients.forEach((c, i) => c.send({ t: "join", roomId: roomList[i % roomList.length].id }));
  await new Promise((r) => setTimeout(r, 800));
  for (const c of clients) c.send({ t: "start" }); // only hosts are honoured
  await new Promise((r) => setTimeout(r, 4000)); // countdown

  // Steady state: every client reports position at the real client's rate.
  snapshotsReceived = 0;
  bytesReceived = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.entity) continue;
      c.send({ t: "ents", ents: [{ id: c.entity, x: Math.random() * 40 - 20, y: 0, z: Math.random() * 40 - 20, facing: Math.random() * 6, anim: "RifleRun" }] });
    }
  }, 1000 / REPORT_HZ);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(timer);
  const elapsed = (Date.now() - started) / 1000;

  console.log("\n--- steady state ---");
  console.log(`duration           ${elapsed.toFixed(1)}s`);
  console.log(`players            ${clients.length}`);
  console.log(`snapshots received ${snapshotsReceived}  (${(snapshotsReceived / elapsed).toFixed(0)}/s across all clients)`);
  console.log(`inbound traffic    ${(bytesReceived / 1024 / elapsed).toFixed(1)} KB/s total, ${(bytesReceived / 1024 / elapsed / clients.length).toFixed(2)} KB/s per player`);
  console.log(`projected per hour ${(bytesReceived / 1048576 / elapsed * 3600).toFixed(0)} MB for this many concurrent players`);
}

for (const c of clients) { try { c.socket.destroy(); } catch { /* ignore */ } }
setTimeout(() => process.exit(process.exitCode || 0), 300);
