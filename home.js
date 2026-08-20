// Homepage behaviour: the play button adapts to who you are, and the contract
// address copies on click.
//
// Deliberately dependency-free and non-blocking — nothing here is required for
// the page to be readable, so a failed request or an old browser costs a nicer
// button label, never the content.

(function () {
  "use strict";

  // ---------- play button ----------
  //
  // Three states, because sending someone to a sign-in page that cannot work is
  // worse than not offering it:
  //   signed in          -> straight to the dashboard
  //   backend, signed out-> sign in with X, which lands on the dashboard after
  //   no backend         -> play as a guest (static hosting, no game server)

  var buttons = [
    { btn: document.getElementById("playBtn"), label: document.getElementById("playLabel") },
    { btn: document.getElementById("playBtn2"), label: document.getElementById("playLabel2") },
  ].filter(function (b) { return b.btn && b.label; });

  var note = document.getElementById("ctaNote");

  function setPlay(href, text, noteText) {
    buttons.forEach(function (b) {
      b.btn.setAttribute("href", href);
      b.label.textContent = text;
    });
    if (note && noteText) note.textContent = noteText;
  }

  function resolvePlayState() {
    // Same positive-handshake test the game uses: only our own backend answers
    // /api/me with a `player` key. A static host's 404 page can be JSON too, so
    // checking the content type is not enough.
    fetch("/api/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("no backend");
        return res.json();
      })
      .then(function (body) {
        if (!body || !Object.prototype.hasOwnProperty.call(body, "player")) throw new Error("no backend");
        if (body.player && body.player.handle) {
          setPlay(
            "/arena3d/dashboard.html",
            "Enter the arena",
            "Signed in as @" + body.player.handle + " — " + (body.player.xp || 0) + " XP banked."
          );
        } else {
          setPlay(
            "/auth/x/login",
            "Sign in with X to play",
            "Your X handle becomes your name on the leaderboard."
          );
        }
      })
      .catch(function () {
        setPlay(
          "/arena3d/dashboard.html",
          "Play as guest",
          "Sign-in is offline right now — you can still play against bots."
        );
      });
  }

  resolvePlayState();

  // ---------- contract address ----------

  var caBtn = document.getElementById("caBtn");
  var caHint = document.getElementById("caHint");

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // If the clipboard is refused (an unfocused tab, an old browser, a locked-down
  // webview), select the address so Ctrl+C still works. Telling someone to
  // "select it manually" without selecting it for them is a dead end -- and
  // getting this address wrong is the one mistake that costs real money.
  function selectAddress() {
    var node = document.getElementById("caText");
    if (!node || !window.getSelection || !document.createRange) return;
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function flash(ok) {
    if (!caHint || !caBtn) return;
    // "Acquired" rather than "Copied": in the arena that is what picking
    // something up says, and this block is styled as a pickup.
    caHint.textContent = ok ? "✅ Acquired" : "Selected — press Ctrl+C";
    if (!ok) selectAddress();
    caBtn.classList.toggle("acquired", ok);
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(function () {
      caHint.textContent = "Click to copy";
      caBtn.classList.remove("acquired");
    }, 2200);
  }

  if (caBtn) {
    caBtn.addEventListener("click", function () {
      var address = caBtn.getAttribute("data-address") || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(
          function () { flash(true); },
          function () { flash(legacyCopy(address)); }
        );
      } else {
        flash(legacyCopy(address));
      }
    });
  }
})();
