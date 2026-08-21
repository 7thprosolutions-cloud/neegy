import {
  loadProfile, saveProfile, loadCustomServers, addCustomServer,
  FLAVOR_SERVERS, MOCK_LEADERBOARD, MODES,
} from "/arena3d/profile.js?v=31";
import { getAccount, logout, fetchLeaderboard } from "/arena3d/account.js?v=31";
import * as net from "/arena3d/net.js?v=31";
import { qrSvg } from "/arena3d/qr.js?v=31";

const playerNameEl = document.getElementById("playerName");
const guestChip = document.getElementById("guestChip");
const accountChip = document.getElementById("accountChip");
const accountAvatar = document.getElementById("accountAvatar");
const accountName = document.getElementById("accountName");
const accountHandle = document.getElementById("accountHandle");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const statKillsEl = document.getElementById("statKills");
const statGamesEl = document.getElementById("statGames");
const statXpEl = document.getElementById("statXp");
const leaderboardEl = document.getElementById("leaderboard");
const serverListEl = document.getElementById("serverList");

const createServerBtn = document.getElementById("createServerBtn");
const createServerForm = document.getElementById("createServerForm");
const newServerNameEl = document.getElementById("newServerName");
const modePicker = document.getElementById("modePicker");
const confirmCreateBtn = document.getElementById("confirmCreateBtn");
const cancelCreateBtn = document.getElementById("cancelCreateBtn");
const privateCheck = document.getElementById("privateCheck");
const privateNote = document.getElementById("privateNote");
const privateBlurb = document.getElementById("privateBlurb");

const balancesEl = document.getElementById("balances");
const balLivesEl = document.getElementById("balLives");
const balPassEl = document.getElementById("balPass");
const upgradesSignedOut = document.getElementById("upgradesSignedOut");
const payNote = document.getElementById("payNote");
const testnetWarning = document.getElementById("testnetWarning");

const codeOverlay = document.getElementById("codeOverlay");
const codeRoomName = document.getElementById("codeRoomName");
const roomCodeEl = document.getElementById("roomCode");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const codeDoneBtn = document.getElementById("codeDoneBtn");
const showCodeBtn = document.getElementById("showCodeBtn");

const payOverlay = document.getElementById("payOverlay");
const payTitle = document.getElementById("payTitle");
const payAmount = document.getElementById("payAmount");
const payQr = document.getElementById("payQr");
const payLink = document.getElementById("payLink");
const payCopyBtn = document.getElementById("payCopyBtn");
const payStatusEl = document.getElementById("payStatus");
const payCloseBtn = document.getElementById("payCloseBtn");
const payWalletBtn = document.getElementById("payWalletBtn");
const payTestnet = document.getElementById("payTestnet");

const passwordOverlay = document.getElementById("passwordOverlay");
const passwordRoomName = document.getElementById("passwordRoomName");
const passwordInput = document.getElementById("passwordInput");
const passwordError = document.getElementById("passwordError");
const passwordJoinBtn = document.getElementById("passwordJoinBtn");
const passwordCancelBtn = document.getElementById("passwordCancelBtn");

const lobbyOverlay = document.getElementById("lobbyOverlay");
const lobbyServerName = document.getElementById("lobbyServerName");
const lobbyModeLabel = document.getElementById("lobbyModeLabel");
const lobbyStatus = document.getElementById("lobbyStatus");
const lobbySlots = document.getElementById("lobbySlots");
const cancelLobbyBtn = document.getElementById("cancelLobbyBtn");
const startMatchBtn = document.getElementById("startMatchBtn");

let profile = loadProfile();
let selectedMode = "1v1";
let lobbyTimers = [];
// The signed-in X player, once /api/me answers. Null while unknown or signed
// out; when set, it is the authority for the display name everywhere.
let account = null;
let realLeaderboard = [];

