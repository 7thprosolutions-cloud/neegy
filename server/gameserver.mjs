// Wire protocol between the browser and the room state machine.
//
// One WebSocket per browser tab. The socket inherits the HTTP session cookie
// from the upgrade request, so a signed-in player is identified by their real
// X handle here without a second login step; everyone else plays as a guest
// under the name they typed on the dashboard.
//
// Reconnect adoption: the browser navigating from the dashboard to the game
// page opens a *new* socket, which would otherwise read as "player left the
// room" right as their match begins. So each tab carries a stable id
// (sessionStorage, sent in `hello`), a dropped client lingers in its room for
// a grace period instead of being removed immediately, and a reconnect with a
// known tab id re-binds to that same client -- same id, same team, same
// entities. That also covers a brief network blip mid-match for free.
//
// Message shapes are documented in README-multiplayer.md.
import crypto from "node:crypto";
import { attachWebSocketServer } from "./ws.mjs";
import { sessionPlayer } from "./store.mjs";
import {
  rooms, createRoom, joinRoom, leaveRoom, listRooms, roomStateMessage,
  beginCountdown, startMatch, applyEntityStates, applyHit, checkMatchOver,
  snapshot, sweepRooms, ensurePermanentRooms, reviveOwnEntity, TICK_MS,
} from "./rooms.mjs";
import { entitlementsOf } from "./store.mjs";

const clients = new Map(); // clientId -> client
const clientsByTab = new Map(); // tabId -> client

// How long a disconnected client keeps its slot, team and entities.
const RECONNECT_GRACE_MS = 25000;

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

function send(client, msg) {
  if (client.conn?.open) client.conn.send(msg);
}

function broadcast(room, msg, exceptId = null) {
  for (const c of room.clients.values()) {
    if (c.id !== exceptId) send(c, msg);
  }
}

function pushRoomState(room) {
  if (!room) return;
  broadcast(room, roomStateMessage(room));
  pushRoomList();
}

// Anyone sitting on the dashboard (not inside a room) sees the browser list
// update live as rooms come and go.
function pushRoomList() {
  const msg = { t: "rooms", rooms: listRooms() };
  for (const c of clients.values()) {
    if (!c.room) send(c, msg);
  }
}

function fail(client, message) {
  send(client, { t: "error", message });
}

// Everything a client needs to (re)build its view of an in-progress match.
function matchStateMessage(room, client) {
  return {
    t: "start",
    mode: room.mode,
    roomName: room.name,
    roomId: room.id,
    you: { team: client.team },
    owned: room.assignments?.get(client.id) || [],
    resumed: true,
  };
}

let lastPermanentCheck = 0;

