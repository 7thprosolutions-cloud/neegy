import sharp from "sharp";
import fs from "fs";
import path from "path";

const SPR = path.resolve("assets/sprites");
const PLAYER_DIR = path.join(SPR, "player");
const ENEMY_DIR = path.join(SPR, "enemy");
fs.mkdirSync(PLAYER_DIR, { recursive: true });
fs.mkdirSync(ENEMY_DIR, { recursive: true });

const s1 = JSON.parse(fs.readFileSync(path.join(SPR, "s1_manifest.json")));

// ---- player walk cycle: two rows of 4 near y~280-900, sort by (y band, x) ----
const walkRow0 = s1.filter((f) => f.y < 700).sort((a, b) => a.x - b.x); // WALK1-4
const walkRow1 = s1.filter((f) => f.y >= 700 && f.y < 1400).sort((a, b) => a.x - b.x); // WALK5-8
const walkFrames = [...walkRow0, ...walkRow1];
walkFrames.forEach((f, i) => {
  fs.copyFileSync(path.join(SPR, `${f.name}.png`), path.join(PLAYER_DIR, `walk${i + 1}.png`));
});

// ---- player jump cycle: 6 frames y>=1400, sort purely by x ----
const jumpFrames = s1.filter((f) => f.y >= 1400).sort((a, b) => a.x - b.x);
jumpFrames.forEach((f, i) => {
  fs.copyFileSync(path.join(SPR, `${f.name}.png`), path.join(PLAYER_DIR, `jump${i + 1}.png`));
});

console.log("player walk frames:", walkFrames.map((f) => f.name));
console.log("player jump frames:", jumpFrames.map((f) => f.name));

// ---- enemy (bear) walk A: already-isolated WALK1 blob ----
const s3 = JSON.parse(fs.readFileSync(path.join(SPR, "s3_manifest.json")));
const walk1 = s3.find((f) => f.name === "s3_r0_c0");
fs.copyFileSync(path.join(SPR, `${walk1.name}.png`), path.join(ENEMY_DIR, "walk_a.png"));

// ---- enemy walk B: manual slice of the merged WALK2-8 blob (index 3 = WALK5) ----
const mergedRow = s3.find((f) => f.name === "s3_r0_c1"); // x303..1759, y417..785
const sliceCount = 7; // WALK2..WALK8
const sliceIndex = 3; // WALK5 (opposite-foot contact, good pairing with WALK1)
const sliceW = mergedRow.w / sliceCount;
const rawX1 = Math.round(mergedRow.x + sliceIndex * sliceW);
const rawX2 = Math.round(mergedRow.x + (sliceIndex + 1) * sliceW);
const rawY1 = Math.max(0, mergedRow.y - 10);
const rawY2 = mergedRow.y + mergedRow.h + 10;

const WHITE_LUMA = 246;
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function extractTightFromRegion(file, rx1, ry1, rx2, ry2, outFile) {
  const regW = rx2 - rx1;
  const regH = ry2 - ry1;
  const { data } = await sharp(file)
    .ensureAlpha()
    .extract({ left: rx1, top: ry1, width: regW, height: regH })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // find the largest non-white connected blob within this region
  const ink = new Uint8Array(regW * regH);
  for (let i = 0; i < regW * regH; i++) {
    const o = i * 4;
    ink[i] = luma(data[o], data[o + 1], data[o + 2]) < WHITE_LUMA ? 1 : 0;
  }
  const labels = new Int32Array(regW * regH).fill(-1);
  const stack = new Int32Array(regW * regH);
  let best = null;
  for (let start = 0; start < regW * regH; start++) {
    if (ink[start] !== 1 || labels[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = 1;
    let minX = regW, maxX = 0, minY = regH, maxY = 0, area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % regW;
      const y = (idx / regW) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= regW || ny < 0 || ny >= regH) continue;
          const nidx = ny * regW + nx;
          if (ink[nidx] === 1 && labels[nidx] === -1) {
            labels[nidx] = 1;
            stack[sp++] = nidx;
          }
        }
      }
    }
    if (!best || area > best.area) best = { minX, maxX, minY, maxY, area };
  }

  const PAD = 6;
  const cx1 = Math.max(0, best.minX - PAD);
  const cy1 = Math.max(0, best.minY - PAD);
  const cx2 = Math.min(regW, best.maxX + PAD);
  const cy2 = Math.min(regH, best.maxY + PAD);
  const w = cx2 - cx1;
  const h = cy2 - cy1;

  const { data: cropData } = await sharp(file)
    .ensureAlpha()
    .extract({ left: rx1 + cx1, top: ry1 + cy1, width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.from(cropData);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const l = luma(out[o], out[o + 1], out[o + 2]);
    let alpha = 255;
    if (l >= 250) alpha = 0;
    else if (l > 232) alpha = Math.round(255 * (1 - (l - 232) / (250 - 232)));
    out[o + 3] = alpha;
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outFile);
  console.log(`wrote ${outFile} (${w}x${h}, blob area=${best.area})`);
}

await extractTightFromRegion(
  "Sprite/Sprite 3.png",
  rawX1,
  rawY1,
  rawX2,
  rawY2,
  path.join(ENEMY_DIR, "walk_b.png")
);
