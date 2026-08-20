(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const GROUND_Y = H - 60;

  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");

  // ---------- tunables ----------
  const GRAVITY = 0.62;
  const MOVE_SPEED = 4.4;
  const JUMP_VELOCITY = -13.5;
  const PLAYER_W = 34;
  const PLAYER_H = 70;
  const PLAYER_RENDER_H = 84;
  const ARENA_MARGIN = 24;

  const SHOOT_COOLDOWN = 16;
  const BULLET_SPEED = 11;
  const BULLET_DAMAGE = 20;
  const MAX_AMMO = 5;
  const MAX_HP = 100;

  const PUNCH_RANGE = 46;
  const PUNCH_DAMAGE = 12;
  const PUNCH_COOLDOWN = 22;
  const PUNCH_POSE_FRAMES = 10;
  const PUNCH_LUNGE = 8;

  const COVER_H = 56;
  const PLATFORM_OFFSET = 90;
  const PLATFORM_H = 15;

  const covers = [
    { x1: 280, x2: 308 },
    { x1: 652, x2: 680 },
  ];
  const platform = { x1: 405, x2: 555, y: GROUND_Y - PLATFORM_OFFSET };

  // ---------- sprite assets (shared with the main game) ----------
  const sprites = { walk: [], jump: [], fire: null };
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
    ...Array.from({ length: 8 }, (_, i) => loadImage(`/assets/sprites/player/walk${i + 1}.png`)),
    ...Array.from({ length: 6 }, (_, i) => loadImage(`/assets/sprites/player/jump${i + 1}.png`)),
    loadImage("/assets/sprites/player/fire.png"),
  ]).then((imgs) => {
    sprites.walk = imgs.slice(0, 8);
    sprites.jump = imgs.slice(8, 14);
    sprites.fire = imgs[14];
    assetsReady = true;
    startBtn.disabled = false;
  });

  const WALK_FRAME_STEP = 0.6;

  function getFighterFrame(f) {
    if (f.punchTimer > 0) return sprites.fire;
    if (f.cooldown > SHOOT_COOLDOWN - 9) return sprites.fire;
    if (!f.onGround) return f.vy < 0 ? sprites.jump[2] : sprites.jump[4];
    if (f.vx !== 0) {
      const idx = Math.floor(f.legPhase / WALK_FRAME_STEP) % 8;
      return sprites.walk[idx];
    }
    return sprites.walk[0];
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
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["a", "d", "w", "f", "arrowleft", "arrowright", "arrowup", "enter"].includes(k)) {
      e.preventDefault();
    }
    keys.add(k);
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  // ---------- fighters ----------
  function makeFighter(opts) {
    return {
      x: opts.x,
      y: GROUND_Y,
      vx: 0,
      vy: 0,
      facing: opts.facing,
      onGround: true,
      hp: MAX_HP,
      ammo: MAX_AMMO,
      cooldown: 0,
      punchCooldown: 0,
      punchTimer: 0,
      legPhase: 0,
      hitFlash: 0,
      alive: true,
      name: opts.name,
      hue: opts.hue,
      controls: opts.controls,
    };
  }

  let p1 = makeFighter({
    x: 110,
    facing: 1,
    name: "ANSEM",
    hue: "you",
    controls: { left: "a", right: "d", jump: "w", fire: "f" },
  });
  let p2 = makeFighter({
    x: 850,
    facing: -1,
    name: "ORANGIE",
    hue: "rival",
    controls: { left: "arrowleft", right: "arrowright", jump: "arrowup", fire: "enter" },
  });

  let bullets = [];
  let particles = [];
  let state = "idle"; // idle | playing | roundover
  let frame = 0;

  function resetRound() {
    p1.x = 110; p1.y = GROUND_Y; p1.vx = 0; p1.vy = 0; p1.facing = 1;
    p1.hp = MAX_HP; p1.ammo = MAX_AMMO; p1.cooldown = 0; p1.punchCooldown = 0; p1.punchTimer = 0;
    p1.hitFlash = 0; p1.alive = true;

    p2.x = 850; p2.y = GROUND_Y; p2.vx = 0; p2.vy = 0; p2.facing = -1;
    p2.hp = MAX_HP; p2.ammo = MAX_AMMO; p2.cooldown = 0; p2.punchCooldown = 0; p2.punchTimer = 0;
    p2.hitFlash = 0; p2.alive = true;

    bullets = [];
    particles = [];
    frame = 0;
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

  function resolveCoverX(f, nextX) {
    const highEnough = f.y <= GROUND_Y - COVER_H + 2;
    if (highEnough) return nextX;
    for (const c of covers) {
      const overlaps = nextX + PLAYER_W / 2 > c.x1 && nextX - PLAYER_W / 2 < c.x2;
      if (overlaps) {
        if (f.x <= c.x1) nextX = Math.min(nextX, c.x1 - PLAYER_W / 2);
        else if (f.x >= c.x2) nextX = Math.max(nextX, c.x2 + PLAYER_W / 2);
        else nextX = f.x;
      }
    }
    return nextX;
  }

  function shoot(f) {
    if (f.ammo > 0) {
      if (f.cooldown > 0) return;
      f.cooldown = SHOOT_COOLDOWN;
      f.ammo--;
      bullets.push({
        x: f.x + f.facing * PLAYER_W * 0.6,
        y: f.y - PLAYER_H * 0.62,
        vx: f.facing * BULLET_SPEED,
        w: 10,
        h: 4,
        owner: f,
      });
      playShootSfx();
    } else {
      if (f.punchCooldown > 0) return;
      f.punchCooldown = PUNCH_COOLDOWN;
      f.punchTimer = PUNCH_POSE_FRAMES;
      const other = f === p1 ? p2 : p1;
      const dist = Math.abs(other.x - f.x);
      const facingRight = other.x >= f.x;
      if (dist < PUNCH_RANGE && Math.abs(other.y - f.y) < 40 && (facingRight ? f.facing === 1 : f.facing === -1)) {
        other.hp = Math.max(0, other.hp - PUNCH_DAMAGE);
        other.hitFlash = 30;
        spawnParticles(other.x, other.y - PLAYER_H / 2, "#ffd76a", 14);
        playPunchSfx();
        if (other.hp <= 0) endRound(f);
      } else {
        playPunchMissSfx();
      }
    }
  }

  function endRound(winner) {
    state = "roundover";
    showOverlay(`${winner.name} WINS!`, "REMATCH");
  }

  // ---------- update ----------
  function updateFighter(f, other) {
    const left = keys.has(f.controls.left);
    const right = keys.has(f.controls.right);
    const jump = keys.has(f.controls.jump);
    const fire = keys.has(f.controls.fire);

    f.vx = 0;
    if (left) f.vx = -MOVE_SPEED;
    if (right) f.vx = MOVE_SPEED;

    if (jump && f.onGround) {
      f.vy = JUMP_VELOCITY;
      f.onGround = false;
      playJumpSfx();
    }

    if (fire) shoot(f);
    if (f.cooldown > 0) f.cooldown--;
    if (f.punchCooldown > 0) f.punchCooldown--;
    if (f.punchTimer > 0) f.punchTimer--;

    let nextX = f.x + f.vx;
    nextX = Math.max(ARENA_MARGIN, Math.min(W - ARENA_MARGIN, nextX));
    nextX = resolveCoverX(f, nextX);
    f.x = nextX;

    const prevY = f.y;
    f.vy += GRAVITY;
    const nextY = f.y + f.vy;

    let landed = null;
    if (f.vy >= 0) {
      if (f.x > platform.x1 && f.x < platform.x2 && prevY <= platform.y + 1 && nextY >= platform.y) {
        landed = platform.y;
      } else if (nextY >= GROUND_Y) {
        landed = GROUND_Y;
      }
    }

    if (landed !== null) {
      f.y = landed;
      f.vy = 0;
      f.onGround = true;
    } else {
      f.y = nextY;
      f.onGround = false;
    }

    if (f.vx !== 0 && f.onGround) f.legPhase += 0.3;
    if (f.hitFlash > 0) f.hitFlash--;

    if (Math.abs(other.x - f.x) > 2) {
      f.facing = other.x > f.x ? 1 : -1;
    }
  }

  function update() {
    frame++;
    updateFighter(p1, p2);
    updateFighter(p2, p1);

    bullets.forEach((b) => (b.x += b.vx));

    bullets = bullets.filter((b) => {
      if (b.x < 0 || b.x > W) return false;
      for (const c of covers) {
        if (b.x > c.x1 && b.x < c.x2 && b.y >= GROUND_Y - COVER_H && b.y <= GROUND_Y) {
          spawnParticles(b.x, b.y, "#e8a55c", 6);
          return false;
        }
      }
      return true;
    });

    for (const b of bullets) {
      const target = b.owner === p1 ? p2 : p1;
      if (!target.alive) continue;
      if (Math.abs(b.x - target.x) < PLAYER_W / 2 + 6 && Math.abs(target.y - PLAYER_H / 2 - b.y) < PLAYER_H / 2) {
        target.hp = Math.max(0, target.hp - BULLET_DAMAGE);
        target.hitFlash = 30;
        b.x = -9999;
        spawnParticles(target.x, target.y - PLAYER_H / 2, "#ff5f6d", 14);
        playHitSfx();
        if (target.hp <= 0) {
          target.alive = false;
          endRound(b.owner);
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
    ctx.ellipse(220, GROUND_Y + 50, 220, 100, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(760, GROUND_Y + 50, 220, 100, 0, Math.PI, 0);
    ctx.fill();
  }

  const TILE = 32;
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

  const GROUND_PALETTE = {
    grass: "#4ec13f", grassShade: "#3aa62d",
    dirt: "#c87f3b", dirtLine: "#a5652a", dirtHilite: "#e0a262",
  };

  function drawThinBrick(x1, x2, topY, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, topY, x2 - x1, h);
    ctx.clip();
    ctx.fillStyle = "#c9772f";
    ctx.fillRect(x1, topY, x2 - x1, h);
    ctx.strokeStyle = "#8a4f1e";
    ctx.lineWidth = 1;
    for (let bx = x1; bx < x2 + 13; bx += 13) {
      ctx.beginPath();
      ctx.moveTo(bx, topY);
      ctx.lineTo(bx, topY + h);
      ctx.stroke();
    }
    for (let by = topY; by < topY + h; by += 13) {
      ctx.beginPath();
      ctx.moveTo(x1, by);
      ctx.lineTo(x2, by);
      ctx.stroke();
    }
    ctx.fillStyle = "#e8a55c";
    ctx.fillRect(x1, topY, x2 - x1, 3);
    ctx.restore();
  }

  function drawTerrain() {
    const firstTileX = 0;
    for (let x = firstTileX; x < W; x += TILE) {
      drawGroundTile(x, GROUND_Y, H - GROUND_Y, GROUND_PALETTE);
    }
    covers.forEach((c) => drawThinBrick(c.x1, c.x2, GROUND_Y - COVER_H, COVER_H));
    drawThinBrick(platform.x1, platform.x2, platform.y, PLATFORM_H);
  }

  function drawHpBar(f, side) {
    const barW = 300;
    const x = side === "left" ? 20 : W - 20 - barW;
    const y = 16;

    ctx.font = "bold 13px 'Trebuchet MS', sans-serif";
    ctx.textAlign = side === "left" ? "left" : "right";
    ctx.fillStyle = f.hue === "you" ? "#ffcf4d" : "#ff5f6d";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 3;
    ctx.fillText(f.name, side === "left" ? x : x + barW, y + 12);
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
    if (f.hue === "you") {
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

    ctx.textAlign = "center";
    ctx.font = "bold 10px 'Trebuchet MS', sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${Math.ceil(f.hp)} / ${MAX_HP}`, x + barW / 2, y + 30);
  }

  function drawAmmoBar(f, side) {
    const segW = 20, segH = 12, gap = 3;
    const totalW = MAX_AMMO * segW + (MAX_AMMO - 1) * gap;
    const x = side === "left" ? 20 : W - 20 - totalW;
    const y = H - 34;

    ctx.font = "bold 10px 'Trebuchet MS', sans-serif";
    ctx.textAlign = side === "left" ? "left" : "right";
    ctx.fillStyle = "#ffe9a8";
    const label = f.ammo > 0 ? `${f.name}'S CLIP  ${f.ammo}/${MAX_AMMO}` : `${f.name} — FISTS ONLY`;
    ctx.fillText(label, side === "left" ? x : x + totalW, y - 4);

    for (let i = 0; i < MAX_AMMO; i++) {
      const sx = side === "left" ? x + i * (segW + gap) : x + totalW - segW - i * (segW + gap);
      ctx.fillStyle = i < f.ammo
        ? (f.hue === "you" ? "#ffb347" : "#ff5f6d")
        : "rgba(255,255,255,0.15)";
      ctx.strokeStyle = "#2b2010";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(sx, y, segW, segH);
      ctx.fill();
      ctx.stroke();
    }
  }

  function draw() {
    drawBackground();
    drawTerrain();

    ctx.fillStyle = "#ffe86a";
    ctx.shadowColor = "#ffe86a";
    ctx.shadowBlur = 8;
    bullets.forEach((b) => ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h));
    ctx.shadowBlur = 0;

    const lungeP1 = p1.punchTimer > 0 ? p1.facing * PUNCH_LUNGE * (p1.punchTimer / PUNCH_POSE_FRAMES) : 0;
    const lungeP2 = p2.punchTimer > 0 ? p2.facing * PUNCH_LUNGE * (p2.punchTimer / PUNCH_POSE_FRAMES) : 0;

    drawSprite(getFighterFrame(p1), p1.x + lungeP1, p1.y, PLAYER_RENDER_H, p1.facing, p1.hitFlash);
    drawSprite(getFighterFrame(p2), p2.x + lungeP2, p2.y, PLAYER_RENDER_H, p2.facing, p2.hitFlash);

    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(p.life / 30, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    });

    drawHpBar(p1, "left");
    drawHpBar(p2, "right");
    drawAmmoBar(p1, "left");
    drawAmmoBar(p2, "right");

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

  function showOverlay(title, buttonText) {
    overlay.innerHTML = `
      <h1>${title}</h1>
      <button id="startBtn">${buttonText}</button>
      <p class="footnote">Local 2-player, same keyboard.</p>
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

  function playShootSfx() { playSweep(950, 220, 0.1, "square", 0.14); }
  function playJumpSfx() { playSweep(220, 660, 0.14, "triangle", 0.16); }
  function playHitSfx() { playSweep(180, 60, 0.12, "sawtooth", 0.16); }
  function playPunchSfx() { playSweep(140, 40, 0.09, "square", 0.18); }
  function playPunchMissSfx() { playSweep(400, 300, 0.06, "sine", 0.08); }

  function startGame() {
    if (!assetsReady) return;
    resetRound();
    state = "playing";
    overlay.classList.add("hidden");
    initAudio();
  }

  startBtn.addEventListener("click", startGame);

  requestAnimationFrame(loop);
})();
