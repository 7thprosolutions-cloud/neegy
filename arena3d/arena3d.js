import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadRiggedCharacterAsset, instantiateRiggedCharacter, WHITE } from "/arena3d/character.js?v=34";
import { loadProfile, recordMatchResult, MODES, XP_PER_KILL, XP_PER_GAME } from "/arena3d/profile.js?v=34";
import { submitMatchResult } from "/arena3d/account.js?v=34";
import * as MP from "/arena3d/mp.js?v=34";
import { mp } from "/arena3d/mp.js?v=34";

// ---------- DOM ----------
const canvas = document.getElementById("game");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const hud = document.getElementById("hud");
const buildHint = document.getElementById("buildHint");
const hpFillYou = document.getElementById("hpFillYou");
const hpFillRival = document.getElementById("hpFillRival");
const structCountEl = document.getElementById("structCount");
const introTitle = document.getElementById("introTitle");
const introTagline = document.getElementById("introTagline");
const squadStatus = document.getElementById("squadStatus");
const blueAliveCountEl = document.getElementById("blueAliveCount");
const redAliveCountEl = document.getElementById("redAliveCount");
const blueTeamSizeEl = document.getElementById("blueTeamSize");
const redTeamSizeEl = document.getElementById("redTeamSize");
const spectatorNote = document.getElementById("spectatorNote");
const extraLifeBtn = document.getElementById("extraLifeBtn");
const extraLifeCount = document.getElementById("extraLifeCount");
const revivePrompt = document.getElementById("revivePrompt");
const reviveBtn = document.getElementById("reviveBtn");
const reviveCount = document.getElementById("reviveCount");
const reviveTimerFill = document.getElementById("reviveTimerFill");
const debugReadout = document.getElementById("debugReadout");
const crosshair = document.getElementById("crosshair");

// ---------- tunables ----------
const ARENA_HALF = 52; // twice the old play area -- squads spawn on opposite ends and have to close the distance
const MOVE_SPEED = 6.2;
const GRAVITY = -22;
const JUMP_SPEED = 8.2;
const PLAYER_RADIUS = 0.45;
const PLAYER_EYE_H = 1.55;
const SPRITE_H = 2.05;

const SHOOT_COOLDOWN = 0.2;
const AI_SHOOT_COOLDOWN = 0.55;
const BULLET_SPEED = 26;
const BULLET_DAMAGE = 8;
const AI_BULLET_DAMAGE = 6;
const MAX_HP = 100;
const AI_PREFERRED_RANGE = 12;

const HIT_REACTION_DURATION = 0.35;
const RIGGED_MODEL_SCALE = 1.7; // shooter_character.glb's rest height is ~1.1m ("mini" chibi scale) -- scale up to read properly in the arena

const TEAM_BLUE = "blue";
const TEAM_RED = "red";
// team size comes from the dashboard's ?mode= param (1v1/3v3/5v5); opening
// this page directly without going through the dashboard falls back to 4v4
const MATCH_MODE = MODES[new URLSearchParams(location.search).get("mode")] ? new URLSearchParams(location.search).get("mode") : null;
const TEAM_SIZE = MATCH_MODE ? MODES[MATCH_MODE].teamSize : 4;
const SERVER_NAME = new URLSearchParams(location.search).get("server") || null;
const LAUNCHED_FROM_DASHBOARD = !!MATCH_MODE;
const ARROW_HEIGHT = RIGGED_MODEL_SCALE * 1.3; // floats just above a fighter's head

if (LAUNCHED_FROM_DASHBOARD) {
  introTitle.textContent = SERVER_NAME || "JOINING MATCH";
  introTagline.textContent = `${MODES[MATCH_MODE].label.toUpperCase()} — assets are loading, the match starts automatically.`;
  const backLink = document.getElementById("backLink");
  backLink.href = "/arena3d/dashboard.html";
  backLink.textContent = "← DASHBOARD";
}
blueTeamSizeEl.textContent = TEAM_SIZE;
redTeamSizeEl.textContent = TEAM_SIZE;

const WALL_LEN = 3.2, WALL_H = 2.5, WALL_THICK = 0.35;
const RAMP_LEN = 4.2, RAMP_WIDTH = 2.4, RAMP_H = 2.5;
const BUILD_OFFSET = 3.2, BUILD_COOLDOWN = 0.55;
const MAX_STRUCTURES = 8;
const STRUCT_HP = 60;

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const HORIZON_COLOR = 0xbfe0ff; // bright midday sky blue
const scene = new THREE.Scene();
scene.background = new THREE.Color(HORIZON_COLOR);
scene.fog = new THREE.Fog(HORIZON_COLOR, 42, 92);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 320);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
window.addEventListener("resize", resize);
resize();

// ---------- procedural textures (canvas-generated, no external image files) ----------
function makeCanvasTexture(size, draw) {
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = size;
  const cctx = cnv.getContext("2d");
  draw(cctx, size);
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function hexToCss(hex) {
  return "#" + hex.toString(16).padStart(6, "0");
}

const grassTex = makeCanvasTexture(256, (c, s) => {
  c.fillStyle = "#5aa845";
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 55; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 10 + Math.random() * 26;
    c.fillStyle = Math.random() < 0.5 ? "rgba(70,150,55,0.35)" : "rgba(100,190,80,0.3)";
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    c.fillStyle = Math.random() < 0.5 ? "rgba(40,95,35,0.35)" : "rgba(150,210,110,0.28)";
    c.fillRect(x, y, 1.6, 1.6 + Math.random() * 2.5);
  }
});

const rockTex = makeCanvasTexture(256, (c, s) => {
  c.fillStyle = "#767f8c";
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    c.fillStyle = Math.random() < 0.5 ? "rgba(50,56,66,0.4)" : "rgba(160,168,178,0.3)";
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.random() * 22 - 11, y + Math.random() * 22 - 11);
    c.lineTo(x + Math.random() * 22 - 11, y + Math.random() * 22 - 11);
    c.closePath();
    c.fill();
  }
  const grad = c.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, "rgba(255,255,255,0.96)");
  grad.addColorStop(0.42, "rgba(255,255,255,0.4)");
  grad.addColorStop(0.58, "rgba(255,255,255,0)");
  c.fillStyle = grad;
  c.fillRect(0, 0, s, s);
});

function makeWoodTexture(base, line, hi) {
  return makeCanvasTexture(256, (c, s) => {
    c.fillStyle = base;
    c.fillRect(0, 0, s, s);
    const plankH = s / 5;
    for (let y = 0; y < s; y += plankH) {
      c.globalAlpha = 0.35;
      c.fillStyle = hi;
      c.fillRect(0, y, s, 3);
      c.globalAlpha = 1;
      c.strokeStyle = line;
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke();
      for (let i = 0; i < 3; i++) {
        const gy = y + Math.random() * plankH;
        c.strokeStyle = "rgba(0,0,0,0.12)";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(0, gy);
        c.bezierCurveTo(s * 0.3, gy + 4, s * 0.7, gy - 4, s, gy);
        c.stroke();
      }
    }
  });
}
const wallWoodTex = makeWoodTexture("#c9772f", "#8a4f1e", "#e8a55c");

function makeBrickTexture(base, line) {
  return makeCanvasTexture(256, (c, s) => {
    c.fillStyle = base;
    c.fillRect(0, 0, s, s);
    const bh = s / 7, bw = s / 3.4;
    c.strokeStyle = line;
    c.lineWidth = 3;
    let row = 0;
    for (let y = 0; y < s; y += bh) {
      const offset = (row % 2) * (bw / 2);
      for (let x = -bw; x < s + bw; x += bw) {
        c.strokeRect(x + offset, y, bw, bh);
        c.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
        c.fillRect(x + offset, y, bw, bh);
        c.fillStyle = base;
      }
      row++;
    }
  });
}

function makeShingleTexture(base) {
  return makeCanvasTexture(256, (c, s) => {
    c.fillStyle = base;
    c.fillRect(0, 0, s, s);
    c.strokeStyle = "rgba(0,0,0,0.3)";
    let row = 0;
    for (let y = 0; y < s; y += s / 9) {
      const offset = (row % 2) * 10;
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke();
      for (let x = -10; x < s + 10; x += 20) {
        c.beginPath(); c.moveTo(x + offset, y); c.lineTo(x + offset, y + s / 9); c.stroke();
      }
      row++;
    }
  });
}

const crateTex = makeCanvasTexture(256, (c, s) => {
  c.fillStyle = "#9aa4ad";
  c.fillRect(0, 0, s, s);
  c.strokeStyle = "#5c6873";
  c.lineWidth = 6;
  c.strokeRect(4, 4, s - 8, s - 8);
  c.beginPath();
  c.moveTo(4, 4); c.lineTo(s - 4, s - 4);
  c.moveTo(s - 4, 4); c.lineTo(4, s - 4);
  c.lineWidth = 4;
  c.stroke();
});

const asphaltTex = makeCanvasTexture(256, (c, s) => {
  c.fillStyle = "#54595f";
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    c.fillStyle = Math.random() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.05)";
    c.fillRect(x, y, 1.5, 1.5);
  }
});

const skyTex = makeCanvasTexture(128, (c, s) => {
  const g = c.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, "#2f7fd6");
  g.addColorStop(0.45, "#6fb3ec");
  g.addColorStop(0.75, "#a9d8f5");
  g.addColorStop(1, "#e8f6ff");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});
skyTex.wrapS = THREE.ClampToEdgeWrapping;
skyTex.wrapT = THREE.ClampToEdgeWrapping;
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(150, 16, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
);
scene.add(sky);

// ---------- atmosphere: sun glow, drifting clouds, distant birds ----------
const sunGlowTex = makeCanvasTexture(128, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,244,1)");
  g.addColorStop(0.35, "rgba(255,246,214,0.85)");
  g.addColorStop(1, "rgba(255,246,214,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});
const sunDir = new THREE.Vector3(24, 34, -14).normalize();
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlowTex, fog: false, transparent: true, depthWrite: false }));
sunSprite.position.copy(sunDir.multiplyScalar(140));
sunSprite.scale.set(38, 38, 1);
scene.add(sunSprite);

const cloudTex = makeCanvasTexture(128, (c, s) => {
  c.fillStyle = "rgba(255,255,255,0)";
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 6; i++) {
    const x = s * 0.25 + Math.random() * s * 0.5, y = s * 0.4 + Math.random() * s * 0.25, r = s * (0.16 + Math.random() * 0.12);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,244,232,0.85)");
    g.addColorStop(1, "rgba(255,244,232,0)");
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
});
const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, fog: true, transparent: true, depthWrite: false, opacity: 0.8 });
const CLOUD_SPAN = ARENA_HALF * 3.2;
const clouds = [];
for (let i = 0; i < 9; i++) {
  const sprite = new THREE.Sprite(cloudMat.clone());
  const scale = 14 + Math.random() * 14;
  sprite.scale.set(scale * 1.6, scale, 1);
  sprite.position.set((Math.random() - 0.5) * CLOUD_SPAN, 22 + Math.random() * 14, (Math.random() - 0.5) * CLOUD_SPAN);
  scene.add(sprite);
  clouds.push({ sprite, speed: 0.15 + Math.random() * 0.25 });
}

const birdTex = makeCanvasTexture(64, (c, s) => {
  c.strokeStyle = "#181820";
  c.lineWidth = 4;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(6, 40); c.quadraticCurveTo(20, 16, 32, 30); c.quadraticCurveTo(44, 16, 58, 40);
  c.stroke();
});
const birdMat = new THREE.SpriteMaterial({ map: birdTex, fog: true, transparent: true, depthWrite: false });
const birds = [];
for (let i = 0; i < 6; i++) {
  const sprite = new THREE.Sprite(birdMat.clone());
  sprite.scale.set(1.6, 0.9, 1);
  const radius = 22 + Math.random() * 16;
  const angle = Math.random() * Math.PI * 2;
  birds.push({
    sprite, radius, angle,
    height: 12 + Math.random() * 9,
    speed: 0.12 + Math.random() * 0.1,
    flapPhase: Math.random() * 10,
  });
  scene.add(sprite);
}

