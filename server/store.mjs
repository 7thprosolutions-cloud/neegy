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
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");

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
// Payments in flight, keyed by reference. This file is the reason the whole
// module persists at all rather than living in memory: every push to main
// restarts this process, and someone whose wallet confirms during those few
// seconds has already parted with real money. Losing that record means their
// SOL is in the treasury and their account shows nothing -- the one failure
// here that cannot be shrugged off. On restart the sweep picks these up and
// credits them late rather than never.
const payments = readJson(PAYMENTS_FILE, {});

// Request tokens waiting on the user to approve at X. In memory only -- they
// expire in minutes, so losing them on restart costs nothing.
const pendingLogins = new Map();

// Both files are rewritten in full, so doing it once per changed record is
// wasteful: the end of a 5v5 match calls recordMatch ten times, which used to
// mean ten complete rewrites of the player file for a single event. Coalesce
// instead -- mark dirty, flush on a short timer. Data still lands within a
// second, and a burst of N changes costs one write instead of N.
const FLUSH_DELAY_MS = 250;
let playersDirty = false;
let sessionsDirty = false;
let paymentsDirty = false;
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

export function flushNow() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (playersDirty) { playersDirty = false; writeJson(PLAYERS_FILE, players); }
  if (sessionsDirty) { sessionsDirty = false; writeJson(SESSIONS_FILE, sessions); }
  if (paymentsDirty) { paymentsDirty = false; writeJson(PAYMENTS_FILE, payments); }
}

function savePlayers() { playersDirty = true; scheduleFlush(); }
function saveSessions() { sessionsDirty = true; scheduleFlush(); }
// Payments are written through immediately, not on the debounce the other two
// use. A few milliseconds of batching is a fine trade for match scores; it is
// not a fine trade for the only record that someone paid.
function savePayments() { paymentsDirty = false; writeJson(PAYMENTS_FILE, payments); }

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
    payments: Object.keys(payments).length,
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
    // Paid entitlements. Balances, not flags: one purchase adds to whatever is
    // already there, and spending decrements. `??` not `||` so a legitimately
    // zero balance is never silently reset to a default.
    extraLives: existing?.extraLives ?? 0,
    // A timestamp, not a count: 0 means "never had a pass". `??` not `||` so a
    // legitimately expired pass is not silently reset to a default.
    privateUntil: existing?.privateUntil ?? 0,
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

// ---------- entitlements ----------

export const PRIVATE_PASS_MS = 24 * 60 * 60 * 1000;

// Two shapes of thing can be bought, and they are not interchangeable.
//
// `count` is a stock you draw down: ten extra lives, spent one at a time.
// `window` is access that runs on a clock: a private-server pass good for 24
// hours from purchase, no matter how many matches you play inside it. Charging
// per match for a private server was the earlier model and it was wrong for
// what people actually do with one -- you set a room up for an evening with
// friends, and a meter running on each round is the wrong shape for that.
export const ENTITLEMENTS = {
  extraLives: {
    type: "count", field: "extraLives", perPurchase: 10, priceSol: 0.1,
    label: "Extra lives",
  },
  privateServer: {
    type: "window", field: "privateUntil", windowMs: PRIVATE_PASS_MS, priceSol: 0.1,
    label: "Private server pass (24h)",
  },
};

// Adds to a balance, or extends a window. Returns the new player record, or
// null if unknown player. `quantity` is passed explicitly rather than read
// from the table so a partial or promotional grant is possible without
// inventing a second code path -- for a window it means N further periods.
export function grantEntitlement(playerId, kind, quantity) {
  const spec = ENTITLEMENTS[kind];
  const p = players[playerId];
  if (!spec || !p) return null;
  const n = Math.max(0, Math.floor(Number(quantity) || 0));
  if (!n) return p;

  if (spec.type === "window") {
    // Buying again while a pass is still live extends it rather than
    // restarting it, so nobody is punished for topping up early.
    const from = Math.max(Date.now(), p[spec.field] || 0);
    p[spec.field] = from + spec.windowMs * n;
  } else {
    p[spec.field] = (p[spec.field] || 0) + n;
  }
  savePlayers();
  return p;
}

// Is this player's private-server pass live right now?
export function privateAccess(playerId) {
  const until = players[playerId]?.privateUntil || 0;
  const msLeft = until - Date.now();
  return { active: msLeft > 0, until, msLeft: Math.max(0, msLeft) };
}

