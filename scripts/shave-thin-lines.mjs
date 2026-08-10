import sharp from "sharp";
import fs from "fs";
import path from "path";
import { globSync } from "fs";

const MAX_LOCAL_WIDTH = 3; // a real body part is thicker than this almost everywhere along its length
const MIN_RUN_LENGTH = 55; // how tall a sliver must be before we treat it as a stray line

async function shaveFile(file) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = meta.width, h = meta.height;

  const opaque = (x, y) => data[(y * w + x) * 4 + 3] > 40;

  // local width at (x,y): consecutive opaque columns through row y, centered near x
  function localWidthAt(x, y) {
    let x1 = x;
    while (x1 > 0 && opaque(x1 - 1, y)) x1--;
    let x2 = x;
    while (x2 < w - 1 && opaque(x2 + 1, y)) x2++;
    return x2 - x1 + 1;
  }

  let erasedPixels = 0;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!opaque(x, y)) {
        y++;
        continue;
      }
      let runStart = y;
      while (y < h && opaque(x, y)) y++;
      const runLen = y - runStart;
      if (runLen >= MIN_RUN_LENGTH) {
        const midY = runStart + Math.floor(runLen / 2);
        const width = localWidthAt(x, midY);
        // also sample near the ends of the run to avoid nuking a real limb that's
        // only briefly narrow at one point
        const wStart = localWidthAt(x, runStart + Math.floor(runLen * 0.15));
        const wEnd = localWidthAt(x, runStart + Math.floor(runLen * 0.85));
        if (width <= MAX_LOCAL_WIDTH && wStart <= MAX_LOCAL_WIDTH + 1 && wEnd <= MAX_LOCAL_WIDTH + 1) {
          for (let yy = runStart; yy < runStart + runLen; yy++) {
            data[(yy * w + x) * 4 + 3] = 0;
            erasedPixels++;
          }
        }
      }
    }
  }

  if (erasedPixels === 0) {
    console.log(`  ${path.basename(file)}: clean`);
    return;
  }

  const outBuffer = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  fs.writeFileSync(file, outBuffer);
  console.log(`  ${path.basename(file)}: shaved ${erasedPixels}px of thin-line artifact`);
}

const files = globSync("assets/sprites/{player,enemy}/*.png");
for (const f of files) {
  await shaveFile(f);
}
