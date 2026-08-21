# Neegy Arena 3D — handoff notes (rewritten, previous version is stale)

Read this file first before touching anything in `arena3d/`. It supersedes the old handoff content below the "OLD NOTES" marker at the bottom, which describes an earlier, now-replaced version of the character/game (procedural gold-suit character, single AI opponent, no dashboard). Almost everything has changed since then.

## Where things stand — architecture

- **`arena3d/dashboard.html` + `arena3d/dashboard.js` + `arena3d/dashboard.css`** — the entry point. Player picks a display name (localStorage, stands in for a real X handle until OAuth login exists), browses/creates public "servers" (name + mode: 1v1/3v3/5v5), joins a lobby that shows "Waiting for N more players…" and mock-fills with bots after a short delay, then navigates to `arena3d/?mode=<mode>&server=<name>` to actually launch the match. Also shows a local leaderboard (kills/XP, mixed with placeholder mock entries) and an "Upgrades" panel (Life Refill 0.1 SOL / Ammo / Skin) that is **intentionally all "COMING SOON", fully non-functional, no payment code** — that was explicit scope for now.
- **`arena3d/profile.js`** — the only "backend" that exists: localStorage-based player profile (name/kills/deaths/xp/gamesPlayed) and custom server list. `MODES` (`1v1`/`3v3`/`5v5` → team size), `XP_PER_KILL`/`XP_PER_GAME`, `FLAVOR_SERVERS` (always-present placeholder public servers), `MOCK_LEADERBOARD`. Imported by both `dashboard.js` and `arena3d.js`.
- **`arena3d/index.html` + `arena3d/arena3d.js`** — the actual 3v3-style team-battle game (now supports 1v1/3v3/5v5 via the `?mode=` URL param, defaults to old 4v4 if opened directly with no param). Doubled-size arena (`ARENA_HALF=52`), teams spawn at opposite far ends and have to close the distance, cars/buildings/crates/trees scattered as cover (some standable), team-colored floating arrows + name-tag "holders" (dark pill background) over every bot's head, tactical bot AI (engage/cover state machine, burst-fire with a per-team concurrent-shooter cap), a full death → free-fly spectator mode (WASD+mouse, no collision, until your team wins/loses), and kills/XP get written back to the local profile at match end with a "BACK TO DASHBOARD" button alongside the rematch button.
- **`arena3d/character.js`** — loads `arena3d/assets/shooter_character.glb` (a real Mixamo-style rigged character — see "How the character pipeline got here" below) via `loadRiggedCharacterAsset()` (fetched **once**, promise-cached) and `instantiateRiggedCharacter()` (cheap per-fighter clone via `SkeletonUtils.clone()` — required for correctly cloning a `SkinnedMesh`'s skeleton, a plain `Object3D.clone()` does not work for this). Every fighter (player + all bots, both teams) uses this same rigged model now; the old procedural `makeCharacterModel()`/`loadCharacterModel()` path (character.glb, gold/suit tactical-suit build) is **no longer used by the live game** but is left intact since `showcase.js` still references it.
- **`server/` (repo root, not in `arena3d/`)** — a real zero-dependency Node backend: `server/server.mjs` serves the static site *and* the API from one origin (run `node server/server.mjs`, port 5174, replaces `npx serve` for anything auth-related). `oauth1.mjs` is a from-scratch OAuth 1.0a signer (validated against X's canonical test vector via `server/_selftest.mjs`), `xauth.mjs` is the three-legged "Sign in with X" flow, `store.mjs` is the JSON-file player/session store. **See `server/README-auth.md`** for endpoints, configuration, and the app-type/PIN-mode situation — read it before touching auth.
- **`arena3d/account.js`** — the client half. Wraps `/api/me`, `/api/logout`, `/api/leaderboard`, `/api/match-result`, and **degrades to the old localStorage-only behavior whenever no backend answers**, so the game still works on a plain static host. Backend detection is a *positive handshake* (200 + a `player` key), deliberately not a content-type check — `npx serve` returns its 404 as `application/json` when the request asks for JSON, which reads as a live backend and puts a dead "Sign in with X" link on a static page. That exact bug was hit and fixed during this work.
- **Multiplayer (`server/ws.mjs`, `server/rooms.mjs`, `server/gameserver.mjs`, `arena3d/net.js`, `arena3d/mp.js`)** — real cross-browser play over a WebSocket on the same origin as the site (`ws://<host>/ws`). **Read `server/README-multiplayer.md` before touching any of it** — it has the wire protocol, the authority split, and the three non-obvious design decisions (host-simulated bot fill, reconnect adoption, and the frame-stall watchdog) that are each there for a specific reason someone would otherwise "simplify" away. Short version: the server owns rooms/teams/health/damage/deaths/scoring; clients own their own movement and report it. `ws.mjs` is a hand-written RFC 6455 server (no `ws` dependency — this repo gitignores `package.json`, so npm state is untracked and a dependency is a deploy hazard).
- **Cache-busting**: every internal script/module import now carries a `?v=N` query param (bumped to `v=22` as of this writing) — **bump it on every future edit to `character.js`/`profile.js`/`arena3d.js`/`dashboard.js`**, or the static dev server (`npx serve`) can silently keep serving a stale cached copy of files that were imported without any version param, which cost significant debugging time this session (see below).

## How the character pipeline got here (skip if just fixing bugs)

The original in-game character was procedurally built (`makeCharacterModel()`) then upgraded to a Blender-modeled organic mesh (`build_character.py` → `character.glb`), both driven by hand-rotating named empty/pivot nodes (`animateCharacter()`), no real skeleton. Mid-session the user generated a **properly rigged version of the same character** on an external platform ("Basic Shooter Pack" — Mixamo-style rig, `mixamorig:*` bone names, full finger bones, 17 baked animation clips: Walking, RifleRun, Strafe/StrafeLeft/StrafeRight, FiringRifle, Reloading, RifleAimingIdle, RifleJump, TossGrenade, HitReaction, turns, backwards variants) and asked to switch the whole game over to it. That FBX pack lives in `C:\dev\Neegy\Sprite\Basic Shooter Pack\` (not committed) — it was imported into Blender, fixed for a 100x Mixamo import-scale bug, decimated from ~250k to ~20k vertices, exported to `shooter_character.glb`, and a CC0 gun (Kenney "Blaster Kit", `blaster-e`) was bone-parented to the right hand plus a separate grenade prop (`grenade-a`) exported alongside it (`arena3d/assets/grenade.glb`). The whole `character.js` rigged-model API (`loadRiggedCharacterAsset`/`instantiateRiggedCharacter`) and the team/AI/animation-clip-selection system in `arena3d.js` were built around this asset. This is not going to need re-deriving unless the character model itself changes again.

## FIXED: the forward/back "moves away then snaps back" bug

**Resolved.** Root cause found and verified with hard data, after six earlier attempts that
each addressed a real-but-different (or imagined) problem. Keep this section as the record of
what it actually was, because the wrong assumption in it is an easy one to make again.

**Root cause:** `shooter_character.glb`'s `Armature` node carries `rotation: [0.7071, 0, 0, 0.7071]`
— a +90 degree X rotation. That is Blender's Z-up -> glTF Y-up conversion applied at the *object*
level rather than baked into the bone data, which means **the bone-local axes are still Blender's**:
in Hips-bone space, **X = sideways, Y = forward/back, Z = vertical**.

`stripHorizontalRootMotion()` assumed the glTF convention (Y = up) and therefore froze **X and Z**,
deliberately leaving Y alone "so the vertical bob still plays". For this asset that is exactly
inverted. Per-clip Hips ranges from the raw glb:

| clip | rangeX | rangeY | rangeZ |
|---|---|---|---|
| RifleRun | 0.009 | **0.977** | 0.056 |
| Walking | 0.024 | **0.576** | 0.030 |
| WalkingBackwards | 0.027 | **0.650** | 0.037 |
| StrafeLeft | **0.605** | 0.034 | 0.029 |
| StrafeRight | **0.457** | 0.044 | 0.023 |
| RifleAimingIdle | 0.001 | 0.001 | 0.001 |

Forward travel lives on Y — the one axis that was never stripped, so it played at full strength.
Strafe travel lives on X — which *was* stripped, which is precisely why "sideways is fine" and
forward/back is not. The vertical bob lives on Z, which was being frozen (silently killing the bob).

Magnitude: `RifleRun` drifts ~0.98 units of un-stripped root motion, times `RIGGED_MODEL_SCALE`
(1.7) = **~1.66 world units**, with the camera only 2.4 units away. That is the whole symptom —
the character walks a full stride-length away from the camera during the clip and snaps back on
every loop restart.

Axis mapping confirmed three independent ways: (a) the quaternion maps local Z to world -Y;
(b) Hips rest Z = -0.454 -> world height 0.454, correct hip height on a ~1.1 m model;
(c) `RifleJump` is the only clip whose largest range is Z (0.115) — the jump.

**The fix** (`character.js`): `stripHorizontalRootMotion(clip, verticalAxis)` now freezes the two
*non-vertical* axes and preserves the vertical one, and `detectVerticalAxisIndex(scene)` derives
which axis that is from the rig's actual world orientation (whichever Hips-local axis ends up most
aligned with world up after the parent's world rotation) rather than assuming a convention — so a
re-export with different axis handling stays correct on its own. Note `GLTFLoader` sanitizes node
names and strips the colon out of Mixamo's `mixamorig:Hips` (it becomes `mixamorigHips`), so both
this and the debug readout match bones by `/hips/i` over the bone list, never by literal name.

**Verified** (in-browser, through the real `GLTFLoader` + `AnimationMixer` path, not just by
reading the glb): all 18 clips now have exactly 0.0000 horizontal drift and one identical Hips
start offset across every clip (so no cross-clip pop either), with the vertical bob preserved at
sensible magnitudes (RifleJump 0.093, RifleRun 0.048, RifleAimingIdle 0.001). Stepping a real
instantiated fighter's mixer through ~3 full `RifleRun` loops gives ranges X=0.0004, Y=0.007
(fade-in residue), Z=0.0564 — versus ~0.98 on Y before the fix.

Fixes 1-8 in the old list were left in place: `forceSeamlessLoop()` and `normalizeHipsPosition()`
are still correct and harmless, the `blur` -> `keys.clear()` handler (#6) fixed a genuinely separate
real bug, and the intent-based clip selection (#3) is the right design regardless.

**Still worth confirming in a real focused browser tab** (this harness can never run a gameplay
frame — see Environment notes). The `#debugReadout` box now has a `hipsLocal=` line showing the
Hips bone's local position live: **while walking forward/back, the first two numbers must stay
rock constant and only the third (the vertical bob) may move.** If the first two ever move again,
root motion is back.

### One known-imperfect leftover (low priority, not the bug above)

`forceSeamlessLoop()` forces every track's last keyframe to equal its first, on *every* clip —
including the one-shot clips (`HitReaction`, `Reloading`), which are played with
`LoopOnce` + `clampWhenFinished`. For those, it means the clip ends by snapping back to its own
start pose and clamping there. In practice they're crossfaded out immediately so it isn't visible,
but if a one-shot animation ever looks like it rewinds at the end, this is why — the fix would be
to only apply it to clips that actually loop.

## READ THIS FIRST — current state (most recent session)

**LAUNCHED.** `index.html` is now the new homepage (the V1 arcade moved to
`/arcade.html`, which the homepage links to). `neegy.life` serves it.

### The one thing that is still split, and why it matters

`neegy.life` is a **STATIC** deploy of this branch. Every page is there, but
there is **no Node process behind it** — `/api/*` and `/ws` both 404. The
server only runs on the Hostinger **Web App**, currently
`chocolate-gull-388433.hostingersite.com`.

So the homepage detects this: when `/api/me` does not answer on its own origin,
the play button points at the Web App instead, and players get the real game
(sign-in, live matches, upgrades) rather than a stub. Verified from
`neegy.life` itself — button routes across, socket connects LIVE, 9 servers
listed, X sign-in offered.

**To put everything on one domain: attach `neegy.life` to the Web App in
Hostinger.** Then `/api/me` answers locally, the redirect branch in `home.js`
stops firing on its own, and there is nothing to undo. The X callback
`https://neegy.life/auth/x/callback` is already registered, so sign-in works
the moment it switches.

### How players pay TODAY: QR only

The Phantom button is **switched off** behind `WALLET_BUTTON_ENABLED` in
`dashboard.js`. Not because it is broken -- it works, and the transaction it
builds is correct -- but because Phantom's domain reputation scanner blocks
connections from neegy.life outright: *"This dApp could be malicious"*, shown
before it ever looks at the transaction.

That is a false positive earned by being a young domain that asks for SOL, and
it needs a **delisting appeal**, not a code change. Phantom's blocklist is on
GitHub (`phantom/blocklist`); the *Learn more* link on the warning names the
scanning provider. Flip the constant back to `true` once it clears -- the whole
wallet flow is still there and still tested.

The `solana:` deep-link button is gone for a different reason: desktop browsers
usually have no handler registered for that scheme, so clicking it waits for an
app that never opens and reads as the dialog hanging. The QR carries the
identical request.

**Two bugs are fixed under here and both are easy to reintroduce:**

1. Phantom wants a serialized **TRANSACTION**, not a bare message. Handed a
   message it reads the leading 1 as "one signature follows", eats 64 bytes,
   then runs off the end -- *"Reached end of buffer unexpectedly"*. See
   `buildTransferTransactionBase58`.
2. Setting `display: block` on the buttons in the pay card **broke the HTML
   `hidden` attribute**, because an author display rule beats the UA
   stylesheet's `[hidden] { display: none }`. That silently disabled the guard
   that hides the `solana:` link off mainnet -- where a mainnet wallet reading
   a devnet request sends real money the server never sees. `[hidden]` is now
   forced with `!important`. **`hidden: true` in the DOM and "not visible on
   screen" are different claims; check the second one with a screenshot.**

### The 503 that ate an evening: shutdown held the port

Symptom: every request 503s while the runtime logs show a *completely clean
startup* seconds earlier. It looks like a crash that is not there.

Cause: the SIGTERM handler called `server.close()`, which waits for every
connection to end -- and this process holds **WebSockets**, which never end on
their own. The platform sends SIGTERM and starts the replacement ~200ms later;
the new instance found port 3000 still held, exited with EADDRINUSE, and
nothing was left serving.

Fixed twice over: shutdown destroys live sockets and hard-exits after 400ms
(**not** unref'd), and EADDRINUSE now retries for a few seconds instead of
exiting, because the previous instance letting go momentarily is the normal
case on a deploy. Two clean deploys in a row confirmed it.

**Also: do not push twice within a few minutes.** Overlapping auto-deploys
SIGTERM each other mid-boot and leave orphaned processes -- which is what
"ten SIGTERMs in one millisecond" was: several instances sharing one log.

### LIVE ON MAINNET. Real SOL. The env vars that must exist

    PORT=3000
    TREASURY_ADDRESS=2HEsBXsyrb2roxcUwPPKNW9eajm7mL6eKNCWU1XbrCnn
    ADMIN_TOKEN=<long random string>
    SOLANA_CLUSTER=mainnet-beta
    DATA_DIR=/home/u932119236/domains/chocolate-gull-388433.hostingersite.com/neegy-data
    X_CONSUMER_KEY / X_CONSUMER_SECRET

**`PORT=3000` IS LOAD-BEARING AND COST 30 MINUTES OF DOWNTIME.** Read this
before touching the environment variables panel again.

Editing env vars in hPanel **dropped the platform-injected PORT**. The app fell
back to its development default (5174) while Hostinger's proxy kept forwarding
to 3000, so every request 503'd — and the runtime logs showed a *completely
clean startup* the whole time, because from inside the process nothing was
wrong. It does not look like a config problem; it looks like a crash that
isn't there.

Two defences are now in place:

- the server accepts `PORT`, `APP_PORT`, `SERVER_PORT`, `NODE_PORT`, `HTTP_PORT`
- startup prints `port: 3000 (from PORT)`, or a loud warning when none was
  provided. **Check that line first** whenever the site 503s.

`ADMIN_TOKEN` gates `POST /api/admin/grant`, which is the only way to repair a
payment that is taken but not credited. 404 means it is unset; 403 means it is
set and guarding correctly.

### Storage is confirmed persistent

`payments: 3` and `players: 1` survived several restarts, so `payments.json`
outlives deploys — which is the one that matters, since it is the only record
that someone paid. `GET /api/health` reports `storageWritable` plus the
players/sessions/payments counts and the cluster; it is the fastest way to
check the box is still holding what it should.

One record was lost when neegy.life was attached to the Web App (2 players ->
1). No payments existed then, so nothing that mattered went with it.

### Ops notes learned the hard way

- **`SIGTERM -- shutting down` in the logs is normal.** It is the platform
  cycling the process on each deploy or env change, not a crash.
- The temporary `chocolate-gull-388433.hostingersite.com` URL **is dead** —
  connecting the domain moved it rather than adding one. `neegy.life` is the
  only origin now. `DATA_DIR` still names the old directory and still works;
  it is an absolute path that survived the move, so **do not "tidy" it**
  without moving the files first.
- The homepage's fallback in `home.js` (send players to the game host when
  this origin has no backend) is now dormant, because neegy.life answers
  `/api/me` itself. Leave it: it is the safety net if the domain is ever moved
  back to a static site.

### Historical: what the setup looked like before it went live

    TREASURY_ADDRESS=2HEsBXsyrb2roxcUwPPKNW9eajm7mL6eKNCWU1XbrCnn
    ADMIN_TOKEN=<any long random string>

The first switches purchasing on (devnet — test SOL). `ADMIN_TOKEN` is what
makes `POST /api/admin/grant` work, and that is **the only way to repair a
payment that is taken but not credited** — without it there is no manual path
at all. Set both together.

Real money needs a third, deliberately separate:

    SOLANA_CLUSTER=mainnet-beta

Until then the Upgrades panel reads "Checkout opens once SOL payments are
switched on" and the buy buttons stay disabled, which is the safe state.

### Deployment (all working)

- Hostinger **Web App** (Node), auto-deploys from `main` on every push. There is
  no way to turn auto-deploy off — Hostinger support confirmed. **Every push
  restarts the server and ends in-progress matches.** Do not push while people
  are playing; ask first.
- `neegy.life` is a **separate static deploy of the same `main` branch**. This
  bit us: replacing `index.html` published the new homepage to the live domain
  unintentionally. Anything written to `index.html` goes live immediately.
- Env vars set in Hostinger: `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `DATA_DIR`
  (`/home/u932119236/domains/chocolate-gull-388433.hostingersite.com/neegy-data`,
  deliberately outside `hbuilds/` so records survive redeploys).
- Entry file must be `server.js` in Hostinger's settings; output directory empty.
- `scripts/check-deploy.mjs <url>` verifies the deploy incl. a raw WebSocket
  handshake. `scripts/load-test.mjs` measures concurrency.

### X sign-in: WORKING (one-click redirect)

Real player `@EDthemountain` is in the store. Callback URLs must be registered
in the X portal **exactly, per origin** — the server sends whatever host it is
served from, derived from `X-Forwarded-Proto`. `https://neegy.life/auth/x/callback`
is registered; **register any new origin before switching domains** or sign-in
breaks with error 415.

### IN PROGRESS — paid upgrades (next session's job)

The user's spec: **0.1 SOL → 10 extra lives** (1 usable per match), and
**0.1 SOL → 5 private-server games** (password-protected rooms, creator sets the
password). Must be **fully automated** — no manual involvement.

**Treasury address (validated: 44 chars, decodes to 32 bytes):**
`6ocgsbQ463HtiYhT2M5Bp15XbsNA2H2Qh4TYhSgFFmfe`

Decisions already made with the user:
- **Devnet first**, then flip to mainnet.
- **Solana Pay QR + `solana:` link**, no wallet SDK (keeps zero dependencies).
  Confirmed to the user: this needs **no business verification or KYC** — funds
  go wallet-to-wallet, the server only *reads* the chain.
- Mechanics before payment.

**Done and tested:**
- `store.mjs`: `extraLives`/`privateGames` balances, `grantEntitlement`,
  `spendEntitlement` (returns null when empty — callers must refuse, not treat
  as zero), `entitlementsOf`, `findPlayerByHandle`.
- `POST /api/admin/grant` (header `x-admin-token`, needs `ADMIN_TOKEN` env; 404s
  when unset). Verified: refuses missing and wrong tokens, grants correctly.
  **This is also the manual-repair path if a real payment ever fails to credit.**
- `/api/me` and the WebSocket `welcome` both carry balances.

**Now VERIFIED — `scripts/test-upgrades.mjs` scores 32/32.** (It needs a seeded
fixture player; the exact setup commands are in the file's header comment.)
Covered: private room creation, the `isPrivate` flag, the password never
reaching any client, wrong/right password, the credit spent at countdown, the
revive, one-per-match enforcement, and that a refused revive charges nothing.

Two bugs were fixed to get there:

1. **The creator was locked out of their own private room.** `joinRoom()`
   skipped the password check for anyone already in `room.clients`, on the
   assumption that the creator was. They are not: `createRoom()` records them
   as `hostId` but the `joinRoom()` call immediately after is what puts them in
   `clients` — so at that instant the creator looks like an outsider arriving
   with no password. Everything downstream failed because there was never a
   room to join. The exemption is now `room.hostId === client.id`.

2. **An extra life was unspendable in 1v1.** A death that wiped a team ended
   the match on the very next 66ms tick, so the revive always arrived to a room
   already in state `over`. `checkMatchOver()` now holds the result open for
   `REVIVE_WINDOW_MS` (7s) — **but only when the wiped side actually has
   someone holding a spendable extra life**, so ordinary matches still end on
   the same tick they always did (measured: 64ms vs 7153ms). Both directions
   are regression-tested.

**Protocol note for the client work:** the server emits a one-shot
`{t:"reviveWindow", team, ms}` on the tick the window opens. Drive the death
prompt's countdown off that rather than hardcoding 7s, or the prompt and the
server's deadline will drift apart. `create` takes `password`, `join` takes
`password`, `revive` spends the life, `revived` broadcasts the result.

### Client UI for upgrades: DONE and verified in a real browser

All of it was driven through the actual UI against a live server, not asserted
from reading the code.

**Dashboard**
- Create form has a **Private server** checkbox + password field. The whole
  control is gated, with the reason shown next to it: `sign in with X to host
  one` / `no private games left` / `needs a game server`. All three states were
  checked in the browser. A password under 3 characters is refused client-side
  without tearing down the form.
- Private rooms are **listed with a lock badge** and a `UNLOCK` button rather
  than hidden, so friends find the server by name instead of swapping room ids.
- Clicking `UNLOCK` opens a styled password dialog (not `window.prompt`, which
  browsers suppress and which is indistinguishable from a phishing box). A
  wrong password shows the server's message **inside the dialog** and keeps it
  open; the right one closes it and drops them in the lobby.
- The lobby shows the lock, `· PRIVATE`, and the host's start button reads
  **START · SPENDS 1 CREDIT** — a paid action never sits behind a bare button.
- UPGRADES panel shows **real balances** from the server, live. Signed out it
  hides them entirely and nudges to sign in; showing "0 extra lives" to someone
  who has simply not signed in reads as a broken balance.

**In game (`?room=`) — two ways to spend one life, one allowance**

The primary route is a button **directly under your own health bar**, pressed
while you are still standing. This is the user's design and it is the better
one: you watch the bar go red and press the button, which is where your eyes
already are. Three states, updated every frame:

- **gone** — no life to spend, or already spent one this match
- **locked** — holding one, but above the health threshold (tooltip says why)
- **ready** — pulsing, pressable; **R** or click; refills to 100

The threshold is **50 health**, enforced on the server, not just in the HUD.
Without it a stray click at 96 health burns a paid item for four points. The
number travels in `welcome` as `lowHealth` so the button cannot light up at a
health the server would refuse.

The post-death prompt is kept as the **safety net**, because in a shooter you
are often not *about to* die, you are simply dead — a close-range burst gives
no moment to press anything, and a player who cannot spend what they paid for
will say so. It fires on `reviveWindow`, shows a bar draining against the
server's own deadline, and takes the same **R**.

Both routes send the same `revive` message, spend the same credit, and share
one allowance per match. The server decides which happened and reports it as
`wasDead` in the `revived` broadcast — only a real death has a spectator-mode
transition to undo.

Verified in a real browser, both routes:
- refill: wounded to 40 → button armed → clicked → bar 40% → 100%, button gone,
  match continued, balance 10 → 9, and the opponent received the broadcast so
  their view of the health bar reset too
- revive: died → prompt → clicked → back on our feet, match did **not** end
- expiry: prompt vanished, match called, nothing charged

Two deliberate choices worth knowing:
- The death prompt **releases pointer lock**, because a button that cannot be
  clicked is worse than one click to re-lock afterwards. The HUD button does
  not need to — `.hud` is `pointer-events:none` and the button opts back in.
- The countdown length comes from the server's `ms`, never a constant in the
  client, so the bar can only ever promise less time than the server honours.

**Testing note:** the in-game prompt cannot be exercised by hand at browser-tool
latency — the window is 7s and a tool round-trip eats most of it. What worked
was arming an in-page poller that clicks the instant the prompt appears, then
triggering the kill from a scripted Node opponent that speaks the wire protocol
(the harness in `scripts/test-upgrades.mjs` is reusable for this).

### Private servers are a 24-HOUR PASS, not per-match credits

0.1 SOL buys 24 hours of private-server access. Playing does not draw it down;
buying again while one is live **extends** rather than restarts it. The old
`privateGames` counter is gone -- `players.json` now carries `privateUntil`, a
millisecond timestamp, and `privateAccess(playerId)` in `store.mjs` is the only
thing that decides whether a pass is open.

`ENTITLEMENTS` now has a `type`: `count` (a stock you spend, i.e. extra lives)
or `window` (access on a clock). `spendEntitlement()` deliberately returns null
for a window -- there are no units to decrement, and a caller that thought
otherwise would be wrong in a way worth failing loudly.

The pass is checked at **every match start**, not only at room creation, so one
purchase cannot buy a permanent private server by never closing the tab.

### Room passwords are GENERATED, not chosen

Ten characters from a 31-glyph alphabet with `0 O 1 I L` left out, grouped as
`XXXXX-XXXXX`. They get read aloud and retyped from photos, so look-alikes cost
more in mistyped codes than they add in entropy, and matching is
case-insensitive.

This changed how they are stored, and the reasoning matters if anyone revisits
it. A *typed* password is a credential -- people reuse them, so it must be
hashed and unrecoverable. A *generated* per-room code is not: it exists for one
room on one evening, and its entire purpose is to be read off the screen and
sent to a friend, which hashing would make impossible. So it is held in clear,
and the protections sit where they actually apply:

- memory only, never written to disk, dies with the room
- only ever sent to the room's current host (`passwordForHost()`)
- never in `roomSummary()`, so it cannot ride out on the room list
- five wrong guesses per client buys a minute of silence

Protocol: `create` takes `private: true` (no password); `joined` comes back to
the host alone carrying `name` and `password`. A host who dismissed the dialog
asks again with `{t:"password"}` -- the server re-checks that they are still the
host rather than trusting a cached value. The name rides on `joined` because
that message arrives *before* the `room` message that would otherwise carry it.

## PAYMENTS: built, on devnet, disabled in production

**Production has no `TREASURY_ADDRESS` set, so payments are OFF there and the
Upgrades panel stays locked.** That is the safe default and nothing changes
until you set it. Everything defaults to devnet; going live is a deliberate
`SOLANA_CLUSTER=mainnet-beta`.

Env: `TREASURY_ADDRESS`, `SOLANA_CLUSTER` (default `devnet`), optional
`SOLANA_RPC_URL` to escape the public endpoint's rate limits.

### The shape of it, and why there is no KYC

**We never hold, move, or sign for funds.** The player's wallet sends SOL
straight to the treasury, wallet to wallet. This server only *watches* the
chain and, when it sees the transfer land, ticks a number up in `players.json`.
There is no private key anywhere in this codebase and nothing here worth
stealing. That is why no business verification, merchant account or KYC is
involved -- there is no intermediary to register with. Verification only ever
appears at the **off-ramp** (an exchange KYCs you when converting SOL to
ordinary money) and in **tax**, neither of which is triggered by taking payment.

Correlating a payment to a player is the only real problem, and Solana Pay
solves it: each invoice gets a fresh random 32-byte `reference` included in the
transaction as a read-only account, so `getSignaturesForAddress(reference)`
finds exactly the transaction that paid it without knowing the payer up front.

### Two ways to pay, one payment

- **Phantom connect** (desktop, primary). The server builds an **unsigned**
  transaction (`POST /api/pay/tx`, `server/solana-tx.mjs`) and the wallet signs
  it. Built server-side on purpose: one tested copy of the binary encoding
  instead of a second in the browser that could drift, and the amount,
  recipient and reference are fixed by the server rather than by the page.
  Any provider exposing the same shape works; it is not Phantom-specific.
- **Solana Pay QR + link** (phone). `arena3d/qr.js` is a from-scratch encoder,
  byte mode, versions 1-13, EC L and M.

### Files

- `server/base58.mjs` - checked against 12 published vectors incl. leading zeros
- `server/solana-tx.mjs` - unsigned legacy transaction message
- `server/payments.mjs` - invoices, chain verification, crediting, sweep
- `arena3d/qr.js` - QR encoder
- `scripts/test-payments.mjs`, `scripts/test-qr.mjs`, `scripts/devnet-pay.mjs`

### What is verified, and the one thing that is not

`scripts/test-payments.mjs` (**16/16**) drives a fake RPC and proves the
verifier refuses underpayment by one lamport, payment to another address, a
failed transaction, and a signature replayed against a second invoice -- and
that a dead RPC leaves an invoice *pending* rather than failing it.

`scripts/test-qr.mjs` (**19/19**) checks two ways, and needs both. Against the
**published** format/version tables from the standard, and by decoding the
matrix back with a Reed-Solomon syndrome check. The published table is what
caught a real bug: the version-information generator polynomial was the 10-bit
format one instead of the 13-bit version one. The round-trip was perfectly
happy with it, because the decoder was *told* the version rather than reading
it off the symbol. A self-consistent encoder/decoder pair will agree on their
own mistakes -- keep the external check.

**STILL NOT PROVEN, as of the mainnet launch: a funded transfer actually
landing and being credited.** Everything up to the wallet is verified; no real
SOL has moved. When the first purchase happens, watch the runtime logs for
`[pay] credited ...`. If the SOL leaves and that line does not appear, the
money is safe in the treasury and `POST /api/admin/grant` makes the buyer whole
while it is diagnosed. The one QR-specific risk: the flow depends on the wallet
including the invoice `reference` in the transaction. Solana Pay wallets do --
it is the standard -- but a wallet that omitted it would pay without ever being
matched to a buyer.

(Historic, from the devnet stage:)
**NOT PROVEN: a funded transfer actually landing and being credited.** The
public devnet faucet was exhausted for this IP, so no wallet could be funded.
What is proven is that devnet accepts the transaction's signature and structure
(it stops at `AccountNotFound`, i.e. only the balance is missing) -- and the
controls were run, so that means something: a corrupted signature gives
`SignatureFailure`, a malformed header is rejected while sanitizing. Both the
hand-built and the server-built messages pass, and are byte-identical.

**To close it:** run `node scripts/devnet-pay.mjs <baseUrl> <sessionCookie>
<product>`, or just pay the printed `solana:` link once from a devnet wallet.
The script falls back to `simulateTransaction` when the faucet is dry and says
plainly which of the two happened -- it will never claim "credited" when
nothing was.

### Before switching to mainnet

1. Close the gap above on devnet first, with a real funded payment.
2. Set `TREASURY_ADDRESS` in Hostinger, then `SOLANA_CLUSTER=mainnet-beta`.
3. Consider a paid RPC endpoint. The public one rate limits, and the sweep is
   what credits someone who paid and closed the tab.
4. `POST /api/admin/grant` is still the manual repair path if a payment is ever
   taken but not credited. Keep `ADMIN_TOKEN` set.

**Still not started:** the Ammo and Skin upgrades remain COMING SOON by design.

### Recent bug fixes worth not regressing

- **Mouse look** broke for everyone arriving from the lobby: pointer lock was
  requested only inside `startGame()`, which auto-runs with no user gesture and
  is `async` besides, so the click's activation was already spent. Now requested
  from a **canvas click handler** with a "CLICK TO LOOK AROUND" prompt.
- **Remote bullets were invisible** — relayed shots spawned only a muzzle flash.
  Now spawn a real round with `dmg: 0` owned by the remote fighter, which the
  collision loop already refuses to file a claim for. Both details matter or
  every shot counts twice.
- `.env` absent meant `loadEnv()` returned early and ignored `process.env`
  entirely — deployed servers saw no credentials, no PORT, no DATA_DIR.

## Launch readiness (added when the grenade removal landed)

**The blocker is deployment, and it needs a decision only the user can make.**
`arena3d/` and `server/` are **untracked in git** — none of this is committed or
deployed, and the live site does not link to the 3D game at all. Worse, the live
site is a *static* build from GitHub, and a static host cannot run Node or accept
WebSocket upgrades, so auth and multiplayer literally cannot work there. See
**`server/README-deploy.md`** for the options and a full VPS walkthrough
(nginx WebSocket proxying, systemd, the pre-flight checklist).

Production hardening that was done, all host-independent:

- **The character model was 18.8MB, 15.8MB of which was one 4096px PNG.** It is
  now a 2048px JPEG (no alpha, so plain JPEG needs no glTF extension) and the file
  is **3.5MB**. `scripts/compress-character-texture.mjs` does this and keeps
  `shooter_character.orig.glb` as a backup — re-run it if the model is re-exported,
  and bump the `?a=` marker in `character.js`. All 2717 accessors were verified
  byte-for-byte identical afterwards, so geometry and animation are untouched.
- **This mattered more than it looks.** At 19MB the browser silently refused to
  cache the file at all (single-entry size limit), so correct `immutable` headers
  did nothing and it was refetched on *every* page load — i.e. every match. At
  3.5MB it caches: verified 0 bytes transferred on the second load.
- Static serving now does real caching (immutable for `?v=`/`?a=` URLs, ETag +
  304 for everything else, `no-store` for HTML so a deploy is never invisible)
  and gzip for text (arena3d.js 82KB -> 26KB). Watch out: `Accept-Encoding`
  is parsed properly, because `gzip;q=0` means the client does *not* want gzip.
- `HOST` binding and graceful SIGTERM/SIGINT shutdown for running behind a proxy.

## Grenades: REMOVED before launch, to be restored after

The user pulled the grenade feature pre-launch ("we will work on that later after
the launch"). It was **removed, not disabled** — there is no dead code or feature
flag left behind. What came out:

- `arena3d.js`: the `GRENADE_*` constants, `TOSS_ANIM_DURATION`, `throwGrenade()`,
  `explodeGrenade()`, `updateGrenades()`, the `grenades` array and its resetMatch
  clean-up, the `grenadeCooldown`/`throwingGrenade` fighter fields, the `G` key
  binding, the bot AI's occasional throw, and the `TossGrenade` clip branch in
  `pickRiggedClip()`.
- `arena3d/index.html`: the `G — throw grenade` control hint.
- `server/gameserver.mjs`: the `grenade` relay message.

**Deliberately kept**, because restoring is easier than re-deriving:

- `arena3d/assets/grenade.glb` — the model asset is still on disk, just no longer
  loaded at startup (it was in the same `Promise.all` as the character; that is now
  a plain `loadRiggedCharacterAsset()` call).
- The rig's baked `TossGrenade` animation clip, still in `shooter_character.glb`.

Note the explosion damage was never made multiplayer-authoritative — it applied
damage locally, unlike bullets which route through the server's hit claim. **When
grenades come back, that has to be fixed too**, or a grenade kill will disagree
between clients. See the authority split in `server/README-multiplayer.md`.

## Cache-busting gotcha (cost real time this session)

`character.js`/`profile.js` were originally imported from `arena3d.js`/`dashboard.js` with **no** `?v=` query param at all, and the `?v=1` on the top-level `<script>` tags was never bumped across many edits. The static dev server (`npx serve`) and/or the browser cached these aggressively, so several rounds of genuinely-correct fixes to `character.js` may have silently never reached the browser being tested. Every internal import now has a version param — **always bump every `?v=N` occurrence across `index.html`, `dashboard.html`, `arena3d.js`, `dashboard.js`, `character.js`'s own imports, etc. together, in lockstep, on every edit** (currently `v=28`; `grep -rn '?v=' --include=*.js --include=*.html .` finds them all), and tell the user to hard-refresh, not just reload.

## What's left (explicitly out of scope so far, by design)

1. ~~Finish the walk/camera bug above.~~ **Done** — see the FIXED section above; still wants a real-browser confirmation from the user.
2. ~~**Real backend multiplayer**~~ — **built and verified working across two real browsers.** Live room browser, real lobby with real players, host-started matches, position/animation sync, server-authoritative damage/deaths/scoring, and a shared match result. Empty slots are filled by bots the host simulates, so any mode is playable without waiting for 10 humans. See `server/README-multiplayer.md`.

   **Known limitation, deliberately scoped and documented:** movement is client-authoritative, so it is cheatable, and hit *claims* originate from the shooter (health itself is server-side, with friendly fire refused, hits rate-limited and damage clamped). Closing that needs authoritative server-side movement simulation — a rewrite of the game loop, not a feature. **This matters before any real money rides on a match result** (see item 4).

   Not yet done on top of it: respawning (a dead player spectates until the match ends, as before); and room state is in memory, so a server restart clears open rooms (player records persist).
3. ~~**X (Twitter) OAuth login**~~ — **built and working** (see `server/README-auth.md`). Real credentials are in the gitignored `.env`; env vars override the file, so Hostinger's env panel works with no code change. Signed-in players get a server-side record keyed by their numeric X user id, real stats, and a real global leaderboard; signed-out/static-host visitors keep the old guest-name flow untouched.

   **The one thing left on this, and it is a portal setting, not code:** the X app is registered as a *desktop/native* app, so X rejects any real callback URL with error 417 and only accepts `oob` (PIN mode). Login works today via the PIN fallback the server serves automatically. To get normal one-click redirect login, set the app's **App type** to `Web App, Automated App or Bot` and register the callback URL(s) in the developer portal — the code already handles both and picks automatically, so nothing needs changing once that flips.

   Not yet done on top of this: the in-game name tag over *other* players still uses the mock `BOT_NAME_POOL` handles, because there are no other real players until multiplayer is real (item 2).
4. **Real payments** — the "Life Refill" upgrade (0.1 SOL for +10 life bars) is described by the user but explicitly marked "coming soon"/non-functional for now, along with Ammo and Skin upgrades. No Solana/wallet integration exists. When this becomes in-scope, note Claude is not permitted to execute real financial transactions itself — building the integration code is fine, moving actual funds is not (see the assistant's own standing safety rules, not project-specific).
5. Ammo and Skin upgrade systems generally (mechanics not designed yet, just placeholder UI cards).

## Environment notes

- Dev server: `npx serve -l 5173 .` from `C:\dev\Neegy`, via `.claude/launch.json` config name `neegy-arena3d` (maps to `neegy-static`). Doesn't survive session restarts — start it via the Browser tool's `preview_start`, don't assume it's already running.
- The Browser pane in this harness runs the tab backgrounded/hidden most of the time, which pauses `requestAnimationFrame` entirely — **no live gameplay frame ever actually executes in this harness's own automated testing**. Verification here has to rely on: `node --check` syntax validation, confirming `state==="playing"`/HUD DOM values after a synchronous `resetMatch()` + at least one `update(dt)` tick runs (which does happen once even in a hidden tab, just not repeatedly), console error checks, and network-request checks (confirming fresh `?v=N` assets actually loaded). **Real gameplay verification (does it look/feel right, is the bug actually fixed) requires the user to test in their own real, focused browser tab** — screenshots from them (ideally including the `#debugReadout` box) are the most reliable diagnostic tool available.
- User's own test URL: `http://localhost:5173/arena3d/dashboard.html` (or directly `http://localhost:5173/arena3d/?mode=1v1&server=X` to skip the dashboard for quick iteration).

---

# OLD NOTES (stale — describes the pre-shooter-pack, pre-dashboard version of the game; kept for history only, do not follow as current state)

Continue work on the $NEEGY arena game at `C:\dev\Neegy\arena3d\`. Read this file first, then `arena3d/arena3d.js`, `arena3d/character.js`, and `arena3d/showcase.js` before making changes.

## Where things stood (obsolete)

- **`arena3d/arena3d.js`** — the actual game (full-screen 3D arena, AI opponent, buildings you can walk into, destructible player-built walls/ramps, working aim tied to the camera). This is playable now. Latest pass added: scattered pine trees (visual variety + light cover, with real movement/bullet collision), an atmosphere layer (glowing sun sprite, drifting cloud sprites, orbiting bird sprites — updated every frame via `updateAtmosphere(dt)`, unconditional of game state), muzzle-flash sprite + footstep dust particles (both reuse the existing `particles` array/update loop), and a smarter `updateAI()`: perpendicular strafing that flips direction every ~0.6-1.5s, cover-seeking via `nearestCover()` when AI hp < 45 (peels off toward the nearest building/crate/tree/wall instead of dueling in the open), and occasional tactical wall-building via the existing `placeStructure()` when caught in the open at close-mid range.
- **`arena3d/blender/build_character.py`** — a headless Blender Python script (run via `blender --background --python arena3d/blender/build_character.py`, Blender 5.2.0 LTS portable install at `C:\dev\tools\blender-5.2.0-windows-x64\blender.exe`, not committed/not in PATH) that builds the character with real modeling techniques instead of raw Three.js primitives: a boolean-merged organic head (sphere + chin + nose bridge + nose tip unioned into one continuous mesh) with Subdivision Surface + smooth shading, beveled hard-surface suit parts, and build-once-then-mirror for symmetric pieces (pauldrons + lion-mane spike fan, ears). It exports `arena3d/assets/character.glb`. `arena3d/blender/inspect_glb.py` is a companion script that re-imports the glb and dumps the full node hierarchy with world-space bounding boxes — useful for sanity-checking proportions/placement without a screenshot (see harness caveat below). The script builds in Blender's native Z-up space using the exact same numeric offsets as `character.js`'s Y-up values, remapped via `P()`/`S()`/`R()` helpers at the top of the file — if you add new geometry, use those helpers rather than hand-deriving the axis swap (a first pass had 3 real bugs from getting this wrong: a leg-position reset, a pauldron mirror that flipped geometry but not position, and every `add_box()` call silently swapping height/depth because `dims` wasn't going through `S()` — all fixed, see git history if useful context). The output hierarchy (`CharacterRoot` > `LegL`/`LegR`/`ArmL`→`ElbowL`/`ArmR`→`ElbowR` + static organic/suit groups) intentionally matches `character.js`'s pivot names exactly, and two materials are named `Gold`/`Suit` so the game can look them up and tint them for hit-flash.
- **`arena3d/character.js`** — a shared ES module exporting three things: `animateCharacter()` (pose/joint-rotation driver, shared by both model paths below), `makeCharacterModel()` (the original procedural build, raw Three.js primitives — still used by `showcase.js`, not touched this pass), and `loadCharacterModel()` (new, async — loads `character.glb` via `GLTFLoader`, this is what the live game in `arena3d.js` uses now; `arena3d.js` calls it twice at startup via `Promise.all(...)` to get two independent instances with independent Gold/Suit materials for per-fighter hit-flash tinting, and disables the DROP IN button until both resolve). Both model paths return the same shape (`{ group, legL, legR, armL, armR, goldMat, suitMat, goldBase, suitBase }` with `armL.elbow`/`armR.elbow`) so `animateCharacter()` drives either one identically. This is the gold-skinned, black-and-gold tactical character (lion-style gold pauldrons, camo boots, gun with gold trim) built to match a reference "legendary skin" promo render the user provided. **The user said they want to keep improving this character model further** — treat current geometry/proportions as a first pass, not final. The procedural build (`makeCharacterModel()`) has: real elbow joints (shoulder → upper-arm → elbow-hinge → forearm → hand), a fisted hand shape, face detail (brow ridges, mouth line, tapered chin), a lion-mane fan of gold spikes per pauldron, and small tactical tassets off the belt. The Blender build (`loadCharacterModel()` / `character.glb`) covers the same design with real organic modeling — see the entry above.
- **`arena3d/showcase.html` + `arena3d/showcase.js`** — a standalone turntable page (not linked from the game) that stands the character on a podium against a dusk-mountain backdrop and can record a 360° rotation via `canvas.captureStream()` + `MediaRecorder`, saved as WebM. **This is unfinished and was mid-debug when the session ended:**
  - First attempt produced a ~110-byte (empty) recording. Root cause: this dev/test browser environment runs the tab in a backgrounded/hidden state, and `requestAnimationFrame` is paused for hidden tabs — so the render loop never actually drew new frames during "recording."
  - Fix applied but **not yet re-verified end-to-end**: swapped both the main render loop and the turntable rotation loop in `showcase.js` from `requestAnimationFrame` to `setTimeout(fn, 1000/30)`, which should keep firing regardless of tab visibility. Next step is to re-run the capture and confirm the resulting WebM is a real, smooth 8-second 360° video (check `window.__recordingSize` / `window.__recordingReady` after calling `window.__triggerRecord()`).
  - Delivery mechanism not yet decided: options are (a) trigger a real browser download and locate the file, or (b) read `window.__recordingDataURL` (a base64 data: URL) and write it to disk via chunked retrieval (a single response may be too large for one shot — pull in slices via `.slice(start,end)` across multiple calls and reassemble).
  - **Do not publish/ship this yet** — the user explicitly asked to hold off until it's polished.

## Paused: AI-generated character experiment (not wired into the game)

Mid-session the user pivoted from refining `build_character.py` to trying an AI-generated 3D reconstruction of the character instead, since procedural primitives hit a real fidelity ceiling against the reference art. **This whole thread is currently paused — the live game is untouched and still uses the procedural `character.glb` via `loadCharacterModel()` as described above.** Context for resuming:

- **BlenderMCP is installed and connected.** `uv`/`uvx` installed to `C:\Users\<user>\.local\bin`. The addon (`arena3d/blender/blendermcp_addon.py`, sourced from `ahujasid/blender-mcp`) is installed into Blender's user preferences and auto-enables on every launch. The MCP server is registered with Claude Code as `blender` (local scope, `uvx blender-mcp`) — **requires a fresh Claude Code session to pick up** (MCP servers connect at session start). Once connected, Blender must actually be running with the addon's socket server started for the tools to work — `arena3d/blender/view_character_with_mcp.py` (run via `blender --python ...`, not `--background`) loads the current `character.glb` and calls `bpy.ops.blendermcp.start_server()` automatically.
- **The `3d-ai-studio-api` skill is installed** at `.claude/skills/3d-ai-studio-api/` (vetted clean — see conversation for the review). API key is in `.env` at the project root (gitignored) as `3D_AI_STUDIO_API_KEY`. **Credit balance is down to ~20** (started at 200; two image-to-3D generations at ~80-100 credits each). Python 3.12 is installed but not on PATH for already-running shells — use the full interpreter path `C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe`, or a fresh terminal.
- **Reference images** live in `C:\dev\Neegy\assets\Character\`: `Neegy character.png` (front) and `side view.png` (side), both containing a "Diary of a Wimpy Kid"-referencing engraving + name tag on the gun that must never be sent to a generation API or otherwise reproduced — cleaned versions with that text/tag masked out (flat dark fill, not a substitution) are `Neegy_character_clean.png` and `side_view_clean.png`; always use the `_clean` versions as generation input, never the raw originals.
- **Two generations were run**, both from the cleaned images: a single-image one (`arena3d/assets/generated/neegy_generated.glb`) and a better multi-view one using both front+side together (`arena3d/assets/generated/neegy_multiview.glb`, via `arena3d/blender/generate_multiview.py` since the packaged CLI doesn't expose a `--multi-view` flag — call the `Client` class directly with `multi_view_images=[{"view_type":..., "view_image":...}]`). The CLI's `download` command is buggy — the archive/zip asset URL 400s and aborts the whole download loop before reaching the GLB; work around it by re-fetching `status` fresh (asset URLs are signed and expire/rotate) and downloading the GLB URL directly with `curl`, skipping the CLI's `download` subcommand entirely.
- **Known problems with the multi-view result, none resolved:**
  1. It's a single unrigged mesh (500,000 polygons originally; decimated live in Blender via a `DECIMATE` modifier at ratio 0.04 down to 20,000 — that reduction was applied and is presumably still live in whatever Blender session has it open, but was never re-exported to disk).
  2. My own redaction boxes over the gun text got reconstructed as literal flat grey geometric blocks on the model (visible on chest/gun). Three different automated attempts to isolate and remove them all failed: face-area outlier detection (mesh is uniformly fine-tessellated everywhere, no size signal), texture-color matching (baked lighting/AO destroyed the flat-color signature), and connected-component/island analysis (the mesh has 3,544 disconnected islands total — it's topologically noisy throughout, not just at the artifact). No further automated approach was attempted; would likely need manual sculpting/masking by a human in Blender's UI, or regenerating from a pose that doesn't hold a gun at all so the weapon can be added cleanly as a separate object with nothing to conflict with.
  3. A simple procedural placeholder rifle was added as a separate object (`SimpleRifle`) and repositioned via bounding-box math after the first placement was clearly wrong, but the user confirmed the second attempt **still didn't look correct** and asked to pause before a third attempt.
  4. No armature/rig/skinning was started. Getting this mesh to actually animate in-game would additionally require a new bone-based animation pathway in `character.js`/`arena3d.js` (the current system drives named pivot nodes via direct rotation, incompatible with skeletal/skin animation).
- **Tool reliability note:** `mcp__blender__get_viewport_screenshot` was unreliable for most of this thread — it repeatedly returned a stale/cached image across multiple different scene edits and view-angle changes, confirmed by cross-checking `get_object_info` (which showed edits *had* applied even when the screenshot looked unchanged). Prefer verifying via `get_object_info`/`get_scene_info` (numeric ground truth) over trusting the screenshot tool, or ask the user to look at their own live Blender window directly.
- **Next time this resumes**, the user said *"I will think of other way"* — likely worth discussing direction before diving back into either (a) more automated mesh surgery on the AI-generated blob, or (b) a fresh generation attempt with a cleaner source pose/reference.

## Environment quirks worth knowing (obsolete duplicate — see current "Environment notes" section above)

- The dev server is `npx serve . -l 5173` run from `C:\dev\Neegy`, in the background. It does not survive session restarts — check with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/` (note: `localhost` sometimes fails to resolve in this Bash environment even when the server is up — use `127.0.0.1` to check, but the actual Browser tool navigation should still use `http://localhost:5173/...`).
- The Browser pane in this harness often runs as a backgrounded/hidden tab (`document.hidden === true`), which pauses `requestAnimationFrame`-driven code. Any new animation/capture logic should prefer `setTimeout`-based loops if it needs to keep running reliably during automated testing.
- Screenshots via the `computer` tool frequently fail with "Browser pane is not displayed" in this harness — verification has mostly relied on `javascript_exec` state-checks (console errors, WebGL error codes, scene-graph structure) rather than actual visual screenshots. If real visual confirmation is needed, ask the user to look directly rather than trusting a screenshot attempt.
- Other isolated, untouched sibling builds exist from earlier iterations: `pvp/` (2D local-multiplayer duel) and `arena/` (2D full-screen side-view arena). `arena3d/` is the current active direction. None of these affect the live site (`index.html`, `game.js`, `style.css` at the project root) — that stays untouched throughout.

