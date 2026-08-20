# Deploying Neegy Arena

## The constraint that drives everything

The V1 site (`neegy.life`) is a **static** build. The arena's auth and
multiplayer need a host that **runs a Node process and allows WebSocket
upgrades**. A static host cannot do either, at any plan tier.

The site, the API and the WebSocket also deliberately share **one origin**. That
is what makes the session cookie first-party (so browser tracking protection
cannot drop it) and removes CORS entirely. `server/server.mjs` serves the static
files too, so one process covers everything — including the V1 2D game at `/`,
since it serves the whole repo root.

---

## Chosen path: Hostinger "Deploy Web App" (GitHub)

Hostinger's managed Node hosting: **Websites → Add website → Deploy Web App →
Import Git repository**. It auto-detects the framework, installs, runs a build
command and starts the app; pushing to the connected branch triggers a rebuild.
It issues a temporary `*.hostingersite.com` domain, so `neegy.life` can stay on
the V1 static site until V2 is ready to take the domain over.

### What had to change for this to work at all

Hostinger's docs list **"a Node.js project with a `package.json`"** as a hard
requirement — it is what tells the platform the Node version and the start
command. This repo **gitignored `package.json`**, so a GitHub deploy would have
failed on the first attempt. It is now committed, with no runtime dependencies:

```json
{ "engines": { "node": ">=18" },
  "scripts": { "start": "node server/server.mjs" } }
```

Zero runtime dependencies is a genuine advantage here: `npm install` has nothing
to fetch, so builds are fast and cannot break on a native module. (`sharp` is a
devDependency used only by the local texture script.)

### Settings

| Field | Value |
|---|---|
| Repository | `7thprosolutions-cloud/neegy` |
| Node version | 18, 20, 22 or 24 — any is fine |
| Build command | leave empty (or `npm run build`, which is a no-op) |
| Start command | `npm start` → `server/server.mjs` |
| Env vars | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `DATA_DIR` |

Do **not** set `PORT` or `HOST` by hand. The platform supplies `PORT` and the
server reads it (`process.env` overrides the `.env` file — see `env.mjs`).
Binding the wrong port is Hostinger's own listed top cause of a failed deploy.
`HOST` defaults to `0.0.0.0`, which is what a managed platform needs.

Never commit `.env`. It is gitignored; put the values in Hostinger's environment
variables panel instead.

### The two things Hostinger's docs do not answer

Their documentation is silent on **WebSocket upgrades** and **filesystem
persistence**, and the arena needs both. Rather than guess, run the smoke test
against the deployed URL:

```bash
node scripts/check-deploy.mjs https://your-app.hostingersite.com
```

It verifies the dashboard and API respond, that `.env` and `/server/*` are
refused, that the model is cached — and performs a **raw WebSocket handshake**
against `/ws`, which is the single most likely thing to be missing.

- **If the WebSocket check fails**, the platform is not forwarding `Upgrade`.
  The arena still loads and plays offline against bots (the lobby shows
  `OFFLINE`), but real multiplayer is impossible and the VPS path below is
  required instead.
- **For persistence**, run the script once, sign in so a player record exists,
  push a trivial change to trigger a redeploy, then run it again. If the player
  count drops to zero the filesystem is ephemeral: point `DATA_DIR` at
  persistent storage, or move to the VPS. The server prints its data directory
  and record count at startup, so a wipe shows up in the logs immediately.

### After the domain is connected

Add `https://neegy.life/auth/x/callback` as a Callback URI in the X developer
portal, alongside the `*.hostingersite.com` one — X requires exact matches, so
every origin that will be used needs its own entry.

---

## Fallback: VPS (guaranteed to work)

Use this if either check above fails. A VPS is already in the account sidebar.

1. **Node 18+.** No `npm install` needed — zero runtime dependencies.

2. **Environment.** Do not deploy `.env`; set real environment variables:

   ```
   X_CONSUMER_KEY=...
   X_CONSUMER_SECRET=...
   PORT=5174
   HOST=127.0.0.1     # bind loopback; let the proxy face the internet
   DATA_DIR=/var/lib/neegy
   ```

3. **Reverse proxy with TLS.** It must forward the WebSocket upgrade and set
   `X-Forwarded-Proto`, which is what makes the session cookie `Secure`:

   ```nginx
   location / {
       proxy_pass         http://127.0.0.1:5174;
       proxy_http_version 1.1;
       proxy_set_header   Upgrade $http_upgrade;      # required for /ws
       proxy_set_header   Connection "upgrade";       # required for /ws
       proxy_set_header   Host $host;
       proxy_set_header   X-Forwarded-Proto $scheme;  # required for Secure cookie
       proxy_read_timeout 3600s;                      # WebSockets are long-lived
   }
   ```

   Without `proxy_read_timeout`, the default 60s silently drops players
   mid-match. Without the `Upgrade`/`Connection` headers, `/ws` fails outright
   and the game falls back to offline mode.

4. **Keep it running** (systemd):

   ```ini
   [Service]
   ExecStart=/usr/bin/node /var/www/neegy/server/server.mjs
   WorkingDirectory=/var/www/neegy
   Restart=always
   EnvironmentFile=/etc/neegy.env
   ```

   The server handles `SIGTERM`/`SIGINT` gracefully: it stops accepting new
   connections and lets in-flight requests finish (5s cap, because WebSockets
   never close on their own).

---

## Persistence

`DATA_DIR` (default `server/data/`) holds player records and sessions. It is
gitignored, so a deploy neither ships nor overwrites it — but it is not backed
up either. Back it up, or move to a real database; `store.mjs` is the only
module that touches the filesystem.

Room state is in memory: a restart drops open rooms and in-progress matches.
Player records survive.

## Assets

`arena3d/assets/shooter_character.glb` is ~3.5MB.
`shooter_character.orig.glb` (~19MB) is the pre-compression original, kept as a
local backup and **gitignored** so it is never deployed — nothing loads it. If
the model is ever re-exported, re-run
`node scripts/compress-character-texture.mjs` and bump the `?a=` marker in
`arena3d/character.js`.

## Repo notes

`package-lock.json` stays gitignored (nothing to lock — no runtime deps).
`arena3d/` and `server/` were untracked until this work; they must be committed
for any GitHub-based deploy to see them.
