// Beta strip for the preview build.
//
// Shown only when the site is NOT running on the production domain, so it
// appears for everyone testing the staging link and disappears by itself the
// moment the real domain goes live -- no flag to remember to turn off.
//
// Loaded by the homepage and the arena dashboard.

(function () {
  "use strict";

  var PRODUCTION_HOSTS = ["neegy.life", "www.neegy.life"];
  if (PRODUCTION_HOSTS.indexOf(location.hostname) !== -1) return;

  // Someone who has dismissed it once should not see it every navigation.
  try {
    if (sessionStorage.getItem("neegy_beta_dismissed") === "1") return;
  } catch (e) { /* storage blocked; just show it */ }

  var bar = document.createElement("div");
  bar.className = "beta-bar";
  bar.innerHTML =
    '<span class="beta-tag">Preview build</span>' +
    '<span class="beta-msg">Still being built — things may change or break while you play. ' +
    'Found something? Tell <a href="https://x.com/EDthemountain" target="_blank" rel="noopener">@EDthemountain</a>.</span>' +
    '<button type="button" class="beta-x" aria-label="Dismiss">×</button>';

  var style = document.createElement("style");
  style.textContent = [
    ".beta-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;",
    "gap:12px;padding:10px 16px;background:#141117;border-top:1px solid rgba(232,178,60,.35);",
    "font:400 13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#c9c0b2}",
    ".beta-tag{flex:none;font:600 10px/1 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;",
    "color:#0a0908;background:#e8b23c;border-radius:999px;padding:6px 10px}",
    ".beta-msg{flex:1;min-width:0}",
    ".beta-bar a{color:#e8b23c}",
    ".beta-x{flex:none;background:none;border:0;color:#8b8378;font-size:20px;line-height:1;",
    "cursor:pointer;padding:4px 8px;border-radius:4px}",
    ".beta-x:hover{color:#ede7dc}",
    "@media(max-width:560px){.beta-bar{font-size:12px;padding:9px 12px;gap:9px}.beta-tag{display:none}}",
  ].join("");

  function mount() {
    document.head.appendChild(style);
    document.body.appendChild(bar);
    bar.querySelector(".beta-x").addEventListener("click", function () {
      bar.remove();
      try { sessionStorage.setItem("neegy_beta_dismissed", "1"); } catch (e) { /* fine */ }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
