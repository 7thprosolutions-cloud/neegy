// Exercises the private-server and extra-life rules over a real WebSocket.
//
// Needs a running server and the session id of a signed-in player who holds
// exactly 10 extra lives and an ACTIVE private-server pass -- the balance
// assertions are absolute, so this runs against a fresh fixture, not live data.
// `privateUntil` is a millisecond timestamp; set it a day ahead:
//
//   mkdir -p /tmp/neegy-test
//   node -e "const fs=require('fs'),n=Date.now();fs.writeFileSync('/tmp/neegy-test/players.json',JSON.stringify({'x:999000111':{id:'x:999000111',xUserId:'999000111',handle:'testowner',name:'Test Owner',avatar:null,kills:0,deaths:0,xp:0,gamesPlayed:0,extraLives:10,privateUntil:n+86400000,createdAt:n,lastSeen:n}}));fs.writeFileSync('/tmp/neegy-test/sessions.json',JSON.stringify({testsid:{playerId:'x:999000111',createdAt:n}}))"
//   PORT=8331 DATA_DIR=/tmp/neegy-test node server/server.mjs &
//   node scripts/test-upgrades.mjs 8331 testsid
//
// Re-running spends extra lives, so reset players.json between runs.
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
  `extraLives=${welcome?.you?.entitlements?.extraLives} privateActive=${welcome?.you?.entitlements?.privateActive}`);
check("welcome reports an active pass", welcome?.you?.entitlements?.privateActive === true,
  `${((welcome?.you?.entitlements?.privateMsLeft || 0) / 3600000).toFixed(1)}h left`);

// A guest cannot open a private server at all -- it is charged to an account,
// so there has to be an account.
friend.log.length = 0;
friend.send({ t: "create", name: "Guest Private", mode: "1v1", private: true });
await wait(400);
check("guest cannot open a private server", Boolean(last(friend, "error")), last(friend, "error")?.message);

// create a private room -- the password is generated, not chosen
owner.send({ t: "create", name: "Friends Only", mode: "1v1", private: true });
await wait(400);
const joined = last(owner, "joined");
const roomId = joined?.roomId;
const password = joined?.password;
const roomMsg = last(owner, "room")?.room;
check("private room created", Boolean(roomId), roomId?.slice(0, 14));
check("room is flagged private", roomMsg?.isPrivate === true, `isPrivate=${roomMsg?.isPrivate}`);
check("a password was generated for the host", /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(password || ""), password);
check("generated password avoids look-alike glyphs", !/[01OIL]/.test(password || ""), password);

// The room summary that every client sees must never carry it.
check("password absent from the room summary", !JSON.stringify(roomMsg).includes(password), "not in room state");

// wrong password is refused
friend.log.length = 0;
friend.send({ t: "join", roomId, password: "WRONG-CODE" });
await wait(400);
check("wrong password refused", Boolean(last(friend, "error")), last(friend, "error")?.message);

// and nobody but the host ever sees the real one
check("password never reaches other players", !JSON.stringify(friend.log).includes(password),
  "not in anything the guest received");

// right password gets in
friend.log.length = 0;
friend.send({ t: "join", roomId, password });
await wait(400);
check("correct password admitted", Boolean(last(friend, "joined")), last(friend, "joined")?.roomId?.slice(0, 14));

// starting the match spends a private-game credit
owner.log.length = 0;
owner.send({ t: "start" });
await wait(4200);
const started = last(owner, "start");
check("private match started", Boolean(started), started ? `owns ${started.owned?.length} slot(s)` : "no start message");

const meAfterStart = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
// A pass is a window, not a stock: playing does not draw it down.
check("the 24h pass is not consumed by playing", meAfterStart.player.privateActive === true,
  `${(meAfterStart.player.privateMsLeft / 3600000).toFixed(1)}h left`);

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

// ---------- the revive window ----------
//
// A death that wipes a team used to end the match on the very next tick, which
// left no instant in which an extra life could be spent -- the paid item was
// unusable in 1v1 and only accidentally usable in team modes. The result is
// now held open briefly, but only for a side that actually has a spendable
// life, so these two cases pull in opposite directions and both matter.

// 1. Two guests, no entitlements: must still be called immediately.
const g1 = await connect("");
const g2 = await connect("");
g1.send({ t: "hello", tabId: "pub-1" });
g2.send({ t: "hello", tabId: "pub-2" });
await wait(400);
g1.send({ t: "create", name: "Public Duel", mode: "1v1" });
await wait(300);
const pubId = last(g1, "joined")?.roomId;
g2.send({ t: "join", roomId: pubId });
await wait(300);
g1.send({ t: "start" });
await wait(4200);
const pubEnt = last(g1, "start")?.owned?.find((o) => !o.isBot)?.entityId;
g2.send({ t: "hit", target: pubEnt, damage: 60 });
await wait(200);
const pubT0 = Date.now();
g2.send({ t: "hit", target: pubEnt, damage: 60 });
let pubOverMs = -1;
for (let i = 0; i < 60; i++) {
  await wait(50);
  if (last(g1, "over")) { pubOverMs = Date.now() - pubT0; break; }
}
check("ordinary match still ends at once", pubOverMs >= 0 && pubOverMs < 1000, `called after ${pubOverMs}ms`);
check("no window offered to players without lives", !last(g1, "reviveWindow"), "none offered");
g1.socket.destroy();
g2.socket.destroy();

