import sharp from "sharp";
import fs from "fs";

const WHITE_LUMA = 246;
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function stripRuleLines(ink, width, height) {
  function horizontalInkWidthAt(x, y) {
    let x1 = x;
    while (x1 > 0 && ink[y * width + x1 - 1] === 1) x1--;
    let x2 = x;
    while (x2 < width - 1 && ink[y * width + x2 + 1] === 1) x2++;
    return x2 - x1 + 1;
  }
  function verticalInkHeightAt(x, y) {
    let y1 = y;
    while (y1 > 0 && ink[(y1 - 1) * width + x] === 1) y1--;
    let y2 = y;
    while (y2 < height - 1 && ink[(y2 + 1) * width + x] === 1) y2++;
    return y2 - y1 + 1;
  }
  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const v = x < width ? ink[y * width + x] : 0;
      if (v === 1) {
        if (runStart === -1) runStart = x;
      } else if (runStart !== -1) {
        const runLen = x - runStart;
        if (runLen / width > 0.3) {
          const mid = runStart + Math.floor(runLen / 2);
          if (verticalInkHeightAt(mid, y) <= 5) {
            for (let xx = runStart; xx < x; xx++) ink[y * width + xx] = 0;
          }
        }
        runStart = -1;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let runStart = -1;
    for (let y = 0; y <= height; y++) {
      const v = y < height ? ink[y * width + x] : 0;
      if (v === 1) {
        if (runStart === -1) runStart = y;
      } else if (runStart !== -1) {
        const runLen = y - runStart;
        if (runLen > 150) {
          const mid = runStart + Math.floor(runLen / 2);
          if (horizontalInkWidthAt(x, mid) <= 5) {
            for (let yy = runStart; yy < y; yy++) ink[yy * width + x] = 0;
          }
        }
        runStart = -1;
      }
    }
  }
}

async function extractClean(file, rx1, ry1, rx2, ry2, outFile) {
  const regW = rx2 - rx1;
  const regH = ry2 - ry1;
  const { data } = await sharp(file)
    .ensureAlpha()
    .extract({ left: rx1, top: ry1, width: regW, height: regH })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ink = new Uint8Array(regW * regH);
  for (let i = 0; i < regW * regH; i++) {
    const o = i * 4;
    ink[i] = luma(data[o], data[o + 1], data[o + 2]) < WHITE_LUMA ? 1 : 0;
  }
  stripRuleLines(ink, regW, regH);

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
  console.log(`wrote ${outFile} (${w}x${h}, area=${best.area})`);
}

const s1 = JSON.parse(fs.readFileSync("assets/sprites/s1_manifest.json").toString());

const row0 = s1.filter((f) => f.y < 700).sort((a, b) => a.x - b.x);
const row1 = s1.filter((f) => f.y >= 700 && f.y < 1400).sort((a, b) => a.x - b.x);

(async () => {
  for (let i = 0; i < row0.length; i++) {
    const f = row0[i];
    await extractClean("Sprite/Sprite 1.png", f.x - 2, 292, f.x + f.w + 2, f.y + f.h + 4, `assets/sprites/player/walk${i + 1}.png`);
  }
  for (let i = 0; i < row1.length; i++) {
    const f = row1[i];
    await extractClean("Sprite/Sprite 1.png", f.x - 2, 887, f.x + f.w + 2, f.y + f.h + 4, `assets/sprites/player/walk${i + 5}.png`);
  }
})();