// ---- multiplayer state ----
// `online` decides between real rooms over the WebSocket and the original
// offline mock lobby (which fills with bots on a timer). Everything below
// branches on it rather than assuming a server is there.
let online = false;
let netRooms = [];      // room summaries pushed by the server
let currentRoom = null; // the room we are actually sitting in, server-side
let myClientId = null;
// Paid balances, authoritative from the server (`welcome`, then `entitlements`
// after anything spends one). Never inferred locally -- the server owns these.
let entitlements = { extraLives: 0, privateUntil: 0, privateActive: false, privateMsLeft: 0 };
// What the server will and will not sell, answered by /api/pay/config. Null
// until that lands, which is why the buy buttons start disabled.
let payConfig = null;
// The invoice currently on screen, and the poll watching for it to land.
let activeInvoice = null;
let payPollTimer = null;
// Set once a wallet has actually submitted the transaction. Without it the
// three-second poll overwrites "sent" with "waiting for payment", so the
// moment after someone approves in Phantom reads as though nothing happened.
let walletSubmitted = false;
// Set when the wallet route has said something the player needs to read -- an
// error, a timeout, a cancellation. The poll runs every three seconds and will
// happily talk over it otherwise, so the one message explaining what went
// wrong is replaced by a generic "waiting" a moment after it appears. Only a
// settled payment outranks it.
let payStatusLocked = false;
// The generated code for the private room we are hosting, kept so the host can
// bring it back up after dismissing the dialog.
let hostedRoomCode = null;
// The private room we are mid-way through unlocking, so the password dialog
// knows what it is asking about and where to send the answer.
let pendingPrivateJoin = null;

// ---------- profile / identity ----------

// The name shown in the lobby, the leaderboard and on the in-game name tag.
// A signed-in X handle always wins over the locally typed guest name.
function displayName() {
  if (account) return "@" + account.handle;
  return profile.name || "";
}

function renderProfile() {
  playerNameEl.value = profile.name || "";
  // Signed in: stats come from the server record, which is the one that
  // survives clearing browser storage and is what the global ranking uses.
  const stats = account || profile;
  statKillsEl.textContent = stats.kills || 0;
  statGamesEl.textContent = stats.gamesPlayed || 0;
  statXpEl.textContent = stats.xp || 0;
}

function renderIdentity() {
  if (account) {
    accountName.textContent = account.name || account.handle;
    accountHandle.textContent = "@" + account.handle;
    if (account.avatar) accountAvatar.src = account.avatar;
    else accountAvatar.removeAttribute("src");
    accountChip.hidden = false;
    guestChip.hidden = true;
    signInBtn.hidden = true;
  } else {
    accountChip.hidden = true;
    guestChip.hidden = false;
    // Only offer the X button when a backend is actually there to handle it --
    // on a plain static host the link would just 404.
    signInBtn.hidden = !backendAvailable;
  }
}

let backendAvailable = false;

playerNameEl.addEventListener("change", () => {
  profile.name = playerNameEl.value.trim().slice(0, 20);
  saveProfile(profile);
  renderLeaderboard();
});

signOutBtn.addEventListener("click", async () => {
  await logout();
  account = null;
  entitlements = { extraLives: 0, privateUntil: 0, privateActive: false, privateMsLeft: 0 };
  renderIdentity();
  renderProfile();
  renderLeaderboard();
  renderEntitlements();
});

// Resolve identity before first paint of the chips, so the header does not
// flash "enter your name" at someone who is already signed in.
(async () => {
  const state = await getAccount();
  backendAvailable = state.backendAvailable;
  account = state.player;
  if (account) {
    entitlements = {
      extraLives: account.extraLives || 0,
      privateUntil: account.privateUntil || 0,
      privateActive: Boolean(account.privateActive),
      privateMsLeft: account.privateMsLeft || 0,
    };
  }
  if (backendAvailable) realLeaderboard = await fetchLeaderboard();
  renderIdentity();
  renderProfile();
  renderLeaderboard();
  renderEntitlements();

  const authResult = new URLSearchParams(location.search).get("auth");
  if (authResult === "denied") {
    lobbyStatusToast("X sign-in was cancelled.");
  }
  if (authResult) {
    history.replaceState(null, "", location.pathname);
  }
})();

// ---------- upgrades ----------

// Two things move together here: what the sidebar says you own, and whether
// the "Private server" box in the create form can be ticked at all. Creating a
// private room charges the creator a credit at match start, so offering the box
// to someone who cannot be charged (signed out, or out of credits) would only
// produce a server that refuses to start.
// A pass is a deadline, not a count, so it wants saying in the units a person
// would use: hours while there are hours left, minutes once it is nearly gone.
function describePass(msLeft) {
  if (msLeft <= 0) return "none";
  const hours = Math.floor(msLeft / 3600000);
  const minutes = Math.round((msLeft % 3600000) / 60000);
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  return `${Math.max(1, minutes)}m left`;
}

