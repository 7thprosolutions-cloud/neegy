# Neegy multiplayer — architecture and wire protocol

Real-time play over a WebSocket on the same origin/port as the site and the
auth API (`ws://<host>/ws`). Run it with the same command:

```bash
node server/server.mjs
```

## Where authority lives

This is **not** an authoritative simulation, and that is a deliberate scope
decision, not an oversight.

| Owned by the server | Owned by the client |
|---|---|
| Who is in a room, team assignment | Its own movement and collision |
| When a match starts and ends | Its own aiming and firing |
| Health, damage, deaths | The bots it was assigned (host only) |
| Scoring, and writing results to player records | Rendering, effects, sound |

Making movement authoritative would mean reimplementing the arena's movement,
collision, ramps, buildings and physics on the server and reconciling it
against client prediction — a rewrite of the game, not a feature. So each
client reports where it is and the server relays that.

**The consequence, stated plainly: movement is cheatable.** A modified client
can teleport or move faster. Damage is *not* freely cheatable — health lives on
the server, friendly fire is refused, hits are rate-limited to one per 40ms and
clamped to 60 per hit — but the hit *claim* still originates from the shooter,
so a modified client could still claim hits it did not earn. Closing that needs
server-side hit validation against server-side positions, which needs
authoritative movement. Worth knowing before real stakes (money, ranked
ladders) ride on a match result.

## Entities, not players

A client can own more than itself. When a match starts with empty slots, the
**host simulates the remainder as bots** using the single-player AI that
already exists, and reports them like any other entity.

Without this, a 3v3 would need six humans and a 5v5 would need ten before the
mode could be played at all. With it, one player can start any mode instantly
and real players simply replace bots as they join.

Entity ids: `p:<clientId>` for a human, `b:<team>:<slot>` for a bot. Every
entity carries its `(team, slot)`, and every client builds its scene from the
shared `TEAM_SPAWNS` table using those — so the same entity is the same
character, at the same spawn, on every screen.

## Reconnect adoption

Navigating from the dashboard to the game page opens a **new** socket, which
would otherwise read as "this player left" at the exact moment their match
begins. So:

- Each browser tab holds a stable id in `sessionStorage` (not `localStorage` —
  two tabs are two players and must not share one) and sends it in `hello`.
- A dropped client keeps its slot, team and entities for `RECONNECT_GRACE_MS`
  (25s) instead of being removed immediately.
- A connect carrying a known tab id re-binds to that same client rather than
  creating a new one, and is re-sent its match assignment.

This covers a short network blip mid-match for free.

`welcome` is deliberately deferred until `hello` resolves whether the socket is
new or a reconnect — otherwise a client would receive two welcomes with two
different ids and have to guess which one is real.

## The frame-stall watchdog

`requestAnimationFrame` stops firing whenever the browser decides a page is not
worth drawing. In a live match that means a player stops reporting position and
**stands frozen on everyone else's screen while still being shootable**.

So `arena3d.js` runs a watchdog: if no frame has run for ~75ms and a match is
live, it simulates on a timer and skips the render.

It is keyed on *frames having actually stopped*, not on `document.hidden` —
because a page can report `visibilityState: "visible"` and still never receive
a frame. That was verified directly here: an unfocused, non-compositing window
reports `hidden === false` while rAF never fires. A visibility-based check
misses exactly that case.

## Wire protocol

All messages are JSON with a `t` (type) field.

### Client → server

| `t` | Payload | Notes |
|---|---|---|
| `hello` | `tabId` | Always sent first; drives reconnect adoption |
| `name` | `name` | Guests only; ignored for signed-in players |
| `rooms` | — | Request the room list |
| `create` | `name`, `mode` | Creates and joins |
| `join` | `roomId` | Re-sending while already in the room resyncs |
| `leave` | — | |
| `start` | — | Host only |
| `ents` | `ents[]` | Transforms for entities this client owns |
| `shot` | `from`, position, direction | Cosmetic relay only |
| `hit` | `target`, `damage` | A *claim*; the server rules on it |

There was also a `grenade` relay. Grenades were removed pre-launch — see the
grenade section in `arena3d/HANDOFF.md` for exactly what to restore, including
the one thing that was never finished: grenade damage was applied locally, not
routed through the server the way bullet hits are.

### Server → client

| `t` | Payload |
|---|---|
| `welcome` | `you {id, name, handle, avatar, signedIn}`, `rooms` |
| `rooms` | `rooms[]` — pushed live to anyone not in a room |
| `room` | Full room state incl. `members`, `hostId`, `countdownMs` |
| `joined` | `roomId` |
| `start` | `mode`, `roomName`, `roomId`, `you {team}`, `owned[]`, `resumed?` |
| `snap` | `ents[]` — ~15/sec, positions rounded to 2dp |
| `damage` | `id`, `hp`, `by` |
| `death` | `id`, `by` |
| `over` | `winningTeam`, `results[]` |
| `left`, `error` | |

## Client modules

- **`arena3d/net.js`** — transport. Connection, `hello`, reconnect with capped
  backoff, an event bus, and a `ready()` that settles on open-or-unavailable so
  callers can branch without racing the socket.
- **`arena3d/mp.js`** — game glue. Ownership, the roster, snapshot
  interpolation, hit claims. Everything is gated on `mp.active`.
- **`arena3d/dashboard.js`** — real room browser and lobby when online.
- **`arena3d/arena3d.js`** — builds the match from the server roster, skips
  local simulation for remote characters, defers damage/match-end to the server.

## Degradation

Multiplayer is an upgrade, never a requirement. With no reachable server:

- the dashboard shows an `OFFLINE` badge and the original local mock lobby;
- the game page never even opens a socket (it only connects when the URL has
  `?room=`), and plays the normal offline match against bots;
- if a `?room=` join fails, it falls through to an offline match rather than
  leaving the player on a dead button.

## Limits

`MAX_ROOMS` 40, snapshot rate ~15/sec, max WebSocket payload 256KB, room state
is in memory only (a server restart clears rooms; player records persist).
Nothing here is horizontally scalable — one process holds all room state.
