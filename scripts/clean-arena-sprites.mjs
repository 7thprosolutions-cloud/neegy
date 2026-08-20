import sharp from "sharp";
import fs from "fs";
import path from "path";
import { globSync } from "fs";

async function cleanFile(file) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = meta.width, h = meta.height;

  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = data[i * 4 + 3] > 40 ? 1 : 0;

  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let start = 0; start < w * h; start++) {
    if (fg[start] !== 1 || labels[start] !== -1) continue;
    const compId = comps.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = compId;
    let area = 0;
    const pixels = [];
    while (sp > 0) {
      const idx = stack[--sp];
      area++;
      pixels.push(idx);
      const x = idx % w, y = (idx / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nidx = ny * w + nx;
          if (fg[nidx] === 1 && labels[nidx] === -1) {
            labels[nidx] = compId;
            stack[sp++] = nidx;
          }
        }
      }
    }
    comps.push({ area, pixels });
  }

  if (comps.length <= 1) {
    console.log(`  ${path.basename(file)}: single blob, nothing to erase`);
    return;
  }

  comps.sort((a, b) => b.area - a.area);
  const mainArea = comps[0].area;
  let erased = 0;
  const out = Buffer.from(data);
  for (let c = 1; c < comps.length; c++) {
    if (comps[c].area < mainArea * 0.5) {
      for (const idx of comps[c].pixels) out[idx * 4 + 3] = 0;
      erased += comps[c].area;
    }
  }

  if (erased === 0) {
    console.log(`  ${path.basename(file)}: ${comps.length} blobs, none small enough to erase`);
    return;
  }

  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer().then((buf) => fs.writeFileSync(file, buf));
  console.log(`  ${path.basename(file)}: erased ${comps.length - 1} stray blob(s), ${erased}px total`);
}

const files = globSync("assets/sprites/arena/*.png");
for (const f of files) {
  await cleanFile(f);
}
