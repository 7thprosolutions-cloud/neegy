// Pays one of the server's own invoices with DEVNET SOL, to prove the payment
// path end to end without a wallet and without real money.
//
// DEVNET ONLY, and it refuses to run against anything else. Devnet SOL is
// valueless test currency handed out by a faucet; this script generates a
// throwaway keypair, asks the faucet for some, and sends it to the treasury.
// It holds no real key and can move no real funds.
//
//   node scripts/devnet-pay.mjs <baseUrl> <sessionCookie> <product>
//
// It does what a wallet would do: reads the invoice, builds a SystemProgram
// transfer that carries the invoice's `reference` as a read-only account,
// signs it, submits it, then watches the server notice and credit the account.
//
// The transaction is assembled by hand because the server has no dependencies
// and neither should its test tooling. Legacy message layout:
//
//   signatures      compact-array of 64-byte signatures
//   header          numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
//   accountKeys     compact-array of 32-byte public keys
//   recentBlockhash 32 bytes
//   instructions    compact-array of { programIdIndex, accountIndexes, data }
//
// Account keys are ordered writable-signers, readonly-signers,
// writable-non-signers, readonly-non-signers, and the header counts describe
// that ordering -- get it wrong and the runtime rejects the transaction with a
// signature-verification error that tells you nothing about why.
import crypto from "node:crypto";
import { encodeBase58, decodeBase58 } from "../server/base58.mjs";

const [baseUrl, cookie, product = "extraLives"] = process.argv.slice(2);
if (!baseUrl || !cookie) {
  console.error("usage: node scripts/devnet-pay.mjs <baseUrl> <sessionCookie> [product]");
  process.exit(2);
}

const RPC = "https://api.devnet.solana.com";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const LAMPORTS_PER_SOL = 1_000_000_000;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ed25519, via node's own crypto ----------

// A Solana address is the raw 32-byte ed25519 public key. Node hands them out
// wrapped in DER (SPKI / PKCS8), so the raw bytes are the last 32 of the SPKI
// and the last 32 of the PKCS8 seed section.
function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { publicKey: spki.subarray(spki.length - 32), privateKey };
}

// ---------- shortvec (compact-u16) ----------

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

function compactArray(items) {
  return Buffer.concat([shortVec(items.length), ...items]);
}

// ---------- the transfer ----------

