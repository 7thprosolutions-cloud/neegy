// Neegy dev/hobby backend: serves the static site AND the auth + player API
// from a single origin. Single-origin matters -- it means no CORS setup and,
// more importantly, the session cookie is first-party, so it survives browser
// tracking protection that would drop a cross-site cookie.
//
// Replaces `npx serve` for local work. Run: node server/server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadEnv, ROOT } from "./env.mjs";
import { beginLogin, completeLogin } from "./xauth.mjs";
import {
  upsertPlayer, recordMatch, leaderboard,
  createSession, sessionPlayer, destroySession, describeStorage,
} from "./store.mjs";
import { attachGameServer } from "./gameserver.mjs";

const env = loadEnv();
const PORT = Number(env.PORT || 5174);
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
  return { id, handle, name, avatar, kills, deaths, xp, gamesPlayed };
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
    const callback = `${url.protocol}//${url.host}/auth/x/callback`;
    let started;
    try {
      started = await beginLogin(env, callback);
    } catch (err) {
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

// Real-time multiplayer rides on the same http server (and therefore the
// same origin and the same session cookie) at ws://<host>/ws.
attachGameServer(server);

server.listen(PORT, HOST, () => {
  const configured = Boolean(env.X_CONSUMER_KEY && env.X_CONSUMER_SECRET);
  console.log(`Neegy server on http://localhost:${PORT}`);
  console.log(`  dashboard: http://localhost:${PORT}/arena3d/dashboard.html`);
  console.log(`  X credentials: ${configured ? "loaded" : "MISSING -- set X_CONSUMER_KEY / X_CONSUMER_SECRET"}`);
  console.log(`  multiplayer:   ws://localhost:${PORT}/ws`);
  const store = describeStorage();
  console.log(`  player store:  ${store.players} players, ${store.sessions} sessions`);
  console.log(`                 ${store.dir}`);
  if (!store.configured) {
    console.log("                 (DATA_DIR not set -- on a host with an ephemeral");
    console.log("                  filesystem this is wiped on every redeploy)");
  }
});

// Stop accepting new connections and let in-flight requests finish, rather
// than cutting every player off mid-request on a deploy or restart.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`
${signal} -- shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on a wedged socket (WebSockets are long-lived by
    // design and will never close on their own).
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
