// File-backed store for player records and login sessions. Deliberately a
// plain JSON file rather than a database: this is a single-box dev/hobby
// server, the write volume is a handful of rows per match, and keeping it
// dependency-free means no package.json (which is gitignored in this repo).
// Swap this module for a real DB if the game ever needs concurrent writers.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./env.mjs";

// Overridable so a deployment can point this at a persistent volume. This
// matters: managed Node platforms often give you an ephemeral filesystem that
// is wiped on every redeploy, which would silently destroy every player record
// (kills, XP, X identity) each time code is pushed. If DATA_DIR is not set we
// still work, but say so loudly at startup rather than losing data quietly --
// see describeStorage().
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "server", "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_TTL_MS = 15 * 60 * 1000; // an unfinished login is dead after 15 min

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write to a temp file then rename: a crash mid-write leaves the previous
// good file intact instead of a truncated one.
//
// Never throws. A misconfigured or read-only DATA_DIR must not take the game
// down or break sign-in -- the process keeps serving from memory and says so
// once, loudly, rather than failing every request that touches a record.
let writeFailureReported = false;
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    if (!writeFailureReported) {
      writeFailureReported = true;
      console.error(`[store] CANNOT WRITE to ${path.dirname(file)} (${err.code || err.message})`);
      console.error("[store] Players and sessions still work but are lost on restart.");
      console.error("[store] Set DATA_DIR to a writable directory that survives deploys.");
    }
    return false;
  }
}

// Probed at startup so a bad DATA_DIR shows up immediately, rather than at the
// moment the first real player tries to sign in.
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

const players = readJson(PLAYERS_FILE, {});
const sessions = readJson(SESSIONS_FILE, {});

// Request tokens waiting on the user to approve at X. In memory only -- they
// expire in minutes, so losing them on restart costs nothing.
const pendingLogins = new Map();

function savePlayers() { writeJson(PLAYERS_FILE, players); }
function saveSessions() { writeJson(SESSIONS_FILE, sessions); }

// ---------- players ----------

// Reported at startup so an unexpectedly empty store is obvious in the logs
// immediately, instead of being discovered when a player asks where their XP
// went.
export function describeStorage() {
  return {
    dir: DATA_DIR,
    configured: Boolean(process.env.DATA_DIR),
    writable: canWrite(DATA_DIR),
    // Managed hosts commonly deploy into a fresh per-release directory, so a
    // data path inside the build tree is wiped on every push. Detect that
    // shape and warn, rather than silently losing every player record.
    ephemeral: /[\\/](hbuilds|releases|versions)[\\/]/i.test(DATA_DIR),
    players: Object.keys(players).length,
    sessions: Object.keys(sessions).length,
  };
}

export function playerKey(xUserId) {
  return "x:" + xUserId;
}

export function upsertPlayer({ xUserId, handle, name, avatar }) {
  const id = playerKey(xUserId);
  const now = Date.now();
  const existing = players[id];
  players[id] = {
    id,
    xUserId: String(xUserId),
    handle,
    // X profile fields can go missing if the /2/users/me lookup is not
    // available on this API tier -- never let that blank out what we already
    // have on file.
    name: name || existing?.name || handle,
    avatar: avatar || existing?.avatar || null,
    kills: existing?.kills ?? 0,
    deaths: existing?.deaths ?? 0,
    xp: existing?.xp ?? 0,
    gamesPlayed: existing?.gamesPlayed ?? 0,
    createdAt: existing?.createdAt ?? now,
    lastSeen: now,
  };
  savePlayers();
  return players[id];
}

export function getPlayer(id) {
  return players[id] || null;
}

export function recordMatch(id, { kills = 0, deaths = 0, xp = 0 }) {
  const p = players[id];
  if (!p) return null;
  // Clamp: these numbers arrive from the browser, which the player controls.
  // This is not real anti-cheat (that needs authoritative server-side match
  // simulation), it just stops a typo or a trivial console poke from writing
  // an absurd score into the shared leaderboard.
  p.kills += Math.max(0, Math.min(100, Math.floor(kills) || 0));
  p.deaths += Math.max(0, Math.min(100, Math.floor(deaths) || 0));
  p.xp += Math.max(0, Math.min(10000, Math.floor(xp) || 0));
  p.gamesPlayed += 1;
  p.lastSeen = Date.now();
  savePlayers();
  return p;
}

export function leaderboard(limit = 20) {
  return Object.values(players)
    .sort((a, b) => b.xp - a.xp || b.kills - a.kills)
    .slice(0, limit)
    .map(({ handle, name, avatar, kills, deaths, xp, gamesPlayed }) => ({
      handle, name, avatar, kills, deaths, xp, gamesPlayed,
    }));
}

// ---------- sessions ----------

export function createSession(playerId) {
  const sid = crypto.randomBytes(32).toString("hex");
  sessions[sid] = { playerId, createdAt: Date.now() };
  saveSessions();
  return sid;
}

export function sessionPlayer(sid) {
  const s = sid && sessions[sid];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    delete sessions[sid];
    saveSessions();
    return null;
  }
  return getPlayer(s.playerId);
}

export function destroySession(sid) {
  if (sid && sessions[sid]) {
    delete sessions[sid];
    saveSessions();
  }
}

// ---------- in-flight logins ----------

export function stashPending(token, secret) {
  pendingLogins.set(token, { secret, createdAt: Date.now() });
  for (const [k, v] of pendingLogins) {
    if (Date.now() - v.createdAt > PENDING_TTL_MS) pendingLogins.delete(k);
  }
}

export function takePending(token) {
  const entry = pendingLogins.get(token);
  if (!entry) return null;
  pendingLogins.delete(token);
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
  return entry.secret;
}