function renderEntitlements() {
  const known = Boolean(account);
  balancesEl.hidden = !known;
  upgradesSignedOut.hidden = known;
  balLivesEl.textContent = entitlements.extraLives;
  balPassEl.textContent = describePass(entitlements.privateMsLeft || 0);

  const row = document.getElementById("privateToggleRow");
  let reason = "";
  if (!backendAvailable) reason = "needs a game server";
  else if (!account) reason = "sign in with X to host one";
  else if (!entitlements.privateActive) reason = "needs a 24h pass - 0.1 SOL";

  const allowed = !reason;
  privateCheck.disabled = !allowed;
  row.querySelector(".dash-check").classList.toggle("disabled", !allowed);
  if (!allowed) {
    privateCheck.checked = false;
    privateBlurb.hidden = true;
  }
  privateNote.textContent = allowed ? describePass(entitlements.privateMsLeft) : reason;
  privateNote.classList.toggle("warn", !allowed && Boolean(account));

  renderBuyButtons();
}

privateCheck.addEventListener("change", () => {
  privateBlurb.hidden = !privateCheck.checked;
});

// The balance changes the moment anything spends one, and the server says so
// rather than the browser guessing.
net.on("entitlements", (msg) => {
  entitlements = msg.entitlements || entitlements;
  renderEntitlements();
});

// The pass is a deadline, so what it says goes stale on its own. Tick it down
// once a minute rather than leaving "3h left" on screen until something else
// happens to repaint.
setInterval(() => {
  if (!entitlements.privateActive) return;
  entitlements.privateMsLeft = Math.max(0, entitlements.privateMsLeft - 60000);
  if (entitlements.privateMsLeft === 0) entitlements.privateActive = false;
  renderEntitlements();
}, 60000);

// ---------- buying ----------

function renderBuyButtons() {
  const buttons = document.querySelectorAll("[data-buy]");
  const sellable = Boolean(payConfig?.enabled) && Boolean(account);
  for (const btn of buttons) {
    const product = payConfig?.products?.find((p) => p.key === btn.dataset.buy);
    btn.disabled = !sellable;
    btn.classList.toggle("dash-btn-locked", !sellable);
    btn.classList.toggle("dash-btn-primary", sellable);
    btn.textContent = product ? `${product.priceSol} SOL` : "0.1 SOL";
  }
  if (!payConfig) payNote.textContent = "Checking whether payments are available...";
  else if (!payConfig.enabled) payNote.textContent = "Checkout opens once SOL payments are switched on.";
  else if (!account) payNote.textContent = "Sign in with X to buy - purchases are tied to your handle.";
  else payNote.textContent = "Pay from any Solana wallet. Credited automatically, usually within a minute.";
  // Devnet must be impossible to mistake for the real thing.
  testnetWarning.hidden = !(payConfig?.enabled && !payConfig.live);
}

(async () => {
  try {
    const res = await fetch("/api/pay/config", { credentials: "same-origin" });
    payConfig = res.ok ? await res.json() : { enabled: false };
  } catch {
    payConfig = { enabled: false };
  }
  renderBuyButtons();
})();

document.querySelectorAll("[data-buy]").forEach((btn) => {
  btn.addEventListener("click", () => beginPurchase(btn.dataset.buy));
});

async function beginPurchase(product) {
  if (!payConfig?.enabled || !account) return;
  const spec = payConfig.products.find((p) => p.key === product);
  payTitle.textContent = spec?.label || "Buy";
  payAmount.textContent = `${spec?.priceSol ?? 0.1} SOL`;
  payQr.innerHTML = "";
  payStatusEl.textContent = "Creating request...";
  payStatusEl.className = "dash-pay-status";
  payTestnet.hidden = payConfig.live;
  payOverlay.classList.remove("hidden");

  let invoice;
  try {
    const res = await fetch("/api/pay/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not start the payment");
    invoice = body.invoice;
  } catch (err) {
    payStatusEl.textContent = err.message;
    payStatusEl.className = "dash-pay-status failed";
    return;
  }

  activeInvoice = invoice;
  payLink.href = invoice.url;

  // A `solana:` request carries no cluster. On devnet that is a way to lose
  // real money: a wallet set to mainnet would read this QR, build a perfectly
  // valid MAINNET transfer, and send actual SOL to the treasury -- which this
  // server, watching devnet, would never see. The payer would be out real
  // funds and get nothing.
  //
  // The wallet button has no such hole, because the transaction it signs is
  // built on a devnet blockhash: a mainnet wallet cannot execute it at all, it
  // just fails. So while we are not on mainnet, that is the only route
  // offered, and the QR stays off the screen entirely rather than relying on
  // anyone reading a warning.
  const testMoney = !payConfig.live;
  payQr.hidden = testMoney;
  payLink.hidden = testMoney;
  payCopyBtn.hidden = testMoney;
  document.querySelector(".dash-pay-hint").hidden = testMoney;

  if (!testMoney) {
    try {
      payQr.innerHTML = qrSvg(invoice.url);
    } catch (err) {
      // A QR that cannot be drawn is not a reason to block the payment -- the
      // link below it carries exactly the same request.
      payQr.innerHTML = "";
      console.warn("qr:", err.message);
    }
  } else {
    payQr.innerHTML = "";
  }
  walletSubmitted = false;
  payStatusLocked = false;
  const provider = browserWallet();
  payWalletBtn.hidden = !provider;
  payWalletBtn.disabled = false;
  payWalletBtn.textContent = provider?.isPhantom ? "PAY WITH PHANTOM" : "PAY WITH WALLET";

  if (testMoney && !provider) {
    payStatusEl.textContent = "Test mode needs a browser wallet set to devnet.";
    payStatusEl.className = "dash-pay-status failed";
    return;
  }

  payStatusEl.textContent = "Waiting for payment...";
  pollPayment();
}

