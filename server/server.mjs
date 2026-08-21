// Neegy dev/hobby backend: serves the static site AND the auth + player API
// from a single origin. Single-origin matters -- it means no CORS setup and,
// more importantly, the session cookie is first-party, so it survives browser
// tracking protection that would drop a cross-site cookie.
//
// Replaces `npx serve` for local work. Run: node server/server.mjs
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadEnv, ROOT } from "./env.mjs";
import { beginLogin, completeLogin } from "./xauth.mjs";
import {
  upsertPlayer, recordMatch, leaderboard,
  createSession, sessionPlayer, destroySession, describeStorage,
  sweepSessions, flushNow, grantEntitlement, ENTITLEMENTS, findPlayerByHandle,
  getPayment, paymentsForPlayer,
} from "./store.mjs";
import { attachGameServer } from "./gameserver.mjs";
import {
  configurePayments, paymentConfig, productCatalog, startPayment, checkPayment,
  startPaymentSweep, buildWalletTransaction,
} from "./payments.mjs";

const env = loadEnv();
// Lets a health check tell "still the process I looked at" from "quietly
// restarted between my two requests", which is exactly the question when
// records go missing.
const STARTED_AT = Date.now();
// How many times we have lost the race for the port to an outgoing instance.
let portRetries = 0;
// Which port to listen on, and it is worth spelling out why this is not just
// `env.PORT`.
//
// A managed host runs a reverse proxy in front of this process and forwards to
// a port it decides. If the app listens somewhere else, the proxy has nothing
// to talk to and every request is a 503 -- while the app's own logs show a
// perfectly healthy startup, because from in here nothing is wrong. That is a
// genuinely confusing failure, and it happened: editing environment variables
// in the panel dropped the platform-injected PORT, the app fell back to its
// development default, and the site went dark with clean logs.
//
// So: accept the usual spellings rather than only one, and if none is present
// say so at startup instead of silently using a number that only makes sense
// on a laptop.
const PORT_SOURCE = ["PORT", "APP_PORT", "SERVER_PORT", "NODE_PORT", "HTTP_PORT"]
  .find((name) => env[name] && Number(env[name]) > 0);