function updateAtmosphere(dt) {
  for (const c of clouds) {
    c.sprite.position.x += c.speed * dt;
    if (c.sprite.position.x > CLOUD_SPAN / 2) c.sprite.position.x = -CLOUD_SPAN / 2;
  }
  for (const b of birds) {
    b.angle += b.speed * dt * 0.3;
    b.flapPhase += dt * 6;
    b.sprite.position.set(Math.cos(b.angle) * b.radius, b.height + Math.sin(b.flapPhase * 0.5) * 0.4, Math.sin(b.angle) * b.radius);
    b.sprite.scale.y = 0.9 * (0.7 + Math.abs(Math.sin(b.flapPhase)) * 0.3);
  }
}

// ---------- lighting ----------
// midday palette: bright blue sky fill, clean white-yellow high sun
scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x6b8f4e, 1.0));
const sun = new THREE.DirectionalLight(0xfff6da, 1.5);
sun.position.set(24, 34, -14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -ARENA_HALF - 6;
sun.shadow.camera.right = ARENA_HALF + 6;
sun.shadow.camera.top = ARENA_HALF + 6;
sun.shadow.camera.bottom = -ARENA_HALF - 6;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0025;
scene.add(sun);

// ---------- ground + backdrop mountains + road ----------
const groundTex = grassTex.clone();
groundTex.needsUpdate = true;
groundTex.repeat.set(ARENA_HALF * 2.6 / 3.2, ARENA_HALF * 2.6 / 3.2);
const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2.6, ARENA_HALF * 2.6), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const roadTexInst = asphaltTex.clone();
roadTexInst.needsUpdate = true;
roadTexInst.repeat.set(2, ARENA_HALF * 2.6 / 6);
const roadMat = new THREE.MeshStandardMaterial({ map: roadTexInst, roughness: 0.95 });
const road = new THREE.Mesh(new THREE.PlaneGeometry(5.5, ARENA_HALF * 2.6), roadMat);
road.rotation.x = -Math.PI / 2;
road.position.y = 0.01;
road.receiveShadow = true;
scene.add(road);
const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffe86a });
for (let z = -ARENA_HALF * 1.2; z < ARENA_HALF * 1.2; z += 4) {
  const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 1.8), stripeMat);
  stripe.rotation.x = -Math.PI / 2;
  stripe.position.set(0, 0.015, z);
  scene.add(stripe);
}

function makeMountain(x, z, radius, height, colorTint) {
  // multi-ring jitter (more wobble low down, less near the summit) instead of
  // a single perturbed ring, so the silhouette reads as craggy rock rather
  // than a smooth, obviously-perfect cone
  const geo = new THREE.ConeGeometry(radius, height, 9, 5);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < height / 2 - 0.1) {
      const t = (y + height / 2) / height; // 0 at base, ~1 near the tip
      const jitterAmt = radius * (0.24 - t * 0.14);
      pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * jitterAmt);
      pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * jitterAmt);
      pos.setY(i, y + (Math.random() - 0.5) * height * 0.025);
    }
  }
  geo.computeVertexNormals();
  const tex = rockTex.clone();
  tex.needsUpdate = true;
  tex.repeat.set(3, 1);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, color: colorTint });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, height / 2 - 0.4, z);
  m.receiveShadow = true;
  scene.add(m);
}

// a ring of primary peaks, each with 1-2 smaller companion peaks clustered
// around it, reads as an actual mountain range instead of a row of cones
const MOUNTAIN_TINTS = [0xc7d1e0, 0xaebad0, 0x97a6c2];
const ring = ARENA_HALF * 1.5;
const peakCount = 9;
for (let i = 0; i < peakCount; i++) {
  const a = (i / peakCount) * Math.PI * 2 + Math.random() * 0.25;
  const r = ring + Math.random() * 10;
  const baseX = Math.cos(a) * r, baseZ = Math.sin(a) * r;
  const mainR = 10 + Math.random() * 7;
  const mainH = 16 + Math.random() * 14;
  const tint = MOUNTAIN_TINTS[i % MOUNTAIN_TINTS.length];
  makeMountain(baseX, baseZ, mainR, mainH, tint);

  const companions = 1 + Math.floor(Math.random() * 2);
  for (let c = 0; c < companions; c++) {
    const offX = (Math.random() - 0.5) * mainR * 1.6;
    const offZ = (Math.random() - 0.5) * mainR * 1.6;
    makeMountain(
      baseX + offX, baseZ + offZ,
      mainR * (0.45 + Math.random() * 0.3),
      mainH * (0.5 + Math.random() * 0.35),
      tint
    );
  }
}

// A walkable building: a doorway on the near side (-Z) and a matching
// opening on the far side (+Z) so you can actually walk through it —
// solid side walls (with windows) give real cover once you're inside.
// Returns an array of collision segments (one per solid wall piece), not a
// single box, so bullets/movement/standing-height all treat each wall
// piece independently and the door/exit gaps are genuinely open.
function makeBuilding(x, z, w, d, h, wallColor, roofColor) {
  const group = new THREE.Group();
  const localSegs = [];
  const wallThick = 0.3;
  const doorW = Math.min(1.6, w * 0.4);
  const doorH = h * 0.8;

  const brickTexBase = makeBrickTexture(hexToCss(wallColor), "rgba(0,0,0,0.35)");
  function wallMatFor(lengthHint) {
    const t = brickTexBase.clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(lengthHint / 1.4)), Math.max(1, Math.round(h / 1.4)));
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
  }

  function addWallSeg(cx, cz, segW, segD) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(segW, h, segD), wallMatFor(Math.max(segW, segD)));
    mesh.position.set(cx, h / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    localSegs.push({ x1: cx - segW / 2, x2: cx + segW / 2, z1: cz - segD / 2, z2: cz + segD / 2, h });
  }

  // front (-Z, entrance) and back (+Z, exit) walls, split around a doorway gap
  const sideSegW = (w - doorW) / 2;
  addWallSeg(-w / 2 + sideSegW / 2, -d / 2, sideSegW, wallThick);
  addWallSeg(w / 2 - sideSegW / 2, -d / 2, sideSegW, wallThick);
  addWallSeg(-w / 2 + sideSegW / 2, d / 2, sideSegW, wallThick);
  addWallSeg(w / 2 - sideSegW / 2, d / 2, sideSegW, wallThick);

  // solid left/right walls — the long faces on an elongated building, and
  // where you actually get cover once you're inside
  addWallSeg(-w / 2, 0, wallThick, d);
  addWallSeg(w / 2, 0, wallThick, d);

  // decorative door frames (visual only, not solid — the gap stays fully walkable)
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 0.8 });
  for (const dz of [-d / 2, d / 2]) {
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.3, 0.22, wallThick + 0.08), frameMat);
    lintel.position.set(0, doorH, dz);
    group.add(lintel);
    for (const dx of [-doorW / 2 - 0.09, doorW / 2 + 0.09]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, doorH, wallThick + 0.08), frameMat);
      post.position.set(dx, doorH / 2, dz);
      group.add(post);
    }
  }

  // gable roof — a peaked A-frame suits an elongated rectangle far better
  // than a single cone would
  const overhang = 0.35;
  const peakH = h * 0.42;
  const halfW = w / 2 + overhang;
  const panelLen = Math.hypot(halfW, peakH);
  const angle = Math.atan2(peakH, halfW);
  const shingleTex = makeShingleTexture(hexToCss(roofColor));
  shingleTex.repeat.set(Math.max(1, Math.round(d / 2)), 1);
  const roofMat = new THREE.MeshStandardMaterial({ map: shingleTex, roughness: 0.85 });
  const panelGeo = new THREE.BoxGeometry(panelLen, 0.12, d + overhang * 2);
  const roofLeft = new THREE.Mesh(panelGeo, roofMat);
  roofLeft.rotation.z = angle;
  roofLeft.position.set(-halfW / 2, h + peakH / 2, 0);
  roofLeft.castShadow = true;
  group.add(roofLeft);
  const roofRight = new THREE.Mesh(panelGeo, roofMat);
  roofRight.rotation.z = -angle;
  roofRight.position.set(halfW / 2, h + peakH / 2, 0);
  roofRight.castShadow = true;
  group.add(roofRight);

  const snowCap = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.14, d + overhang * 2),
    new THREE.MeshStandardMaterial({ color: 0xf3f7ff, roughness: 0.75 })
  );
  snowCap.position.set(0, h + peakH + 0.07, 0);
  snowCap.castShadow = true;
  group.add(snowCap);

  const gableMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.9, side: THREE.DoubleSide });
  const gableGeo = new THREE.BufferGeometry();
  gableGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-w / 2, 0, 0, w / 2, 0, 0, 0, peakH, 0]), 3));
  gableGeo.setIndex([0, 1, 2]);
  gableGeo.computeVertexNormals();
  const gableFront = new THREE.Mesh(gableGeo, gableMat);
  gableFront.position.set(0, h, -d / 2 - 0.02);
  group.add(gableFront);
  const gableBack = new THREE.Mesh(gableGeo, gableMat);
  gableBack.position.set(0, h, d / 2 + 0.02);
  group.add(gableBack);

  // windows along both long side walls
  const winW = 0.85, winH = 0.9, winY = h * 0.58;
  const winGlassMat = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, roughness: 0.25, metalness: 0.1, emissive: 0x224466, emissiveIntensity: 0.15 });
  const winFrameMat = new THREE.MeshStandardMaterial({ color: 0xfff8e6, roughness: 0.6 });
  for (const side of [-1, 1]) {
    const faceX = side * (w / 2 + wallThick / 2 + 0.02);
    for (const wz of [-d * 0.27, d * 0.27]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.05, winH + 0.14, winW + 0.14), winFrameMat);
      frame.position.set(faceX, winY, wz);
      group.add(frame);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.03, winH, winW), winGlassMat);
      glass.position.set(faceX + side * 0.03, winY, wz);
      group.add(glass);
    }
  }

  group.position.set(x, 0, z);
  scene.add(group);
  return localSegs.map((s) => ({ x1: s.x1 + x, x2: s.x2 + x, z1: s.z1 + z, z2: s.z2 + z, h: s.h }));
}

// SPREAD scales every hand-placed prop position out to match the doubled
// ARENA_HALF, so the town/cover/scatter keeps roughly the same relative
// layout instead of sitting bunched up in the middle of a much bigger map.
const SPREAD = 2.0;

const buildings = [
  makeBuilding(-14 * SPREAD, -10 * SPREAD, 4.4, 8.5, 4.4, 0xc9772f, 0x8a4f1e),
  makeBuilding(14 * SPREAD, 10 * SPREAD, 4.8, 9.5, 4.8, 0xd9a35c, 0x7a4a24),
  makeBuilding(-13 * SPREAD, 12 * SPREAD, 4, 7.5, 3.8, 0xb8895a, 0x6b3f22),
  makeBuilding(15 * SPREAD, -11 * SPREAD, 4.2, 8, 4, 0xc28a52, 0x71431f),
].flat();