function buildTransferMessage({ payer, treasury, reference, lamports, blockhash }) {
  // Order matters and is not arbitrary; see the header note at the top.
  const keys = [payer, treasury, reference, decodeBase58(SYSTEM_PROGRAM)];
  const header = Buffer.from([
    1, // one required signature: the payer
    0, // no readonly signers
    2, // readonly non-signers: the reference and the system program
  ]);

  // SystemProgram::Transfer is instruction 2, then the amount as u64 LE.
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);

  // from, to, and the reference. The reference is carried here, as a
  // read-only non-signer, purely so that getSignaturesForAddress() can find
  // this transaction later -- it is never read from or written to.
  const accountIndexes = Buffer.from([0, 1, 2]);
  const instruction = Buffer.concat([
    Buffer.from([3]),                              // programIdIndex -> system program
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

// Everything the funded path does, minus the money. `sigVerify: true` makes
// the validator check the signature before it does anything else, so the
// errors are diagnostic:
//
//   AccountNotFound   the transaction is well formed and correctly signed, and
//                     the runtime got all the way to looking up the payer --
//                     who has no balance, because the faucet is dry. This is
//                     the pass condition.
//   SignatureFailure  the signature or the serialized message is wrong.
//   sanitize errors   the header counts or account ordering are wrong.
async function simulateOnly(inv, payer) {
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
  const message = buildTransferMessage({
    payer: payer.publicKey,
    treasury: decodeBase58(inv.recipient),
    reference: decodeBase58(inv.reference),
    lamports: inv.lamports,
    blockhash,
  });
  const signature = crypto.sign(null, message, payer.privateKey);
  const tx = Buffer.concat([compactArray([signature]), message]);
  const sim = await rpc("simulateTransaction", [
    tx.toString("base64"),
    { encoding: "base64", sigVerify: true, commitment: "confirmed" },
  ]);
  const err = sim?.value?.err;
  if (err === "AccountNotFound") {
    console.log("  VALID: devnet accepted the transaction's signature and structure.");
    console.log("  It stopped only at the payer having no balance, which is the faucet's fault.");
    console.log("");
    console.log("  Proven:     the invoice, the reference, and the transaction we build.");
    console.log("  Not proven: a funded transfer actually landing and being credited.");
    console.log("              To close that, pay the printed link from a devnet wallet:");
    console.log(`              ${inv.url}`);
    return;
  }
  throw new Error(`devnet rejected the transaction: ${JSON.stringify(err)} -- this is a real bug in the builder, not the faucet`);
}

async function main() {
  console.log(`paying ${product} at ${baseUrl}`);

  // 1. Ask the server for an invoice, exactly as the browser does.
  const startRes = await fetch(`${baseUrl}/api/pay/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `neegy_sid=${cookie}` },
    body: JSON.stringify({ product }),
  });
  const startBody = await startRes.json();
  if (!startRes.ok) throw new Error(`pay/start: ${startBody.error}`);
  const inv = startBody.invoice;
  console.log(`  invoice   ${inv.reference.slice(0, 12)}...  ${inv.amountSol} SOL -> ${inv.recipient.slice(0, 8)}...`);
  console.log(`  cluster   ${inv.cluster}`);
  if (inv.cluster !== "devnet") {
    throw new Error(`REFUSING TO RUN: server is on "${inv.cluster}", not devnet. This script is for test money only.`);
  }

  // 2. A throwaway wallet, funded from the devnet faucet.
  const payer = newKeypair();
  const payerAddress = encodeBase58(payer.publicKey);
  console.log(`  payer     ${payerAddress.slice(0, 12)}... (throwaway, devnet)`);

  const airdrop = Math.max(LAMPORTS_PER_SOL, inv.lamports * 3);
  let airdropSig;
  try {
    airdropSig = await rpc("requestAirdrop", [payerAddress, airdrop]);
  } catch (err) {
    // The public devnet faucet is exhausted per-IP most days. That blocks the
    // funded transfer but not the interesting question, which is whether the
    // transaction we build is one the chain would accept -- so fall back to
    // asking it exactly that, and say plainly what is and is not proven.
    console.log(`\n  faucet unavailable: ${err.message}`);
    console.log("  falling back to simulateTransaction, which needs no funds\n");
    await simulateOnly(inv, payer);
    return null;
  }
  console.log(`  airdrop   ${airdropSig.slice(0, 12)}... waiting for funds`);
  for (let i = 0; i < 45; i++) {
    await wait(1000);
    const bal = await rpc("getBalance", [payerAddress, { commitment: "confirmed" }]);
    if (bal?.value >= inv.lamports) { console.log(`  funded    ${bal.value / LAMPORTS_PER_SOL} SOL`); break; }
    if (i === 44) throw new Error("airdrop never landed");
  }

  // 3. Build, sign and send the transfer.
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
  const message = buildTransferMessage({
    payer: payer.publicKey,
    treasury: decodeBase58(inv.recipient),
    reference: decodeBase58(inv.reference),
    lamports: inv.lamports,
    blockhash,
  });
  const signature = crypto.sign(null, message, payer.privateKey);
  const tx = Buffer.concat([compactArray([signature]), message]);

  const sig = await rpc("sendTransaction", [
    tx.toString("base64"),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  console.log(`  sent      ${sig.slice(0, 20)}...`);

  // 4. Watch the server notice. This is the part under test: everything above
  //    is just standing in for a wallet.
  console.log("  waiting for the server to see it (finalized, so this takes a moment)...");
  for (let i = 0; i < 90; i++) {
    await wait(2000);
    const res = await fetch(`${baseUrl}/api/pay/status?reference=${inv.reference}`, {
      headers: { Cookie: `neegy_sid=${cookie}` },
    });
    const body = await res.json();
    if (body.status === "paid") {
      console.log(`\n  PAID after ~${(i + 1) * 2}s`);
      console.log(`  signature ${body.signature}`);
      console.log(`  balances  ${JSON.stringify({
        extraLives: body.player.extraLives,
        privateActive: body.player.privateActive,
        privateHoursLeft: +(body.player.privateMsLeft / 3600000).toFixed(2),
      })}`);
      return sig;
    }
    if (body.status === "expired") throw new Error("the invoice expired before the payment was seen");
    if (i % 5 === 4) console.log(`    still ${body.status}...`);
  }
  throw new Error("server never credited the payment");
}

main().then(
  (sig) => {
    // These are not the same result and must never print the same line: one
    // means money moved and was credited, the other means only that the
    // transaction would have been accepted had the faucet had anything to give.
    console.log(sig
      ? "\nOK - devnet payment sent and credited"
      : "\nOK - transaction validated, but NOT paid (faucet dry, nothing was credited)");
    process.exit(0);
  },
  (err) => { console.error("\nFAILED:", err.message); process.exit(1); }
);
