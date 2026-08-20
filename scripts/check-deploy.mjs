// Post-deploy smoke test. Run it against the deployed URL to answer the two
// questions Hostinger's docs do not: does the platform pass WebSocket upgrades
// through, and does the filesystem survive a redeploy?
//
//   node scripts/check-deploy.mjs https://your-app.hostingersite.com
//
// Exits non-zero if anything required for the arena to work is broken.
import crypto from "node:crypto";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node scripts/check-deploy.mjs https://your-app.hostingersite.com");
  process.exit(2);
}

const results = [];
function record(name, ok, detail, fatal = true) {
  results.push({ name, ok, detail, fatal });
  const mark = ok ? "PASS" : fatal ? "FAIL" : "WARN";
  console.log(`${mark.padEnd(5)} ${name.padEnd(34)} ${detail}`);
}

// ---------- HTTP ----------

async function head(path) {
  try {
    const res = await fetch(base + path, { redirect: "manual" });
    return res;
  } catch (err) {
    return { status: 0, error: err.message, headers: new Map() };
  }
}

console.log(`checking ${base}\n`);

const dash = await head("/arena3d/dashboard.html");
record("dashboard reachable", dash.status === 200, `HTTP ${dash.status}${dash.error ? " " + dash.error : ""}`);

const me = await head("/api/me");
let apiOk = false;
if (me.status === 200) {
  try {
    apiOk = Object.prototype.hasOwnProperty.call(await me.clone().json(), "player");
  } catch { /* not json */ }
}
record("API responding", apiOk, apiOk ? "/api/me returned a player field" : `HTTP ${me.status} (the Node app may not be running)`);

// Secrets and server sources must never be reachable.
const envLeak = await head("/.env");
record("/.env blocked", envLeak.status === 403 || envLeak.status === 404, `HTTP ${envLeak.status}`);
const srcLeak = await head("/server/store.mjs");
record("/server/* blocked", srcLeak.status === 403 || srcLeak.status === 404, `HTTP ${srcLeak.status}`);

// Caching: the character model is ~3.5MB and must not be refetched every load.
const glb = await head("/arena3d/assets/shooter_character.glb?a=2");
const cc = glb.headers.get?.("cache-control") || "";
record("model cached long-term", cc.includes("immutable"), cc || "(no cache-control header -- a CDN may be stripping it)");

// ---------- WebSocket ----------
// Done by hand rather than with a library: this repo has no runtime deps, and
// the raw handshake is exactly what tells us whether the platform's proxy
// forwards Upgrade at all -- the single most likely thing to be missing.

const wsResult = await new Promise((resolve) => {
  const url = new URL(base);
  const isTls = url.protocol === "https:";
  const port = url.port || (isTls ? 443 : 80);
  const key = crypto.randomBytes(16).toString("base64");
  const expect = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  const req =
    `GET /ws HTTP/1.1\r\nHost: ${url.hostname}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

  const connect = isTls ? import("node:tls") : import("node:net");
  connect.then((mod) => {
    const opts = isTls
      ? { host: url.hostname, port, servername: url.hostname }
      : { host: url.hostname, port };
    const socket = mod.connect(opts, () => socket.write(req));
    let buf = "";
    // end() then unref(), never destroy(): tearing the socket down hard and
    // then exiting trips a libuv assertion on Windows and returns a bogus
    // exit code even when every check passed.
    const done = (value) => {
      try { socket.end(); socket.unref(); } catch { /* already gone */ }
      resolve(value);
    };
    socket.setTimeout(10000, () => done({ ok: false, detail: "timed out waiting for the upgrade response" }));
    socket.on("error", (e) => done({ ok: false, detail: e.message }));
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      const status = buf.split("\r\n")[0];
      if (!/101/.test(status)) return done({ ok: false, detail: `${status.trim()} -- proxy is not forwarding the upgrade` });
      const accept = (buf.match(/sec-websocket-accept:\s*(\S+)/i) || [])[1];
      done(accept === expect
        ? { ok: true, detail: "upgrade accepted, handshake valid" }
        : { ok: false, detail: "101 received but Sec-WebSocket-Accept did not match" });
    });
  });
});
record("WebSocket upgrade (/ws)", wsResult.ok, wsResult.detail);

// ---------- persistence ----------
// Cannot be tested in one run; this just reports what the server sees so it can
// be compared before and after a redeploy.
const board = await head("/api/leaderboard");
let players = null;
if (board.status === 200) {
  try { players = (await board.json()).players?.length ?? null; } catch { /* ignore */ }
}
record(
  "player records present",
  players !== null,
  players === null
    ? "could not read /api/leaderboard"
    : `${players} player(s). Re-run this AFTER a redeploy: if this drops to 0, the filesystem is ephemeral -- set DATA_DIR to persistent storage or move to a VPS.`,
  false
);

const failed = results.filter((r) => !r.ok && r.fatal);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nBlocking issues:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  if (failed.some((f) => f.name.startsWith("WebSocket"))) {
    console.log("\n  Without WebSocket upgrades the arena still loads and plays offline");
    console.log("  against bots, but the lobby shows OFFLINE and no real multiplayer");
    console.log("  is possible. That is the case where a VPS is required instead.");
  }
}
// Set the code and let the event loop drain on its own -- calling
// process.exit() here races the socket teardown above.
process.exitCode = failed.length ? 1 : 0;
