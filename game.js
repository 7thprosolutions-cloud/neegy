(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const GROUND_Y = H - 60;

  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const livesEl = document.getElementById("lives");
  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");

  const BEST_KEY = "neegy_best_score";
  let best = Number(localStorage.getItem(BEST_KEY) || 0);
  bestEl.textContent = best;

  // ---------- input ----------
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", " ", "Spacebar"].includes(e.key)) e.preventDefault();
    keys.add(e.key.toLowerCase());
    if (e.key === " " || e.key === "Spacebar") shootRequested = true;
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  canvas.addEventListener("mousedown", () => (shootRequested = true));
  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      shootRequested = true;
    },
    { passive: false }
  );

  let shootRequested = false;

  // ---------- state ----------
  const GRAVITY = 0.62;
  const MOVE_SPEED = 4.4;
  const JUMP_VELOCITY = -13.5;
  const SHOOT_COOLDOWN = 16; // frames

  let state = "idle"; // idle | playing | gameover
  let frame = 0;
  let score = 0;
  let lives = 3;
  let spawnTimer = 0;
  let spawnInterval = 90;
  let enemySpeedBase = 1.6;

  const player = {
    x: W / 2,
    y: GROUND_Y,
    vx: 0,
    vy: 0,
    w: 34,
    h: 70,
    facing: 1,
    onGround: true,
    cooldown: 0,
    hitFlash: 0,
    legPhase: 0,
  };

  let bullets = [];
  let enemies = [];
  let particles = [];

  function resetGame() {
    score = 0;
    lives = 3;
    frame = 0;
    spawnTimer = 0;
    spawnInterval = 90;
    enemySpeedBase = 1.6;
    player.x = W / 2;
    player.y = GROUND_Y;
    player.vx = 0;
    player.vy = 0;
    player.onGround = true;
    player.cooldown = 0;
    player.hitFlash = 0;
    bullets = [];
    enemies = [];
    particles = [];
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    livesEl.textContent = "♥ ".repeat(Math.max(lives, 0)).trim();
  }

  // ---------- entities ----------
  function spawnEnemy() {
    const fromLeft = Math.random() < 0.5;
    const speedVariance = Math.random() * 0.6;
    enemies.push({
      x: fromLeft ? -30 : W + 30,
      y: GROUND_Y,
      w: 30,
      h: 54,
      dir: fromLeft ? 1 : -1,
      speed: enemySpeedBase + speedVariance,
      alive: true,
      legPhase: Math.random() * Math.PI * 2,
      hp: 1,
    });
  }

  function spawnParticles(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6 - 1,
        life: 24 + Math.random() * 12,
        color,
      });
    }
  }

  function shoot() {
    if (player.cooldown > 0) return;
    player.cooldown = SHOOT_COOLDOWN;
    bullets.push({
      x: player.x + player.facing * player.w * 0.6,
      y: player.y - player.h * 0.62,
      vx: player.facing * 11,
      w: 10,
      h: 4,
    });
  }

  // ---------- update ----------
  function update() {
    frame++;

    // input -> movement
    const left = keys.has("arrowleft") || keys.has("a");
    const right = keys.has("arrowright") || keys.has("d");
    const jump = keys.has("arrowup") || keys.has("w");

    player.vx = 0;
    if (left) {
      player.vx = -MOVE_SPEED;
      player.facing = -1;
    }
    if (right) {
      player.vx = MOVE_SPEED;
      player.facing = 1;
    }
    if (jump && player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
    }
    if (shootRequested) {
      shoot();
      shootRequested = false;
    }
    if (player.cooldown > 0) player.cooldown--;

    // physics
    player.x += player.vx;
    player.x = Math.max(30, Math.min(W - 30, player.x));
    player.vy += GRAVITY;
    player.y += player.vy;
    if (player.y >= GROUND_Y) {
      player.y = GROUND_Y;
      player.vy = 0;
      player.onGround = true;
    }
    if (player.vx !== 0 && player.onGround) player.legPhase += 0.3;
    if (player.hitFlash > 0) player.hitFlash--;

    // bullets
    bullets.forEach((b) => (b.x += b.vx));
    bullets = bullets.filter((b) => b.x > -20 && b.x < W + 20);

    // spawn enemies, ramping difficulty
    spawnTimer++;
    if (spawnTimer >= spawnInterval) {
      spawnTimer = 0;
      spawnEnemy();
      spawnInterval = Math.max(35, spawnInterval - 1.2);
      enemySpeedBase = Math.min(4.2, enemySpeedBase + 0.03);
    }

    // enemies
    enemies.forEach((en) => {
      en.x += en.dir * en.speed;
      en.legPhase += 0.25;
    });

    // bullet vs enemy
    for (const en of enemies) {
      if (!en.alive) continue;
      for (const b of bullets) {
        if (
          Math.abs(b.x - en.x) < en.w / 2 + 6 &&
          Math.abs(en.y - en.h / 2 - b.y) < en.h / 2
        ) {
          en.alive = false;
          b.x = -9999;
          score += 10;
          spawnParticles(en.x, en.y - en.h / 2, "#ff5f6d", 14);
        }
      }
    }
    enemies = enemies.filter((en) => en.alive && en.x > -60 && en.x < W + 60);
    bullets = bullets.filter((b) => b.x > -20 && b.x < W + 20);

    // enemy vs player
    for (const en of enemies) {
      if (Math.abs(en.x - player.x) < (en.w + player.w) / 2 - 6 && player.hitFlash === 0) {
        en.alive = false;
        lives--;
        player.hitFlash = 45;
        spawnParticles(player.x, player.y - player.h / 2, "#ffd76a", 16);
        updateHud();
        if (lives <= 0) {
          endGame();
        }
      }
    }
    enemies = enemies.filter((en) => en.alive);

    // particles
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.25;
      p.life--;
    });
    particles = particles.filter((p) => p.life > 0);

    updateHud();
  }

  function endGame() {
    state = "gameover";
    if (score > best) {
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
    }
    showOverlay(
      "GAME OVER",
      `Score ${score} &middot; Best ${best}`,
      "PLAY AGAIN"
    );
  }

  // ---------- drawing ----------
  function drawBackground() {
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#241a3d");
    g.addColorStop(0.55, "#3a2a5c");
    g.addColorStop(1, "#201530");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // distant moons/stars
    ctx.fillStyle = "rgba(255,215,106,0.5)";
    ctx.beginPath();
    ctx.arc(W - 90, 70, 30, 0, Math.PI * 2);
    ctx.fill();

    // ground
    ctx.fillStyle = "#150f24";
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.strokeStyle = "rgba(255,215,106,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(W, GROUND_Y);
    ctx.stroke();
  }

  function drawGoldGuy(x, y, w, h, facing, legPhase, hitFlash) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(facing, 1);

    const flashOn = hitFlash > 0 && Math.floor(hitFlash / 4) % 2 === 0;
    const gold = ctx.createLinearGradient(-w, -h, w, 0);
    gold.addColorStop(0, flashOn ? "#ffffff" : "#fff2b8");
    gold.addColorStop(0.5, flashOn ? "#ffffff" : "#f6c445");
    gold.addColorStop(1, flashOn ? "#ffffff" : "#b9812a");
    ctx.fillStyle = gold;
    ctx.strokeStyle = "#7a5417";
    ctx.lineWidth = 1.5;

    // legs
    const stride = Math.sin(legPhase) * 8;
    ctx.fillRect(-9, -26 + Math.max(0, -stride) * 0.2, 8, 26);
    ctx.fillRect(2, -26 + Math.max(0, stride) * 0.2, 8, 26);

    // body
    ctx.beginPath();
    ctx.moveTo(-11, -h * 0.5);
    ctx.quadraticCurveTo(-13, -h * 0.78, -6, -h * 0.86);
    ctx.lineTo(9, -h * 0.86);
    ctx.quadraticCurveTo(14, -h * 0.78, 12, -h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // arm + gun (front arm)
    ctx.beginPath();
    ctx.moveTo(9, -h * 0.68);
    ctx.lineTo(22, -h * 0.6);
    ctx.lineTo(21, -h * 0.53);
    ctx.lineTo(9, -h * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // gun barrel
    ctx.fillStyle = "#4a4a52";
    ctx.fillRect(20, -h * 0.615, 16, 5);
    ctx.fillStyle = gold;

    // head/neck
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.94, 5, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // long face - elongated skull with big nose
    ctx.beginPath();
    ctx.moveTo(-9, -h * 0.97);
    ctx.quadraticCurveTo(-13, -h * 1.18, -3, -h * 1.32);
    ctx.quadraticCurveTo(2, -h * 1.4, 6, -h * 1.3);
    ctx.quadraticCurveTo(9, -h * 1.18, 8, -h * 1.02);
    ctx.quadraticCurveTo(20, -h * 1.0, 22, -h * 0.93);
    ctx.quadraticCurveTo(21, -h * 0.87, 8, -h * 0.9);
    ctx.quadraticCurveTo(4, -h * 0.85, -2, -h * 0.88)
    ctx.quadraticCurveTo(-9, -h * 0.9, -9, -h * 0.97);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ear
    ctx.beginPath();
    ctx.ellipse(-11, -h * 1.1, 4.5, 6, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // hair tuft
    ctx.strokeStyle = "#7a5417";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-2, -h * 1.31);
    ctx.lineTo(-5, -h * 1.44);
    ctx.moveTo(0, -h * 1.32);
    ctx.lineTo(0, -h * 1.46);
    ctx.moveTo(2, -h * 1.31);
    ctx.lineTo(4, -h * 1.43);
    ctx.stroke();

    // eye
    ctx.fillStyle = "#3a2a10";
    ctx.beginPath();
    ctx.ellipse(-1, -h * 1.14, 1.6, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawEnemy(en) {
    ctx.save();
    ctx.translate(en.x, en.y);
    const stride = Math.sin(en.legPhase) * 7;
    ctx.fillStyle = "#8c2c3b";
    ctx.strokeStyle = "#3d0f18";
    ctx.lineWidth = 1.5;

    // legs
    ctx.fillRect(-8, -20 + Math.max(0, -stride) * 0.2, 7, 20);
    ctx.fillRect(1, -20 + Math.max(0, stride) * 0.2, 7, 20);

    // body
    ctx.beginPath();
    ctx.moveTo(-10, -en.h * 0.4);
    ctx.lineTo(-9, -en.h * 0.75);
    ctx.lineTo(9, -en.h * 0.75);
    ctx.lineTo(10, -en.h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // spiky head
    ctx.beginPath();
    ctx.arc(0, -en.h * 0.9, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3d0f18";
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 5, -en.h * 0.9 - 10);
      ctx.lineTo(i * 5 - 2, -en.h * 0.9 - 18);
      ctx.lineTo(i * 5 + 2, -en.h * 0.9 - 18);
      ctx.closePath();
      ctx.fill();
    }
    // eyes
    ctx.fillStyle = "#ffe86a";
    ctx.beginPath();
    ctx.ellipse(-4, -en.h * 0.9, 2, 2.4, 0, 0, Math.PI * 2);
    ctx.ellipse(4, -en.h * 0.9, 2, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function draw() {
    drawBackground();

    // bullets
    ctx.fillStyle = "#ffe86a";
    ctx.shadowColor = "#ffe86a";
    ctx.shadowBlur = 8;
    bullets.forEach((b) => ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h));
    ctx.shadowBlur = 0;

    enemies.forEach(drawEnemy);
    drawGoldGuy(player.x, player.y, player.w, player.h, player.facing, player.legPhase, player.hitFlash);

    // particles
    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(p.life / 30, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    });
  }

  // ---------- loop ----------
  function loop() {
    if (state === "playing") {
      update();
      draw();
    }
    requestAnimationFrame(loop);
  }

  function showOverlay(title, subtitle, buttonText) {
    overlay.innerHTML = `
      <h1>${title}</h1>
      ${subtitle ? `<p class="result">${subtitle}</p>` : `<p class="tagline">Gold Gunner Arcade</p>`}
      <p class="hint">Enemies rush from both sides — shoot them down and survive.</p>
      <div class="controls">
        <div><b>&larr; &rarr;</b> or <b>A / D</b> — move</div>
        <div><b>&uarr;</b> or <b>W</b> — jump</div>
        <div><b>SPACE</b> or <b>click</b> — shoot</div>
      </div>
      <button id="startBtn">${buttonText}</button>
      <p class="footnote">No sign up. Just your score.</p>
    `;
    overlay.classList.remove("hidden");
    document.getElementById("startBtn").addEventListener("click", startGame);
  }

  function startGame() {
    resetGame();
    state = "playing";
    overlay.classList.add("hidden");
  }

  startBtn.addEventListener("click", startGame);

  updateHud();
  requestAnimationFrame(loop);
})();
