// Base58 (Bitcoin/Solana alphabet), written out rather than pulled in.
//
// The server has no runtime dependencies on purpose -- package-lock.json is
// gitignored and the deploy installs nothing -- so an address codec that is
// forty lines of arithmetic is not worth breaking that for.
//
// Base58 is plain base conversion over a 58-glyph alphabet that omits 0, O, I
// and l so an address cannot be misread. The only subtlety is leading zero
// BYTES: base conversion drops them (they contribute nothing to the number),
// so they are re-attached explicitly as '1's, one per zero byte. A Solana
// address whose key happens to start with a zero byte round-trips wrongly
// without that, which is a bug you would only meet in production.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function encodeBase58(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length === 0) return "";

  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);

  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function decodeBase58(str) {
  const s = String(str);
  if (s.length === 0) return Buffer.alloc(0);

  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`invalid base58 character: ${c}`);
    n = n * BASE + v;
  }

  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// A Solana address is a 32-byte ed25519 public key. Anything that does not
// decode to exactly 32 bytes is a typo, not an address -- and a typo'd
// treasury address means money sent somewhere nobody can spend it from, so
// this is checked at startup rather than at the first payment.
export function isValidSolanaAddress(address) {
  try {
    return decodeBase58(address).length === 32;
  } catch {
    return false;
  }
}