function makeCrate(x, z, s) {
  const tex = crateTex.clone();
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
  m.position.set(x, s / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  return { x1: x - s / 2, x2: x + s / 2, z1: z - s / 2, z2: z + s / 2, h: s };
}
const crates = [
  makeCrate(-6 * SPREAD, -3 * SPREAD, 1.7), makeCrate(6 * SPREAD, 4 * SPREAD, 1.7),
  makeCrate(-2 * SPREAD, 9 * SPREAD, 1.5), makeCrate(3 * SPREAD, -8 * SPREAD, 1.6),
  makeCrate(-20 * SPREAD, 3 * SPREAD, 1.5), makeCrate(19 * SPREAD, -4 * SPREAD, 1.5),
];

// scattered pine trees — visual variety plus light cover away from the
// buildings/crate clusters, thin trunk collision so they're a peek-around
// obstacle rather than a wall
const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.9 });
const treeFoliageMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 0.95 });
function makeTree(x, z, scale) {
  const group = new THREE.Group();
  const trunkH = 1.6 * scale, trunkR = 0.14 * scale;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkR * 0.8, trunkR, trunkH, 7), treeTrunkMat);
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  for (let i = 0; i < 3; i++) {
    const tierH = 1.1 * scale * (1 - i * 0.12);
    const tierR = 0.85 * scale * (1 - i * 0.22);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(tierR, tierH, 8), treeFoliageMat);
    cone.position.y = trunkH + i * tierH * 0.55 + tierH * 0.4;
    cone.castShadow = true;
    cone.receiveShadow = true;
    group.add(cone);
  }
  group.position.set(x, 0, z);
  scene.add(group);
  const r = trunkR * 1.6;
  return { x1: x - r, x2: x + r, z1: z - r, z2: z + r, h: trunkH * 0.9 };
}
const treeSpotsScaled = [
  [-20, -18, 1.1], [-22, -6, 0.9], [-19, 6, 1.0],
  [20, -14, 1.0], [22, 2, 1.15], [18, 17, 0.95],
  [-4, -20, 1.05], [9, -19, 0.9], [-9, 19, 1.0],
  [3, 20, 0.95], [-18, -22, 1.1], [16, -22, 1.0],
];
// extra scatter for the space the doubled arena opened up, already at final
// world scale (not run through SPREAD) -- includes stands along each team's
// long walk in from their spawn end at the arena's far edges
const treeSpotsOuter = [
  [-32, 10, 1.05], [-34, -14, 1.0], [-40, 4, 0.95],
  [32, -9, 1.0], [35, 13, 1.1], [40, -3, 0.9],
  [-6, 34, 1.0], [8, -34, 1.05], [-28, -30, 0.95], [27, 30, 1.0],
];
const trees = [
  ...treeSpotsScaled.map(([x, z, scale]) => makeTree(x * SPREAD, z * SPREAD, scale)),
  ...treeSpotsOuter.map(([x, z, scale]) => makeTree(x, z, scale)),
];

// scattered gold ingots — purely decorative, a nod to the character's gold
// theme, echoing the broken gold props in the reference art. Not solid.
function makeGoldIngot(x, z, rotY) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.24, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xffc94a, roughness: 0.28, metalness: 0.8, emissive: 0x7a4400, emissiveIntensity: 0.1 })
  );
  mesh.position.set(x, 0.12, z);
  mesh.rotation.y = rotY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}
[
  [-7.4, -2.1, 0.3],
  [6.9, 3.1, -0.5],
  [-13.6, 9.4, 1.1],
  [1.1, -1.6, 2.0],
  [13.4, 8.7, 0.8],
].forEach(([gx, gz, gr]) => makeGoldIngot(gx * SPREAD, gz * SPREAD, gr));

const platformH = 2.2;
const platformTex = wallWoodTex.clone();
platformTex.needsUpdate = true;
platformTex.repeat.set(3, 3);
const platformMesh = new THREE.Mesh(
  new THREE.BoxGeometry(4.5, platformH, 4.5),
  new THREE.MeshStandardMaterial({ map: platformTex, roughness: 0.85 })
);
platformMesh.position.set(0, platformH / 2, 0);
platformMesh.castShadow = true;
platformMesh.receiveShadow = true;
scene.add(platformMesh);
const centerPlatform = { x1: -2.25, x2: 2.25, z1: -2.25, z2: 2.25, h: platformH };

// ---------- abandoned cars ----------
// low-poly, boxy on purpose to match the rest of the props -- solid cover
// scattered along the road and the long walk between the two spawn ends.
function makeCar(x, z, rotY, bodyColor) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.45, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8fd0ff, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.7 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.5, metalness: 0.4 });

  const bodyLen = 2.2, bodyW = 1.05, bodyH = 0.6, rideHeight = 0.32;

  const lower = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyLen), bodyMat);
  lower.position.y = rideHeight + bodyH / 2;
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.86, 0.48, bodyLen * 0.55), bodyMat);
  cabin.position.set(0, rideHeight + bodyH + 0.24, -bodyLen * 0.03);
  cabin.castShadow = true;
  group.add(cabin);

  const glass = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.9, 0.4, bodyLen * 0.5), glassMat);
  glass.position.copy(cabin.position);
  group.add(glass);

  for (const [wx, wz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.26, 12), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx * (bodyW / 2 + 0.01), 0.32, wz * (bodyLen * 0.32));
    wheel.castShadow = true;
    group.add(wheel);
  }

  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 1.04, 0.15, 0.14), trimMat);
  bumperF.position.set(0, rideHeight + 0.06, bodyLen / 2 + 0.03);
  group.add(bumperF);
  const bumperB = bumperF.clone();
  bumperB.position.z = -bodyLen / 2 - 0.03;
  group.add(bumperB);

  group.position.set(x, 0, z);
  group.rotation.y = rotY;
  scene.add(group);

  // square, generous approximation of the rotated footprint (matches the
  // level of collision fidelity used for trees/buildings elsewhere here)
  const half = bodyLen / 2;
  return { x1: x - half, x2: x + half, z1: z - half, z2: z + half, h: rideHeight + bodyH + 0.5 };
}
const CAR_COLORS = [0xc0392b, 0x2c6fbb, 0x3a7d3a, 0xd4ac0d, 0x7f8c8d, 0x8e44ad];
const CAR_SPOTS = [
  // strung out along the central road
  [0, -18, 0.15], [0, -6, -0.1], [0, 12, 0.25], [0, 26, -0.2],
  // flanking the long walk from each spawn end, and around the town
  [-24, -2, 1.1], [-30, 22, 0.6], [24, 6, -1.0], [30, -20, -0.5],
  [-8, -30, 0.4], [10, 30, -0.7],
];
const cars = CAR_SPOTS.map(([x, z, rot], i) => makeCar(x, z, rot, CAR_COLORS[i % CAR_COLORS.length]));

// ---------- team indicator (small floating arrow over each bot's head) ----------
function makeArrowTexture(color) {
  return makeCanvasTexture(64, (c, s) => {
    c.clearRect(0, 0, s, s);
    c.fillStyle = color;
    c.strokeStyle = "rgba(0,0,0,0.45)";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(s / 2, s * 0.92); // point, aimed down at the head
    c.lineTo(s * 0.16, s * 0.32);
    c.lineTo(s * 0.38, s * 0.32);
    c.lineTo(s * 0.38, s * 0.08);
    c.lineTo(s * 0.62, s * 0.08);
    c.lineTo(s * 0.62, s * 0.32);
    c.lineTo(s * 0.84, s * 0.32);
    c.closePath();
    c.fill();
    c.stroke();
  });
}
const teamArrowMat = {
  [TEAM_BLUE]: new THREE.SpriteMaterial({ map: makeArrowTexture("#3f8dff"), transparent: true, depthTest: false }),
  [TEAM_RED]: new THREE.SpriteMaterial({ map: makeArrowTexture("#ff4d4d"), transparent: true, depthTest: false }),
};
function makeTeamArrow(team) {
  const sprite = new THREE.Sprite(teamArrowMat[team].clone());
  sprite.scale.set(0.4, 0.4, 1);
  sprite.position.set(0, ARROW_HEIGHT, 0);
  sprite.renderOrder = 10;
  return sprite;
}