export function attachGameServer(httpServer) {
  // Stand up the always-on 1v1/3v3/5v5 servers before the first client can
  // connect, so the browser list is never empty.
  const permanentCount = ensurePermanentRooms();
  console.log(`  servers:       ${permanentCount} always-on rooms (1v1 / 3v3 / 5v5)`);

  attachWebSocketServer(httpServer, {
    path: "/ws",
    onConnection(conn, req) {
      const player = sessionPlayer(readCookie(req, "neegy_sid"));
      const client = {
        id: "c-" + crypto.randomBytes(6).toString("hex"),
        conn,
        tabId: null,
        // A signed-in X handle always wins over a self-declared guest name --
        // otherwise anyone could type "@someone_else" into the name box and
        // appear as them in the lobby and on the scoreboard.
        playerId: player?.id || null,
        handle: player?.handle || null,
        avatar: player?.avatar || null,
        displayName: player ? "@" + player.handle : "Guest",
        signedIn: Boolean(player),
        room: null,
        team: null,
        disconnectedAt: null,
      };
      clients.set(client.id, client);
      conn._client = client;

      // Welcome is deferred until `hello` resolves whether this socket is a
      // brand-new client or a reconnect adopting an existing one -- otherwise
      // the client gets two welcomes with two different ids and has to guess
      // which is authoritative. The timer covers a client that never sends
      // hello at all (a raw socket, a test harness) so it is not left silent.
      client.welcomeTimer = setTimeout(() => {
        if (conn._client === client && !client.tabId) sendWelcome(client);
      }, 1000);

      conn.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return fail(conn._client, "Malformed message.");
        }
        try {
          handle(conn._client, msg, conn);
        } catch (err) {
          fail(conn._client, err.message || "Something went wrong.");
        }
      });

      conn.on("close", () => {
        const c = conn._client;
        if (!c || c.conn !== conn) return; // already adopted by a newer socket
        c.conn = null;
        if (c.room) {
          // Keep the slot warm -- they may just be navigating to the game page.
          c.disconnectedAt = Date.now();
          pushRoomState(c.room);
        } else {
          dropClient(c);
          pushRoomList();
        }
      });
    },
  });

  // One timer drives every room: start countdowns that have elapsed, push
  // snapshots for live matches, and end matches whose last defender fell.
  const timer = setInterval(() => {
    reapDisconnected();
    for (const room of [...rooms.values()]) {
      if (room.state === "countdown" && Date.now() >= room.countdownEndsAt) {
        const assignments = startMatch(room);
        for (const c of room.clients.values()) {
          send(c, {
            t: "start",
            mode: room.mode,
            roomName: room.name,
            roomId: room.id,
            you: { team: c.team },
            // the slots this particular client is responsible for simulating
            owned: assignments.get(c.id) || [],
          });
        }
        pushRoomList();
        continue;
      }
      if (room.state === "playing") {
        broadcast(room, snapshot(room));
        // Either the result, or the one-shot notice that the losing side has
        // a few seconds to spend an extra life before it becomes the result.
        const verdict = checkMatchOver(room);
        if (verdict) {
          broadcast(room, verdict);
          if (verdict.t === "over") pushRoomList();
        }
      }
    }
    sweepRooms();
    // Defensive only -- leaveRoom() keeps permanent rooms alive, so this is
    // just a safety net. Throttled to ~10s because rescanning every room 15
    // times a second to check for something that should never happen is waste.
    if (Date.now() - lastPermanentCheck > 10000) {
      lastPermanentCheck = Date.now();
      ensurePermanentRooms();
    }
  }, TICK_MS);
  timer.unref?.();
}

function sendWelcome(client) {
  send(client, {
    t: "welcome",
    you: {
      id: client.id, name: client.displayName,
      handle: client.handle, avatar: client.avatar, signedIn: client.signedIn,
      entitlements: client.playerId ? entitlementsOf(client.playerId) : { extraLives: 0, privateGames: 0 },
    },
    rooms: listRooms(),
  });
}

function dropClient(c) {
  clearTimeout(c.welcomeTimer);
  clients.delete(c.id);
  if (c.tabId && clientsByTab.get(c.tabId) === c) clientsByTab.delete(c.tabId);
}

function reapDisconnected() {
  const cutoff = Date.now() - RECONNECT_GRACE_MS;
  for (const c of [...clients.values()]) {
    if (c.conn || c.disconnectedAt === null || c.disconnectedAt > cutoff) continue;
    const room = c.room;
    const stillThere = room ? leaveRoom(c) : null;
    dropClient(c);
    if (stillThere) pushRoomState(stillThere);
    else pushRoomList();
  }
}

// Rebinds an existing (disconnected) client onto a freshly opened socket,
// discarding the throwaway client that socket was given on connect.
function adopt(prior, fresh, conn) {
  clearTimeout(fresh.welcomeTimer);
  clients.delete(fresh.id);
  prior.conn = conn;
  prior.disconnectedAt = null;
  // A reconnect may carry a *newer* identity than the original socket did --
  // e.g. the player signed in with X between the two connections.
  if (fresh.signedIn) {
    prior.playerId = fresh.playerId;
    prior.handle = fresh.handle;
    prior.avatar = fresh.avatar;
    prior.displayName = fresh.displayName;
    prior.signedIn = true;
  }
  conn._client = prior;
  return prior;
}