// Polls until it lands. The server re-checks the chain on each of these, so
// this is also what makes a payment show up within a second or two of
// confirming rather than waiting for the background sweep.
function pollPayment() {
  clearInterval(payPollTimer);
  let elapsed = 0;
  payPollTimer = setInterval(async () => {
    if (!activeInvoice) return clearInterval(payPollTimer);
    elapsed += 3;
    try {
      const res = await fetch(`/api/pay/status?reference=${encodeURIComponent(activeInvoice.reference)}`, {
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) return;
      if (body.status === "paid") {
        clearInterval(payPollTimer);
        payStatusLocked = false;
        payStatusEl.textContent = "Paid - credited to your account.";
        payStatusEl.className = "dash-pay-status paid";
        if (body.player) {
          account = { ...account, ...body.player };
          entitlements = {
            extraLives: body.player.extraLives,
            privateUntil: body.player.privateUntil,
            privateActive: body.player.privateActive,
            privateMsLeft: body.player.privateMsLeft,
          };
          renderEntitlements();
        }
        return;
      }
      if (body.status === "expired") {
        clearInterval(payPollTimer);
        payStatusLocked = false;
        payStatusEl.textContent = "This request expired. Close and try again.";
        payStatusEl.className = "dash-pay-status failed";
        return;
      }
      if (payStatusLocked) {
        // Something is on screen that the player still needs to read.
      } else if (walletSubmitted) {
        payStatusEl.textContent = `Sent - waiting for the network to confirm... (${elapsed}s)`;
      } else {
        payStatusEl.textContent = elapsed < 20
          ? "Waiting for payment..."
          : `Waiting for payment... (${elapsed}s - confirmation can take a moment)`;
      }
    } catch {
      /* a dropped poll is not a failed payment; the next one will ask again */
    }
  }, 3000);
}

// ---------- paying from a browser wallet ----------
//
// Phantom and the other extensions all inject the same provider shape, so this
// is not Phantom-specific beyond the button text. There is no SDK and no
// registration behind any of it: the extension signs a transaction the server
// assembled, and the SOL moves wallet to wallet.
function browserWallet() {
  const provider = window.phantom?.solana || window.solana;
  return provider?.isPhantom || provider?.isSolana ? provider : null;
}

// Nothing here should be able to sit on "loading" forever. A wallet popup that
// never opens, an extension that never answers, a request that goes nowhere --
// all of them look identical to the player unless each step says what it is
// doing and gives up eventually.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function payWithWallet() {
  const provider = browserWallet();
  if (!provider || !activeInvoice) return;
  payWalletBtn.disabled = true;
  payStatusLocked = false;
  const step = (text, hold) => {
    payStatusEl.textContent = text;
    payStatusEl.className = hold ? "dash-pay-status failed" : "dash-pay-status";
    // Progress messages are fine to be replaced; anything the player has to
    // act on is not.
    payStatusLocked = Boolean(hold);
  };

  try {
    step("Connecting to your wallet...");
    const conn = await withTimeout(
      provider.connect(),
      45000,
      "Your wallet did not respond. Open the Phantom extension - the approval may be waiting there."
    );
    const payer = (conn?.publicKey || provider.publicKey)?.toString();
    if (!payer) throw new Error("Your wallet did not share an address.");

    step("Preparing the transaction...");
    // The server builds it. That fixes the amount, the recipient and the
    // reference, so this page cannot be talked into paying something other
    // than the invoice it is showing -- and the server still signs nothing;
    // only the wallet can.
    const res = await fetch("/api/pay/tx", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: activeInvoice.reference, payer }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Could not prepare the transaction.");

    step("Approve the payment in Phantom...");
    await withTimeout(
      provider.request({ method: "signAndSendTransaction", params: { message: body.message } }),
      120000,
      "No answer from the wallet. If Phantom did not open, click its icon in your toolbar."
    );

    walletSubmitted = true;
    step("Sent - waiting for the network to confirm...");
  } catch (err) {
    // Declining is a normal thing to do, not an error worth shouting about.
    walletSubmitted = false;
    const message = err?.message || String(err);
    const declined = /user rejected|declined|4001|cancell?ed/i.test(message);
    step(declined ? "Cancelled in your wallet - nothing was charged." : message, true);
    if (!declined) console.error("wallet payment failed:", err);
  } finally {
    payWalletBtn.disabled = false;
  }
}