// Spends exactly one unit, atomically. Returns the remaining balance, or null
// if there was nothing to spend -- callers must treat null as "refuse the
// action", never as zero, or an empty balance would grant a free use.
export function spendEntitlement(playerId, kind) {
  const spec = ENTITLEMENTS[kind];
  const p = players[playerId];
  if (!spec || !p) return null;
  // A window is not a stock; there is nothing to decrement. Callers wanting to
  // know whether it is open ask privateAccess().
  if (spec.type === "window") return null;
  const balance = p[spec.field] || 0;
  if (balance <= 0) return null;
  p[spec.field] = balance - 1;
  savePlayers();
  return p[spec.field];
}

// Handles are what a human actually knows, and X allows renames, so match
// case-insensitively rather than assuming exact capitalisation.
export function findPlayerByHandle(handle) {
  const want = String(handle || "").replace(/^@/, "").toLowerCase();
  if (!want) return null;
  return Object.values(players).find((p) => (p.handle || "").toLowerCase() === want) || null;
}

export function entitlementsOf(playerId) {
  const p = players[playerId];
  const pass = privateAccess(playerId);
  return {
    extraLives: p?.extraLives || 0,
    // Both the deadline and the remaining time: the deadline so a client can
    // show "until 21:40", the remaining time so it does not have to trust the
    // browser clock, which is the one on a phone that is an hour out.
    privateUntil: pass.until,
    privateActive: pass.active,
    privateMsLeft: pass.msLeft,
  };
}

export function leaderboard(limit = 20) {
  return Object.values(players)
    .sort((a, b) => b.xp - a.xp || b.kills - a.kills)
    .slice(0, limit)
    .map(({ handle, name, avatar, kills, deaths, xp, gamesPlayed }) => ({
      handle, name, avatar, kills, deaths, xp, gamesPlayed,
    }));
}

// ---------- payments ----------
//
// A payment moves pending -> paid exactly once, and the transition is what
// grants the entitlement. Two guards make that safe against the ways money
// code goes wrong: a reference can only be credited once (checked on the
// record itself), and a chain signature can only be used once ever (checked
// across all records). The second matters because the same transaction can
// legitimately be seen by two concurrent sweeps.

const PAYMENT_TTL_MS = 45 * 60 * 1000; // an unpaid invoice is dead after 45 min

export function createPayment({ reference, playerId, product, lamports, cluster }) {
  payments[reference] = {
    reference, playerId, product, lamports, cluster,
    status: "pending",
    signature: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + PAYMENT_TTL_MS,
    creditedAt: null,
  };
  savePayments();
  return payments[reference];
}

export function getPayment(reference) {
  return payments[reference] || null;
}

// Only what the sweep should still be asking the chain about.
export function pendingPayments() {
  const now = Date.now();
  return Object.values(payments).filter((p) => p.status === "pending" && p.expiresAt > now);
}

export function signatureAlreadyUsed(signature) {
  return Object.values(payments).some((p) => p.signature === signature && p.status === "paid");
}

// The single place a payment turns into an entitlement. Returns the updated
// record, or null when this call was a duplicate and did nothing -- callers
// must not grant on null, or a double sweep pays out twice.
export function markPaid(reference, signature) {
  const p = payments[reference];
  if (!p || p.status === "paid") return null;
  if (signatureAlreadyUsed(signature)) return null;
  p.status = "paid";
  p.signature = signature;
  p.creditedAt = Date.now();
  savePayments();
  return p;
}

export function expireStalePayments() {
  const now = Date.now();
  let n = 0;
  for (const p of Object.values(payments)) {
    if (p.status === "pending" && p.expiresAt <= now) { p.status = "expired"; n++; }
  }
  // Paid records are kept as the receipt trail -- they are the only proof on
  // this side that a given signature was honoured, and they are what a manual
  // repair would be checked against.
  if (n) savePayments();
  return n;
}

export function paymentsForPlayer(playerId, limit = 10) {
  return Object.values(payments)
    .filter((p) => p.playerId === playerId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// ---------- sessions ----------

// Expired sessions were previously only dropped when that exact session was
// looked up again -- which never happens for an abandoned one. At a thousand
// logins a day against a 30-day TTL that is tens of thousands of dead records
// accumulating in a file that gets rewritten on every single login. Sweep them
// on a timer instead.
export function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.createdAt < cutoff) { delete sessions[sid]; removed++; }
  }
  if (removed) saveSessions();
  return removed;
}

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
