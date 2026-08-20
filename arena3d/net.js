// Client transport for real multiplayer. One WebSocket per tab, shared by the
// dashboard (room browser + lobby) and the game (match sync).
//
// Like account.js, this degrades: if the socket cannot be opened -- which is
// the normal case on a plain static host with no backend -- `status` settles
// on "unavailable" and callers fall back to the old offline behavior (mock
// lobby, bots only). Multiplayer is an upgrade, never a requirement.
//
// The socket carries the HTTP session cookie from the handshake, so a
// signed-in player is already identified by their X handle server-side; there
// is no separate socket login.

const listeners = new Map(); // type -> Set<fn>
let socket = null;
let status = "idle"; // idle | connecting | open | unavailable | closed
let reconnectDelay = 500;
let reconnectTimer = null;
let intentionalClose = false;
// Messages sent before the socket finishes opening are held rather than lost.
let queue = [];

// Stable for the lifetime of this browser tab, and deliberately sessionStorage
// rather than localStorage: two tabs are two players, and must not share an id.
function tabId() {
  let id = sessionStorage.getItem("neegy_tab_id");
  if (!id) {
    id = "tab-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("neegy_tab_id", id);
  }
  return id;
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

function emit(type, payload) {
  for (const fn of listeners.get(type) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error("net listener failed for", type, err);
    }
  }
}

export function getStatus() {
  return status;
}

export function isAvailable() {
  return status === "open";
}

function url() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

export function connect() {
  if (socket && (status === "open" || status === "connecting")) return;
  intentionalClose = false;
  status = "connecting";
  emit("status", status);

  let ws;
  try {
    ws = new WebSocket(url());
  } catch {
    status = "unavailable";
    emit("status", status);
    return;
  }
  socket = ws;

  ws.onopen = () => {
    status = "open";
    reconnectDelay = 500;
    // Always first: identifies this browser tab so the server can re-bind us
    // to the room/team/entities we already had, rather than treating a page
    // navigation (dashboard -> game) as "player left".
    ws.send(JSON.stringify({ t: "hello", tabId: tabId() }));
    for (const msg of queue) ws.send(msg);
    queue = [];
    emit("status", status);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    emit(msg.t, msg);
    emit("*", msg);
  };

  ws.onerror = () => {
    // Fired before onclose when the connection never established at all --
    // on a static host that is the "there is no backend" signal.
    if (status === "connecting") {
      status = "unavailable";
      emit("status", status);
    }
  };

  ws.onclose = () => {
    socket = null;
    // "unavailable" means the socket never established -- there is no backend
    // here, so stay quiet rather than retrying forever on a static host.
    const neverConnected = status === "unavailable";
    if (intentionalClose || neverConnected) {
      if (!neverConnected) status = "closed";
      emit("status", status);
      return;
    }
    status = "closed";
    emit("status", status);
    // Exponential backoff, capped -- a dropped wifi should recover on its own.
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

export function disconnect() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}

export function send(msg) {
  const text = JSON.stringify(msg);
  if (socket && status === "open") socket.send(text);
  else if (status === "connecting") queue.push(text);
}

// Resolves once the socket is either open or definitively unavailable, so
// callers can decide between the real lobby and the offline fallback without
// racing the connection.
export function ready(timeoutMs = 2500) {
  if (status === "open") return Promise.resolve(true);
  if (status === "unavailable") return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const off = on("status", (s) => {
      if (s === "open") done(true);
      else if (s === "unavailable") done(false);
    });
    const timer = setTimeout(() => done(status === "open"), timeoutMs);
  });
}

// ---------- convenience wrappers ----------

export const setName = (name) => send({ t: "name", name });
export const listRooms = () => send({ t: "rooms" });
export const createRoom = (name, mode) => send({ t: "create", name, mode });
export const joinRoom = (roomId) => send({ t: "join", roomId });
export const leaveRoom = () => send({ t: "leave" });
export const startMatch = () => send({ t: "start" });
export const sendEntities = (ents) => send({ t: "ents", ents });
export const sendHit = (target, damage) => send({ t: "hit", target, damage });
export const sendShot = (shot) => send({ t: "shot", ...shot });
