// Root entry point.
//
// The real server lives in server/server.mjs. This file exists because hosting
// platforms (Hostinger's Web App deploy among them) look for a conventional
// root-level `server.js` as the thing that starts the app, and will otherwise
// fall back to treating the repo as a static site -- which silently disables
// login and multiplayer, since neither can work without a running process.
//
// Kept as .js (CommonJS) on purpose so it works no matter how the platform
// decides to load it; the dynamic import pulls in the real ES module.
import("./server/server.mjs").catch((err) => {
  console.error("Failed to start the Neegy server:", err);
  process.exit(1);
});
