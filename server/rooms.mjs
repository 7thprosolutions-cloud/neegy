// Authoritative room / lobby / match state for real multiplayer.
//
// Split of responsibility (see README-multiplayer.md for the reasoning):
//
//   server owns  -- who is in a room, team assignment, when a match starts,
//                   health, damage, deaths, scoring, when a match ends.
//   client owns  -- its own movement. Each client reports the position of the
//                   entities it owns and the server relays them.
//
// "Entities" rather than "players" because a client can own more than itself:
// the host also simulates the bots that fill empty slots, using the same AI
// the single-player game already has. Without that, a 5v5 would need ten real
// humans before it could ever be played or tested.
import crypto from "node:crypto";
import { MODES } from "./modes.mjs";
import { recordMatch, spendEntitlement, entitlementsOf } from "./store.mjs";

const TICK_MS = 66; // ~15 snapshots/sec -- plenty for this pace, easy on bandwidth
const LOBBY_COUNTDOWN_MS = 3000;
const OVER_LINGER_MS = 8000;
// How long a wiped team's last death is held open so an extra life can be
// spent. Without this the match is called on the very next tick and an extra
// life is unusable in 1v1 and only accidentally usable in team modes -- the
// paid item would do nothing in the mode most people play.
const REVIVE_WINDOW_MS = 7000;
// Player-created rooms, on top of the always-on ones. At 10 players each this
// is a ceiling of ~2000 concurrent players -- far beyond what one process
// should be asked to hold, so the practical limit is CPU and bandwidth, not
// this number. It exists to stop one script opening unbounded rooms.
const MAX_ROOMS = 200;
const XP_PER_KILL = 25;
const XP_PER_GAME = 5;

const TEAM_BLUE = 0;
const TEAM_RED = 1;

export const rooms = new Map();

function id(prefix) {
  return prefix + "-" + crypto.randomBytes(6).toString("hex");
}

function now() {
  return Date.now();
}

// Room passwords are hashed, never stored or transmitted in clear. They are
// low-stakes (a door code shared with friends, not an account credential), but
// they still travel over the wire and sit in a file, so treat them properly:
// per-room salt, and a timing-safe comparison so a wrong guess cannot be
// distinguished from a near-miss by how long the check took.
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}