// name/handle tag just below the arrow -- mock handles for bots until real
// X login exists (see profile.js), same placeholder-first approach as the
// dashboard's leaderboard.
const BOT_NAME_POOL = [
  "@duneRider", "@goldjackal", "@snipeQueen", "@crateking", "@lowpoly_lars",
  "@ricochet_rae", "@nightcrate", "@ambervolt", "@ghostplate", "@ironmesa",
  "@duskrunner", "@bramblefox", "@saltflat_sam", "@vaultbreaker", "@copperwolf",
];
function pickBotNames(count) {
  const pool = [...BOT_NAME_POOL].sort(() => Math.random() - 0.5);
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}
function roundedRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
const NAME_TAG_W = 320, NAME_TAG_H = 96;
function makeNameTagTexture(text, accentColor) {
  const cnv = document.createElement("canvas");
  cnv.width = NAME_TAG_W;
  cnv.height = NAME_TAG_H;
  const c = cnv.getContext("2d");
  c.font = "bold 40px 'Trebuchet MS', sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";

  // dark pill "holder" behind the text so it reads against sky, grass, or
  // anything else bright/busy behind it
  const padX = 24;
  const boxW = Math.min(NAME_TAG_W - 6, c.measureText(text).width + padX * 2);
  const boxH = 62;
  const boxX = NAME_TAG_W / 2 - boxW / 2, boxY = NAME_TAG_H / 2 - boxH / 2;
  roundedRectPath(c, boxX, boxY, boxW, boxH, 16);
  c.fillStyle = "rgba(8, 12, 20, 0.78)";
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = accentColor;
  c.stroke();

  c.fillStyle = "#ffffff";
  c.fillText(text, NAME_TAG_W / 2, boxY + boxH / 2 + 2);

  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeNameTag(team, name) {
  const color = team === TEAM_BLUE ? "#8fc4ff" : "#ff9d9d";
  const mat = new THREE.SpriteMaterial({ map: makeNameTagTexture(name, color), transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.0, (1.0 * NAME_TAG_H) / NAME_TAG_W, 1);
  sprite.position.set(0, ARROW_HEIGHT - 0.32, 0);
  sprite.renderOrder = 10;
  return sprite;
}

// ---------- character model (Blender-built glTF, loaded via character.js) ----------
// Every fighter (player + all bots, both teams) uses the rigged shooter-pack
// model. The glb is fetched exactly once via loadRiggedCharacterAsset() and
// each of the 8 fighters gets its own cheap instance (skeleton clone + fresh
// mixer + cloned materials) via instantiateRiggedCharacter() -- see
// character.js for why a plain scene clone doesn't work for skinned meshes.
let assetsReady = false;
let characterAsset = null;
startBtn.disabled = true;
startBtn.textContent = "LOADING…";

const gltfLoader = new GLTFLoader();
loadRiggedCharacterAsset()
  .then((asset) => {
    characterAsset = asset;
    assetsReady = true;
    startBtn.disabled = false;
    startBtn.textContent = LAUNCHED_FROM_DASHBOARD ? "ENTER ARENA" : "DROP IN";
    if (LAUNCHED_FROM_DASHBOARD) startGame();
  })
  .catch((err) => {
    console.error("Failed to load character model:", err);
    startBtn.textContent = "LOAD FAILED";
  });

// ---------- world/game state ----------
// `fighters` holds all 8 combatants; `player` points at whichever one is
// human-controlled (fighters[0] by convention, set fresh in resetMatch).
let fighters = [], player, bullets, particles, structures, buildCooldown;
let state = "idle"; // idle | playing | over
let matchStats = { kills: 0, deaths: 0 };
let pointerLocked = false;
const keys = new Set();
let mouseDown = false;
let yaw = Math.PI; // camera yaw, radians
let pitch = -0.18;

// once the player dies, their body vanishes and control switches to a free
// fly-cam so they can keep watching the rest of the match instead of
// staring at a black screen or a frozen corpse
let spectatorMode = false;
const spectatorPos = { x: 0, y: 0, z: 0 };
const SPECTATOR_SPEED = 13;

function makeFighter(opts) {
  return {
    x: opts.x, z: opts.z, y: 0, vy: 0,
    facing: opts.facing, // radians, world-space heading
    team: opts.team,
    isPlayer: !!opts.isPlayer,
    onGround: true,
    ducking: false,
    hp: MAX_HP,
    cooldown: 0,
    hitFlash: 0,
    alive: true,
    isAI: !opts.isPlayer,
    currentTarget: null,
    model: opts.model,
    phase: 0,
    lastX: opts.x, lastZ: opts.z,
    stuckTimer: 0,
    hitReactionTimer: 0,
    firingTimer: 0,
    burstShotsLeft: 0,
    _animFwd: 0,
    _animRight: 0,
  };
}

// generates `count` spawn slots clustered near the team's edge of the arena
// (blue at the far -X end, red at the far +X end), spread out in Z so a
// whole squad doesn't clump into one hitbox, and staggered slightly inward
// for the outer pairs. Works for any team size (1v1/3v3/5v5/...). With
// ARENA_HALF=52 that's roughly a 90-unit gap between the squads -- they have
// to actively push in and search each other out instead of colliding within
// a few seconds.
function generateTeamSpawns(edgeX, count) {
  const dirIn = edgeX < 0 ? 1 : -1; // step back toward the center for outer rings
  const facing = edgeX < 0 ? 0 : Math.PI;
  const slots = [{ x: edgeX, z: 0, facing }];
  for (let ring = 1; slots.length < count; ring++) {
    const z = ring * 4;
    const x = edgeX + dirIn * (ring - 1) * 2;
    slots.push({ x, z, facing });
    if (slots.length < count) slots.push({ x, z: -z, facing });
  }
  return slots.slice(0, count);
}
const TEAM_SPAWNS = {
  [TEAM_BLUE]: generateTeamSpawns(-44, TEAM_SIZE),
  [TEAM_RED]: generateTeamSpawns(44, TEAM_SIZE),
};

function resetMatch() {
  bullets && bullets.forEach((b) => scene.remove(b.mesh));
  structures && structures.forEach((s) => s.meshes.forEach((m) => scene.remove(m)));
  particles && particles.forEach((p) => scene.remove(p.mesh));
  fighters.forEach((f) => scene.remove(f.model.group));

  bullets = [];
  particles = [];
  structures = [];
  buildCooldown = 0;
  fighters = [];
  matchStats = { kills: 0, deaths: 0 };
  spectatorMode = false;
  hideRevivePrompt();

  const botNames = pickBotNames(TEAM_SIZE * 2 - 1);
  let botNameIdx = 0;

  if (mp.active) {
    buildMultiplayerFighters(botNames);
  } else {
    for (const team of [TEAM_BLUE, TEAM_RED]) {
      TEAM_SPAWNS[team].forEach((spawn, i) => {
        const isPlayer = team === TEAM_BLUE && i === 0;
        const model = instantiateRiggedCharacter(characterAsset);
        scene.add(model.group);
        if (!isPlayer) {
          model.group.add(makeTeamArrow(team));
          model.group.add(makeNameTag(team, botNames[botNameIdx++]));
        }
        const f = makeFighter({ x: spawn.x, z: spawn.z, facing: spawn.facing, team, isPlayer, model });
        fighters.push(f);
        if (isPlayer) player = f;
      });
    }
  }

  yaw = Math.PI;
  pitch = -0.18;
}

// The server's roster is the single source of truth for who is in the match:
// every client builds the same fighters, at the same spawns, from the same
// (team, slot) pairs -- so an entity is the same character on every screen.
//
// Which ones we actually *simulate* is the only thing that differs per client:
//   ours + human  -> the player, driven by input
//   ours + bot    -> the existing single-player AI
//   someone elses -> not simulated at all; interpolated from snapshots
function buildMultiplayerFighters(botNames) {
  let botNameIdx = 0;
  for (const ent of mp.roster) {
    const team = ent.team === 0 ? TEAM_BLUE : TEAM_RED;
    const spawn = TEAM_SPAWNS[team][ent.slot] || TEAM_SPAWNS[team][0];
    const isMine = mp.owned.has(ent.id);
    const isPlayer = ent.id === mp.myEntityId;

    const model = instantiateRiggedCharacter(characterAsset);
    scene.add(model.group);

    const label = ent.name || (ent.isBot ? botNames[botNameIdx++] : "player");
    if (!isPlayer) {
      model.group.add(makeTeamArrow(team));
      model.group.add(makeNameTag(team, label));
    }

    const f = makeFighter({ x: spawn.x, z: spawn.z, facing: spawn.facing, team, isPlayer, model });
    f.hp = ent.hp;
    f.alive = ent.alive;
    f.netName = label;
    // Only run AI for bots we own. A remote player's character must never be
    // driven by our AI -- it is driven by their machine, via the server.
    f.isAI = isMine && !isPlayer;
    MP.bindFighter(ent.id, f);
    fighters.push(f);
    if (isPlayer) player = f;
  }
  // Safety net: if the roster never arrived we would have no player at all.
  if (!player && fighters.length) player = fighters[0];
}

// ---------- structures ----------
function footprintXZ(s, x, z) {
  return x > s.x1 && x < s.x2 && z > s.z1 && z < s.z2;
}

function rampHeightAt(ramp, x, z) {
  const relX = x - ramp.baseX, relZ = z - ramp.baseZ;
  const along = relX * ramp.dirX + relZ * ramp.dirZ;
  const perp = relX * -ramp.dirZ + relZ * ramp.dirX;
  if (along < -0.2 || along > ramp.length || Math.abs(perp) > ramp.width / 2) return null;
  const t = Math.max(0, Math.min(1, along / ramp.length));
  return t * ramp.height;
}

function placeStructure(f, type) {
  if (buildCooldown > 0) return;
  buildCooldown = BUILD_COOLDOWN;
  const dirX = Math.sin(f.facing), dirZ = Math.cos(f.facing);
  const baseX = f.x + dirX * BUILD_OFFSET;
  const baseZ = f.z + dirZ * BUILD_OFFSET;

  if (type === "wall") {
    const perpX = dirZ, perpZ = -dirX;
    const wallTexInst = wallWoodTex.clone();
    wallTexInst.needsUpdate = true;
    wallTexInst.repeat.set(WALL_LEN / 1.1, WALL_H / 1.1);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(WALL_LEN, WALL_H, WALL_THICK),
      new THREE.MeshStandardMaterial({ map: wallTexInst, roughness: 0.85 })
    );
    mesh.position.set(baseX, WALL_H / 2, baseZ);
    mesh.rotation.y = Math.atan2(perpX, perpZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const halfLen = WALL_LEN / 2;
    structures.push({
      type: "wall",
      x1: baseX - Math.abs(perpX) * halfLen - Math.abs(dirX) * WALL_THICK,
      x2: baseX + Math.abs(perpX) * halfLen + Math.abs(dirX) * WALL_THICK,
      z1: baseZ - Math.abs(perpZ) * halfLen - Math.abs(dirZ) * WALL_THICK,
      z2: baseZ + Math.abs(perpZ) * halfLen + Math.abs(dirZ) * WALL_THICK,
      h: WALL_H, hp: STRUCT_HP, maxHp: STRUCT_HP, meshes: [mesh],
    });
  } else {
    const rampTexInst = wallWoodTex.clone();
    rampTexInst.needsUpdate = true;
    rampTexInst.repeat.set(RAMP_WIDTH / 1.1, RAMP_LEN / 1.1);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(RAMP_WIDTH, 0.4, RAMP_LEN * 1.02),
      new THREE.MeshStandardMaterial({ map: rampTexInst, roughness: 0.85 })
    );
    const slope = Math.atan2(RAMP_H, RAMP_LEN);
    mesh.position.set(baseX + dirX * RAMP_LEN / 2, RAMP_H / 2, baseZ + dirZ * RAMP_LEN / 2);
    mesh.rotation.y = Math.atan2(dirX, dirZ);
    mesh.rotation.x = -slope;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    structures.push({
      type: "ramp",
      baseX, baseZ, dirX, dirZ, length: RAMP_LEN, width: RAMP_WIDTH, height: RAMP_H,
      x1: Math.min(baseX, baseX + dirX * RAMP_LEN) - RAMP_WIDTH,
      x2: Math.max(baseX, baseX + dirX * RAMP_LEN) + RAMP_WIDTH,
      z1: Math.min(baseZ, baseZ + dirZ * RAMP_LEN) - RAMP_WIDTH,
      z2: Math.max(baseZ, baseZ + dirZ * RAMP_LEN) + RAMP_WIDTH,
      hp: STRUCT_HP, maxHp: STRUCT_HP, meshes: [mesh],
    });
  }

  if (structures.length > MAX_STRUCTURES) {
    const old = structures.shift();
    old.meshes.forEach((m) => scene.remove(m));
  }
  playBuildSfx();
}

function destroyStructure(s) {
  s.meshes.forEach((m) => scene.remove(m));
  const i = structures.indexOf(s);
  if (i >= 0) structures.splice(i, 1);
}

// ---------- collision ----------
function surfaceHeightAt(x, z) {
  let best = 0;
  for (const b of buildings) if (footprintXZ(b, x, z)) best = Math.max(best, b.h);
  for (const c of crates) if (footprintXZ(c, x, z)) best = Math.max(best, c.h);
  for (const c of cars) if (footprintXZ(c, x, z)) best = Math.max(best, c.h);
  if (footprintXZ(centerPlatform, x, z)) best = Math.max(best, centerPlatform.h);
  for (const s of structures) {
    if (s.type === "wall") {
      if (footprintXZ(s, x, z)) best = Math.max(best, s.h);
    } else {
      const rh = rampHeightAt(s, x, z);
      if (rh !== null) best = Math.max(best, rh);
    }
  }
  return best;
}

function resolveBlockersXZ(f, nextX, nextZ) {
  const blockers = [...buildings, ...crates, ...trees, ...cars];
  for (const s of structures) if (s.type === "wall") blockers.push(s);
  for (const b of blockers) {
    const highEnough = f.y >= b.h - 0.05;
    if (highEnough) continue;
    if (nextX > b.x1 - PLAYER_RADIUS && nextX < b.x2 + PLAYER_RADIUS && nextZ > b.z1 - PLAYER_RADIUS && nextZ < b.z2 + PLAYER_RADIUS) {
      const overlapX = Math.min(nextX - (b.x1 - PLAYER_RADIUS), (b.x2 + PLAYER_RADIUS) - nextX);
      const overlapZ = Math.min(nextZ - (b.z1 - PLAYER_RADIUS), (b.z2 + PLAYER_RADIUS) - nextZ);
      if (overlapX < overlapZ) {
        nextX = f.x <= (b.x1 + b.x2) / 2 ? b.x1 - PLAYER_RADIUS : b.x2 + PLAYER_RADIUS;
      } else {
        nextZ = f.z <= (b.z1 + b.z2) / 2 ? b.z1 - PLAYER_RADIUS : b.z2 + PLAYER_RADIUS;
      }
    }
  }
  return [nextX, nextZ];
}

// ---------- combat ----------
const bulletGeo = new THREE.SphereGeometry(0.09, 6, 6);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe86a });

