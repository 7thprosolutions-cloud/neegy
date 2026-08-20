// Shrinks shooter_character.glb by recompressing its oversized texture.
//
// Why this exists: the exported model was 18.8MB, and 15.8MB of that was a
// single 4096x4096 PNG. The geometry is only ~34k vertices. A file that large
// is not just slow to download -- browsers silently refuse to keep a single
// cache entry that big, so correct `immutable` cache headers did not help and
// it was refetched on every page load (i.e. every match).
//
// The texture has no alpha channel, so plain JPEG works: it is core glTF, needs
// no extension, and three.js loads it natively. 2048px is still well beyond
// what this character resolves to on screen.
//
// Usage:  node scripts/compress-character-texture.mjs [--size 2048] [--quality 92]
// Writes <input>.orig.glb as a backup the first time it runs.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const GLB = path.resolve("arena3d/assets/shooter_character.glb");
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const SIZE = argVal("size", 2048);
const QUALITY = argVal("quality", 92);

const ALIGN = 4; // glTF requires 4-byte alignment for bufferViews and chunks
const pad = (n) => (n + ALIGN - 1) & ~(ALIGN - 1);

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB file");
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const binStart = 20 + jsonLen + 8;
  return { json, bin: buf.subarray(binStart, binStart + binLen) };
}

function buildGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Buffer.alloc(pad(jsonBuf.length), 0x20); // spaces
  jsonBuf.copy(jsonPadded);
  const binPadded = Buffer.alloc(pad(bin.length), 0);
  bin.copy(binPadded);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;   // "glTF"
  out.writeUInt32LE(2, o); o += 4;            // version
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonPadded.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;   // "JSON"
  jsonPadded.copy(out, o); o += jsonPadded.length;
  out.writeUInt32LE(binPadded.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;   // "BIN"
  binPadded.copy(out, o);
  return out;
}

const original = fs.readFileSync(GLB);
const backup = GLB.replace(/\.glb$/, ".orig.glb");
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, original);
  console.log("backed up original ->", path.basename(backup));
}

const { json, bin } = parseGlb(original);

// Find the image that actually costs something; leave small ones alone.
const images = json.images || [];
let targetIndex = -1;
let biggest = 0;
images.forEach((im, i) => {
  if (im.bufferView === undefined) return;
  const len = json.bufferViews[im.bufferView].byteLength;
  if (len > biggest) { biggest = len; targetIndex = i; }
});
if (targetIndex === -1) throw new Error("no embedded image found to compress");

const targetImage = images[targetIndex];
const targetView = targetImage.bufferView;
const srcStart = json.bufferViews[targetView].byteOffset || 0;
const srcBytes = bin.subarray(srcStart, srcStart + json.bufferViews[targetView].byteLength);

const meta = await sharp(srcBytes).metadata();
if (meta.hasAlpha) {
  throw new Error("texture has an alpha channel -- JPEG would discard it; use WebP + EXT_texture_webp instead");
}

const jpeg = await sharp(srcBytes)
  .resize(SIZE, SIZE, { kernel: "lanczos3" })
  .jpeg({ quality: QUALITY, mozjpeg: true })
  .toBuffer();

// Rebuild the binary chunk: every bufferView is re-emitted in its original
// order with fresh offsets, because replacing one view shifts everything after
// it. Accessor byteOffsets are relative to their view, so they need no change.
const order = json.bufferViews
  .map((bv, i) => ({ i, offset: bv.byteOffset || 0 }))
  .sort((a, b) => a.offset - b.offset);

const chunks = [];
let cursor = 0;
for (const { i } of order) {
  const bv = json.bufferViews[i];
  const bytes = i === targetView
    ? jpeg
    : bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const start = pad(cursor);
  if (start > cursor) chunks.push(Buffer.alloc(start - cursor, 0));
  chunks.push(bytes);
  bv.byteOffset = start;
  bv.byteLength = bytes.length;
  cursor = start + bytes.length;
}

const newBin = Buffer.concat(chunks);
json.buffers[0].byteLength = newBin.length;
targetImage.mimeType = "image/jpeg";
if (targetImage.name) targetImage.name += `_${SIZE}q${QUALITY}`;

const out = buildGlb(json, newBin);
fs.writeFileSync(GLB, out);

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`texture: ${meta.width}x${meta.height} png ${mb(srcBytes.length)}  ->  ${SIZE}x${SIZE} jpeg q${QUALITY} ${mb(jpeg.length)}`);
console.log(`file:    ${mb(original.length)}  ->  ${mb(out.length)}   (${(original.length / out.length).toFixed(1)}x smaller)`);
