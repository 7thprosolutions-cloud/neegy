// Multiplayer glue for the arena.
//
// The single-player game is untouched and remains the fallback: this module is
// only live when the page was opened with ?room=<id>, and everything it does
// is gated on `mp.active`. If the socket cannot be reached, `mp.active` stays
// false and arena3d.js runs exactly as it always did, bots and all.
//
// Division of labour (mirrors server/rooms.mjs):
//   - Entities this client OWNS are simulated locally by the normal game code
//     (the player from input, any bots from the existing AI) and their
//     positions are reported upstream every tick.
//   - Entities owned by SOMEONE ELSE are not simulated at all. They are moved
//     by interpolating toward the last snapshot the server sent.
//   - Health, damage, deaths and the end of the match are decided by the
//     server. A local bullet hit reports a claim and waits to be told.
import * as net from "/arena3d/net.js?v=20";

export const mp = {
  active: false,
  roomId: null,
  myEntityId: null,
  myTeam: null,
  owned: new Set(),          // entity ids this client simulates
  bySlot: new Map(),         // `${team}:${slot}` -> entity id
  fighterByEnt: new Map(),   // entity id -> fighter
  entByFighter: new WeakMap(),
  remote: new Map(),         // entity id -> latest server transform
  roster: [],                // entities from the most recent snapshot
  started: false,
  result: null,
  // true while we are asking the server whether our match still exists after a
  // reconnect (see joinMatch)
  resyncing: false,
};

const ROOM_ID = new URLSearchParams(location.search).get("room");

export function isMultiplayerRequested() {
  return Boolean(ROOM_ID);
}

// Resolves with the `start` payload once the server has told us which slots we
// own, or null if there is no reachable server / no such room.
export async function joinMatch({ onSnapshot, onDamage, onDeath, onOver, onShot, onError, onMatchLost } = {}) {
  if (!ROOM_ID) return null;
  net.connect();
  // Same reasoning as the dashboard: a cold connection (DNS + TLS, or a server
  // still warming after a deploy) can take several seconds, and giving up too
  // early drops the player into an offline bot match when a real one was
  // waiting for them. Losing the match is far worse than waiting a moment.
  const online = await net.ready(8000);
  if (!online) return null;

  net.on("snap", (msg) => {
    mp.roster = msg.ents;
    for (const e of msg.ents) {
      mp.remote.set(e.id, e);
      if (e.slot !== undefined) mp.bySlot.set(`${e.team}:${e.slot}`, e.id);
    }
    onSnapshot?.(msg.ents);
  });
  net.on("damage", (msg) => onDamage?.(msg));
  net.on("death", (msg) => onDeath?.(msg));
  net.on("shot", (msg) => onShot?.(msg));
  net.on("over", (msg) => { mp.result = msg; onOver?.(msg); });
  net.on("error", (msg) => {
    // While resyncing, an error means the server does not know this room --
    // see the status handler below.
    if (mp.resyncing) {
      mp.resyncing = false;
      onMatchLost?.(msg.message);
      return;
    }
    onError?.(msg.message);
  });

  // The socket coming back is not proof the match survived. Room state lives
  // only in the server's memory, so a restart (every deploy does one) wipes it
  // while the browser reconnects perfectly happily. Without this the player is
  // left in a frozen arena -- remote characters stuck mid-stride, nothing
  // responding, no explanation. Re-announce ourselves and find out.
  net.on("status", (state) => {
    if (state !== "open" || !mp.active || !mp.roomId) return;
    mp.resyncing = true;
    net.joinRoom(mp.roomId);
    setTimeout(() => {
      if (!mp.resyncing) return;
      mp.resyncing = false;
      onMatchLost?.("The server did not answer.");
    }, 5000);
  });

  // Either of these means the server still has our room and we are back in it.
  net.on("start", () => { mp.resyncing = false; });
  net.on("snap", () => { mp.resyncing = false; });

  const start = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000);
    const off = net.on("start", (msg) => {
      clearTimeout(timer);
      off();
      resolve(msg);
    });
    // We arrived by navigation, so the match is already running: re-announce
    // ourselves and the server replies with our assignment (see the `join`
    // handler's already-in-room branch in server/gameserver.mjs).
    net.joinRoom(ROOM_ID);
  });

  if (!start) return null;

  mp.active = true;
  mp.roomId = ROOM_ID;
  mp.myTeam = start.you.team;
  mp.owned = new Set(start.owned.map((o) => o.entityId));
  for (const o of start.owned) mp.bySlot.set(`${o.team}:${o.slot}`, o.entityId);
  mp.myEntityId = start.owned.find((o) => !o.isBot)?.entityId || null;
  mp.started = true;
  return start;
}

// The first snapshot carries every entity in the match -- id, team, slot and
// name -- which is everything needed to build the scene once, correctly, for
// remote players as well as our own. Waiting the one tick for it is far
// simpler than creating placeholder fighters and patching them up later.
export function waitForRoster(timeoutMs = 3000) {
  if (mp.roster.length) return Promise.resolve(mp.roster);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(mp.roster); }, timeoutMs);
    const off = net.on("snap", () => {
      clearTimeout(timer);
      off();
      resolve(mp.roster);
    });
  });
}

export function ownsEntity(entityId) {
  return mp.owned.has(entityId);
}

export function bindFighter(entityId, fighter) {
  mp.fighterByEnt.set(entityId, fighter);
  mp.entByFighter.set(fighter, entityId);
  fighter.entityId = entityId;
  fighter.isRemote = !mp.owned.has(entityId);
}

export function fighterFor(entityId) {
  return mp.fighterByEnt.get(entityId) || null;
}

// Report every entity we own. Called once per frame; the server samples
// whatever arrived most recently, so dropping some of these is harmless.
export function reportOwned(fighters) {
  if (!mp.active) return;
  const ents = [];
  for (const f of fighters) {
    if (!f.entityId || f.isRemote || !f.alive) continue;
    ents.push({
      id: f.entityId,
      x: f.x, y: f.y, z: f.z,
      facing: f.facing,
      anim: f._lastClipName || "RifleAimingIdle",
      name: f.netName || undefined,
    });
  }
  if (ents.length) net.sendEntities(ents);
}

// Smoothly chase the last known server transform instead of teleporting on
// each snapshot -- snapshots arrive ~15x/sec but we render at 60.
export function applyRemoteTransforms(fighters, dt) {
  if (!mp.active) return;
  const LERP = Math.min(1, dt * 12);
  for (const f of fighters) {
    if (!f.isRemote || !f.entityId) continue;
    const target = mp.remote.get(f.entityId);
    if (!target) continue;
    f.x += (target.x - f.x) * LERP;
    f.y += (target.y - f.y) * LERP;
    f.z += (target.z - f.z) * LERP;
    // shortest way round the circle, so facing never spins the long way
    let d = target.facing - f.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    f.facing += d * LERP;
    f._netAnim = target.anim;
  }
}

export function claimHit(targetFighter, damage) {
  if (!mp.active || !targetFighter?.entityId) return;
  net.sendHit(targetFighter.entityId, damage);
}

export function reportShot(from, x, y, z, dx, dy, dz) {
  if (!mp.active) return;
  net.sendShot({ from, x, y, z, dx, dy, dz });
}

export function leave() {
  if (!mp.active) return;
  net.leaveRoom();
  net.disconnect();
  mp.active = false;
}