const muzzleFlashTex = makeCanvasTexture(64, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,225,1)");
  g.addColorStop(0.4, "rgba(255,220,140,0.9)");
  g.addColorStop(1, "rgba(255,180,80,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
});
const muzzleFlashMat = new THREE.SpriteMaterial({ map: muzzleFlashTex, fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
function spawnMuzzleFlash(x, y, z) {
  const sprite = new THREE.Sprite(muzzleFlashMat.clone());
  sprite.scale.set(0.5, 0.5, 1);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  particles.push({ mesh: sprite, vx: 0, vy: 0, vz: 0, life: 0.05 });
}

function shoot(f) {
  if (f.cooldown > 0) return;
  f.cooldown = f.isAI ? AI_SHOOT_COOLDOWN : SHOOT_COOLDOWN;
  f.firingTimer = 0.25;

  let dirX, dirY, dirZ;
  if (f.isAI) {
    // aim a real 3D vector at this bot's chosen target, so height differences matter
    const target = f.currentTarget;
    if (!target) return;
    const tx = target.x - f.x;
    const ty = (target.y + SPRITE_H * 0.5) - (f.y + PLAYER_EYE_H * 0.85);
    const tz = target.z - f.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    dirX = tx / len; dirY = ty / len; dirZ = tz / len;
  } else {
    // player aims wherever the camera/crosshair is pointing, pitch included
    dirX = Math.sin(yaw) * Math.cos(pitch);
    dirY = Math.sin(pitch);
    dirZ = Math.cos(yaw) * Math.cos(pitch);
  }

  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  const bx = f.x + dirX * 0.6, by = f.y + PLAYER_EYE_H * 0.85 + dirY * 0.3, bz = f.z + dirZ * 0.6;
  mesh.position.set(bx, by, bz);
  scene.add(mesh);
  bullets.push({ x: bx, y: by, z: bz, dirX, dirY, dirZ, dmg: f.isAI ? AI_BULLET_DAMAGE : BULLET_DAMAGE, owner: f, mesh, life: 2.2 });
  spawnMuzzleFlash(bx, by, bz);
  playShootSfx(f.isAI);
  // Let the other clients draw the muzzle flash. Only the bullet's *effect*
  // (a hit claim) is authoritative; this is purely so shots are visible.
  if (mp.active && f.entityId && !f.isRemote) {
    MP.reportShot(f.entityId, bx, by, bz, dirX, dirY, dirZ);
  }
}

function spawnFootstepDust(x, z, groundY) {
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xcbb28a, transparent: true, opacity: 0.5 })
    );
    mesh.position.set(x + (Math.random() - 0.5) * 0.2, groundY + 0.03, z + (Math.random() - 0.5) * 0.2);
    scene.add(mesh);
    particles.push({
      mesh,
      vx: (Math.random() - 0.5) * 0.6, vy: Math.random() * 0.5 + 0.15, vz: (Math.random() - 0.5) * 0.6,
      life: 0.3 + Math.random() * 0.15,
    });
  }
}

function spawnParticles(x, y, z, color, count) {
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(x, y, z);
    scene.add(mesh);
    particles.push({
      mesh,
      vx: (Math.random() - 0.5) * 4, vy: Math.random() * 3.5 + 1, vz: (Math.random() - 0.5) * 4,
      life: 0.5 + Math.random() * 0.4,
    });
  }
}

// records who got credit for a kill/death this match -- used at match end to
// write XP back to the local profile (see profile.js)
function registerKill(killerFighter, victimFighter) {
  if (killerFighter && killerFighter.isPlayer) matchStats.kills++;
  if (victimFighter && victimFighter.isPlayer) matchStats.deaths++;
}

function endMatch(winningTeam) {
  state = "over";
  document.exitPointerLock && document.exitPointerLock();
  const won = winningTeam === player.team;
  const title = won ? "YOU WIN" : "YOU DIED";

  recordMatchResult(loadProfile(), { kills: matchStats.kills, deaths: matchStats.deaths, won });
  const xpEarned = matchStats.kills * XP_PER_KILL + XP_PER_GAME;
  const subtitle = (won ? "Your squad cleared the arena." : "Your squad was wiped out.")
    + ` — ${matchStats.kills} kill${matchStats.kills === 1 ? "" : "s"}, +${xpEarned} XP`;

  showOverlay(title, subtitle, "PLAY AGAIN", true);

  // Also push the result to the server so it lands on the global ranking
  // under the player's X handle. Fire-and-forget on purpose: the local
  // profile above is already saved, so a signed-out player or an offline
  // backend costs the shared leaderboard entry and nothing else. The
  // overlay is already on screen; append to it only if this succeeds.
  submitMatchResult({ kills: matchStats.kills, deaths: matchStats.deaths, xp: xpEarned })
    .then((serverPlayer) => {
      if (!serverPlayer || state !== "over") return;
      appendOverlaySubtitle(` · saved to @${serverPlayer.handle} (${serverPlayer.xp} XP total)`);
    })
    .catch(() => {});
}

// call once per frame from update(dt) -- ends the match the instant either
// team has no fighters left alive
function checkMatchEnd() {
  if (state !== "playing") return;
  // In multiplayer the server decides, and tells everyone at once -- deciding
  // locally would let two clients disagree about who won.
  if (mp.active) return;
  const blueAlive = fighters.some((f) => f.team === TEAM_BLUE && f.alive);
  const redAlive = fighters.some((f) => f.team === TEAM_RED && f.alive);
  if (!blueAlive) endMatch(TEAM_RED);
  else if (!redAlive) endMatch(TEAM_BLUE);
}

// ---------- AI ----------
function nearestCover(x, z) {
  let best = null, bestDist = Infinity;
  const candidates = [...buildings, ...crates, ...trees, ...cars];
  for (const s of structures) if (s.type === "wall") candidates.push(s);
  for (const c of candidates) {
    const cx = (c.x1 + c.x2) / 2, cz = (c.z1 + c.z2) / 2;
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

// nearest living fighter on a different team from f -- each bot re-picks
// every frame, so a squad naturally redistributes fire as targets die
function findNearestEnemy(f) {
  let best = null, bestDist = Infinity;
  for (const other of fighters) {
    if (other === f || !other.alive || other.team === f.team) continue;
    const d = Math.hypot(other.x - f.x, other.z - f.z);
    if (d < bestDist) { bestDist = d; best = other; }
  }
  return best;
}

// how many bots on the SAME team are allowed to be actively firing (i.e.
// mid-burst) at the same instant -- keeps a squad from turning into a
// constant wall of gunfire and forces the rest to hold, move, or hide instead
const MAX_CONCURRENT_AI_SHOOTERS_PER_TEAM = 2;
function countActiveAITeamShooters(f) {
  let n = 0;
  for (const other of fighters) {
    if (other !== f && other.isAI && other.team === f.team && other.firingTimer > 0) n++;
  }
  return n;
}

function updateAI(f, dt) {
  const target = findNearestEnemy(f);
  f.currentTarget = target;
  if (!target) { f.ducking = false; f._animFwd = 0; f._animRight = 0; return; } // f's whole opposing team is already down -- just hold position

  const dx = target.x - f.x, dz = target.z - f.z;
  const dist = Math.hypot(dx, dz);
  f.facing = Math.atan2(dx, dz);

  // ---- tactical state machine: alternate between pushing/engaging in the
  // open and falling back to cover to break line of sight, instead of
  // dueling head-on nonstop like a turret ----
  if (f.aiState === undefined) { f.aiState = "engage"; f.aiStateTimer = 1.0 + Math.random() * 1.5; }
  f.aiStateTimer -= dt;
  if (f.aiStateTimer <= 0) {
    if (f.aiState === "engage") {
      f.aiState = "cover";
      f.aiStateTimer = 1.4 + Math.random() * 1.8;
      f.coverTarget = nearestCover(f.x, f.z);
    } else {
      f.aiState = "engage";
      f.aiStateTimer = 1.2 + Math.random() * 1.8;
    }
  }
  // badly hurt overrides whatever it was doing and forces a retreat to cover
  if (f.hp < 45 && f.aiState !== "cover") {
    f.aiState = "cover";
    f.aiStateTimer = Math.max(f.aiStateTimer, 1.6);
    f.coverTarget = nearestCover(f.x, f.z);
  }

  let moveX = 0, moveZ = 0;
  let wantsToDuck = false;
  let atCover = false;

  if (f.aiState === "cover" && f.coverTarget) {
    const cx = (f.coverTarget.x1 + f.coverTarget.x2) / 2, cz = (f.coverTarget.z1 + f.coverTarget.z2) / 2;
    const cdx = cx - f.x, cdz = cz - f.z, clen = Math.hypot(cdx, cdz) || 1;
    if (clen > 1.6) {
      moveX = cdx / clen; moveZ = cdz / clen;
    } else {
      atCover = true;
      wantsToDuck = true; // hunkered down behind cover
    }
  } else {
    // engage: approach/retreat to hold a preferred range, like before
    if (dist > AI_PREFERRED_RANGE + 3) { moveX = dx / dist; moveZ = dz / dist; }
    else if (dist < AI_PREFERRED_RANGE - 4) { moveX = -dx / dist; moveZ = -dz / dist; }

    // strafe perpendicular to the target, flipping direction every second
    // or so, so it isn't just a straight line walking into fire
    f.strafeTimer = (f.strafeTimer ?? 0) - dt;
    if (f.strafeTimer <= 0) {
      f.strafeDir = Math.random() < 0.5 ? -1 : 1;
      f.strafeTimer = 0.6 + Math.random() * 0.9;
    }
    if (dist > 0.001) {
      moveX += (-dz / dist) * f.strafeDir * 0.8;
      moveZ += (dx / dist) * f.strafeDir * 0.8;
    }
  }

  const mlen = Math.hypot(moveX, moveZ);
  if (mlen > 0.001) { moveX /= mlen; moveZ /= mlen; }

  // animation intent from the steering vector itself (stable) rather than
  // the position delta it produces after collision resolution (noisy)
  f._animFwd = moveX * Math.sin(f.facing) + moveZ * Math.cos(f.facing);
  f._animRight = moveX * Math.sin(f.facing - Math.PI / 2) + moveZ * Math.cos(f.facing - Math.PI / 2);

  const nextX = f.x + moveX * MOVE_SPEED * dt;
  const nextZ = f.z + moveZ * MOVE_SPEED * dt;
  const [rx, rz] = resolveBlockersXZ(f, nextX, nextZ);
  f.x = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, rx));
  f.z = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, rz));
  f.ducking = wantsToDuck && f.onGround;

  if (f.onGround) {
    const moved = Math.hypot(f.x - f.lastX, f.z - f.lastZ);
    if (moved < 0.01 && (moveX !== 0 || moveZ !== 0)) f.stuckTimer += dt;
    else f.stuckTimer = 0;
    // occasional tactical hop while pushing (dodges shots, breaks up the
    // silhouette) on top of the anti-stuck fallback jump
    const tacticalJumpChance = f.aiState === "engage" && !atCover ? 0.006 : 0.0012;
    if (f.stuckTimer > 0.25 || Math.random() < tacticalJumpChance) {
      f.vy = JUMP_SPEED;
      f.onGround = false;
      f.stuckTimer = 0;
      playJumpSfx();
    }
  }
  f.lastX = f.x; f.lastZ = f.z;

  // tactical build: drop a wall for cover when caught in the open at
  // close-mid range, instead of only ever building near ambush range
  if (f.aiState === "engage" && dist < 9 && structures.length < MAX_STRUCTURES && Math.random() < 0.01) {
    placeStructure(f, "wall");
  }

  // ---- firing discipline: short bursts with a real pause after, and only
  // if the squad hasn't already got its cap of shooters going right now ----
  const inFiringRange = dist < AI_PREFERRED_RANGE + 7;
  if (f.aiState === "engage" && !f.ducking && inFiringRange) {
    if (f.burstShotsLeft > 0 && f.cooldown <= 0) {
      if (countActiveAITeamShooters(f) < MAX_CONCURRENT_AI_SHOOTERS_PER_TEAM) {
        shoot(f);
        f.burstShotsLeft--;
        if (f.burstShotsLeft <= 0) f.cooldown = Math.max(f.cooldown, 0.9 + Math.random() * 1.1);
      }
    } else if (!f.burstShotsLeft && f.cooldown <= 0 && Math.random() < 0.05) {
      f.burstShotsLeft = 2 + Math.floor(Math.random() * 3); // 2-4 round burst, then holds fire
    }
  } else if (atCover && wantsToDuck && dist < AI_PREFERRED_RANGE + 4 && Math.random() < 0.01) {
    // occasional defensive pot-shot from behind cover, same squad cap applies
    if (countActiveAITeamShooters(f) < MAX_CONCURRENT_AI_SHOOTERS_PER_TEAM) shoot(f);
  }

}

