// Exercises the private-server and extra-life rules over a real WebSocket.
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 8320);
const SID = process.argv[3] || "";

function connect(cookie) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        (cookie ? `Cookie: neegy_sid=${cookie}\r\n` : "") +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let up = false, buf = Buffer.alloc(0);
    const log = [];
    const client = { log, send, socket };
    function send(o) {
      const p = Buffer.from(JSON.stringify(o), "utf8");
      const m = crypto.randomBytes(4);
      let h;
      if (p.length < 126) { h = Buffer.alloc(2); h[1] = 0x80 | p.length; }
      else { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
      h[0] = 0x81;
      const x = Buffer.alloc(p.length);
      for (let i = 0; i < p.length; i++) x[i] = p[i] ^ m[i & 3];
      socket.write(Buffer.concat([h, m, x]));
    }
    socket.on("data", (c) => {
      if (!up) {
        const t = c.toString("latin1");
        const end = t.indexOf("\r\n\r\n");
        if (end === -1) return;
        up = true;
        resolve(client);
        const rest = Buffer.from(t.slice(end + 4), "latin1");
        if (rest.length) { buf = rest; drain(); }
        return;
      }
      buf = Buffer.concat([buf, c]);
      drain();
    });
    function drain() {
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len).toString("utf8");
        buf = buf.subarray(off + len);
        try { log.push(JSON.parse(payload)); } catch { /* ignore */ }
      }
    }
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (c, t) => c.log.filter((m) => m.t === t).pop();
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail ?? ""}`);
}

// owner is signed in; friend is a guest
const owner = await connect(SID);
const friend = await connect("");
owner.send({ t: "hello", tabId: "owner" });
friend.send({ t: "hello", tabId: "friend" });
await wait(400);

const welcome = last(owner, "welcome");
check("welcome carries entitlements", welcome?.you?.entitlements?.extraLives === 10,
  `extraLives=${welcome?.you?.entitlements?.extraLives} privateGames=${welcome?.you?.entitlements?.privateGames}`);

// create a private room
owner.send({ t: "create", name: "Friends Only", mode: "1v1", password: "hunter2" });
await wait(400);
const roomId = last(owner, "joined")?.roomId;
const roomMsg = last(owner, "room")?.room;
check("private room created", Boolean(roomId), roomId?.slice(0, 14));
check("room is flagged private", roomMsg?.isPrivate === true, `isPrivate=${roomMsg?.isPrivate}`);

// the password must never be sent to clients
const anyPassword = JSON.stringify(owner.log).match(/hunter2/);
check("password never leaves the server", !anyPassword, anyPassword ? "LEAKED" : "not present in any message");

// wrong password is refused
friend.log.length = 0;
friend.send({ t: "join", roomId, password: "wrong" });
await wait(400);
check("wrong password refused", Boolean(last(friend, "error")), last(friend, "error")?.message);

// right password gets in
friend.log.length = 0;
friend.send({ t: "join", roomId, password: "hunter2" });
await wait(400);
check("correct password admitted", Boolean(last(friend, "joined")), last(friend, "joined")?.roomId?.slice(0, 14));

// starting the match spends a private-game credit
owner.log.length = 0;
owner.send({ t: "start" });
await wait(4200);
const started = last(owner, "start");
check("private match started", Boolean(started), started ? `owns ${started.owned?.length} slot(s)` : "no start message");

const meAfterStart = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("private game credit spent (5 -> 4)", meAfterStart.player.privateGames === 4, `privateGames=${meAfterStart.player.privateGames}`);

// kill the owner, then revive
const ownerEnt = started?.owned?.find((o) => !o.isBot)?.entityId;
friend.send({ t: "hit", target: ownerEnt, damage: 60 });
await wait(200);
friend.send({ t: "hit", target: ownerEnt, damage: 60 });
await wait(600);
check("owner died", Boolean(last(owner, "death")), `entity ${last(owner, "death")?.id?.slice(0, 12)}`);

owner.log.length = 0;
owner.send({ t: "revive" });
await wait(600);
const revived = last(owner, "revived");
check("revive brings them back", revived?.hp === 100, revived ? `hp=${revived.hp}` : last(owner, "error")?.message);

const meAfterRevive = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("extra life spent (10 -> 9)", meAfterRevive.player.extraLives === 9, `extraLives=${meAfterRevive.player.extraLives}`);

// a second revive in the same match must be refused
owner.log.length = 0;
owner.send({ t: "revive" });
await wait(500);
check("second revive in one match refused", Boolean(last(owner, "error")), last(owner, "error")?.message);

const meFinal = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("refused revive did not charge", meFinal.player.extraLives === 9, `extraLives=${meFinal.player.extraLives}`);

owner.socket.destroy();
friend.socket.destroy();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
