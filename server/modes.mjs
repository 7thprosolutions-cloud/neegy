// Server-side copy of the game mode table.
//
// Deliberately duplicated from arena3d/profile.js rather than imported: that
// file is a browser ES module (and this repo has no package.json, so Node
// treats plain .js as CommonJS), and the static file handler refuses to serve
// anything under /server/ so the browser cannot import this one either.
// Three lines of duplication beats punching a hole in either boundary --
// but they must stay in sync, so change both together.
export const MODES = {
  "1v1": { teamSize: 1, label: "1v1 Duel" },
  "3v3": { teamSize: 3, label: "3v3 Skirmish" },
  "5v5": { teamSize: 5, label: "5v5 Assault" },
};