// 2. An eligible player who declines: the window must expire on its own rather
//    than waiting forever for a revive that never comes, and charge nothing.
const decliner = await connect(SID);
const foe = await connect("");
decliner.send({ t: "hello", tabId: "exp-1" });
foe.send({ t: "hello", tabId: "exp-2" });
await wait(400);
const livesBefore = last(decliner, "welcome")?.you?.entitlements?.extraLives;
decliner.send({ t: "create", name: "Expiry Test", mode: "1v1" });
await wait(300);
foe.send({ t: "join", roomId: last(decliner, "joined")?.roomId });
await wait(300);
decliner.send({ t: "start" });
await wait(4200);
const decEnt = last(decliner, "start")?.owned?.find((o) => !o.isBot)?.entityId;
foe.send({ t: "hit", target: decEnt, damage: 60 });
await wait(200);
const decT0 = Date.now();
foe.send({ t: "hit", target: decEnt, damage: 60 });
let windowMs = -1, decOverMs = -1;
for (let i = 0; i < 300; i++) {
  await wait(50);
  if (windowMs < 0 && last(decliner, "reviveWindow")) windowMs = Date.now() - decT0;
  if (last(decliner, "over")) { decOverMs = Date.now() - decT0; break; }
}
check("window offered to a player holding lives", windowMs >= 0, `after ${windowMs}ms`);
check("window expires without a revive", decOverMs > 6000 && decOverMs < 9000, `called after ${decOverMs}ms`);
const meDeclined = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("declining the window costs nothing", meDeclined.player.extraLives === livesBefore, `extraLives=${meDeclined.player.extraLives}`);
decliner.socket.destroy();
foe.socket.destroy();

// ---------- spending a life while still standing ----------
//
// The route players actually aim for: you watch the bar go red and press the
// button before anything kills you. The death window above is only the safety
// net for a burst that gave you no such moment.

const stander = await connect(SID);
const shooter = await connect("");
stander.send({ t: "hello", tabId: "refill-1" });
shooter.send({ t: "hello", tabId: "refill-2" });
await wait(400);
const livesAtStart = last(stander, "welcome")?.you?.entitlements?.extraLives;
check("welcome carries the low-health threshold", last(stander, "welcome")?.lowHealth === 50,
  `lowHealth=${last(stander, "welcome")?.lowHealth}`);

// 3v3 on purpose: in a 1v1 this death would wipe the team and end the match,
// and the last check below would be answered by "the match is not running"
// instead of by the rule it is meant to prove. The empty slots become bots the
// host simulates, which keeps the team alive.
stander.send({ t: "create", name: "Refill Test", mode: "3v3" });
await wait(300);
shooter.send({ t: "join", roomId: last(stander, "joined")?.roomId });
await wait(300);
stander.send({ t: "start" });
await wait(4200);
const standEnt = last(stander, "start")?.owned?.find((o) => !o.isBot)?.entityId;

// At full health the spend must be refused -- otherwise a stray click burns a
// paid item for nothing.
stander.log.length = 0;
stander.send({ t: "revive" });
await wait(500);
check("refused at full health", Boolean(last(stander, "error")), last(stander, "error")?.message);
const meFull = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("refusal at full health charged nothing", meFull.player.extraLives === livesAtStart, `extraLives=${meFull.player.extraLives}`);

// Now take real damage, down to at-or-below the threshold but still alive.
shooter.send({ t: "hit", target: standEnt, damage: 60 });
await wait(500);
const hurt = last(stander, "damage");
check("hurt but alive", hurt?.hp === 40 && !last(stander, "death"), `hp=${hurt?.hp}`);

stander.log.length = 0;
stander.send({ t: "revive" });
await wait(600);
const refilled = last(stander, "revived");
check("refill while standing works", refilled?.hp === 100, refilled ? `hp=${refilled.hp}` : last(stander, "error")?.message);
check("refill is flagged as not-a-death", refilled?.wasDead === false, `wasDead=${refilled?.wasDead}`);

const meRefilled = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("refill spent one life", meRefilled.player.extraLives === livesAtStart - 1, `extraLives=${meRefilled.player.extraLives}`);

// The one-per-match limit is shared between the two routes: having refilled,
// dying must not then also offer a revive.
shooter.send({ t: "hit", target: standEnt, damage: 60 });
await wait(250);
shooter.send({ t: "hit", target: standEnt, damage: 60 });
await wait(600);
stander.log.length = 0;
stander.send({ t: "revive" });
await wait(500);
const sharedError = last(stander, "error")?.message || "";
check("refill and revive share one allowance", /already used an extra life/i.test(sharedError), sharedError);
const meAfter = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { Cookie: `neegy_sid=${SID}` } }).then((r) => r.json());
check("the refused second spend charged nothing", meAfter.player.extraLives === livesAtStart - 1, `extraLives=${meAfter.player.extraLives}`);
stander.socket.destroy();
shooter.socket.destroy();

owner.socket.destroy();
friend.socket.destroy();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
