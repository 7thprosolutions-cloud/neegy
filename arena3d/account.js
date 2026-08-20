// Client side of the X sign-in / player-record backend (see server/).
//
// Every call here degrades: if the backend is not reachable -- which is the
// normal case when the site is opened through a plain static host, or through
// `npx serve` instead of `node server/server.mjs` -- `backendAvailable`
// becomes false and callers fall back to the localStorage profile in
// profile.js exactly as before. Signing in is an upgrade, never a
// requirement, so the game is always playable.

let cached = null; // { backendAvailable, player }

async function api(path, options) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { Accept: "application/json", ...(options?.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null; // an HTML error page, an empty body, anything not JSON
  }
  return { res, body };
}

function has(body, key) {
  return Boolean(body) && Object.prototype.hasOwnProperty.call(body, key);
}

// Resolves to { backendAvailable, player }. `player` is null when the backend
// is up but nobody is signed in. Cached after the first call; pass
// { refresh: true } after an action that changes the record.
export async function getAccount({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  try {
    const { res, body } = await api("/api/me");
    // Positive handshake, deliberately: only our own backend answers /api/me
    // with 200 AND a `player` key. Sniffing the content-type instead is not
    // enough -- `npx serve` returns its 404 as application/json whenever the
    // request asks for JSON, which reads as a live backend and puts a dead
    // "Sign in with X" link on a statically hosted page.
    const ok = res.ok && has(body, "player");
    cached = { backendAvailable: ok, player: ok ? body.player : null };
  } catch {
    cached = { backendAvailable: false, player: null }; // offline / blocked
  }
  return cached;
}

export function loginUrl() {
  return "/auth/x/login";
}

export async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* nothing to sign out of */
  }
  cached = null;
}

// Returns the updated player record, or null if the result could not be
// recorded server-side (not signed in, or no backend). Callers still write
// the local profile either way, so a failure here only costs the global
// leaderboard entry, never the player's own visible stats.
export async function submitMatchResult({ kills = 0, deaths = 0, xp = 0 } = {}) {
  try {
    const { res, body } = await api("/api/match-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kills, deaths, xp }),
    });
    if (!res.ok || !has(body, "player") || !body.player) return null;
    if (cached) cached = { ...cached, player: body.player };
    return body.player;
  } catch {
    return null;
  }
}

// Real signed-in players, best first. Empty array when there is no backend.
export async function fetchLeaderboard() {
  try {
    const { res, body } = await api("/api/leaderboard");
    if (!res.ok || !Array.isArray(body?.players)) return [];
    return body.players;
  } catch {
    return [];
  }
}