function handle(client, msg, conn) {
  switch (msg.t) {
    case "hello": {
      const tabId = String(msg.tabId || "").slice(0, 64);
      if (!tabId) return;
      clearTimeout(client.welcomeTimer);
      const prior = clientsByTab.get(tabId);
      if (prior && prior !== client && !prior.conn) {
        const resumed = adopt(prior, client, conn);
        sendWelcome(resumed);
        if (resumed.room) {
          send(resumed, roomStateMessage(resumed.room));
          if (resumed.room.state === "playing") send(resumed, matchStateMessage(resumed.room, resumed));
          pushRoomState(resumed.room);
        }
        return;
      }
      client.tabId = tabId;
      clientsByTab.set(tabId, client);
      sendWelcome(client);
      return;
    }

    case "name": {
      // Guests may name themselves; signed-in players may not rename away
      // from their X handle.
      if (client.signedIn) return;
      const name = String(msg.name || "").trim().slice(0, 20);
      client.displayName = name || "Guest";
      if (client.room) pushRoomState(client.room);
      return;
    }

    case "rooms":
      return send(client, { t: "rooms", rooms: listRooms() });

    case "create": {
      // A password turns this into a private server: listed by name, but only
      // joinable by someone who has the password.
      const room = createRoom({
        name: msg.name, mode: msg.mode, hostClient: client,
        password: msg.password ? String(msg.password) : null,
      });
      joinRoom(room, client);
      send(client, { t: "joined", roomId: room.id });
      return pushRoomState(room);
    }

    case "join": {
      const room = rooms.get(msg.roomId);
      if (!room) return fail(client, "That server no longer exists.");
      // Already in it (a reconnect that re-sends join) -- just resync.
      if (client.room === room) {
        send(client, { t: "joined", roomId: room.id });
        send(client, roomStateMessage(room));
        if (room.state === "playing") send(client, matchStateMessage(room, client));
        return;
      }
      joinRoom(room, client, msg.password);
      send(client, { t: "joined", roomId: room.id });
      return pushRoomState(room);
    }

    case "revive": {
      const room = client.room;
      if (!room) return fail(client, "You are not in a match.");
      const result = reviveOwnEntity(room, client);
      if (result.error) return fail(client, result.error);
      // Everyone needs to know, or the revived player would be walking around
      // while other screens still show them dead and unshootable.
      broadcast(room, { t: "revived", id: result.entityId, hp: 100 });
      send(client, { t: "entitlements", entitlements: entitlementsOf(client.playerId) });
      return;
    }

    case "leave": {
      const room = client.room;
      if (!room) return;
      const stillThere = leaveRoom(client);
      send(client, { t: "left" });
      if (stillThere) pushRoomState(stillThere);
      return pushRoomList();
    }

    case "start": {
      const room = client.room;
      if (!room) return fail(client, "You are not in a server.");
      if (room.hostId !== client.id) return fail(client, "Only the host can start the match.");
      if (!beginCountdown(room)) return fail(client, "This match cannot start right now.");
      return pushRoomState(room);
    }

    case "ents":
      if (client.room) applyEntityStates(client.room, client, msg.ents);
      return;

    case "shot":
      // Purely cosmetic relay (tracer + muzzle flash on other screens).
      // Damage does not travel this path -- see "hit".
      if (client.room && client.room.state === "playing") {
        broadcast(client.room, {
          t: "shot", from: msg.from,
          x: msg.x, y: msg.y, z: msg.z, dx: msg.dx, dy: msg.dy, dz: msg.dz,
        }, client.id);
      }
      return;

    case "hit": {
      const room = client.room;
      if (!room) return;
      const events = applyHit(room, client, msg);
      if (events) for (const e of events) broadcast(room, e);
      return;
    }

    default:
      return fail(client, "Unknown message type.");
  }
}
