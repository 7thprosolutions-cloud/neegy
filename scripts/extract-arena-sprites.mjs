import sharp from "sharp";
import fs from "fs";
import path from "path";

const OUT_DIR = path.resolve("assets/sprites/arena_raw");
fs.mkdirSync(OUT_DIR, { recursive: true });

const WHITE_LUMA = 246;
const MIN_AREA = 6000;
const PAD = 6;

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function loadRaw(file) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: meta.width, height: meta.height };
}

function findComponents(data, width, height) {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    ink[i] = luma(data[o], data[o + 1], data[o + 2]) < WHITE_LUMA ? 1 : 0;
  }

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
        if (runLen / width > 0.5) {
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
        if (runLen > 250) {
          const mid = runStart + Math.floor(runLen / 2);
          if (horizontalInkWidthAt(x, mid) <= 5) {
            for (let yy = runStart; yy < y; yy++) ink[yy * width + x] = 0;
          }
        }
        runStart = -1;
      }
    }
  }

  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < width * height; start++) {
    if (ink[start] !== 1 || labels[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = components.length;
    let minX = width, maxX = 0, minY = height, maxY = 0, area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nidx = ny * width + nx;
          if (ink[nidx] === 1 && labels[nidx] === -1) {
            labels[nidx] = components.length;
            stack[sp++] = nidx;
          }
        }
      }
    }
    components.push({ minX, maxX, minY, maxY, area });
  }
  return components.filter((c) => c.area >= MIN_AREA);
}

function clusterRows(components) {
  const sorted = [...components].sort((a, b) => (a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2);
  const rows = [];
  const rowThreshold = 80;
  for (const c of sorted) {
    const cy = (c.minY + c.maxY) / 2;
    let row = rows.find((r) => Math.abs(r.cy - cy) < rowThreshold);
    if (!row) {
      row = { cy, items: [] };
      rows.push(row);
    }
    row.items.push(c);
    row.cy = row.items.reduce((s, i) => s + (i.minY + i.maxY) / 2, 0) / row.items.length;
  }
  rows.sort((a, b) => a.cy - b.cy);
  rows.forEach((r) => r.items.sort((a, b) => a.minX - b.minX));
  return rows;
}

async function processSheet(file, prefix) {
  const { data, width, height } = await loadRaw(file);
  const components = findComponents(data, width, height);
  const rows = clusterRows(components);

  console.log(`\n=== ${file} (${width}x${height}) — ${components.length} blobs in ${rows.length} rows ===`);

  let counter = 0;
  const manifest = [];

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].items.length; c++) {
      const blob = rows[r].items[c];
      const x1 = Math.max(0, blob.minX - PAD);
      const y1 = Math.max(0, blob.minY - PAD);
      const x2 = Math.min(width, blob.maxX + PAD);
      const y2 = Math.min(height, blob.maxY + PAD);
      const w = x2 - x1;
      const h = y2 - y1;
      counter++;
      const name = `${prefix}_r${r}_c${c}`;
      const outFile = path.join(OUT_DIR, `${name}.png`);

      const { data: cropData } = await sharp(file)
        .ensureAlpha()
        .extract({ left: x1, top: y1, width: w, height: h })
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
      manifest.push({ name, row: r, col: c, x: x1, y: y1, w, h, area: blob.area });
      console.log(`  row ${r} col ${c}: ${name}.png  (${w}x${h}, area=${blob.area})`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, `${prefix}_manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

const files = [
  ["Sprite/Sprite 4.png", "s4"],
  ["Sprite/Sprite 5.png", "s5"],
];

for (const [file, prefix] of files) {
  await processSheet(file, prefix);
}
