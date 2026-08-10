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

  // ---------- sprite assets ----------
  const PLAYER_RENDER_H = 84;
  const ENEMY_RENDER_H = 70;
  const sprites = { playerWalk: [], playerJump: [], enemyWalk: [] };
  let assetsReady = false;

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = src;
    });
  }

  startBtn.disabled = true;
  Promise.all([
    ...Array.from({ length: 8 }, (_, i) => loadImage(`assets/sprites/player/walk${i + 1}.png`)),
    ...Array.from({ length: 6 }, (_, i) => loadImage(`assets/sprites/player/jump${i + 1}.png`)),
    ...Array.from({ length: 8 }, (_, i) => loadImage(`assets/sprites/enemy/walk${i + 1}.png`)),
  ]).then((imgs) => {
    sprites.playerWalk = imgs.slice(0, 8);
    sprites.playerJump = imgs.slice(8, 14);
    sprites.enemyWalk = imgs.slice(14, 22);
    assetsReady = true;
    const btn = document.getElementById("startBtn");
    if (btn) btn.disabled = false;
  });

  const WALK_FRAME_STEP = 0.6; // legPhase units per animation frame

  function getPlayerFrame() {
    if (!player.onGround) {
      return player.vy < 0 ? sprites.playerJump[2] : sprites.playerJump[4];
    }
    if (player.vx !== 0) {
      const idx = Math.floor(player.legPhase / WALK_FRAME_STEP) % 8;
      return sprites.playerWalk[idx];
    }
    return sprites.playerWalk[0];
  }

  function getEnemyFrame(en) {
    const idx = Math.floor(en.legPhase / WALK_FRAME_STEP) % 8;
    return sprites.enemyWalk[idx];
  }

  function drawSprite(img, x, y, targetH, facing, hitFlash) {
    if (!img) return;
    const scale = targetH / img.naturalHeight;
    const w = img.naturalWidth * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(facing, 1);
    ctx.drawImage(img, -w / 2, -targetH, w, targetH);
    if (hitFlash > 0 && Math.floor(hitFlash / 4) % 2 === 0) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(-w / 2, -targetH, w, targetH);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  // ---------- tunables ----------
  const GRAVITY = 0.62;
  const MOVE_SPEED = 4.4;
  const JUMP_VELOCITY = -13.5;
  const SHOOT_COOLDOWN = 16; // frames
  const VIEW_ANCHOR = W * 0.32; // screen x where the player "sits" once the level is scrolling
  const FALL_LIMIT = 260; // world px below baseline before it counts as a pit death
  const FLOAT_PLATFORM_OFFSET = 90;

  let state = "idle"; // idle | playing | gameover
  let frame = 0;
  let score = 0;
  let lives = 3;
  let camera = { x: 0 };

  const player = {
    worldX: 120,
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
  let captions = [];
  let groundSegments = [];
  let floatPlatforms = [];
  let genX = 0;
  let enemySpawnTimer = 0;
  let enemySpeedBase = 1.6;

  function resetGame() {
    score = 0;
    lives = 3;
    frame = 0;
    camera.x = 0;
    player.worldX = 120;
    player.y = GROUND_Y;
    player.vx = 0;
    player.vy = 0;
    player.onGround = true;
    player.facing = 1;
    player.cooldown = 0;
    player.hitFlash = 0;
    bullets = [];
    enemies = [];
    particles = [];
    captions = [];
    groundSegments = [{ x1: -200, x2: 700 }];
    floatPlatforms = [];
    genX = 700;
    enemySpawnTimer = 0;
    enemySpeedBase = 1.6;
    generateTerrain();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    livesEl.textContent = "♥ ".repeat(Math.max(lives, 0)).trim();
  }

  // ---------- procedural level ----------
  function generateTerrain() {
    while (genX < camera.x + W + 500) {
      const groundLen = 220 + Math.random() * 220;
      const segment = { x1: genX, x2: genX + groundLen };
      groundSegments.push(segment);
      genX += groundLen;

      if (groundLen > 260 && Math.random() < 0.4) {
        const fx1 = segment.x1 + 50 + Math.random() * 40;
        const fx2 = Math.min(fx1 + 110 + Math.random() * 80, segment.x2 - 40);
        if (fx2 - fx1 > 60) {
          floatPlatforms.push({ x1: fx1, x2: fx2, y: GROUND_Y - FLOAT_PLATFORM_OFFSET });
        }
      }

      if (genX > 900 && Math.random() < 0.55) {
        const gapLen = 70 + Math.random() * 60;
        genX += gapLen;
      }
    }
    groundSegments = groundSegments.filter((s) => s.x2 > camera.x - 300);
    floatPlatforms = floatPlatforms.filter((p) => p.x2 > camera.x - 300);
  }

  // ---------- entities ----------
  function spawnEnemy() {
    const spawnX = camera.x + W + 60 + Math.random() * 120;
    const onGround = groundSegments.some((s) => spawnX > s.x1 + 10 && spawnX < s.x2 - 10);
    if (!onGround) return;
    enemies.push({
      x: spawnX,
      y: GROUND_Y,
      w: 30,
      h: 54,
      dir: -1,
      speed: enemySpeedBase + Math.random() * 0.6,
      alive: true,
      legPhase: Math.random() * Math.PI * 2,
    });
  }

  const KILL_QUIPS = ["Shut up Neegy!", "Shurup!", "Neegy!"];

  function spawnCaption(worldX, y) {
    captions.push({
      text: KILL_QUIPS[Math.floor(Math.random() * KILL_QUIPS.length)],
      worldX,
      y,
      vy: -0.6,
      life: 60,
      maxLife: 60,
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
      x: player.worldX + player.facing * player.w * 0.6,
      y: player.y - player.h * 0.62,
      vx: player.facing * 11,
      w: 10,
      h: 4,
    });
  }

  function respawnAfterFall() {
    lives--;
    player.hitFlash = 45;
    spawnParticles(player.worldX - camera.x, player.y - player.h / 2, "#ffd76a", 16);
    updateHud();
    if (lives <= 0) {
      endGame();
      return;
    }
    const next = groundSegments.find((s) => s.x1 >= player.worldX) || groundSegments[groundSegments.length - 1];
    player.worldX = next.x1 + 30;
    player.y = GROUND_Y;
    player.vy = 0;
    player.vx = 0;
    player.onGround = true;
  }

  // ---------- update ----------
  function update() {
    frame++;

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

    // horizontal physics
    player.worldX += player.vx;
    player.worldX = Math.max(player.worldX, camera.x + 20);

    // vertical physics + platform collision
    const prevY = player.y;
    player.vy += GRAVITY;
    const nextY = player.y + player.vy;

    let landed = null;
    if (player.vy >= 0) {
      const candidates = [
        ...groundSegments.map((s) => ({ x1: s.x1, x2: s.x2, y: GROUND_Y })),
        ...floatPlatforms,
      ];
      for (const plat of candidates) {
        if (player.worldX > plat.x1 && player.worldX < plat.x2 && prevY <= plat.y + 1 && nextY >= plat.y) {
          if (!landed || plat.y < landed.y) landed = plat;
        }
      }
    }

    if (landed) {
      player.y = landed.y;
      player.vy = 0;
      player.onGround = true;
    } else {
      player.y = nextY;
      player.onGround = false;
    }

    if (player.y > GROUND_Y + FALL_LIMIT) {
      respawnAfterFall();
    }

    if (player.vx !== 0 && player.onGround) player.legPhase += 0.3;
    if (player.hitFlash > 0) player.hitFlash--;

    // camera follows forward progress only (no backward scroll)
    const target = player.worldX - VIEW_ANCHOR;
    camera.x = Math.max(camera.x, Math.max(0, target));

    generateTerrain();

    // bullets
    bullets.forEach((b) => (b.x += b.vx));
    bullets = bullets.filter((b) => b.x > camera.x - 40 && b.x < camera.x + W + 40);

    // enemy spawn, ramping difficulty with progress
    enemySpawnTimer++;
    const spawnInterval = Math.max(45, 110 - Math.floor(player.worldX / 400));
    if (enemySpawnTimer >= spawnInterval) {
      enemySpawnTimer = 0;
      spawnEnemy();
      enemySpeedBase = Math.min(4.2, enemySpeedBase + 0.02);
    }

    enemies.forEach((en) => {
      en.x += en.dir * en.speed;
      en.legPhase += 0.25;
    });

    // bullet vs enemy
    for (const en of enemies) {
      if (!en.alive) continue;
      for (const b of bullets) {
        if (Math.abs(b.x - en.x) < en.w / 2 + 6 && Math.abs(en.y - en.h / 2 - b.y) < en.h / 2) {
          en.alive = false;
          b.x = -9999;
          score += 10;
          spawnParticles(en.x - camera.x, en.y - en.h / 2, "#ff5f6d", 14);
          spawnCaption(player.worldX, player.y - PLAYER_RENDER_H - 12);
        }
      }
    }
    enemies = enemies.filter((en) => en.alive && en.x > camera.x - 100);
    bullets = bullets.filter((b) => b.x > camera.x - 40 && b.x < camera.x + W + 40);

    // enemy vs player
    for (const en of enemies) {
      if (Math.abs(en.x - player.worldX) < (en.w + player.w) / 2 - 6 && player.hitFlash === 0) {
        en.alive = false;
        lives--;
        player.hitFlash = 45;
        spawnParticles(player.worldX - camera.x, player.y - player.h / 2, "#ffd76a", 16);
        updateHud();
        if (lives <= 0) endGame();
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

    // captions
    captions.forEach((c) => {
      c.y += c.vy;
      c.life--;
    });
    captions = captions.filter((c) => c.life > 0);

    const distanceScore = Math.floor((player.worldX - 120) / 8);
    score = Math.max(score, distanceScore);

    updateHud();
  }

  function endGame() {
    state = "gameover";
    if (score > best) {
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
    }
    showOverlay("GAME OVER", `Score ${score} &middot; Best ${best}`, "PLAY AGAIN");
  }

  // ---------- drawing ----------
  function drawBackground() {
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#4ea9ff");
    g.addColorStop(0.75, "#bfe6ff");
    g.addColorStop(1, "#e8f8ff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // sun
    const sunX = W - 100 - camera.x * 0.04;
    const sunWrapped = ((sunX % (W + 200)) + W + 200) % (W + 200) - 100;
    ctx.fillStyle = "#fff3a0";
    ctx.beginPath();
    ctx.arc(sunWrapped, 80, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffe45c";
    ctx.beginPath();
    ctx.arc(sunWrapped, 80, 32, 0, Math.PI * 2);
    ctx.fill();

    // clouds (parallax)
    function drawCloud(cx, cy, scale) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(cx, cy, 26 * scale, 16 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 22 * scale, cy - 8 * scale, 20 * scale, 14 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 42 * scale, cy, 24 * scale, 15 * scale, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 20 * scale, cy + 6 * scale, 30 * scale, 13 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const cloudSpacing = 340;
    const cloudOffset = -((camera.x * 0.15) % cloudSpacing);
    let ci = 0;
    for (let x = cloudOffset - cloudSpacing; x < W + cloudSpacing; x += cloudSpacing) {
      const bandY = ci % 2 === 0 ? 70 : 130;
      drawCloud(x, bandY, ci % 2 === 0 ? 1 : 0.75);
      ci++;
    }

    // distant hills
    ctx.fillStyle = "#8fd45a";
    const hillOffset = -((camera.x * 0.3) % 260);
    for (let x = hillOffset - 260; x < W + 260; x += 260) {
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y + 50, 170, 100, 0, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = "#79c94a";
    const hillOffset2 = -((camera.x * 0.45) % 200);
    for (let x = hillOffset2 - 200; x < W + 200; x += 200) {
      ctx.beginPath();
      ctx.ellipse(x + 100, GROUND_Y + 55, 120, 70, 0, Math.PI, 0);
      ctx.fill();
    }
  }

  const TILE = 32;
  const GRASS_H = 14;
  const GRASS_COLOR = "#4ec13f";
  const GRASS_SHADE = "#3aa62d";
  const DIRT_COLOR = "#c87f3b";
  const DIRT_LINE = "#a5652a";
  const DIRT_HILITE = "#e0a262";
  const BRICK_COLOR = "#c9772f";
  const BRICK_LINE = "#8a4f1e";
  const BRICK_HILITE = "#e8a55c";

  function drawGroundTile(screenX, topY, height) {
    ctx.fillStyle = GRASS_COLOR;
    ctx.fillRect(screenX, topY, TILE, GRASS_H);
    ctx.fillStyle = GRASS_SHADE;
    ctx.fillRect(screenX, topY + GRASS_H - 4, TILE, 4);

    const dirtTop = topY + GRASS_H;
    const dirtH = height - GRASS_H;
    ctx.fillStyle = DIRT_COLOR;
    ctx.fillRect(screenX, dirtTop, TILE, dirtH);
    ctx.strokeStyle = DIRT_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(screenX + 1, dirtTop + 1, TILE - 2, Math.min(dirtH - 2, TILE - 2));
    ctx.fillStyle = DIRT_HILITE;
    ctx.fillRect(screenX + 5, dirtTop + 5, 6, 6);
  }

  function drawBrickTile(screenX, topY) {
    ctx.fillStyle = BRICK_COLOR;
    ctx.fillRect(screenX, topY, TILE, TILE * 0.5);
    ctx.strokeStyle = BRICK_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(screenX + 1, topY + 1, TILE - 2, TILE * 0.5 - 2);
    ctx.fillStyle = BRICK_HILITE;
    ctx.fillRect(screenX + 4, topY + 3, TILE - 8, 3);
  }

  function drawTerrain() {
    ctx.fillStyle = "#14101f";
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

    groundSegments.forEach((s) => {
      const x1 = s.x1 - camera.x;
      const x2 = s.x2 - camera.x;
      if (x2 < -40 || x1 > W + 40) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, GROUND_Y, x2 - x1, H - GROUND_Y);
      ctx.clip();

      const firstTileWorldX = Math.floor(s.x1 / TILE) * TILE;
      for (let wx = firstTileWorldX; wx < s.x2 + TILE; wx += TILE) {
        drawGroundTile(wx - camera.x, GROUND_Y, H - GROUND_Y);
      }
      ctx.restore();
    });

    floatPlatforms.forEach((p) => {
      const x1 = p.x1 - camera.x;
      const x2 = p.x2 - camera.x;
      if (x2 < -40 || x1 > W + 40) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, p.y, x2 - x1, TILE * 0.5);
      ctx.clip();
      const firstTileWorldX = Math.floor(p.x1 / TILE) * TILE;
      for (let wx = firstTileWorldX; wx < p.x2 + TILE; wx += TILE) {
        drawBrickTile(wx - camera.x, p.y);
      }
      ctx.restore();
    });
  }

  function draw() {
    drawBackground();
    drawTerrain();

    ctx.fillStyle = "#ffe86a";
    ctx.shadowColor = "#ffe86a";
    ctx.shadowBlur = 8;
    bullets.forEach((b) => ctx.fillRect(b.x - camera.x - b.w / 2, b.y - b.h / 2, b.w, b.h));
    ctx.shadowBlur = 0;

    enemies.forEach((en) => drawSprite(getEnemyFrame(en), en.x - camera.x, en.y, ENEMY_RENDER_H, en.dir, 0));
    drawSprite(getPlayerFrame(), player.worldX - camera.x, player.y, PLAYER_RENDER_H, player.facing, player.hitFlash);

    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(p.life / 30, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    });

    captions.forEach((c) => {
      const x = c.worldX - camera.x;
      ctx.globalAlpha = Math.min(1, c.life / 20);
      ctx.font = "bold 20px 'Trebuchet MS', 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#2b2010";
      ctx.strokeText(c.text, x, c.y);
      ctx.fillStyle = "#ffe45c";
      ctx.fillText(c.text, x, c.y);
      ctx.globalAlpha = 1;
    });
    ctx.textAlign = "left";
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
      <p class="hint">Run right, jump the gaps, hop onto ledges, and shoot down anything in your way.</p>
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
    if (!assetsReady) return;
    resetGame();
    state = "playing";
    overlay.classList.add("hidden");
  }

  startBtn.addEventListener("click", startGame);

  updateHud();
  requestAnimationFrame(loop);
})();
