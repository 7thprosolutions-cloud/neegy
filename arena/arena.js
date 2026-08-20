(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");

  let W = 0, H = 0, GROUND_Y = 0;

  function resize() {
    const oldW = W, oldH = H, oldGround = GROUND_Y;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    GROUND_Y = H - 90;

    if (oldW > 0 && worldReady) {
      const scaleX = W / oldW;
      rescaleWorld(scaleX, oldGround);
    }
  }

  let worldReady = false;

  // ---------- tunables ----------
  const GRAVITY = 0.62;
  const MOVE_SPEED = 4.6;
  const JUMP_VELOCITY = -13.5;
  const PLAYER_W = 36;
  const PLAYER_H = 72;
  const PLAYER_RENDER_H = 90;
  const ARENA_MARGIN = 30;

  const SHOOT_COOLDOWN = 13;
  const BULLET_SPEED = 14;
  const BULLET_DAMAGE = 8;
  const MAX_HP = 100;

  const AI_SHOOT_COOLDOWN = 20;
  const AI_BULLET_DAMAGE = 6;
  const AI_PREFERRED_RANGE = 320;

  const WALL_W = 54;
  const WALL_H = 96;
  const WALL_HP = 60;
  const RAMP_STEP_W = 44;
  const RAMP_STEP_H = 32;
  const RAMP_STEPS = 3;
  const RAMP_HP = 60;
  const MAX_STRUCTURES = 10;
  const BUILD_COOLDOWN = 16;
  const BUILD_OFFSET = 70;

  const CRATE_W = 74;
  const CRATE_H = 64;

  // ---------- sprite assets ----------
  const sprites = { walking: null, running: null, ducking: null, jumping: null };
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
    loadImage("/assets/sprites/arena/walking.png"),
    loadImage("/assets/sprites/arena/running.png"),
    loadImage("/assets/sprites/arena/ducking.png"),
    loadImage("/assets/sprites/arena/jumping.png"),
  ]).then(([walking, running, ducking, jumping]) => {
    sprites.walking = walking;
    sprites.running = running;
    sprites.ducking = ducking;
    sprites.jumping = jumping;
    assetsReady = true;
    startBtn.disabled = false;
  });

  function getFighterFrame(f) {
    if (f.ducking) return sprites.ducking;
    if (!f.onGround) return sprites.jumping;
    if (f.vx !== 0) return sprites.running;
    return sprites.walking;
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

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- input ----------
  const keys = new Set();
  let mouseDown = false;
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["a", "d", "w", "s", "f", "q", "e", "arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(k)) {
      e.preventDefault();
    }
    keys.add(k);
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  canvas.addEventListener("mousedown", () => (mouseDown = true));
  window.addEventListener("mouseup", () => (mouseDown = false));
  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      mouseDown = true;
    },
    { passive: false }
  );
  window.addEventListener("touchend", () => (mouseDown = false));

  // ---------- world state ----------
  let player, enemy, bullets, particles, structures, crates, centerPlatform;
  let state = "idle"; // idle | playing | over
  let buildCooldown = 0;

  function makeFighter(opts) {
    return {
      x: opts.x,
      y: 0,
      vx: 0,
      vy: 0,
      facing: opts.facing,
      onGround: true,
      ducking: false,
      hp: MAX_HP,
      cooldown: 0,
      hitFlash: 0,
      alive: true,
      isAI: !!opts.isAI,
      lastX: opts.x,
      stuckTimer: 0,
    };
  }

  function buildWorld() {
    crates = [
      { x1: W * 0.32 - CRATE_W / 2, x2: W * 0.32 + CRATE_W / 2, h: CRATE_H },
      { x1: W * 0.68 - CRATE_W / 2, x2: W * 0.68 + CRATE_W / 2, h: CRATE_H },
    ];
    centerPlatform = { x1: W * 0.46, x2: W * 0.54, y: GROUND_Y - 130 };
    structures = [];
    bullets = [];
    particles = [];
    player = makeFighter({ x: W * 0.15, facing: 1, isAI: false });
    enemy = makeFighter({ x: W * 0.85, facing: -1, isAI: true });
    player.y = GROUND_Y;
    enemy.y = GROUND_Y;
    worldReady = true;
  }

  function rescaleWorld(scaleX, oldGround) {
    const fixY = (y) => GROUND_Y - (oldGround - y);
    crates = crates.map((c) => ({ x1: c.x1 * scaleX, x2: c.x2 * scaleX, h: c.h }));
    centerPlatform = { x1: centerPlatform.x1 * scaleX, x2: centerPlatform.x2 * scaleX, y: fixY(centerPlatform.y) };
    structures.forEach((s) => {
      if (s.type === "wall") {
        s.x1 *= scaleX;
        s.x2 *= scaleX;
      } else {
        s.steps.forEach((step) => {
          step.x1 *= scaleX;
          step.x2 *= scaleX;
          step.y = fixY(step.y);
        });
      }
    });
    [player, enemy].forEach((f) => {
      f.x *= scaleX;
      f.y = fixY(f.y);
    });
    bullets.forEach((b) => {
      b.x *= scaleX;
      b.y = fixY(b.y);
    });
  }

  function resetMatch() {
    buildWorld();
    buildCooldown = 0;
  }

  function spawnParticles(x, y, color, count = 12) {
    for (let i = 0; i < count; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6 - 1,
        life: 22 + Math.random() * 12,
        color,
      });
    }
  }

  // ---------- building ----------
  function placeStructure(f, type) {
    if (buildCooldown > 0) return;
    buildCooldown = BUILD_COOLDOWN;
    const baseX = f.x + f.facing * BUILD_OFFSET;

    if (type === "wall") {
      const x1 = baseX - WALL_W / 2;
      const x2 = baseX + WALL_W / 2;
      structures.push({ type: "wall", x1, x2, hp: WALL_HP, maxHp: WALL_HP });
    } else {
      const steps = [];
      for (let i = 0; i < RAMP_STEPS; i++) {
        const sx1 = baseX + f.facing * i * RAMP_STEP_W;
        const sx2 = sx1 + f.facing * RAMP_STEP_W;
        const lo = Math.min(sx1, sx2), hi = Math.max(sx1, sx2);
        steps.push({ x1: lo, x2: hi, y: GROUND_Y - (i + 1) * RAMP_STEP_H });
      }
      structures.push({ type: "ramp", steps, hp: RAMP_HP, maxHp: RAMP_HP });
    }

    if (structures.length > MAX_STRUCTURES) structures.shift();
    playBuildSfx();
  }

  // ---------- collision helpers ----------
  function resolveSolidsX(f, nextX) {
    const solids = [];
    for (const c of crates) solids.push({ x1: c.x1, x2: c.x2, top: GROUND_Y - c.h });
    for (const s of structures) {
      if (s.type === "wall") solids.push({ x1: s.x1, x2: s.x2, top: GROUND_Y - WALL_H });
    }
    for (const s of solids) {
      const highEnough = f.y <= s.top + 2;
      if (highEnough) continue;
      const overlaps = nextX + PLAYER_W / 2 > s.x1 && nextX - PLAYER_W / 2 < s.x2;
      if (overlaps) {
        if (f.x <= s.x1) nextX = Math.min(nextX, s.x1 - PLAYER_W / 2);
        else if (f.x >= s.x2) nextX = Math.max(nextX, s.x2 + PLAYER_W / 2);
        else nextX = f.x;
      }
    }
    return nextX;
  }

  function landingCandidates() {
    const list = [{ x1: -Infinity, x2: Infinity, y: GROUND_Y }];
    list.push(centerPlatform);
    for (const c of crates) list.push({ x1: c.x1, x2: c.x2, y: GROUND_Y - c.h });
    for (const s of structures) {
      if (s.type === "wall") list.push({ x1: s.x1, x2: s.x2, y: GROUND_Y - WALL_H });
      else for (const step of s.steps) list.push(step);
    }
    return list;
  }

  // ---------- combat ----------
  function shoot(f) {
    if (f.cooldown > 0) return;
    f.cooldown = f.isAI ? AI_SHOOT_COOLDOWN : SHOOT_COOLDOWN;
    bullets.push({
      x: f.x + f.facing * PLAYER_W * 0.6,
      y: f.y - PLAYER_H * 0.6,
      vx: f.facing * BULLET_SPEED,
      w: 11,
      h: 4,
      dmg: f.isAI ? AI_BULLET_DAMAGE : BULLET_DAMAGE,
      owner: f,
    });
    playShootSfx(f.isAI);
  }

  function endMatch(winner) {
    state = "over";
    const title = winner === player ? "YOU WIN" : "YOU DIED";
    showOverlay(title, winner === player ? "You cleared the arena." : "The rival got the better of you.", "DROP IN AGAIN");
  }

  // ---------- AI ----------
  function updateAI(f, target) {
    const dx = target.x - f.x;
    const dist = Math.abs(dx);
    const dir = Math.sign(dx) || 1;

    f.vx = 0;
    f.ducking = false;
    if (dist > AI_PREFERRED_RANGE + 50) f.vx = dir * MOVE_SPEED;
    else if (dist < AI_PREFERRED_RANGE - 90) f.vx = -dir * MOVE_SPEED * 0.6;

    if (f.onGround) {
      if (Math.abs(f.x - f.lastX) < 0.4 && f.vx !== 0) f.stuckTimer++;
      else f.stuckTimer = 0;
      if (f.stuckTimer > 12 || Math.random() < 0.006) {
        f.vy = JUMP_VELOCITY;
        f.onGround = false;
        f.stuckTimer = 0;
        playJumpSfx();
      }
    }
    f.lastX = f.x;

    if (dist < AI_PREFERRED_RANGE + 120 && Math.random() < 0.85) shoot(f);
  }

  // ---------- update ----------
  function updateFighter(f, opponent) {
    if (!f.isAI) {
      const left = keys.has("a") || keys.has("arrowleft");
      const right = keys.has("d") || keys.has("arrowright");
      const jump = keys.has("w") || keys.has("arrowup");
      const duck = (keys.has("s") || keys.has("arrowdown")) && f.onGround;
      const fire = keys.has("f") || keys.has(" ") || mouseDown;

      f.ducking = duck;
      f.vx = 0;
      if (!duck) {
        if (left) f.vx = -MOVE_SPEED;
        if (right) f.vx = MOVE_SPEED;
        if (jump && f.onGround) {
          f.vy = JUMP_VELOCITY;
          f.onGround = false;
          playJumpSfx();
        }
      }
      if (fire) shoot(f);

      if (keys.has("q")) placeStructure(f, "wall");
      if (keys.has("e")) placeStructure(f, "ramp");
    } else {
      updateAI(f, opponent);
    }

    if (f.cooldown > 0) f.cooldown--;

    let nextX = f.x + f.vx;
    nextX = Math.max(ARENA_MARGIN, Math.min(W - ARENA_MARGIN, nextX));
    nextX = resolveSolidsX(f, nextX);
    f.x = nextX;

    const prevY = f.y;
    f.vy += GRAVITY;
    const nextY = f.y + f.vy;

    let landed = null;
    if (f.vy >= 0) {
      for (const plat of landingCandidates()) {
        if (f.x > plat.x1 && f.x < plat.x2 && prevY <= plat.y + 1 && nextY >= plat.y) {
          if (!landed || plat.y < landed.y) landed = plat;
        }
      }
    }

    if (landed) {
      f.y = landed.y;
      f.vy = 0;
      f.onGround = true;
    } else {
      f.y = nextY;
      f.onGround = false;
    }

    if (f.hitFlash > 0) f.hitFlash--;

    if (Math.abs(opponent.x - f.x) > 2) {
      f.facing = opponent.x > f.x ? 1 : -1;
    }
  }

  function update() {
    updateFighter(player, enemy);
    updateFighter(enemy, player);
    if (buildCooldown > 0) buildCooldown--;

    bullets.forEach((b) => (b.x += b.vx));

    bullets = bullets.filter((b) => {
      if (b.x < -60 || b.x > W + 60) return false;

      for (const c of crates) {
        const top = GROUND_Y - c.h;
        if (b.x > c.x1 && b.x < c.x2 && b.y >= top && b.y <= GROUND_Y) {
          spawnParticles(b.x, b.y, "#c7cdd4", 6);
          return false;
        }
      }
      for (const s of structures) {
        if (s.type !== "wall") continue;
        const top = GROUND_Y - WALL_H;
        if (b.x > s.x1 && b.x < s.x2 && b.y >= top && b.y <= GROUND_Y) {
          s.hp -= b.dmg;
          spawnParticles(b.x, b.y, "#e8a55c", 6);
          return false;
        }
      }
      return true;
    });
    structures = structures.filter((s) => s.hp > 0);

    for (const b of bullets) {
      const target = b.owner === player ? enemy : player;
      if (!target.alive) continue;
      if (Math.abs(b.x - target.x) < PLAYER_W / 2 + 6 && Math.abs(target.y - PLAYER_H / 2 - b.y) < PLAYER_H / 2) {
        target.hp = Math.max(0, target.hp - b.dmg);
        target.hitFlash = 26;
        b.x = -9999;
        spawnParticles(target.x, target.y - PLAYER_H / 2, "#ff5f6d", 14);
        playHitSfx();
        if (target.hp <= 0) {
          target.alive = false;
          endMatch(b.owner);
        }
      }
    }
    bullets = bullets.filter((b) => b.x > -1000);

    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.25;
      p.life--;
    });
    particles = particles.filter((p) => p.life > 0);
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

    ctx.fillStyle = "#8fd45a";
    ctx.beginPath();
    ctx.ellipse(W * 0.22, GROUND_Y + 60, W * 0.28, 120, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(W * 0.78, GROUND_Y + 60, W * 0.28, 120, 0, Math.PI, 0);
    ctx.fill();
  }

  const GROUND_PALETTE = {
    grass: "#4ec13f", grassShade: "#3aa62d",
    dirt: "#c87f3b", dirtLine: "#a5652a", dirtHilite: "#e0a262",
  };
  const TILE = 34;
  const GRASS_H = 14;

  function drawGroundTile(x, topY, height, palette) {
    ctx.fillStyle = palette.grass;
    ctx.fillRect(x, topY, TILE, GRASS_H);
    ctx.fillStyle = palette.grassShade;
    ctx.fillRect(x, topY + GRASS_H - 4, TILE, 4);
    const dirtTop = topY + GRASS_H;
    const dirtH = height - GRASS_H;
    ctx.fillStyle = palette.dirt;
    ctx.fillRect(x, dirtTop, TILE, dirtH);
    ctx.strokeStyle = palette.dirtLine;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, dirtTop + 1, TILE - 2, Math.min(dirtH - 2, TILE - 2));
    ctx.fillStyle = palette.dirtHilite;
    ctx.fillRect(x + 5, dirtTop + 5, 6, 6);
  }

  function drawWoodPlank(x1, x2, topY, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, topY, x2 - x1, h);
    ctx.clip();
    ctx.fillStyle = "#c9772f";
    ctx.fillRect(x1, topY, x2 - x1, h);
    ctx.strokeStyle = "#8a4f1e";
    ctx.lineWidth = 2;
    for (let px = x1; px < x2 + 18; px += 18) {
      ctx.beginPath();
      ctx.moveTo(px, topY);
      ctx.lineTo(px, topY + h);
      ctx.stroke();
    }
    ctx.fillStyle = "#e8a55c";
    ctx.fillRect(x1, topY, x2 - x1, 3);
    ctx.restore();
  }

  function drawCrate(c) {
    const top = GROUND_Y - c.h;
    ctx.fillStyle = "#8a97a3";
    ctx.fillRect(c.x1, top, c.x2 - c.x1, c.h);
    ctx.strokeStyle = "#5c6873";
    ctx.lineWidth = 3;
    ctx.strokeRect(c.x1 + 1.5, top + 1.5, c.x2 - c.x1 - 3, c.h - 3);
    ctx.beginPath();
    ctx.moveTo(c.x1, top);
    ctx.lineTo(c.x2, top + c.h);
    ctx.moveTo(c.x2, top);
    ctx.lineTo(c.x1, top + c.h);
    ctx.strokeStyle = "#6b7a86";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawHpChip(x1, x2, top, h, hp, maxHp) {
    const pct = Math.max(0, hp / maxHp);
    ctx.fillStyle = "rgba(20,16,8,0.7)";
    ctx.fillRect(x1, top - 8, x2 - x1, 5);
    ctx.fillStyle = pct > 0.4 ? "#ffb347" : "#ff5f6d";
    ctx.fillRect(x1, top - 8, (x2 - x1) * pct, 5);
  }

  function drawStructure(s) {
    if (s.type === "wall") {
      const top = GROUND_Y - WALL_H;
      drawWoodPlank(s.x1, s.x2, top, WALL_H);
      if (s.hp < s.maxHp) drawHpChip(s.x1, s.x2, top, WALL_H, s.hp, s.maxHp);
    } else {
      for (const step of s.steps) {
        drawWoodPlank(step.x1, step.x2, step.y, RAMP_STEP_H);
      }
      const first = s.steps[0];
      if (s.hp < s.maxHp) drawHpChip(first.x1, first.x2, first.y, RAMP_STEP_H, s.hp, s.maxHp);
    }
  }

  function drawTerrain() {
    const firstTileX = 0;
    for (let x = firstTileX; x < W; x += TILE) {
      drawGroundTile(x, GROUND_Y, H - GROUND_Y, GROUND_PALETTE);
    }
    crates.forEach(drawCrate);
    drawWoodPlank(centerPlatform.x1, centerPlatform.x2, centerPlatform.y, 16);
    structures.forEach(drawStructure);
  }

  function drawHpBar(f, side, name) {
    const barW = Math.min(340, W * 0.28);
    const x = side === "left" ? 20 : W - 20 - barW;
    const y = 18;

    ctx.font = "bold 14px 'Trebuchet MS', sans-serif";
    ctx.textAlign = side === "left" ? "left" : "right";
    ctx.fillStyle = f.isAI ? "#ff5f6d" : "#ffcf4d";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 3;
    ctx.fillText(name, side === "left" ? x : x + barW, y + 12);
    ctx.shadowBlur = 0;

    roundRect(x, y + 18, barW, 16, 8);
    ctx.fillStyle = "rgba(20,16,8,0.55)";
    ctx.fill();
    ctx.strokeStyle = "#2b2010";
    ctx.lineWidth = 2;
    ctx.stroke();

    const pct = Math.max(0, f.hp / MAX_HP);
    const fillW = (barW - 4) * pct;
    const fillX = side === "left" ? x + 2 : x + barW - 2 - fillW;
    const grad = ctx.createLinearGradient(0, y + 20, 0, y + 32);
    if (!f.isAI) {
      grad.addColorStop(0, "#ffcf4d"); grad.addColorStop(1, "#d99a1e");
    } else {
      grad.addColorStop(0, "#ff5f6d"); grad.addColorStop(1, "#c62828");
    }
    ctx.save();
    roundRect(x + 2, y + 20, barW - 4, 12, 6);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(fillX, y + 20, fillW, 12);
    ctx.restore();
  }

  function drawBuildHud() {
    const x = W / 2, y = H - 26;
    ctx.textAlign = "center";
    ctx.font = "bold 12px 'Trebuchet MS', sans-serif";
    ctx.fillStyle = "#ffe9a8";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 3;
    const readiness = buildCooldown > 0 ? "recharging" : "ready";
    ctx.fillText(`Q: WALL   E: RAMP   (${structures.length}/${MAX_STRUCTURES} up, build ${readiness})`, x, y);
    ctx.shadowBlur = 0;
  }

  function draw() {
    drawBackground();
    drawTerrain();

    ctx.fillStyle = "#ffe86a";
    ctx.shadowColor = "#ffe86a";
    ctx.shadowBlur = 8;
    bullets.forEach((b) => ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h));
    ctx.shadowBlur = 0;

    drawSprite(getFighterFrame(player), player.x, player.y, PLAYER_RENDER_H, player.facing, player.hitFlash);
    drawSprite(getFighterFrame(enemy), enemy.x, enemy.y, PLAYER_RENDER_H, enemy.facing, enemy.hitFlash);

    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(p.life / 30, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    });

    drawHpBar(player, "left", "YOU");
    drawHpBar(enemy, "right", "RIVAL");
    drawBuildHud();

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
      <p class="result">${subtitle}</p>
      <button id="startBtn">${buttonText}</button>
      <p class="footnote">V3 preview &mdash; local build, not linked from the live site yet.</p>
    `;
    overlay.classList.remove("hidden");
    document.getElementById("startBtn").addEventListener("click", startGame);
  }

  // ---------- sound effects (synthesized) ----------
  let audioCtx = null;
  let sfxGain = null;

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioCtx = new AudioCtx();
    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = 1;
    sfxGain.connect(audioCtx.destination);
  }

  function playSweep(startFreq, endFreq, duration, type, level) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + duration);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  function playShootSfx(isAI) { playSweep(isAI ? 700 : 950, isAI ? 180 : 220, 0.09, "square", 0.11); }
  function playJumpSfx() { playSweep(220, 660, 0.14, "triangle", 0.14); }
  function playHitSfx() { playSweep(180, 60, 0.12, "sawtooth", 0.15); }
  function playBuildSfx() { playSweep(300, 500, 0.08, "square", 0.14); }

  function startGame() {
    if (!assetsReady) return;
    resetMatch();
    state = "playing";
    overlay.classList.add("hidden");
    initAudio();
  }

  startBtn.addEventListener("click", startGame);
  window.addEventListener("resize", resize);

  window.__arenaDebugStep = () => { update(); draw(); };
  window.__arenaState = () => JSON.parse(JSON.stringify({
    W, H, GROUND_Y,
    player: { x: player.x, y: player.y, hp: player.hp, onGround: player.onGround, facing: player.facing, ducking: player.ducking },
    enemy: { x: enemy.x, y: enemy.y, hp: enemy.hp, onGround: enemy.onGround, facing: enemy.facing },
    bullets: bullets.length,
    structures: structures.map((s) => ({ type: s.type, hp: s.hp, x: s.type === "wall" ? [s.x1, s.x2] : s.steps.map((st) => [st.x1, st.x2, st.y]) })),
    state,
  }));

  resize();
  requestAnimationFrame(loop);
})();
