// Builds the unsigned Solana transaction message for a payment.
//
// This exists so that a browser wallet (Phantom and anything else exposing the
// same provider API) can pay an invoice with one click instead of the player
// scanning a QR with their phone. The browser asks for this message, hands it
// to the wallet, and the wallet signs and submits it.
//
// The server builds it rather than the page, for two reasons. It keeps the one
// piece of fiddly binary encoding in a single tested place instead of a second
// copy in the browser that could drift; and the amount, the recipient and the
// reference are then fixed by the server rather than assembled from values a
// page could be persuaded to change.
//
// Nothing here signs anything. The output is an UNSIGNED message: the only key
// that can turn it into a transaction is the player's own, inside their wallet.
//
// Legacy message layout:
//   header          numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
//   accountKeys     compact-array of 32-byte public keys
//   recentBlockhash 32 bytes
//   instructions    compact-array of { programIdIndex, accountIndexes, data }
//
// Account keys are ordered writable-signers, readonly-signers,
// writable-non-signers, readonly-non-signers, and the header counts describe
// exactly that split. Get it wrong and the validator rejects the transaction
// while sanitizing it, with an error that says nothing about which part.
import { encodeBase58, decodeBase58, isValidSolanaAddress } from "./base58.mjs";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function shortVec(n) {
  const out = [];
  let v = n;
  for (;;) {
    if (v < 0x80) { out.push(v); break; }
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return Buffer.from(out);
}

const compactArray = (items) => Buffer.concat([shortVec(items.length), ...items]);

export function buildTransferMessage({ payer, recipient, reference, lamports, blockhash }) {
  for (const [name, value] of Object.entries({ payer, recipient, reference })) {
    if (!isValidSolanaAddress(value)) throw new Error(`${name} is not a valid Solana address`);
  }
  if (!Number.isInteger(lamports) || lamports <= 0) throw new Error("lamports must be a positive integer");

  const keys = [payer, recipient, reference, SYSTEM_PROGRAM].map(decodeBase58);
  const header = Buffer.from([
    1, // one required signature: the payer
    0, // no readonly signers
    2, // readonly non-signers: the reference and the system program
  ]);

  // SystemProgram::Transfer is instruction 2, followed by the amount as u64 LE.
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);

  // from, to, and the reference. The reference is carried as a read-only
  // non-signer purely so getSignaturesForAddress() can find this transaction
  // afterwards -- it is never read from or written to.
  const accountIndexes = Buffer.from([0, 1, 2]);
  const instruction = Buffer.concat([
    Buffer.from([3]),                               // programIdIndex -> system program
    shortVec(accountIndexes.length), accountIndexes,
    shortVec(data.length), data,
  ]);

  return Buffer.concat([
    header,
    compactArray(keys),
    decodeBase58(blockhash),
    compactArray([instruction]),
  ]);
}

// Wallets that take a serialized message want it base58-encoded.
export function buildTransferMessageBase58(args) {
  return encodeBase58(buildTransferMessage(args));
}

export { shortVec, compactArray };