// ---------- input ----------
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  // One key for one item. R spends it whichever way is currently legal: a
  // refill while you are hurt and standing, or a revive inside the window
  // after a death too fast to react to. It does nothing the rest of the time.
  if (k === "r") useExtraLife();
  keys.add(k);
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
// If the window/tab loses focus for even an instant while a movement key is
// held -- taking a screenshot, alt-tabbing, clicking outside the game -- the
// browser doesn't reliably deliver the matching keyup once focus returns.
// That leaves a key like "s" permanently stuck "held" in this Set, silently
// fighting whatever the player is actually pressing (e.g. walking forward
// while a phantom "back" is also active), which reads as random backward
// jumps during otherwise-normal forward movement. Clearing all held keys on
// blur means a real physical hold always requires a fresh keydown after
// refocusing, which is standard behavior in browser games for this reason.
window.addEventListener("blur", () => {
  keys.clear();
  mouseDown = false;
});
canvas.addEventListener("mousedown", () => (mouseDown = true));
window.addEventListener("mouseup", () => (mouseDown = false));
const lockHint = document.getElementById("lockHint");

function updateLockHint() {
  if (!lockHint) return;
  lockHint.classList.toggle("hidden", pointerLocked || state !== "playing");
}

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  updateLockHint();
});

// Capture the mouse on click, every time it is not already captured.
//
// Requesting it once inside startGame() is not enough, and that is what broke
// looking around entirely: arriving from the dashboard starts the match
// automatically, with no user gesture for the browser to attach the request
// to, and startGame() is async besides -- so by the time it asked, any user
// activation from a click had already been consumed by the awaits. A click
// handler is the one place the gesture is guaranteed to be live.
canvas.addEventListener("click", () => {
  if (state !== "playing" || pointerLocked) return;
  canvas.requestPointerLock && canvas.requestPointerLock();
});
window.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;
  yaw -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0018;
  // spectating gets a much wider look range (near-vertical) to freely scan
  // the arena; normal play stays clamped to a natural FPS-style range
  pitch = spectatorMode ? Math.max(-1.5, Math.min(1.5, pitch)) : Math.max(-0.9, Math.min(0.5, pitch));
});

// ---------- fighter update ----------
// Remote characters still need their model positioned, their clip played and
// their death handled -- just none of the input/AI/physics that would move them.
function updateRemoteFighter(f, dt) {
  if (!f.alive) {
    if (f.model.group.visible) {
      f.model.group.visible = false;
      spawnParticles(f.x, f.y + 0.8, f.z, f.team === TEAM_BLUE ? 0x6fb3ff : 0xff6f6f, 14);
    }
    return;
  }
  if (f.hitFlash > 0) f.hitFlash -= dt;

  const clipName = f._netAnim || "RifleAimingIdle";
  f._lastClipName = clipName;
  const oneShot = clipName === "HitReaction";
  f.model.play(clipName, { loop: !oneShot, clampWhenFinished: oneShot });
  f.model.group.scale.set(RIGGED_MODEL_SCALE, RIGGED_MODEL_SCALE, RIGGED_MODEL_SCALE);
  f.model.mixer.update(dt);

  f.model.group.position.set(f.x, f.y, f.z);
  f.model.group.rotation.y = f.facing;

  const flashMix = f.hitFlash > 0 ? Math.max(0, Math.sin(f.hitFlash * 40)) : 0;
  f.model.bodyMat.color.copy(f.model.bodyBase).lerp(WHITE, flashMix);
}

function updateFighter(f, dt) {
  // A character owned by another player: their machine decides where it is and
  // what it is doing. We only play the animation clip they told us about and
  // let mp.applyRemoteTransforms() move it. Running any of the code below for
  // them would fight the network state and desync the two screens.
  if (f.isRemote) {
    updateRemoteFighter(f, dt);
    return;
  }
  if (!f.alive) {
    // vanish once, right when they die -- stop moving/shooting/animating
    // entirely rather than leaving a corpse that keeps acting
    if (f.model.group.visible) {
      f.model.group.visible = false;
      spawnParticles(f.x, f.y + 0.8, f.z, f.team === TEAM_BLUE ? 0x6fb3ff : 0xff6f6f, 14);
    }
    return;
  }

  if (!f.isAI) {
    const forward = keys.has("w");
    const back = keys.has("s");
    const left = keys.has("a");
    const right = keys.has("d");
    const jump = keys.has(" ");
    const duck = keys.has("shift") || keys.has("c");
    const fire = keys.has("f") || mouseDown;

    f.ducking = duck && f.onGround;

    const camForwardX = Math.sin(yaw), camForwardZ = Math.cos(yaw);
    const camRightX = Math.sin(yaw - Math.PI / 2), camRightZ = Math.cos(yaw - Math.PI / 2);

    let mx = 0, mz = 0;
    if (!f.ducking) {
      if (forward) { mx += camForwardX; mz += camForwardZ; }
      if (back) { mx -= camForwardX; mz -= camForwardZ; }
      if (right) { mx += camRightX; mz += camRightZ; }
      if (left) { mx -= camRightX; mz -= camRightZ; }
    }
    f.facing = yaw; // player always faces the camera direction, like a real TPS
    const mlen = Math.hypot(mx, mz);
    if (mlen > 0.001) {
      mx /= mlen; mz /= mlen;
      const nextX = f.x + mx * MOVE_SPEED * dt;
      const nextZ = f.z + mz * MOVE_SPEED * dt;
      const [rx, rz] = resolveBlockersXZ(f, nextX, nextZ);
      f.x = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, rx));
      f.z = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, rz));
    }
    // animation intent straight from the held keys (camera-relative, and
    // facing === yaw for the player) -- immune to the collision/position
    // jitter that made realized-displacement-based picking flicker
    f._animFwd = f.ducking ? 0 : (forward ? 1 : 0) - (back ? 1 : 0);
    f._animRight = f.ducking ? 0 : (right ? 1 : 0) - (left ? 1 : 0);

    if (jump && f.onGround) {
      f.vy = JUMP_SPEED;
      f.onGround = false;
      playJumpSfx();
    }
    if (fire) shoot(f);
    if (keys.has("q")) placeStructure(f, "wall");
    if (keys.has("e")) placeStructure(f, "ramp");
  } else {
    updateAI(f, dt);
  }

  if (f.cooldown > 0) f.cooldown = Math.max(0, f.cooldown - dt);
  if (f.hitReactionTimer > 0) f.hitReactionTimer = Math.max(0, f.hitReactionTimer - dt);
  if (f.firingTimer > 0) f.firingTimer = Math.max(0, f.firingTimer - dt);

  const ground = surfaceHeightAt(f.x, f.z);
  f.vy += GRAVITY * dt;
  const nextY = f.y + f.vy * dt;
  if (f.vy <= 0 && nextY <= ground) {
    f.y = ground;
    f.vy = 0;
    f.onGround = true;
  } else {
    f.y = nextY;
    f.onGround = false;
  }

  if (f.hitFlash > 0) f.hitFlash -= dt;

  const dxMoved = f.x - (f.lastX2 ?? f.x);
  const dzMoved = f.z - (f.lastZ2 ?? f.z);
  const moved = Math.hypot(dxMoved, dzMoved);
  f.lastX2 = f.x; f.lastZ2 = f.z;
  const poseKey = f.ducking ? "ducking" : !f.onGround ? "jumping" : (moved > 0.0015 ? "running" : "walking");
  if (poseKey === "running" || poseKey === "walking") f.phase += dt;

  // f._animFwd/_animRight are set from *intended* movement (raw WASD for the
  // player, the pre-resolution steering vector for AI) by whichever branch
  // just ran above -- not from this frame's realized position delta. Deltas
  // are noisy (collision resolution, and for AI, facing itself is
  // recalculated every frame toward a moving target) and occasionally flip
  // sign for a single frame, which was swapping in the wrong clip (even
  // briefly into WalkingBackwards) and reading as the character stepping
  // backward while otherwise moving forward.
  const clip = pickRiggedClip(f, f._animFwd, f._animRight);
  f._lastClipName = clip.name;
  f.model.play(clip.name, { loop: clip.loop, clampWhenFinished: !clip.loop });
  f.model.group.scale.set(RIGGED_MODEL_SCALE, RIGGED_MODEL_SCALE * (f.ducking ? 0.62 : 1), RIGGED_MODEL_SCALE);
  f.model.mixer.update(dt);

  if (f.onGround && poseKey === "running") {
    f.footstepTimer = (f.footstepTimer || 0) + dt;
    if (f.footstepTimer > 0.28) {
      f.footstepTimer = 0;
      spawnFootstepDust(f.x, f.z, f.y);
    }
  } else {
    f.footstepTimer = 0;
  }

  f.model.group.position.set(f.x, f.y, f.z);
  f.model.group.rotation.y = f.facing;

  const flashMix = f.hitFlash > 0 ? Math.max(0, Math.sin(f.hitFlash * 40)) : 0;
  f.model.bodyMat.color.copy(f.model.bodyBase).lerp(WHITE, flashMix);
}

// Priority order for the rigged model's full-body animation clip: hit
// reaction / firing / airborne take over completely, otherwise pick a
// movement clip from the fighter's intended forward/right movement
// (f._animFwd/_animRight, unit-vector-scale -- see updateFighter/updateAI).
// NB: the rig still ships a TossGrenade clip -- grenades were pulled before
// launch and will come back, so the clip is left in the asset unused.
function pickRiggedClip(f, fwdAmount, rightAmount) {
  if (f.hitReactionTimer > 0) return { name: "HitReaction", loop: false };
  if (f.firingTimer > 0) return { name: "FiringRifle", loop: true };
  if (!f.onGround) return { name: "RifleJump", loop: true };
  const MOVE_EPS = 0.25;
  if (fwdAmount > MOVE_EPS) return { name: "RifleRun", loop: true };
  if (fwdAmount < -MOVE_EPS) return { name: "WalkingBackwards", loop: true };
  if (rightAmount > MOVE_EPS) return { name: "StrafeRight", loop: true };
  if (rightAmount < -MOVE_EPS) return { name: "StrafeLeft", loop: true };
  return { name: "RifleAimingIdle", loop: true };
}