function passwordMatches(stored, attempt) {
  if (!stored) return true; // public room
  const { hash } = hashPassword(attempt ?? "", stored.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(stored.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- room shape ----------

// Always-on servers, created at startup and never removed when they empty.
// Without these a first-time visitor lands on an empty browser list and has to
// know to create a room before anything can happen -- which reads as "nobody
// plays this" even when the game is working perfectly.
// Three of each mode. Sizing matters: these hold 3*(2+6+10) = 54 players, and
// a measured peak for ~1000 visitors/day lands near 40 concurrent -- so the
// always-on servers alone absorb a normal peak without anyone needing to know
// how to create a room. Past that, players create their own (up to MAX_ROOMS).
const PERMANENT_ROOMS = [
  { name: "Sunset Duel", mode: "1v1" },
  { name: "Backlot Duel", mode: "1v1" },
  { name: "Midnight Duel", mode: "1v1" },
  { name: "Town Skirmish", mode: "3v3" },
  { name: "Rooftop Skirmish", mode: "3v3" },
  { name: "Scrapyard Skirmish", mode: "3v3" },
  { name: "Gold Rush Assault", mode: "5v5" },
  { name: "Dust Bowl Assault", mode: "5v5" },
  { name: "Cargo Bay Assault", mode: "5v5" },
];

export function ensurePermanentRooms() {
  for (const spec of PERMANENT_ROOMS) {
    const exists = [...rooms.values()].some((r) => r.permanent && r.name === spec.name);
    if (!exists) createRoom({ name: spec.name, mode: spec.mode, permanent: true });
  }
  return [...rooms.values()].filter((r) => r.permanent).length;
}

export function createRoom({ name, mode, hostClient, permanent = false, password = null }) {
  if (!permanent && rooms.size >= MAX_ROOMS) throw new Error("Too many servers open right now.");
  if (!MODES[mode]) throw new Error("Unknown mode: " + mode);
  const trimmed = typeof password === "string" ? password.trim() : "";
  if (password !== null && password !== undefined && trimmed.length < 3) {
    throw new Error("A private server needs a password of at least 3 characters.");
  }
  const room = {
    id: id("room"),
    permanent,
    // Private rooms are listed but not joinable without the password, so
    // friends can find the server by name instead of swapping room ids.
    isPrivate: Boolean(trimmed),
    password: trimmed ? hashPassword(trimmed) : null,
    // Whose private-game credits this room spends when a match starts.
    ownerPlayerId: hostClient?.playerId || null,
    name: String(name || "").trim().slice(0, 24) || `${hostClient.displayName}'s Server`,
    mode,
    teamSize: MODES[mode].teamSize,
    // A permanent room has nobody in it yet, so no host until someone joins.
    hostId: hostClient ? hostClient.id : null,
    state: "lobby", // lobby | countdown | playing | over
    clients: new Map(), // clientId -> client
    entities: new Map(), // entityId -> { id, ownerId, team, name, isBot, hp, alive, x,y,z, facing, anim }
    scores: new Map(), // clientId -> { kills, deaths }
    createdAt: now(),
    countdownEndsAt: 0,
    lastHitAt: new Map(), // clientId -> ms, cheap rate limit on damage claims
    revived: new Set(), // clientIds that already spent an extra life this match
  };
  rooms.set(room.id, room);
  return room;
}

export function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    hostName: room.clients.get(room.hostId)?.displayName || (room.permanent ? "open" : "—"),
    permanent: Boolean(room.permanent),
    // Only ever the flag -- the hash and salt stay server-side.
    isPrivate: Boolean(room.isPrivate),
    players: room.clients.size,
    capacity: room.teamSize * 2,
    state: room.state,
  };
}

export function listRooms() {
  return [...rooms.values()].map(roomSummary);
}

// Team with fewer humans wins the next joiner, so teams stay balanced.
function pickTeam(room) {
  let blue = 0, red = 0;
  for (const c of room.clients.values()) (c.team === TEAM_BLUE ? blue++ : red++);
  return blue <= red ? TEAM_BLUE : TEAM_RED;
}

export function joinRoom(room, client, password) {
  if (room.state === "playing") throw new Error("That match has already started.");
  if (room.clients.size >= room.teamSize * 2) throw new Error("That server is full.");
  // Only the creator is exempt, and only because they join their own room in
  // the same breath as making it: createRoom() records them as hostId but does
  // not put them in `clients`, so at this instant they look like an outsider
  // with no password. Without this the author of a private server is the one
  // person who can never get into it.
  const isCreator = room.hostId === client.id;
  const inside = room.clients.has(client.id);
  if (room.isPrivate && !isCreator && !inside && !passwordMatches(room.password, password)) {
    throw new Error("Wrong password for that private server.");
  }
  if (client.room && client.room !== room) leaveRoom(client);

  client.room = room;
  client.team = pickTeam(room);
  room.clients.set(client.id, client);
  room.scores.set(client.id, { kills: 0, deaths: 0 });
  // First one into an always-on room takes the host role, which is what gives
  // them the START control and makes them the simulator for any bot slots.
  if (!room.hostId || !room.clients.has(room.hostId)) room.hostId = client.id;
  return room;
}

export function leaveRoom(client) {
  const room = client.room;
  if (!room) return null;
  room.clients.delete(client.id);
  room.scores.delete(client.id);
  // drop everything that client was simulating, including its bots
  for (const [entId, ent] of room.entities) {
    if (ent.ownerId === client.id) room.entities.delete(entId);
  }
  client.room = null;
  client.team = null;

  if (room.clients.size === 0) {
    // Player-created rooms disappear with their last player; always-on rooms
    // stay listed and reset so the next visitor can drop straight in.
    if (!room.permanent) {
      rooms.delete(room.id);
      return null;
    }
    room.hostId = null;
    room.state = "lobby";
    room.countdownEndsAt = 0;
    room.entities.clear();
    return room;
  }
  // host left -- promote whoever has been here longest so bot simulation and
  // the START control do not vanish with them
  if (room.hostId === client.id) {
    room.hostId = room.clients.keys().next().value;
    // a match in progress loses its bot simulator; the new host takes over
    // from its own copy of the AI on the next frame it sends
  }
  if (room.state === "countdown" && room.clients.size < room.teamSize * 2) {
    room.state = "lobby";
    room.countdownEndsAt = 0;
  }
  return room;
}

export function roomStateMessage(room) {
  return {
    t: "room",
    room: {
      ...roomSummary(room),
      hostId: room.hostId,
      countdownMs: room.state === "countdown" ? Math.max(0, room.countdownEndsAt - now()) : 0,
      members: [...room.clients.values()].map((c) => ({
        id: c.id,
        name: c.displayName,
        handle: c.handle || null,
        avatar: c.avatar || null,
        team: c.team,
        isHost: c.id === room.hostId,
      })),
    },
  };
}

// ---------- match lifecycle ----------

export function canStart(room) {
  return room.state === "lobby" && room.clients.size >= 1;
}

// Starting with empty slots is what makes a 3v3 playable with two humans:
// startMatch() hands the leftover slots to the host to simulate as bots.
export function beginCountdown(room) {
  if (!canStart(room)) return false;
  // A private match costs the room owner one of their private-game credits.
  // Charged here, at the start of the countdown, rather than at room creation:
  // a room that is never played should not cost anything, and the owner may
  // run several matches from one room as long as they have credits left.
  if (room.isPrivate) {
    if (!room.ownerPlayerId) {
      throw new Error("Private servers need the owner signed in with X.");
    }
    if (spendEntitlement(room.ownerPlayerId, "privateGames") === null) {
      throw new Error("No private games left. Top up in Upgrades to keep playing here.");
    }
  }
  room.state = "countdown";
  room.countdownEndsAt = now() + LOBBY_COUNTDOWN_MS;
  return true;
}

export function startMatch(room) {
  room.state = "playing";
  room.entities.clear();
  room.revived.clear(); // extra lives are one per match, so reset the ledger
  room.reviveWindowEndsAt = 0;
  room.startedAt = now();
  for (const c of room.clients.values()) {
    room.scores.set(c.id, { kills: 0, deaths: 0 });
  }

  // Tell every client which slots it is responsible for simulating. The host
  // gets the bots; everyone else just gets themself.
  const perTeamHumans = { [TEAM_BLUE]: [], [TEAM_RED]: [] };
  for (const c of room.clients.values()) perTeamHumans[c.team].push(c);

  const assignments = new Map(); // clientId -> [{ entityId, team, name, isBot, slot }]
  for (const c of room.clients.values()) assignments.set(c.id, []);

  for (const team of [TEAM_BLUE, TEAM_RED]) {
    for (let slot = 0; slot < room.teamSize; slot++) {
      const human = perTeamHumans[team][slot];
      if (human) {
        const entityId = "p:" + human.id;
        assignments.get(human.id).push({ entityId, team, slot, name: human.displayName, isBot: false });
        room.entities.set(entityId, makeEntity(entityId, human.id, team, human.displayName, false, slot));
      } else {
        const entityId = `b:${team}:${slot}`;
        assignments.get(room.hostId).push({ entityId, team, slot, name: null, isBot: true });
        room.entities.set(entityId, makeEntity(entityId, room.hostId, team, null, true, slot));
      }
    }
  }
  // Kept on the room so a client that reconnects mid-match (e.g. the browser
  // navigating from the dashboard to the game page) can be told again which
  // slots it owns, instead of losing its own character.
  room.assignments = assignments;
  return assignments;
}

// `slot` travels in the snapshot so every client places every entity at the
// same spawn point from the same TEAM_SPAWNS table -- without it, clients
// would each have to invent a spawn for players they did not create.
function makeEntity(entityId, ownerId, team, name, isBot, slot) {
  return {
    id: entityId, ownerId, team, name, isBot, slot,
    hp: 100, alive: true,
    x: 0, y: 0, z: 0, facing: 0, anim: "RifleAimingIdle",
  };
}

// Clients only get to move what they own, and only while a match is running.
export function applyEntityStates(room, client, list) {
  if (room.state !== "playing" || !Array.isArray(list)) return;
  for (const s of list) {
    const ent = room.entities.get(s.id);
    if (!ent || ent.ownerId !== client.id || !ent.alive) continue;
    if (Number.isFinite(s.x)) ent.x = s.x;
    if (Number.isFinite(s.y)) ent.y = s.y;
    if (Number.isFinite(s.z)) ent.z = s.z;
    if (Number.isFinite(s.facing)) ent.facing = s.facing;
    if (typeof s.anim === "string") ent.anim = s.anim.slice(0, 32);
    if (typeof s.name === "string" && ent.isBot && !ent.name) ent.name = s.name.slice(0, 24);
  }
}

// Damage is server-side so health can never disagree between clients. The
// *claim* still comes from the shooter, so this is not anti-cheat -- see the
// README. The rate limit just stops a stuck loop or a naive script from
// emptying every health bar in one tick.
export function applyHit(room, client, { target, damage }) {
  if (room.state !== "playing") return null;
  const ent = room.entities.get(target);
  if (!ent || !ent.alive) return null;

  const shooterEnt = [...room.entities.values()].find((e) => e.ownerId === client.id && !e.isBot);
  if (shooterEnt && shooterEnt.team === ent.team) return null; // no friendly fire

  const last = room.lastHitAt.get(client.id) || 0;
  if (now() - last < 40) return null;
  room.lastHitAt.set(client.id, now());

  const dmg = Math.max(0, Math.min(60, Number(damage) || 0));
  ent.hp = Math.max(0, ent.hp - dmg);

  const events = [{ t: "damage", id: ent.id, hp: ent.hp, by: client.id }];
  if (ent.hp === 0) {
    ent.alive = false;
    events.push({ t: "death", id: ent.id, by: client.id });
    const killer = room.scores.get(client.id);
    if (killer) killer.kills += 1;
    if (!ent.isBot) {
      const victimClientId = ent.ownerId;
      const victim = room.scores.get(victimClientId);
      if (victim) victim.deaths += 1;
    }
  }
  return events;
}

// Spends one extra life to put a dead player back in the fight. Server-side
// because health and death are: a client that could revive itself would be
// able to do so for free and forever.
//
// One per match, enforced per client rather than per entity, so leaving and
// rejoining cannot buy a second go on the same round.
export function reviveOwnEntity(room, client) {
  if (room.state !== "playing") return { error: "The match is not running." };
  if (!client.playerId) return { error: "Sign in with X to use extra lives." };
  if (room.revived.has(client.id)) return { error: "You have already used an extra life this match." };

  const ent = [...room.entities.values()].find((e) => e.ownerId === client.id && !e.isBot);
  if (!ent) return { error: "You are not in this match." };
  if (ent.alive) return { error: "You are still alive." };

  const remaining = spendEntitlement(client.playerId, "extraLives");
  if (remaining === null) return { error: "No extra lives left." };

  room.revived.add(client.id);
  ent.hp = 100;
  ent.alive = true;
  // Their team is back in the fight, so the pending result is void.
  room.reviveWindowEndsAt = 0;
  return { entityId: ent.id, remaining };
}

// Is there anyone on this team who could still spend an extra life? Gating the
// hold-open window on a real, spendable balance is what keeps it from adding
// seven seconds of dead air to every ordinary match: with nobody eligible the
// result is declared on the same tick it always was.
function someoneCanRevive(room, team) {
  for (const c of room.clients.values()) {
    if (c.team !== team || !c.playerId || room.revived.has(c.id)) continue;
    if (entitlementsOf(c.playerId).extraLives > 0) return true;
  }
  return false;
}

export function checkMatchOver(room) {
  if (room.state !== "playing") return null;
  const alive = { [TEAM_BLUE]: 0, [TEAM_RED]: 0 };
  for (const ent of room.entities.values()) if (ent.alive) alive[ent.team]++;
  if (alive[TEAM_BLUE] > 0 && alive[TEAM_RED] > 0) {
    room.reviveWindowEndsAt = 0;
    return null;
  }

  const winningTeam = alive[TEAM_BLUE] > 0 ? TEAM_BLUE : TEAM_RED;
  const losingTeam = winningTeam === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
  if (someoneCanRevive(room, losingTeam)) {
    if (!room.reviveWindowEndsAt) {
      room.reviveWindowEndsAt = now() + REVIVE_WINDOW_MS;
      // Announced once, on the tick it opens, so the client can show an
      // accurate countdown rather than guessing the server's deadline.
      return { t: "reviveWindow", team: losingTeam, ms: REVIVE_WINDOW_MS };
    }
    if (now() < room.reviveWindowEndsAt) return null;
  }
  room.reviveWindowEndsAt = 0;
  room.state = "over";
  room.overAt = now();

  const results = [];
  for (const c of room.clients.values()) {
    const s = room.scores.get(c.id) || { kills: 0, deaths: 0 };
    const xp = s.kills * XP_PER_KILL + XP_PER_GAME;
    results.push({ id: c.id, name: c.displayName, kills: s.kills, deaths: s.deaths, xp, won: c.team === winningTeam });
    // Signed-in players get the result written to their permanent record here,
    // server-side -- the browser is not trusted to report its own match score
    // in multiplayer the way it is in the single-player fallback path.
    if (c.playerId) recordMatch(c.playerId, { kills: s.kills, deaths: s.deaths, xp });
  }
  return { t: "over", winningTeam, results };
}

export function sweepRooms() {
  for (const room of rooms.values()) {
    if (room.state === "over" && now() - room.overAt > OVER_LINGER_MS) {
      room.state = "lobby";
      room.entities.clear();
    }
  }
}

export function snapshot(room) {
  return {
    t: "snap",
    ents: [...room.entities.values()].map((e) => ({
      id: e.id, team: e.team, name: e.name, isBot: e.isBot, slot: e.slot,
      hp: e.hp, alive: e.alive,
      x: round(e.x), y: round(e.y), z: round(e.z),
      facing: round(e.facing), anim: e.anim,
    })),
  };
}

// Two decimals is well under what is visible at this scale and roughly halves
// snapshot size versus full float precision.
function round(n) {
  return Math.round((n || 0) * 100) / 100;
}

export { TICK_MS, TEAM_BLUE, TEAM_RED, REVIVE_WINDOW_MS };