payWalletBtn.addEventListener("click", payWithWallet);

function closePayment() {
  clearInterval(payPollTimer);
  activeInvoice = null;
  payOverlay.classList.add("hidden");
}

payCloseBtn.addEventListener("click", closePayment);
payCopyBtn.addEventListener("click", async () => {
  if (!activeInvoice) return;
  try {
    await navigator.clipboard.writeText(activeInvoice.url);
    payCopyBtn.textContent = "COPIED";
    setTimeout(() => { payCopyBtn.textContent = "COPY REQUEST"; }, 1500);
  } catch {
    payCopyBtn.textContent = "COPY FAILED";
  }
});

// ---------- the generated room password ----------

function showRoomCode(name, code) {
  hostedRoomCode = code;
  codeRoomName.textContent = name || "";
  roomCodeEl.textContent = code;
  codeOverlay.classList.remove("hidden");
}

codeDoneBtn.addEventListener("click", () => codeOverlay.classList.add("hidden"));
copyCodeBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCodeEl.textContent);
    copyCodeBtn.textContent = "COPIED";
    setTimeout(() => { copyCodeBtn.textContent = "COPY PASSWORD"; }, 1500);
  } catch {
    copyCodeBtn.textContent = "COPY FAILED";
  }
});
showCodeBtn.addEventListener("click", () => {
  // Ask again rather than trusting what we cached: the host role can move, and
  // the server is the only thing that knows whether we still hold it.
  net.send({ t: "password" });
});
net.on("password", (msg) => showRoomCode(currentRoom?.name || "", msg.password));

function lobbyStatusToast(message) {
  const note = document.getElementById("playerNameNote");
  if (!note) return;
  const original = note.textContent;
  note.textContent = message;
  setTimeout(() => { note.textContent = original; }, 4000);
}

renderProfile();

// ---------- leaderboard ----------
function renderLeaderboard() {
  // Real signed-in X players first. The mock entries stay only while there
  // are barely any real ones, so a fresh install does not look abandoned but
  // a live board is not padded with fake names either.
  const rows = realLeaderboard.map((p) => ({
    name: "@" + p.handle,
    kills: p.kills || 0,
    xp: p.xp || 0,
    you: Boolean(account) && p.handle === account.handle,
  }));
  if (rows.length < MOCK_LEADERBOARD.length) rows.push(...MOCK_LEADERBOARD);
  // Signed out, the local guest profile still deserves a row -- it just is
  // not on the shared board, because there is no identity behind it.
  if (!account) {
    rows.push({ name: displayName() || "You", kills: profile.kills || 0, xp: profile.xp || 0, you: true });
  }
  rows.sort((a, b) => b.xp - a.xp);
  leaderboardEl.innerHTML = rows.map((r, i) => `
    <div class="dash-lb-row ${r.you ? "you" : ""}">
      <span class="dash-lb-rank">${i + 1}</span>
      <span class="dash-lb-name">${escapeHtml(r.name)}${r.you ? " (you)" : ""}</span>
      <span class="dash-lb-kills">${r.kills}k</span>
      <span class="dash-lb-xp">${r.xp} xp</span>
    </div>
  `).join("");
}
renderLeaderboard();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- server list ----------
function renderServers() {
  // Online: the real room list the server pushes, which is the same list every
  // other player is looking at. Offline: the old placeholder/local list.
  const servers = online
    ? netRooms.map((r) => ({
        id: r.id, name: r.name, mode: r.mode, hostName: r.hostName,
        players: r.players, capacity: r.capacity, state: r.state,
        isPrivate: r.isPrivate, live: true,
      }))
    : [...FLAVOR_SERVERS, ...loadCustomServers()];

  if (online && servers.length === 0) {
    serverListEl.innerHTML = `<p class="dash-note">No one is hosting right now — hit
      <strong>+ CREATE SERVER</strong> and others will see it here instantly.</p>`;
    return;
  }

  serverListEl.innerHTML = servers.map((s) => {
    const mode = MODES[s.mode];
    const full = s.live && s.players >= s.capacity;
    const running = s.live && s.state === "playing";
    const disabled = full || running;
    // Private rooms are listed, not hidden: friends find the server by name and
    // are asked for the password on JOIN, rather than having to swap room ids.
    const label = running ? "IN MATCH" : full ? "FULL" : s.isPrivate ? "UNLOCK" : "JOIN";
    return `
      <div class="dash-server-card">
        <div class="dash-server-info">
          <span class="dash-server-name">${s.isPrivate ? '<span class="dash-lock-badge" title="Private — password required">&#128274;</span> ' : ""}${escapeHtml(s.name)}</span>
          <span class="dash-server-meta">
            <span class="dash-mode-badge">${mode.label}</span>
            <span>host: ${escapeHtml(s.hostName)}</span>
            ${s.live ? `<span>${s.players}/${s.capacity} players</span>` : ""}
          </span>
        </div>
        <button class="dash-btn-small dash-btn-primary" data-join="${s.id}" ${disabled ? "disabled" : ""}>${label}</button>
      </div>
    `;
  }).join("");

  serverListEl.querySelectorAll("[data-join]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-join");
      const server = servers.find((s) => s.id === id);
      if (server) joinLobby(server);
    });
  });
}
renderServers();

