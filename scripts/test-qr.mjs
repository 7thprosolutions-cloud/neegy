// Tests the QR encoder in arena3d/qr.js two ways, because one of them is not
// enough and that is not hypothetical.
//
//   1. Against the published format- and version-information tables from the
//      QR standard. These constants come from outside this repo, so they catch
//      mistakes that a self-consistent encoder/decoder pair agree on. This is
//      what found the version-information generator polynomial being the
//      ten-bit format one instead of the thirteen-bit version one -- the
//      round-trip below was perfectly happy with it, because the decoder was
//      told the version rather than reading it.
//
//   2. By decoding the matrix back: read the version and format information
//      out of the symbol, unmask, walk the zigzag, de-interleave the blocks
//      and check the Reed-Solomon syndromes are zero. A tampered module is
//      included as a control, so "parity ok" cannot silently mean "parity not
//      actually checked".
//
//   node scripts/test-qr.mjs
import { encodeQR } from "../arena3d/qr.js";

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail ?? ""}`);
}

// ---------- 1. the published tables ----------

const EC_BITS = { L: 0b01, M: 0b00 };
function formatBits(ec, mask) {
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}
function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0b1111100100101 << (i - 12);
  return (version << 12) | rem;
}

const FORMAT_TABLE = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
};
const VERSION_TABLE = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3,
  11: 0x0bbf6, 12: 0x0c762, 13: 0x0d847,
};

let formatOk = true;
for (const ec of ["L", "M"]) {
  for (let m = 0; m < 8; m++) if (formatBits(ec, m) !== FORMAT_TABLE[ec][m]) formatOk = false;
}
check("format information matches the published table", formatOk, "16 combinations");

let versionOk = true;
const versionMismatches = [];
for (const [v, want] of Object.entries(VERSION_TABLE)) {
  const got = versionBits(Number(v));
  if (got !== want) { versionOk = false; versionMismatches.push(`v${v}: 0x${got.toString(16)}!=0x${want.toString(16)}`); }
}
check("version information matches the published table", versionOk, versionMismatches.join(" ") || "versions 7-13");

// ---------- 2. decoding the matrix back ----------

const EC_TABLE = {
  L: { 1:[7,1,19,0,0],2:[10,1,34,0,0],3:[15,1,55,0,0],4:[20,1,80,0,0],5:[26,1,108,0,0],
       6:[18,2,68,0,0],7:[20,2,78,0,0],8:[24,2,97,0,0],9:[30,2,116,0,0],10:[18,2,68,2,69],
       11:[20,4,81,0,0],12:[24,2,92,2,93],13:[26,4,107,0,0] },
  M: { 1:[10,1,16,0,0],2:[16,1,28,0,0],3:[26,1,44,0,0],4:[18,2,32,0,0],5:[24,2,43,0,0],
       6:[16,4,27,0,0],7:[18,4,31,0,0],8:[22,2,38,2,39],9:[22,3,36,2,37],10:[26,4,43,1,44],
       11:[30,1,50,4,51],12:[22,6,39,2,40],13:[22,8,33,1,34] },
};
const ALIGNMENT = { 1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],
  8:[6,24,42],9:[6,26,46],10:[6,28,50],11:[6,30,54],12:[6,32,58],13:[6,34,62] };

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const MASKS = [
  (r,c)=>(r+c)%2===0, (r)=>r%2===0, (r,c)=>c%3===0, (r,c)=>(r+c)%3===0,
  (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0, (r,c)=>((r*c)%2)+((r*c)%3)===0,
  (r,c)=>(((r*c)%2)+((r*c)%3))%2===0, (r,c)=>(((r+c)%2)+((r*c)%3))%2===0,
];

function functionMap(size, version) {
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
  for (const [br, bc] of [[0,0],[0,size-7],[size-7,0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br+r, bc+c);
  }
  for (const r of ALIGNMENT[version]) for (const c of ALIGNMENT[version]) {
    if ((r===6&&c===6)||(r===6&&c===size-7)||(r===size-7&&c===6)) continue;
    for (let dr=-2; dr<=2; dr++) for (let dc=-2; dc<=2; dc++) mark(r+dr, c+dc);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size-1-i); mark(size-1-i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(size-11+j, i); mark(i, size-11+j); }
  }
  return res;
}

function readFormat(m) {
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= m[8][i] << i;
  bits |= m[8][7] << 6;
  bits |= m[8][8] << 7;
  bits |= m[7][8] << 8;
  for (let i = 9; i <= 14; i++) bits |= m[14 - i][8] << i;
  const data = (bits ^ 0b101010000010010) >> 10;
  return { ec: (data >> 3) & 0b11, mask: data & 0b111 };
}

// Read out of the symbol, not taken from the encoder -- that distinction is
// the whole reason the version bug survived the first version of this test.
function readVersion(m, size) {
  let bits = 0;
  for (let i = 0; i < 18; i++) bits |= m[size - 11 + (i % 3)][Math.floor(i / 3)] << i;
  return { raw: bits, version: bits >> 12 };
}

function readCodewords(m, size, reserved) {
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) if (!reserved[row][col]) bits.push(m[row][col]);
    }
    upward = !upward;
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
}

function syndromesZero(block, ecCount) {
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (const b of block) s = gfMul(s, EXP[i]) ^ b;
    if (s !== 0) return false;
  }
  return true;
}

function decodeQR({ size, modules, version }) {
  const reserved = functionMap(size, version);
  const fmt = readFormat(modules);
  const ecName = fmt.ec === 0b01 ? "L" : "M";
  const unmasked = modules.map((row, r) =>
    row.map((v, c) => (reserved[r][c] ? v : v ^ (MASKS[fmt.mask](r, c) ? 1 : 0))));
  const stream = readCodewords(unmasked, size, reserved);

  const [ecPerBlock, g1, g1d, g2, g2d] = EC_TABLE[ecName][version];
  const sizes = [...Array(g1).fill(g1d), ...Array(g2).fill(g2d)];
  const blocks = sizes.map(() => []);
  let idx = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < blocks.length; b++) if (i < sizes[b]) blocks[b].push(stream[idx++]);
  }
  const ecBlocks = blocks.map(() => []);
  for (let i = 0; i < ecPerBlock; i++) for (let b = 0; b < blocks.length; b++) ecBlocks[b].push(stream[idx++]);
  const parityOk = blocks.every((b, i) => syndromesZero([...b, ...ecBlocks[i]], ecPerBlock));

  const data = blocks.flat();
  let bitPos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  const mode = take(4);
  const length = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(take(8));
  return { ec: ecName, mask: fmt.mask, parityOk, mode, text: new TextDecoder().decode(Uint8Array.from(bytes)) };
}

const samples = [
  "solana:6ocgsbQ463HtiYhT2M5Bp15XbsNA2H2Qh4TYhSgFFmfe?amount=0.1&reference=TPsUVXmTCr8C7xH9P8ndZdNFbxn2tzUv5YqLeYSEL3r&label=Neegy%20Arena&message=Private%20server%20pass%20(24h)",
  "A",
  "https://neegy.life/arena3d/dashboard.html",
  "x".repeat(100),
  "x".repeat(200),
  "unicode: éèê — ¥ ✓",
];

for (const text of samples) {
  for (const ec of ["L", "M"]) {
    const enc = encodeQR(text, { ec });
    const dec = decodeQR(enc);
    const label = `${JSON.stringify(text.slice(0, 24))}${text.length > 24 ? "..." : ""} ${ec}`;
    const detail = `v${enc.version}-${enc.ec} mask${enc.mask} ${enc.size}x${enc.size}`;
    check(`round-trips ${label}`,
      dec.text === text && dec.parityOk && dec.mode === 0b0100 && dec.ec === enc.ec && dec.mask === enc.mask,
      detail + (dec.text === text ? "" : ` TEXT MISMATCH`) + (dec.parityOk ? "" : " PARITY BAD"));

    // Versions 7 and up carry their version in the symbol; read it back.
    if (enc.version >= 7) {
      const v = readVersion(enc.modules, enc.size);
      check(`  version block reads back as v${enc.version}`,
        v.version === enc.version && v.raw === VERSION_TABLE[enc.version],
        `raw=0x${v.raw.toString(16)} want=0x${(VERSION_TABLE[enc.version] || 0).toString(16)}`);
    }
  }
}

// Control: if flipping a module does not break parity, the parity check above
// is not actually checking anything.
const enc = encodeQR(samples[0], { ec: "M" });
const tampered = { ...enc, modules: enc.modules.map((r) => r.slice()) };
tampered.modules[enc.size - 3][enc.size - 3] ^= 1;
check("control: a flipped module breaks parity", decodeQR(tampered).parityOk === false, "parity detects damage");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
