// Shared local "backend" for the dashboard/lobby prototype. Everything here
// is localStorage-only -- there is no real server yet. Kept as its own
// module so dashboard.js and arena3d.js read/write the exact same shape
// without duplicating the logic, and so swapping this out for real network
// calls later only touches this one file.

const PROFILE_KEY = "neegy_profile_v1";
const SERVERS_KEY = "neegy_custom_servers_v1";

export const MODES = {
  "1v1": { teamSize: 1, label: "1v1 Duel" },
  "3v3": { teamSize: 3, label: "3v3 Skirmish" },
  "5v5": { teamSize: 5, label: "5v5 Assault" },
};

export const XP_PER_KILL = 25;
export const XP_PER_GAME = 5;

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function loadProfile() {
  const p = safeParse(localStorage.getItem(PROFILE_KEY), null);
  return p || { name: "", kills: 0, deaths: 0, xp: 0, gamesPlayed: 0 };
}

export function saveProfile(p) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

// merges the result of one match into the persisted profile and returns the
// updated profile (also saves it)
export function recordMatchResult(profile, { kills = 0, deaths = 0, won = false } = {}) {
  const p = { ...profile };
  p.kills = (p.kills || 0) + kills;
  p.deaths = (p.deaths || 0) + deaths;
  p.gamesPlayed = (p.gamesPlayed || 0) + 1;
  p.xp = (p.xp || 0) + kills * XP_PER_KILL + XP_PER_GAME;
  saveProfile(p);
  return p;
}

export function loadCustomServers() {
  return safeParse(localStorage.getItem(SERVERS_KEY), []);
}

export function saveCustomServers(list) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(list));
}

export function addCustomServer(server) {
  const list = loadCustomServers();
  list.push(server);
  saveCustomServers(list);
  return list;
}

// A handful of always-present public servers so the browser list never
// looks empty on a fresh visit -- flavor/placeholder until real players can
// actually host these.
export const FLAVOR_SERVERS = [
  { id: "flavor-1", name: "Sunset Duel", mode: "1v1", hostName: "Neegy", flavor: true },
  { id: "flavor-2", name: "Town Skirmish", mode: "3v3", hostName: "Neegy", flavor: true },
  { id: "flavor-3", name: "Gold Rush Assault", mode: "5v5", hostName: "Neegy", flavor: true },
];

// Mock leaderboard entries so the ranking doesn't look empty before other
// real players exist -- replaced by real X handles once login lands.
export const MOCK_LEADERBOARD = [
  { name: "@duneRider", kills: 214, xp: 6350 },
  { name: "@goldjackal", kills: 176, xp: 5120 },
  { name: "@snipeQueen", kills: 158, xp: 4740 },
  { name: "@crateking", kills: 121, xp: 3610 },
  { name: "@lowpoly_lars", kills: 88, xp: 2540 },
];