// ---------- create server ----------
createServerBtn.addEventListener("click", () => {
  createServerForm.classList.toggle("hidden");
  newServerNameEl.focus();
});
cancelCreateBtn.addEventListener("click", () => createServerForm.classList.add("hidden"));

modePicker.querySelectorAll(".dash-mode-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedMode = btn.getAttribute("data-mode");
    modePicker.querySelectorAll(".dash-mode-opt").forEach((b) => b.classList.toggle("selected", b === btn));
  });
});
modePicker.querySelector('[data-mode="1v1"]').classList.add("selected");

confirmCreateBtn.addEventListener("click", () => {
  if (!requireName()) return;

  const wantsPrivate = privateCheck.checked && !privateCheck.disabled;
  const name = newServerNameEl.value.trim().slice(0, 24) || `${displayName() || "Player"}'s Server`;
  createServerForm.classList.add("hidden");
  newServerNameEl.value = "";
  privateCheck.checked = false;
  privateBlurb.hidden = true;
  renderEntitlements();

  if (online) {
    // The server assigns the real id, generates the password if this is
    // private, and tells everyone else the room exists.
    net.createRoom(name, selectedMode, wantsPrivate);
    return;
  }
  const server = { id: "custom-" + Date.now(), name, mode: selectedMode, hostName: displayName() || "You" };
  addCustomServer(server);
  renderServers();
  joinLobby(server);
});

// Both flows need a name before they can show up to anyone else.
function requireName() {
  if (displayName()) return true;
  playerNameEl.focus();
  playerNameEl.style.borderColor = "#ff6f6f";
  setTimeout(() => (playerNameEl.style.borderColor = ""), 1200);
  return false;
}

// ---------- lobby / matchmaking (mock -- fills with bots) ----------
function joinLobby(server) {
  if (!requireName()) return;

  // Someone else's private room: ask before knocking. Our own room is not
  // routed here (the server puts the creator straight in), so this only ever
  // asks a guest, never the person who set the password.
  if (online && server.isPrivate) {
    askForPassword(server);
    return;
  }

  if (online) {
    // Everything the lobby shows from here comes from the server's `room`
    // messages (see renderNetLobby) -- no local simulation of who is present.
    net.joinRoom(server.id);
    lobbyServerName.textContent = server.name;
    lobbyModeLabel.textContent = (MODES[server.mode] || {}).label?.toUpperCase() || "";
    lobbyStatus.textContent = "Joining…";
    lobbySlots.innerHTML = "";
    startMatchBtn.hidden = true;
    lobbyOverlay.classList.remove("hidden");
    return;
  }

  const mode = MODES[server.mode];
  const teamSize = mode.teamSize;
  const totalSlots = teamSize * 2;

  lobbyServerName.textContent = server.name;
  lobbyModeLabel.textContent = mode.label.toUpperCase();
  lobbyOverlay.classList.remove("hidden");

  let filled = 1; // the player themself
  const renderSlots = () => {
    const parts = [];
    for (let i = 0; i < totalSlots; i++) {
      parts.push(`<span class="dash-lobby-slot ${i < filled ? "filled" : ""}">${i < filled ? (i === 0 ? escapeHtml(displayName()) : "Player " + (i + 1)) : "Empty"}</span>`);
    }
    lobbySlots.innerHTML = parts.join("");
    const remaining = totalSlots - filled;
    lobbyStatus.textContent = remaining > 0
      ? `Waiting for ${remaining} more player${remaining === 1 ? "" : "s"}…`
      : "Match ready — entering the arena…";
  };
  renderSlots();

  clearLobbyTimers();
  for (let i = 1; i < totalSlots; i++) {
    const t = setTimeout(() => {
      filled++;
      renderSlots();
      if (filled >= totalSlots) {
        setTimeout(() => {
          const params = new URLSearchParams({ mode: server.mode, server: server.name });
          // "/arena3d/index.html?..." would work too, but some static hosts
          // 301-redirect index.html -> the clean directory URL and can drop
          // the query string doing it -- "/arena3d/?..." sidesteps that.
          location.href = "/arena3d/?" + params.toString();
        }, 700);
      }
    }, 500 + i * (400 + Math.random() * 500));
    lobbyTimers.push(t);
  }
}