// free fly-cam movement while spectating: forward/back/strafe follow the
// look direction (including pitch, so looking up and pressing forward
// climbs), jump/duck move straight up/down, no gravity or collision --
// spectators can drift anywhere to watch the rest of the fight.
function updateSpectator(dt) {
  const forward = keys.has("w"), back = keys.has("s"), left = keys.has("a"), right = keys.has("d");
  const up = keys.has(" "), down = keys.has("shift") || keys.has("c");

  const dirX = Math.sin(yaw) * Math.cos(pitch), dirY = Math.sin(pitch), dirZ = Math.cos(yaw) * Math.cos(pitch);
  const rightX = Math.sin(yaw - Math.PI / 2), rightZ = Math.cos(yaw - Math.PI / 2);

  let mx = 0, my = 0, mz = 0;
  if (forward) { mx += dirX; my += dirY; mz += dirZ; }
  if (back) { mx -= dirX; my -= dirY; mz -= dirZ; }
  if (right) { mx += rightX; mz += rightZ; }
  if (left) { mx -= rightX; mz -= rightZ; }
  if (up) my += 1;
  if (down) my -= 1;

  const len = Math.hypot(mx, my, mz);
  if (len > 0.001) {
    spectatorPos.x += (mx / len) * SPECTATOR_SPEED * dt;
    spectatorPos.y += (my / len) * SPECTATOR_SPEED * dt;
    spectatorPos.z += (mz / len) * SPECTATOR_SPEED * dt;
  }
  spectatorPos.y = Math.max(1.2, spectatorPos.y);
}

// ---------- main update ----------
function update(dt) {
  // Pull remote characters toward the latest snapshot before anything reads
  // their positions this frame (AI targeting, bullet collision, the camera).
  MP.applyRemoteTransforms(fighters, dt);
  for (const f of fighters) updateFighter(f, dt);
  MP.reportOwned(fighters);
  if (buildCooldown > 0) buildCooldown = Math.max(0, buildCooldown - dt);

  // The bar drains against the server's deadline, so it can only ever promise
  // less time than the server will honour, never more.
  if (!revivePrompt.classList.contains("hidden")) {
    const remaining = MP.reviveMsRemaining();
    reviveTimerFill.style.transform = `scaleX(${Math.max(0, remaining / reviveWindowTotalMs)})`;
    if (remaining <= 0) hideRevivePrompt();
  }

  if (!spectatorMode && player && !player.alive) {
    spectatorMode = true;
    spectatorPos.x = player.x; spectatorPos.y = player.y + PLAYER_EYE_H + 2.5; spectatorPos.z = player.z;
    crosshair.style.display = "none";
    buildHint.classList.add("hidden");
    spectatorNote.classList.remove("hidden");
  }
  if (spectatorMode) updateSpectator(dt);

  // move bullets in short substeps and check solids after each one — at
  // BULLET_SPEED a single full-frame step can be wider than a thin wall
  // (0.35 units), which let bullets tunnel straight through without ever
  // landing on a point inside the wall's footprint. Buildings are checked
  // here too; before, only player-built walls and crates stopped bullets.
  const BULLET_SUBSTEP = 0.12;
  for (const b of bullets) {
    if (b.dead) continue;
    const totalDist = BULLET_SPEED * dt;
    const steps = Math.max(1, Math.ceil(totalDist / BULLET_SUBSTEP));
    const stepDist = totalDist / steps;

    for (let i = 0; i < steps; i++) {
      b.x += b.dirX * stepDist;
      b.y += b.dirY * stepDist;
      b.z += b.dirZ * stepDist;

      let hitColor = null;
      for (const s of structures) {
        if (s.type !== "wall") continue;
        if (footprintXZ(s, b.x, b.z) && b.y < s.h) {
          s.hp -= b.dmg;
          if (s.hp <= 0) destroyStructure(s);
          hitColor = 0xe8a55c;
          break;
        }
      }
      if (!hitColor) {
        for (const c of crates) {
          if (footprintXZ(c, b.x, b.z) && b.y < c.h) { hitColor = 0xc7cdd4; break; }
        }
      }
      if (!hitColor) {
        for (const t of trees) {
          if (footprintXZ(t, b.x, b.z) && b.y < t.h) { hitColor = 0x4a3420; break; }
        }
      }
      if (!hitColor) {
        for (const bd of buildings) {
          if (footprintXZ(bd, b.x, b.z) && b.y < bd.h) { hitColor = 0xd9a35c; break; }
        }
      }
      if (hitColor) {
        spawnParticles(b.x, b.y, b.z, hitColor, 5);
        b.dead = true;
        break;
      }
    }

    b.life -= dt;
    if (!b.dead) b.mesh.position.set(b.x, b.y, b.z);
  }

  bullets = bullets.filter((b) => {
    if (b.dead || b.life <= 0 || b.y < -0.2 || b.y > 40 || Math.abs(b.x) > ARENA_HALF + 4 || Math.abs(b.z) > ARENA_HALF + 4) {
      scene.remove(b.mesh);
      return false;
    }
    return true;
  });

  for (const b of bullets) {
    if (b.life <= 0) continue;
    for (const target of fighters) {
      if (!target.alive || target.team === b.owner.team) continue;
      const dx = b.x - target.x, dz = b.z - target.z, dy = b.y - (target.y + SPRITE_H * 0.5);
      if (Math.hypot(dx, dz) < 0.55 && Math.abs(dy) < SPRITE_H * 0.55) {
        // Feedback (spark, sound, bullet consumed) is immediate either way --
        // waiting a round trip to show a hit would feel broken.
        spawnParticles(b.x, b.y, b.z, 0xff5f6d, 10);
        scene.remove(b.mesh);
        b.life = -1;
        playHitSfx();

        if (mp.active) {
          // Health is the server's to decide, so only bullets we are actually
          // responsible for get to file a claim -- otherwise every client in
          // the match would report the same hit and multiply the damage.
          if (!b.owner.isRemote) MP.claimHit(target, b.dmg);
          target.hitFlash = 0.35;
          break;
        }

        target.hp = Math.max(0, target.hp - b.dmg);
        target.hitFlash = 0.35;
        target.hitReactionTimer = HIT_REACTION_DURATION;
        if (target.hp <= 0) { target.alive = false; registerKill(b.owner, target); }
        break;
      }
    }
  }
  bullets = bullets.filter((b) => b.life > 0);

  for (const p of particles) {
    p.vy += GRAVITY * dt * 0.5;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => {
    if (p.life <= 0) {
      scene.remove(p.mesh);
      return false;
    }
    return true;
  });

  checkMatchEnd();

  structCountEl.textContent = `${structures.length}/${MAX_STRUCTURES}`;
  hpFillYou.style.width = Math.max(0, player.hp) + "%";
  updateExtraLifeButton();

  const enemyTeam = player.team === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
  let enemyHpSum = 0, blueAlive = 0, redAlive = 0;
  for (const f of fighters) {
    if (f.team === enemyTeam) enemyHpSum += Math.max(0, f.hp);
    if (f.alive) { if (f.team === TEAM_BLUE) blueAlive++; else redAlive++; }
  }
  hpFillRival.style.width = (enemyHpSum / (TEAM_SIZE * MAX_HP)) * 100 + "%";
  blueAliveCountEl.textContent = blueAlive;
  redAliveCountEl.textContent = redAlive;
}

// ---------- camera ----------
// A true chase/aim camera: it looks in the exact (yaw, pitch) direction the
// player is aiming, not at the player's body. That way the crosshair (screen
// center) always matches where shots actually travel — previously the camera
// orbited the player but always pointed AT them, so the crosshair showed the
// player's own back/head instead of the real aim direction, and mouse-look
// never actually lined up with where bullets went.
//
// DEBUG: temporarily reverted to a raw (unsmoothed) camera and added an
// on-screen readout of player.x/z and the real camera-to-player distance
// every frame -- smoothing didn't visibly help, so instead of guessing
// again we need to see the actual numbers while it happens to know whether
// it's the tracked position oscillating, the camera distance itself, or
// neither (i.e. it's the skinned mesh's own animated pose, unrelated to
// camera code at all).
function updateCamera(dt) {
  if (spectatorMode) {
    // free-floating: look exactly where the mouse points, no eye offset or
    // ground clamping -- a spectator can float anywhere to watch the fight
    const dirX = Math.sin(yaw) * Math.cos(pitch), dirY = Math.sin(pitch), dirZ = Math.cos(yaw) * Math.cos(pitch);
    camera.position.set(spectatorPos.x, spectatorPos.y, spectatorPos.z);
    camera.lookAt(spectatorPos.x + dirX * 10, spectatorPos.y + dirY * 10, spectatorPos.z + dirZ * 10);
    return;
  }

  // camera sits exactly on the aim ray behind the player's eye, so its
  // forward direction is always identical to the yaw/pitch bullets use —
  // no offset that could throw the crosshair out of alignment with shots.
  // Kept tight/over-the-shoulder on purpose: at the old 5.4 distance the
  // full body (including legs) filled the frame, which made any small hitch
  // in the run animation impossible to miss on your own character even
  // though it's a non-issue watching bots from a normal distance -- this
  // framing keeps the focus on the head/shoulders/arms/gun instead.
  const camDist = 2.4;
  const dirX = Math.sin(yaw) * Math.cos(pitch);
  const dirY = Math.sin(pitch);
  const dirZ = Math.cos(yaw) * Math.cos(pitch);

  const eyeX = player.x, eyeY = player.y + PLAYER_EYE_H, eyeZ = player.z;

  const camX = eyeX - dirX * camDist;
  const camZ = eyeZ - dirZ * camDist;
  const camY = eyeY - dirY * camDist;

  const clampedY = Math.max(camY, surfaceHeightAt(camX, camZ) + 0.6);
  camera.position.set(camX, clampedY, camZ);
  if (clampedY === camY) {
    camera.lookAt(eyeX + dirX * 10, eyeY + dirY * 10, eyeZ + dirZ * 10);
  } else {
    // camera got pushed up to avoid clipping through the ground/a structure;
    // still look toward the eye point along the same horizontal aim so the
    // crosshair stays close to correct even in this edge case
    camera.lookAt(eyeX, eyeY, eyeZ);
  }

  if (debugReadout) {
    const actualDist = Math.hypot(camera.position.x - eyeX, camera.position.y - eyeY, camera.position.z - eyeZ);
    // Hips is the rig's root bone: whatever the animation clips do to it
    // happens *on top of* player.x/y/z. Leftover horizontal root motion here
    // is the character sliding away from the camera independently of its
    // logical position -- so watch that the first two numbers stay rock
    // constant while walking, and only the third (the vertical bob) moves.
    if (player._hipsBone === undefined) {
      // GLTFLoader strips the colon out of Mixamo's "mixamorig:Hips"
      let found = null;
      player.model.group.traverse((o) => {
        if (!found && o.isBone && /hips/i.test(o.name)) found = o;
      });
      player._hipsBone = found;
    }
    const hips = player._hipsBone;
    debugReadout.textContent =
      `pos ${player.x.toFixed(3)}, ${player.y.toFixed(3)}, ${player.z.toFixed(3)}\n` +
      `camDist(target)=${camDist.toFixed(3)}  camDist(actual)=${actualDist.toFixed(3)}\n` +
      `clip=${player._lastClipName || "?"}  onGround=${player.onGround}\n` +
      `hipsLocal=${hips ? `${hips.position.x.toFixed(3)}, ${hips.position.y.toFixed(3)}, ${hips.position.z.toFixed(3)}` : "n/a"} (first two must not move)\n` +
      `keys held: [${[...keys].join(", ")}]  mouseDown=${mouseDown}`;
  }
}

// ---------- loop ----------
const clock = new THREE.Clock();

// requestAnimationFrame stops firing whenever the browser decides the page is
// not worth drawing: a hidden tab, a throttled background tab, an occluded or
// non-compositing window. Offline that is exactly right -- a paused
// single-player game is fine. In a live multiplayer match it is not: we would
// stop reporting our position and stand frozen on everyone else's screen while
// still being shootable.
//
// Note this is deliberately NOT keyed on document.hidden. A page can report
// visibilityState "visible" and still never receive a frame (verified: an
// unfocused/non-compositing window does exactly that), so the only reliable
// signal is that frames have actually stopped arriving. Hence a watchdog: if
// no frame has run recently and a match is live, simulate on a timer and skip
// the render. The timestamp guard also stops the two paths double-stepping if
// rAF resumes.
const STALL_TICK_MS = 50; // 20Hz -- enough to stay in sync, cheap when unseen
let lastStepAt = performance.now();