const PORT = Number(PORT_SOURCE ? env[PORT_SOURCE] : 5174);
// Behind a reverse proxy on a VPS you usually want to bind loopback only and
// let the proxy face the internet; 0.0.0.0 is right when this IS the edge.
const HOST = env.HOST || "0.0.0.0";
const COOKIE = "neegy_sid";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendHtml(res, status, body, headers = {}) {
  send(res, status, body, { "Content-Type": "text/html; charset=utf-8", ...headers });
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8", ...headers,
  });
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(sid, secure) {
  // HttpOnly so page scripts (and any XSS) cannot read the session id;
  // SameSite=Lax so the cookie still rides along on X's redirect back to us.
  const parts = [
    COOKIE + "=" + sid, "Path=/", "HttpOnly", "SameSite=Lax",
    "Max-Age=" + 30 * 24 * 60 * 60,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function currentPlayer(req) {
  return sessionPlayer(readCookie(req, COOKIE));
}

function publicPlayer(p) {
  if (!p) return null;
  const { id, handle, name, avatar, kills, deaths, xp, gamesPlayed } = p;
  const privateUntil = p.privateUntil || 0;
  return {
    id, handle, name, avatar, kills, deaths, xp, gamesPlayed,
    extraLives: p.extraLives || 0,
    privateUntil,
    privateActive: privateUntil > Date.now(),
    // Sent as a duration as well as a deadline, so the page never has to trust
    // the device clock to work out whether a pass is still good.
    privateMsLeft: Math.max(0, privateUntil - Date.now()),
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// A tiny self-contained page, used for the PIN flow and for auth errors.
function page(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{background:#0b0d12;color:#e8ecf4;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;
       display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:24px}
  .card{max-width:460px;width:100%;background:#141822;border:1px solid #232a38;border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#9aa6bd;margin:0 0 16px}
  a.btn,button{display:inline-block;background:#1d9bf0;color:#fff;border:0;border-radius:999px;
       padding:11px 22px;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none}
  input{width:100%;box-sizing:border-box;background:#0b0d12;border:1px solid #2c3546;color:#e8ecf4;
       border-radius:10px;padding:11px 14px;font-size:16px;margin-bottom:14px}
  code{background:#0b0d12;padding:2px 6px;border-radius:5px;color:#ffd479}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === "/auth/x/login" && req.method === "GET") {
    // X matches callback URLs byte for byte, so this must be derived, not
    // guessed. url.protocol is unreliable behind a proxy -- the URL is built
    // from a hardcoded http:// base below, and whether it ends up https
    // depends on whether the proxy happens to send an absolute request URI.
    // X-Forwarded-Proto is what the proxy actually tells us, and it is the
    // same signal the Secure cookie already trusts.
    const scheme = req.headers["x-forwarded-proto"] || url.protocol.replace(":", "");
    const callback = `${scheme}://${url.host}/auth/x/callback`;
    let started;
    try {
      started = await beginLogin(env, callback);
    } catch (err) {
      // Error 415 is by far the most likely failure here and the raw message
      // ("Callback URL not approved for this client application") does not say
      // which URL, so it reads as unfixable. It is: X matches callbacks
      // exactly, and this server sends whichever host it is being served from.
      // Every origin the site runs on needs its own entry.
      if (/code="415"/.test(err.message) || /Callback URL not approved/i.test(err.message)) {
        return sendHtml(res, 502, page("Sign-in not configured", `
          <h1>X sign-in needs this address approved</h1>
          <p>X only accepts callback URLs that are registered exactly. This site is running on
             <code>${escapeHtml(url.host)}</code>, so add this to the X developer portal under
             <strong>User authentication settings &rarr; Callback URI</strong>:</p>
          <p><code>${escapeHtml(callback)}</code></p>
          <p style="font-size:13px">You can register more than one — keep every domain the site
             runs on (temporary host and live domain) so switching between them never breaks sign-in.</p>
          <a class="btn" href="/arena3d/dashboard.html">Play as a guest instead</a>`));
      }
      return sendHtml(res, 502, page("Login failed", `<h1>Could not start X login</h1>
        <p>${escapeHtml(err.message)}</p>
        <a class="btn" href="/arena3d/dashboard.html">Back to dashboard</a>`));
    }

    if (started.mode === "redirect") {
      return send(res, 302, "", { Location: started.authorizeUrl });
    }

    // PIN mode: the X app is registered as desktop/native, so X will not
    // redirect back to us. Open the approve page, take the PIN by hand.
    return sendHtml(res, 200, page("Sign in with X", `
      <h1>Sign in with X</h1>
      <p>This X app is registered as a <strong>desktop app</strong>, so X shows a PIN
         instead of redirecting back. Approve access, then paste the PIN here.</p>
      <p><a class="btn" href="${escapeHtml(started.authorizeUrl)}" target="_blank" rel="noopener">Open X to approve</a></p>
      <form method="POST" action="/auth/x/pin" style="margin-top:22px">
        <input type="hidden" name="oauth_token" value="${escapeHtml(started.requestToken)}">
        <input name="pin" inputmode="numeric" autocomplete="off" placeholder="PIN from X" required>
        <button type="submit">Finish sign in</button>
      </form>
      <p style="margin-top:18px;font-size:13px">To get the normal one-click redirect instead, set the app
         type to <code>Web App</code> and add <code>${escapeHtml(callback)}</code> as a Callback URI
         in the X developer portal.</p>`));
  }

  if (p === "/auth/x/callback" && req.method === "GET") {
    if (url.searchParams.get("denied")) {
      return send(res, 302, "", { Location: "/arena3d/dashboard.html?auth=denied" });
    }
    return finishLogin(req, res, url.searchParams.get("oauth_token"), url.searchParams.get("oauth_verifier"));
  }

  if (p === "/auth/x/pin" && req.method === "POST") {
    const body = new URLSearchParams(await readBody(req));
    return finishLogin(req, res, body.get("oauth_token"), (body.get("pin") || "").trim());
  }

  if (p === "/api/me" && req.method === "GET") {
    return sendJson(res, 200, { player: publicPlayer(currentPlayer(req)) });
  }

  if (p === "/api/logout" && req.method === "POST") {
    destroySession(readCookie(req, COOKIE));
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    });
  }

  // Grant entitlements without a payment. This is how the features get tested
  // and how a botched purchase gets made right by hand -- on-chain payments
  // cannot be reversed, so there has to be a way to credit someone directly.
  //
  // Refuses to run unless ADMIN_TOKEN is set, so an unconfigured deployment
  // cannot be handed free upgrades by anyone who guesses the path.
  if (p === "/api/admin/grant" && req.method === "POST") {
    const expected = env.ADMIN_TOKEN;
    if (!expected) return sendJson(res, 404, { error: "not enabled" });
    const supplied = req.headers["x-admin-token"] || "";
    const a = Buffer.from(String(supplied));
    const b = Buffer.from(String(expected));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return sendJson(res, 403, { error: "bad admin token" });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    const { handle, kind, quantity } = body || {};
    if (!ENTITLEMENTS[kind]) {
      return sendJson(res, 400, { error: "kind must be one of: " + Object.keys(ENTITLEMENTS).join(", ") });
    }
    const target = findPlayerByHandle(handle);
    if (!target) {
      return sendJson(res, 404, { error: `no player with handle "${handle}" -- they must sign in with X once first` });
    }
    const qty = quantity === undefined ? ENTITLEMENTS[kind].perPurchase : quantity;
    const updated = grantEntitlement(target.id, kind, qty);
    console.log(`[admin] granted ${qty} ${kind} to @${target.handle}`);
    return sendJson(res, 200, { player: publicPlayer(updated) });
  }

  // ---------- payments ----------

  if (p === "/api/pay/config" && req.method === "GET") {
    const cfg = paymentConfig();
    return sendJson(res, 200, {
      enabled: cfg.enabled,
      cluster: cfg.cluster,
      // The address is public by definition -- it is where the money goes, and
      // the payer needs it to send anything at all.
      recipient: cfg.enabled ? cfg.treasury : null,
      // So the page can say plainly that no real money is involved yet.
      live: cfg.cluster === "mainnet-beta",
      products: productCatalog(),
    });
  }

  if (p === "/api/pay/start" && req.method === "POST") {
    const me = currentPlayer(req);
    // Payment has to be tied to an identity, or there is nobody to credit.
    if (!me) return sendJson(res, 401, { error: "Sign in with X before buying." });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    try {
      return sendJson(res, 200, { invoice: startPayment(me.id, body?.product) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (p === "/api/pay/status" && req.method === "GET") {
    const me = currentPlayer(req);
    if (!me) return sendJson(res, 401, { error: "not signed in" });
    const reference = url.searchParams.get("reference") || "";
    const record = getPayment(reference);
    // Someone else's invoice is none of your business, and saying "not found"
    // for both cases means the endpoint cannot be used to probe for live
    // references belonging to other players.
    if (!record || record.playerId !== me.id) {
      return sendJson(res, 404, { error: "no such payment" });
    }
    // Ask the chain on demand as well as on the sweep, so a player watching
    // the screen sees it land in a second or two rather than up to twenty.
    const checked = record.status === "pending" ? await checkPayment(reference) : record;
    return sendJson(res, 200, {
      status: checked.status,
      signature: checked.signature,
      cluster: checked.cluster,
      product: checked.product,
      expiresAt: checked.expiresAt,
      player: publicPlayer(currentPlayer(req)),
    });
  }

  // Hands a browser wallet an UNSIGNED transaction to sign. The server holds no
  // key and signs nothing; this only assembles bytes.
  if (p === "/api/pay/tx" && req.method === "POST") {
    const me = currentPlayer(req);
    if (!me) return sendJson(res, 401, { error: "not signed in" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    const record = getPayment(body?.reference || "");
    if (!record || record.playerId !== me.id) return sendJson(res, 404, { error: "no such payment" });
    try {
      return sendJson(res, 200, await buildWalletTransaction(record.reference, String(body?.payer || "")));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (p === "/api/pay/history" && req.method === "GET") {
    const me = currentPlayer(req);
    if (!me) return sendJson(res, 401, { error: "not signed in" });
    return sendJson(res, 200, {
      payments: paymentsForPlayer(me.id).map(({ reference, product, status, signature, createdAt, cluster }) => ({
        reference, product, status, signature, createdAt, cluster,
      })),
    });
  }

  // A one-glance answer to "is the box still holding what it should?". Counts
  // and flags only -- never the path, which would tell the internet where the
  // records live for nothing in return.
  //
  // `storageWritable: false` is the one that matters and the reason this
  // exists: a managed host that deploys into a fresh directory, or a DATA_DIR
  // left pointing at a renamed folder, loses every record on each restart.
  // Kills and XP surviving is nice; payments.json surviving is the difference
  // between honouring a payment and having no evidence it happened.
  if (p === "/api/health" && req.method === "GET") {
    const store = describeStorage();
    const cfg = paymentConfig();
    return sendJson(res, 200, {
      ok: true,
      storageWritable: store.writable,
      storageConfigured: store.configured,
      players: store.players,
      sessions: store.sessions,
      payments: store.payments,
      paymentsEnabled: cfg.enabled,
      cluster: cfg.cluster,
      realMoney: cfg.cluster === "mainnet-beta",
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    });
  }

  if (p === "/api/leaderboard" && req.method === "GET") {
    return sendJson(res, 200, { players: leaderboard(20) });
  }

  if (p === "/api/match-result" && req.method === "POST") {
    const me = currentPlayer(req);
    if (!me) return sendJson(res, 401, { error: "not signed in" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON" });
    }
    return sendJson(res, 200, { player: publicPlayer(recordMatch(me.id, body)) });
  }

  return null; // not an API route -- fall through to static files
}

async function finishLogin(req, res, requestToken, verifier) {
  if (!requestToken || !verifier) {
    return sendHtml(res, 400, page("Login failed", `<h1>Missing login details</h1>
      <p>No token or verifier came back from X.</p>
      <a class="btn" href="/auth/x/login">Try again</a>`));
  }
  try {
    const profile = await completeLogin(env, requestToken, verifier);
    const player = upsertPlayer(profile);
    const sid = createSession(player.id);
    return send(res, 302, "", {
      Location: "/arena3d/dashboard.html?auth=ok",
      "Set-Cookie": sessionCookie(sid, isSecure(req)),
    });
  } catch (err) {
    return sendHtml(res, 502, page("Login failed", `<h1>X sign-in failed</h1>
      <p>${escapeHtml(err.message)}</p>
      <a class="btn" href="/auth/x/login">Try again</a>`));
  }
}

// Text types are worth compressing; images, fonts and .glb are already
// compressed containers and would only burn CPU for ~nothing.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

// Accept-Encoding is a weighted list: "gzip;q=0" means the client explicitly
// does NOT want gzip, so a naive substring test would compress for a client
// that asked us not to.
function acceptsGzip(req) {
  const header = req.headers["accept-encoding"];
  if (!header) return false;
  return header.split(",").some((part) => {
    const [token, ...params] = part.trim().split(";");
    if (token !== "gzip" && token !== "*") return false;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

function cacheHeadersFor(rel, url, stat) {
  // HTML is the entry point: it carries the ?v= markers that invalidate
  // everything else, so it must never be cached or a new deploy is invisible.
  if (rel.endsWith(".html")) return { "Cache-Control": "no-store" };

  // Anything requested with an explicit version marker is immutable by
  // definition -- a change ships under a new URL. This is what lets the 19MB
  // character model be fetched once instead of on every single page load.
  if (url.searchParams.has("v") || url.searchParams.has("a")) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }

  // Everything else revalidates, but cheaply: the browser sends the ETag back
  // and gets a ~200-byte 304 instead of the file. Safe for un-versioned URLs,
  // since a changed file changes its ETag and is refetched immediately.
  return {
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
    "Last-Modified": stat.mtime.toUTCString(),
  };
}

function isFresh(req, headers) {
  const inm = req.headers["if-none-match"];
  if (inm && headers.ETag && inm.split(",").some((t) => t.trim() === headers.ETag)) return true;
  const ims = req.headers["if-modified-since"];
  if (ims && headers["Last-Modified"]) {
    return new Date(ims).getTime() >= new Date(headers["Last-Modified"]).getTime();
  }
  return false;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = path.join(ROOT, rel);
  // Never serve outside the project root, never hand out the secrets file,
  // and never expose the server sources (which read those secrets).
  if (!full.startsWith(ROOT) || path.basename(full) === ".env" || rel.startsWith("/server/")) {
    return send(res, 403, "Forbidden");
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");

    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    const headers = { "Content-Type": type, ...cacheHeadersFor(rel, url, stat) };

    if (isFresh(req, headers)) {
      res.writeHead(304, headers);
      return res.end();
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      return res.end();
    }

    const stream = fs.createReadStream(full);
    stream.on("error", () => { if (!res.headersSent) send(res, 500, "Read failed"); });

    if (COMPRESSIBLE.test(type) && acceptsGzip(req)) {
      // Vary matters: a cache must not hand a gzipped body to a client that
      // did not ask for one.
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      return stream.pipe(zlib.createGzip()).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost:" + PORT}`);
  try {
    // Short entry point for sharing: /play drops straight into the server
    // browser. Must live here rather than in handleApi(), which is only
    // consulted for /auth/* and /api/* paths.
    if (url.pathname === "/play") {
      return send(res, 302, "", { Location: "/arena3d/dashboard.html" });
    }

    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled !== null) return;
      return sendJson(res, 404, { error: "unknown endpoint" });
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error("request failed:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
});

// A last line of defence, and the reason it is here rather than left to
// Node's default: an unhandled rejection anywhere -- a background payment
// check, a flaky RPC, a stray await -- terminates the process by default.
// For a game server that means every live match ends, the host restarts it,
// and the same thing happens again. Whatever went wrong is nearly always
// less bad than taking the whole site down for it, so log loudly and keep
// serving. Anything genuinely unrecoverable will still fail its own request.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] unhandled rejection:", reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] uncaught exception:", err?.stack || err);
});

// Real-time multiplayer rides on the same http server (and therefore the
// same origin and the same session cookie) at ws://<host>/ws.
attachGameServer(server);

// Drop expired sessions hourly. Without this they only ever get cleaned up if
// that exact session is looked up again, so abandoned ones pile up forever in
// a file that is rewritten in full on every login.
const sessionSweep = setInterval(() => {
  const removed = sweepSessions();
  if (removed) console.log(`[sessions] expired ${removed} session(s)`);
}, 60 * 60 * 1000);
sessionSweep.unref?.();

// Without this, a port clash throws an unhandled 'error' event and dumps a
// stack trace, which says nothing useful about what to actually do.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`Port ${PORT} is already in use -- something else is running there.`);
    console.error("On a managed host this usually means the previous instance has not");
    console.error("finished releasing the port yet. Retrying a few times rather than");
    console.error("giving up, because exiting here leaves nothing serving at all.");
    console.error("");
    // A deploy replaces this process while the old one is still shutting down,
    // so losing the race is expected and recoverable -- give the old instance
    // a moment and take the port when it lets go.
    if (portRetries < 10) {
      portRetries += 1;
      setTimeout(() => server.listen(PORT, HOST), 500);
      return;
    }
  } else {
    console.error("");
    console.error("Server failed to start:", err.message);
    console.error("");
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const configured = Boolean(env.X_CONSUMER_KEY && env.X_CONSUMER_SECRET);
  console.log(`Neegy server on http://localhost:${PORT}`);
  if (PORT_SOURCE) {
    console.log(`  port:          ${PORT} (from ${PORT_SOURCE})`);
  } else {
    // Loud, because the symptom otherwise looks like a crash rather than a
    // misdirected proxy: 503 from outside, clean logs from inside.
    console.warn("  port:          WARNING - no PORT provided, defaulting to " + PORT);
    console.warn("                 On a managed host this is usually wrong: the proxy");
    console.warn("                 forwards to a port it assigns, so if that is not");
    console.warn("                 this one, every request 503s while these logs look");
    console.warn("                 perfectly healthy. Set PORT in the panel.");
  }
  console.log(`  dashboard: http://localhost:${PORT}/arena3d/dashboard.html`);
  console.log(`  X credentials: ${configured ? "loaded" : "MISSING -- set X_CONSUMER_KEY / X_CONSUMER_SECRET"}`);
  console.log(`  multiplayer:   ws://localhost:${PORT}/ws`);
  configurePayments(env);
  startPaymentSweep();
  const store = describeStorage();
  console.log(`  player store:  ${store.players} players, ${store.sessions} sessions`);
  console.log(`                 ${store.dir}`);
  if (!store.writable) {
    console.log("  WARNING:       that directory is NOT WRITABLE -- records will be lost on restart");
  } else if (store.ephemeral) {
    console.log("  WARNING:       that path is inside the per-deploy build directory, so every");
    console.log("                 player record is WIPED on each redeploy. Set DATA_DIR to a");
    console.log("                 path outside it, e.g. one level above 'hbuilds'.");
  } else if (!store.configured) {
    console.log("                 (DATA_DIR not set -- fine locally; on a managed host set it");
    console.log("                  to a directory that survives deploys)");
  }
});

// Shut down FAST. This was the cause of a long outage and the reasoning is
// worth keeping.
//
// A graceful drain sounds right: stop listening, let in-flight requests
// finish. But server.close() waits for every connection to end, and this
// process holds WEBSOCKETS, which are long-lived by design and never end on
// their own. So the old process sat there owning port 3000.
//
// Meanwhile the platform sends SIGTERM and starts the replacement about 200ms
// later. The new process found the port still taken, exited with EADDRINUSE,
// and nothing was left serving -- a 503 whose logs show a perfectly healthy
// startup immediately beforehand.
//
// Being courteous to a handful of in-flight requests is not worth being late
// to release the port. Cut the sockets, flush, and go.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // One shutdown per process. Without this a repeated signal restarts the
    // sequence and prints the same line again, which reads like a storm of
    // signals when it is one.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} -- shutting down`);

    // Writes are coalesced on a short timer, so force any pending one out
    // first or the last match's results (and any payment record) are lost.
    flushNow();

    // Destroy live sockets rather than waiting for them. Without this,
    // close() never calls back while any player is connected.
    server.closeAllConnections?.();
    server.close(() => process.exit(0));

    // Deliberately NOT unref'd, and deliberately short: the platform will not
    // wait seconds for us, and holding the port is worse than dropping a
    // request. If close() has not finished by now, leave anyway.
    setTimeout(() => process.exit(0), 400);
  });
}