// ---------- private server password ----------

function askForPassword(server) {
  pendingPrivateJoin = server;
  passwordRoomName.textContent = server.name;
  passwordInput.value = "";
  passwordError.hidden = true;
  passwordJoinBtn.disabled = false;
  passwordOverlay.classList.remove("hidden");
  passwordInput.focus();
}

function closePasswordPrompt() {
  pendingPrivateJoin = null;
  passwordOverlay.classList.add("hidden");
  passwordInput.value = "";
}

function submitPassword() {
  if (!pendingPrivateJoin) return;
  const password = passwordInput.value;
  if (!password) {
    showPasswordError("Enter the password.");
    return;
  }
  passwordError.hidden = true;
  passwordJoinBtn.disabled = true;
  // The dialog stays up until the server rules on it: a `room` message means
  // we are in (and closes it), an `error` means the password was wrong (and
  // puts the reason where they are already looking).
  net.joinRoom(pendingPrivateJoin.id, password);
}

function showPasswordError(message) {
  passwordError.textContent = message;
  passwordError.hidden = false;
  passwordJoinBtn.disabled = false;
  passwordInput.select();
}

passwordJoinBtn.addEventListener("click", submitPassword);
passwordCancelBtn.addEventListener("click", closePasswordPrompt);
passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPassword();
  if (e.key === "Escape") closePasswordPrompt();
});

// ---------- multiplayer bootstrap ----------
//
// `online` decides between real rooms shared with other players and the local
// offline lobby. Crucially this is NOT a one-shot decision: the first
// connection can take longer than the initial wait on a cold load (DNS + TLS,
// or a server still warming after a deploy), and a page that latched OFFLINE
// at that moment would keep telling players the game has no servers while the
// socket was in fact connected. So we take a first reading, then keep
// listening and upgrade the moment the socket actually opens.

function updateNetBadge() {
  const heading = document.querySelector(".dash-panel-head h2");
  if (!heading) return;
  let badge = heading.querySelector(".dash-net-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "dash-net-badge";
    heading.appendChild(badge);
  }
  badge.classList.toggle("online", online);
  badge.classList.toggle("offline", !online);
  badge.textContent = online ? "LIVE" : "OFFLINE";
  badge.title = online
    ? "Connected — these are real servers other players can join."
    : "No game server reachable — servers and opponents here are local placeholders.";
}

function setOnline(next) {
  if (online === next) return;
  online = next;
  updateNetBadge();
  if (online) {
    // Guests announce the name they typed; signed-in players are already known
    // to the server from the session cookie and cannot rename themselves.
    if (!account && profile.name) net.setName(profile.name);
    net.listRooms();
  }
  renderServers();
}

(async () => {
  net.connect();
  // Generous: this only decides how long to wait before showing the offline
  // lobby, and going online later is handled below, so a slow first connect
  // costs a moment of placeholder content rather than the whole feature.
  const first = await net.ready(8000);
  online = !first; // force setOnline() to run its side effects
  setOnline(first);
})();

// The socket can open (or drop and come back) long after that first reading.
net.on("status", (state) => setOnline(state === "open"));

net.on("welcome", (msg) => {
  myClientId = msg.you.id;
  netRooms = msg.rooms || [];
  entitlements = msg.you.entitlements || entitlements;
  renderServers();
  renderEntitlements();
});

net.on("rooms", (msg) => {
  netRooms = msg.rooms || [];
  // Do not repaint the browser list out from under an open lobby.
  if (!currentRoom) renderServers();
});

