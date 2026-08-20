# Neegy backend — X (Twitter) sign-in and player records

Zero-dependency Node server (`node:http` + `node:crypto` only, no `package.json`
needed). It serves the static site **and** the auth/player API from one origin.

```bash
node server/server.mjs
```

Then open <http://localhost:5174/arena3d/dashboard.html>.

Single origin is deliberate: no CORS to configure, and the session cookie is
first-party, so browser tracking protection will not drop it.

## Why there has to be a server at all

X login cannot be done from a static page, for three independent reasons:

1. The app credentials are **OAuth 1.0a** (Consumer Key/Secret). Every request
   is signed with HMAC-SHA1 using the consumer secret — putting that in browser
   JavaScript hands it to anyone who opens devtools.
2. Even X's OAuth 2.0 PKCE *public client* flow (which needs no secret) cannot
   finish in a browser: `api.x.com` sends no CORS headers on the token endpoint.
3. The **Bearer Token is app-only**. It reads public data but can never say
   *which user* is signed in, so it is not usable for login at all.

## Configuration

Credentials are read from `.env` at the repo root (gitignored), and any real
environment variable **overrides** the file — so on Hostinger (or any host with
an env-var panel) set them there and leave `.env` out of the deploy entirely.

```
X_CONSUMER_KEY=...
X_CONSUMER_SECRET=...
X_BEARER_TOKEN=...        # not used by login; kept for future app-only API calls
PORT=5174                 # optional
```

## App type: PIN mode vs. redirect mode

The app is currently registered in the X developer portal as a **desktop /
native** app. Those only accept the literal callback value `oob`; any real
callback URL is rejected with:

```
<error code="417">Desktop applications only support the oauth_callback value 'oob'</error>
```

So `/auth/x/login` handles both, and picks automatically:

- **redirect mode** (preferred) — X bounces the user straight back to
  `/auth/x/callback`. One click, no typing.
- **PIN mode** (current fallback) — the server serves a small page: approve at
  X, copy the PIN it shows, paste it back. Works today with no portal changes.

To switch to redirect mode, in the X developer portal under the app's
**User authentication settings**:

1. Set **App type** to `Web App, Automated App or Bot`.
2. Add the callback URL — `http://localhost:5174/auth/x/callback` for local
   work, and the deployed `https://.../auth/x/callback` for production. X
   requires an exact match, so add every origin that will be used.
3. Make sure **Request email from users** stays off — we do not need it, and
   asking for it adds a review requirement.

No code change is needed; the 417 simply stops happening and the redirect
branch takes over.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/x/login` | Start sign-in (redirects to X, or serves the PIN page) |
| GET | `/auth/x/callback` | OAuth redirect target (redirect mode) |
| POST | `/auth/x/pin` | Finish sign-in from a pasted PIN (PIN mode) |
| GET | `/api/me` | `{ player }` — null when signed out |
| POST | `/api/logout` | Destroys the session |
| GET | `/api/leaderboard` | Top 20 real players by XP |
| POST | `/api/match-result` | `{ kills, deaths, xp }` — requires a session |

## Data

`server/data/players.json` and `server/data/sessions.json`, written via
write-to-temp-then-rename so a crash mid-write cannot truncate them. Both are
gitignored. Player records are keyed `x:<numeric X user id>` — the handle can
be renamed on X, the numeric id cannot, so the id is what identifies a player.

A plain JSON file is fine at this scale (a few rows per match, one writer). If
the game ever gets concurrent writers, this is the module to swap for a real
database — nothing else touches the filesystem.

## Security notes

- Session cookie is `HttpOnly` (page scripts and any XSS cannot read it),
  `SameSite=Lax` (survives the redirect back from X, blocks cross-site POSTs),
  and gains `Secure` automatically when `x-forwarded-proto: https` is seen.
- `.env` and the whole `/server/` path are refused by the static file handler,
  and paths are checked to stay inside the project root.
- `/api/match-result` **clamps** incoming numbers (≤100 kills, ≤100 deaths,
  ≤10000 XP per match). This is not anti-cheat — the browser reports its own
  score, so a determined player can still inflate it within those bounds. Real
  anti-cheat needs authoritative server-side match simulation, which is the
  same work as real multiplayer.

## Client side

`arena3d/account.js` wraps all of this and **degrades**: if `/api/me` does not
answer with a `player` key, `backendAvailable` is false and the dashboard falls
back to the localStorage guest profile exactly as before, hiding the X button
rather than offering a dead link.

The backend check is a *positive handshake*, not a content-type sniff, and that
matters: `npx serve` returns its 404 as `application/json` when the request asks
for JSON, which looks exactly like a live backend if you only check the header.