function step(render) {
  lastStepAt = performance.now();
  const dt = Math.min(clock.getDelta(), 0.05);
  updateAtmosphere(dt);
  if (state === "playing") {
    update(dt);
  }
  if (player) updateCamera(dt);
  if (render) renderer.render(scene, camera);
}

function loop() {
  step(true);
  requestAnimationFrame(loop);
}

setInterval(() => {
  if (!mp.active) return; // never burn CPU ticking an unseen offline match
  if (performance.now() - lastStepAt < STALL_TICK_MS * 1.5) return; // rAF is healthy
  step(false);
}, STALL_TICK_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // getDelta() has been accumulating the whole time frames were stalled; drop
  // that gap so the first frame back is not one huge dt teleport.
  clock.getDelta();
});

// Appends to the result line of the overlay that is already on screen --
// used when an async result (e.g. the server confirming a match was saved)
// lands after the overlay was shown. Uses textContent, never innerHTML: the
// text includes a handle that came from an external API.
function appendOverlaySubtitle(text) {
  const line = overlay.querySelector(".result");
  if (line) line.textContent += text;
}

function showOverlay(title, subtitle, buttonText, showDashboardBtn) {
  overlay.innerHTML = `
    <h1>${title}</h1>
    <p class="result">${subtitle}</p>
    <button id="startBtn">${buttonText}</button>
    ${showDashboardBtn ? `<button id="dashboardBtn" class="secondary-btn">BACK TO DASHBOARD</button>` : ""}
    <p class="footnote">V3 preview &mdash; 3D build, not linked from the live site yet.</p>
  `;
  overlay.classList.remove("hidden");
  hud.classList.add("hidden");
  squadStatus.classList.add("hidden");
  buildHint.classList.add("hidden");
  spectatorNote.classList.add("hidden");
  revivePrompt.classList.add("hidden");
  extraLifeBtn.classList.add("hidden");
  debugReadout.classList.add("hidden");
  lockHint && lockHint.classList.add("hidden");
  crosshair.style.display = "none";
  document.getElementById("startBtn").addEventListener("click", startGame);
  const dashBtn = document.getElementById("dashboardBtn");
  if (dashBtn) dashBtn.addEventListener("click", () => { location.href = "/arena3d/dashboard.html"; });
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

// ---------- server-driven match events ----------
// These are the only things allowed to change health, kill a fighter, or end
// the match while mp.active -- see the authority split in mp.js.

function applyNetDamage(msg) {
  const f = MP.fighterFor(msg.id);
  if (!f) return;
  f.hp = msg.hp;
  f.hitFlash = 0.35;
  if (!f.isRemote) f.hitReactionTimer = HIT_REACTION_DURATION;
}

function applyNetDeath(msg) {
  const f = MP.fighterFor(msg.id);
  if (!f || !f.alive) return;
  f.alive = false;
  f.hp = 0;
  // Local match stats still drive the end-of-match overlay text; the
  // authoritative tally comes back in the `over` message.
  if (f === player) matchStats.deaths++;
  else if (msg.by && mp.myEntityId && msg.by === clientIdOf(mp.myEntityId)) matchStats.kills++;
}

// Entity ids for humans are "p:<clientId>", which is how a `by` client id in a
// death event maps back to whether it was us who got the kill.
function clientIdOf(entityId) {
  return entityId.startsWith("p:") ? entityId.slice(2) : null;
}

// ---------- extra lives ----------
//
// The server holds the result open for a few seconds when a team is wiped and
// someone on it can still buy back in. That pause is the only moment this
// prompt makes sense, so it is driven entirely by the server's message rather
// than by our own death: dying with no lives left, or as the first casualty of
// a 5v5, must not put a buy button on screen.

// The window's full length, as the server reported it -- only used to scale
// the draining bar, so it must come from the message, not a constant here.
let reviveWindowTotalMs = 7000;

// Three states, updated every frame alongside the health bar it sits under:
// gone (no life to spend, or already spent this match), locked (holding one but
// not hurt enough yet), ready (press it). Showing it locked rather than hiding
// it is deliberate -- the player learns the button exists, and where, before
// the moment they are too busy to go looking for it.
function updateExtraLifeButton() {
  if (!MP.hasExtraLife() || !player || !player.alive) {
    extraLifeBtn.classList.add("hidden");
    return;
  }
  const ready = MP.canRefill(player.hp);
  extraLifeBtn.classList.remove("hidden");
  extraLifeBtn.classList.toggle("ready", ready);
  extraLifeBtn.classList.toggle("locked", !ready);
  extraLifeCount.textContent = `x${mp.extraLives}`;
  extraLifeBtn.title = ready
    ? "Refill to full health (R)"
    : `Available at ${mp.lowHealth} health or below`;
}

function useExtraLife() {
  if (!player) return;
  // Both routes spend the same credit under the same one-per-match rule, so
  // either being legal is enough.
  if (!MP.canRefill(player.hp) && !MP.canRevive()) return;
  extraLifeBtn.classList.add("hidden");
  hideRevivePrompt();
  MP.requestExtraLife();
}

extraLifeBtn.addEventListener("click", (e) => {
  e.preventDefault();
  useExtraLife();
});

function showRevivePrompt() {
  if (!MP.canRevive() || !player || player.alive) return;
  reviveCount.textContent = `(${mp.extraLives} left)`;
  reviveBtn.disabled = false;
  revivePrompt.classList.remove("hidden");
  // Spending a life needs a click, and a click needs a cursor.
  document.exitPointerLock && document.exitPointerLock();
}

function hideRevivePrompt() {
  revivePrompt.classList.add("hidden");
}

function requestRevive() {
  if (revivePrompt.classList.contains("hidden") || reviveBtn.disabled) return;
  reviveBtn.disabled = true;
  MP.requestExtraLife();
}

reviveBtn.addEventListener("click", requestRevive);

function applyNetReviveWindow(msg) {
  reviveWindowTotalMs = msg.ms || reviveWindowTotalMs;
  showRevivePrompt();
}

// Anyone can be revived, not just us -- a squadmate coming back has to reappear
// on our screen too, or we would keep shooting at a body the server considers
// alive.
// Covers both routes. `wasDead` is the server's word for which one it was --
// a refill only needs the health bar to jump, while a revive has a whole death
// transition to undo.
function applyNetRevived(msg) {
  const f = MP.fighterFor(msg.id);
  if (!f) return;
  f.alive = true;
  f.hp = msg.hp;
  f.hitFlash = 0;
  hideRevivePrompt();
  reviveBtn.disabled = false;
  if (f !== player) return;

  if (msg.wasDead) {
    // Back on our feet: undo everything the death transition did.
    spectatorMode = false;
    spectatorNote.classList.add("hidden");
    buildHint.classList.remove("hidden");
    crosshair.style.display = "block";
    updateLockHint();
  }
}

function applyNetShot(msg) {
  if (Number.isFinite(msg.x)) spawnMuzzleFlash(msg.x, msg.y, msg.z);
  playShootSfx(true);

  // Spawn the actual round, not just the flash. Showing only a muzzle flash
  // meant a player saw their own tracers and nothing else -- incoming fire was
  // invisible, so there was no way to tell where you were being shot from.
  const shooter = MP.fighterFor(msg.from);
  if (!shooter || !Number.isFinite(msg.dx)) return;

  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.position.set(msg.x, msg.y, msg.z);
  scene.add(mesh);
  bullets.push({
    x: msg.x, y: msg.y, z: msg.z,
    dirX: msg.dx, dirY: msg.dy, dirZ: msg.dz,
    // Visual only. Damage for this shot is the shooter's own hit claim, ruled
    // by the server -- and because `owner` is a remote fighter, the collision
    // loop will not file a second claim for it here. Both halves matter: drop
    // either and every shot would be counted twice.
    dmg: 0,
    owner: shooter,
    mesh,
    life: 2.2,
  });
}

// The server restarted (or otherwise forgot this room) while we were playing.
// Say so plainly and give the player a way out -- the alternative is standing
// in a frozen arena with no idea why nothing responds.
function applyNetMatchLost(reason) {
  if (state !== "playing") return;
  state = "over";
  hideRevivePrompt();
  document.exitPointerLock && document.exitPointerLock();
  showOverlay(
    "MATCH ENDED",
    "The game server restarted, so this match could not continue. It was not scored — "
      + "your saved stats are unaffected. Jump back into the lobby to start another.",
    "BACK TO LOBBY",
    true
  );
  console.warn("multiplayer: match lost —", reason);
}

function applyNetOver(msg) {
  if (state !== "playing") return;
  state = "over";
  hideRevivePrompt();
  document.exitPointerLock && document.exitPointerLock();
  const mine = msg.results.find((r) => r.id === clientIdOf(mp.myEntityId || ""));
  const won = mine ? mine.won : msg.winningTeam === (player.team === TEAM_BLUE ? 0 : 1);
  const scoreboard = msg.results
    .slice()
    .sort((a, b) => b.kills - a.kills)
    .map((r) => `${r.name}: ${r.kills}k / ${r.deaths}d`)
    .join("  ·  ");
  showOverlay(
    won ? "YOU WIN" : "YOU DIED",
    (won ? "Your squad cleared the arena." : "Your squad was wiped out.") + ` — ${scoreboard}`,
    "BACK TO LOBBY",
    true
  );
}

async function startGame() {
  if (!assetsReady) return;

  // Opened with ?room= -- join the live match before building the scene, so
  // resetMatch() can construct exactly the roster the server says is playing.
  // If the join fails for any reason we fall through to the normal offline
  // match rather than leaving the player staring at a dead button.
  if (MP.isMultiplayerRequested() && !mp.active) {
    startBtn.disabled = true;
    startBtn.textContent = "CONNECTING…";
    const joined = await MP.joinMatch({
      onDamage: applyNetDamage,
      onDeath: applyNetDeath,
      onOver: applyNetOver,
      onReviveWindow: applyNetReviveWindow,
      onRevived: applyNetRevived,
      onShot: applyNetShot,
      onMatchLost: applyNetMatchLost,
      onError: (message) => {
        // requestExtraLife() marks the life spent optimistically so a
        // double-click cannot ask twice. A refusal has to hand that back, or
        // the button vanishes for the rest of the match over an attempt that
        // never cost anything.
        if (mp.revivedThisMatch && /extra li|health|match/i.test(message)) {
          mp.revivedThisMatch = false;
          reviveBtn.disabled = false;
        }
        console.warn("multiplayer:", message);
      },
    });
    if (joined) await MP.waitForRoster();
    startBtn.disabled = false;
    startBtn.textContent = LAUNCHED_FROM_DASHBOARD ? "ENTER ARENA" : "DROP IN";
    if (!joined) {
      console.warn("multiplayer: could not join room, falling back to an offline match");
    }
  }

  resetMatch();
  state = "playing";
  overlay.classList.add("hidden");
  hud.classList.remove("hidden");
  squadStatus.classList.remove("hidden");
  buildHint.classList.remove("hidden");
  spectatorNote.classList.add("hidden");
  debugReadout.classList.remove("hidden");
  crosshair.style.display = "block";
  initAudio();
  // May well be refused (no live user gesture after the awaits above); the
  // canvas click handler is what actually gets us locked.
  canvas.requestPointerLock && canvas.requestPointerLock();
  updateLockHint();
}

startBtn.addEventListener("click", startGame);


requestAnimationFrame(loop);