// Only ever sent to the host of a private room, and only on the socket that
// created (or reclaimed) it.
net.on("joined", (msg) => {
  // The name rides along on this message rather than being read from
  // currentRoom: `joined` arrives before the `room` message that sets it, so
  // reading it there left the dialog titleless.
  if (msg.password) showRoomCode(msg.name || "", msg.password);
  else hostedRoomCode = null;
});

net.on("room", (msg) => {
  // Getting room state at all means we were let in, so the password (if we
  // were asked for one) was right.
  if (pendingPrivateJoin) closePasswordPrompt();
  renderNetLobby(msg.room);
});

net.on("left", () => {
  currentRoom = null;
  lobbyOverlay.classList.add("hidden");
  renderServers();
});

// An error means different things depending on what is on screen, and putting
// all of them in the lobby status line meant a rejected password was written
// to a panel the player could not see.
net.on("error", (msg) => {
  if (pendingPrivateJoin) {
    showPasswordError(msg.message);
    return;
  }
  if (!lobbyOverlay.classList.contains("hidden")) {
    lobbyStatus.textContent = msg.message;
    startMatchBtn.disabled = false;
    return;
  }
  // Nothing is open -- most likely a create or a start that was refused, so
  // say so where they last clicked instead of silently doing nothing.
  lobbyStatusToast(msg.message);
});

// The server says the match is live: hand off to the game page, which
// reconnects with the same tab id and picks the match up mid-flight.
net.on("start", (msg) => {
  const params = new URLSearchParams({ room: msg.roomId, mode: msg.mode, server: msg.roomName });
  location.href = "/arena3d/?" + params.toString();
});

net.on("status", (state) => {
  if (state === "closed") lobbyStatus.textContent = "Connection lost — reconnecting…";
});

// Keep the guest name the server knows in sync with the name box.
playerNameEl.addEventListener("change", () => {
  if (online && !account) net.setName(playerNameEl.value.trim().slice(0, 20));
});

function clearLobbyTimers() {
  lobbyTimers.forEach((t) => clearTimeout(t));
  lobbyTimers = [];
}

cancelLobbyBtn.addEventListener("click", () => {
  clearLobbyTimers();
  closePasswordPrompt();
  if (online) net.leaveRoom();
  currentRoom = null;
  lobbyOverlay.classList.add("hidden");
});

startMatchBtn.addEventListener("click", () => {
  startMatchBtn.disabled = true;
  net.startMatch();
});

// ---------- live lobby, driven entirely by server `room` messages ----------

function renderNetLobby(room) {
  currentRoom = room;
  const mode = MODES[room.mode] || { label: room.mode, teamSize: 1 };
  // textContent, not innerHTML: room names are typed by other players.
  lobbyServerName.textContent = (room.isPrivate ? "🔒 " : "") + room.name;
  lobbyModeLabel.textContent = mode.label.toUpperCase() + (room.isPrivate ? " · PRIVATE" : "");

  const parts = [];
  for (const m of room.members) {
    const you = m.id === myClientId ? " (you)" : "";
    parts.push(`<span class="dash-lobby-slot filled human">${escapeHtml(m.name)}${you}${m.isHost ? " ★" : ""}</span>`);
  }
  // Slots nobody has taken become bots the host simulates, so a 3v3 or 5v5 is
  // playable without waiting for ten strangers.
  for (let i = room.members.length; i < room.capacity; i++) {
    parts.push(`<span class="dash-lobby-slot bot">bot</span>`);
  }
  lobbySlots.innerHTML = parts.join("");

  const iAmHost = room.hostId === myClientId;
  const remaining = room.capacity - room.players;

  if (room.state === "countdown") {
    lobbyStatus.textContent = `Match starting in ${Math.ceil(room.countdownMs / 1000)}…`;
    startMatchBtn.hidden = true;
  } else if (room.state === "playing") {
    lobbyStatus.textContent = "Match in progress…";
    startMatchBtn.hidden = true;
  } else {
    lobbyStatus.textContent = remaining > 0
      ? `Waiting for ${remaining} more player${remaining === 1 ? "" : "s"}… empty slots become bots.`
      : "Everyone's here.";
    startMatchBtn.hidden = !iAmHost;
    startMatchBtn.disabled = false;
    startMatchBtn.textContent = remaining > 0 ? "START WITH BOTS" : "START MATCH";
  }
  // Only the host of a private room has a password to show.
  showCodeBtn.hidden = !(room.isPrivate && iAmHost);

  lobbyOverlay.classList.remove("hidden");
}
