// Tests the payment verifier against the ways it could be cheated, without
// needing the chain.
//
// The devnet script (scripts/devnet-pay.mjs) proves the happy path against a
// real ledger, but it can only prove the happy path -- you cannot ask a public
// faucet for a transaction that pays the wrong person, and the faucet is
// frequently rate limited anyway. The interesting cases are all failures, so
// they are driven here by standing a fake RPC in front of the verifier and
// handing it transactions that are wrong in one specific way each.
//
//   node scripts/test-payments.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TREASURY = "6ocgsbQ463HtiYhT2M5Bp15XbsNA2H2Qh4TYhSgFFmfe";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PRICE_LAMPORTS = 100_000_000; // 0.1 SOL

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(50)} ${detail ?? ""}`);
}

// A stand-in Solana RPC. Each test sets `scenario` to whatever the chain
// should appear to say for the next lookup.
let scenario = { signatures: [], transactions: {} };
const rpcServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(raw);
    let result = null;
    if (method === "getSignaturesForAddress") result = scenario.signatures;
    if (method === "getTransaction") result = scenario.transactions[params[0]] ?? null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});
await new Promise((r) => rpcServer.listen(0, "127.0.0.1", r));
const rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;

// A scratch data dir, so this never touches anyone's real records.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neegy-pay-"));
fs.writeFileSync(path.join(dataDir, "players.json"), JSON.stringify({
  "x:1": {
    id: "x:1", xUserId: "1", handle: "buyer", name: "Buyer", avatar: null,
    kills: 0, deaths: 0, xp: 0, gamesPlayed: 0,
    extraLives: 0, privateUntil: 0, createdAt: Date.now(), lastSeen: Date.now(),
  },
}));
process.env.DATA_DIR = dataDir;
process.env.SOLANA_RPC_URL = rpcUrl;
process.env.SOLANA_CLUSTER = "devnet";
process.env.TREASURY_ADDRESS = TREASURY;

const { configurePayments, startPayment, checkPayment } = await import("../server/payments.mjs");
const store = await import("../server/store.mjs");
configurePayments(process.env);

// Builds the shape getTransaction returns. `credited` is what the treasury's
// balance actually moved by, which is the only thing the verifier trusts.
function tx({ to = TREASURY, credited = PRICE_LAMPORTS, err = null } = {}) {
  return {
    meta: {
      err,
      preBalances: [5_000_000_000, 1_000_000],
      postBalances: [5_000_000_000 - credited, 1_000_000 + credited],
    },
    transaction: { message: { accountKeys: [{ pubkey: OTHER }, { pubkey: to }] } },
  };
}

async function invoice(product = "extraLives") {
  return startPayment("x:1", product);
}

// ---------- the honest case ----------

let inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigGOOD", err: null }], transactions: { sigGOOD: tx() } };
let rec = await checkPayment(inv.reference);
check("exact payment is credited", rec.status === "paid", `status=${rec.status}`);
check("ten lives granted", store.getPlayer("x:1").extraLives === 10, `extraLives=${store.getPlayer("x:1").extraLives}`);

// ---------- the ways it could be cheated ----------

inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigSHORT", err: null }], transactions: { sigSHORT: tx({ credited: PRICE_LAMPORTS - 1 }) } };
rec = await checkPayment(inv.reference);
check("underpayment by one lamport is refused", rec.status === "pending", `status=${rec.status}`);

inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigWRONG", err: null }], transactions: { sigWRONG: tx({ to: OTHER }) } };
rec = await checkPayment(inv.reference);
check("payment to another address is refused", rec.status === "pending", `status=${rec.status}`);

inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigFAILED", err: null }], transactions: { sigFAILED: tx({ err: { InstructionError: [0, "Custom"] } }) } };
rec = await checkPayment(inv.reference);
check("failed transaction is refused", rec.status === "pending", `status=${rec.status}`);

inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigERR", err: { some: "error" } }], transactions: {} };
rec = await checkPayment(inv.reference);
check("signature flagged failed is skipped", rec.status === "pending", `status=${rec.status}`);

const livesBeforeOverpay = store.getPlayer("x:1").extraLives;
inv = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigOVER", err: null }], transactions: { sigOVER: tx({ credited: PRICE_LAMPORTS * 2 }) } };
rec = await checkPayment(inv.reference);
check("overpayment is accepted", rec.status === "paid", `status=${rec.status}`);
check("overpayment still grants exactly one lot", store.getPlayer("x:1").extraLives === livesBeforeOverpay + 10,
  `extraLives=${store.getPlayer("x:1").extraLives}`);

// ---------- paying twice ----------

const livesBeforeReplay = store.getPlayer("x:1").extraLives;
// The same invoice checked again must not pay out again, however many sweeps
// and status polls race each other.
await Promise.all([checkPayment(inv.reference), checkPayment(inv.reference), checkPayment(inv.reference)]);
check("re-checking a paid invoice grants nothing", store.getPlayer("x:1").extraLives === livesBeforeReplay,
  `extraLives=${store.getPlayer("x:1").extraLives}`);

// A second invoice pointed at a signature that already paid for a different
// one -- the replay a determined person would actually try.
const replay = await invoice("extraLives");
scenario = { signatures: [{ signature: "sigOVER", err: null }], transactions: { sigOVER: tx({ credited: PRICE_LAMPORTS * 2 }) } };
rec = await checkPayment(replay.reference);
check("a spent signature cannot pay a second invoice", rec.status === "pending", `status=${rec.status}`);
check("the replay granted nothing", store.getPlayer("x:1").extraLives === livesBeforeReplay,
  `extraLives=${store.getPlayer("x:1").extraLives}`);

// ---------- the 24-hour pass ----------

check("no pass before buying one", store.privateAccess("x:1").active === false, "inactive");
inv = await invoice("privateServer");
scenario = { signatures: [{ signature: "sigPASS", err: null }], transactions: { sigPASS: tx() } };
rec = await checkPayment(inv.reference);
const pass = store.privateAccess("x:1");
check("pass is active after paying", pass.active === true, `msLeft=${Math.round(pass.msLeft / 3600000)}h`);
check("pass lasts 24 hours", Math.abs(pass.msLeft - 24 * 3600000) < 60000, `${(pass.msLeft / 3600000).toFixed(2)}h`);

// Buying again while one is live extends rather than restarts.
const untilBefore = store.privateAccess("x:1").until;
inv = await invoice("privateServer");
scenario = { signatures: [{ signature: "sigPASS2", err: null }], transactions: { sigPASS2: tx() } };
await checkPayment(inv.reference);
const extended = store.privateAccess("x:1");
check("buying again extends, not restarts", Math.abs(extended.until - (untilBefore + 24 * 3600000)) < 60000,
  `${(extended.msLeft / 3600000).toFixed(1)}h left`);

// ---------- a flaky RPC must not read as a failed payment ----------

inv = await invoice("extraLives");
const brokenPort = rpcServer.address().port;
rpcServer.close();
rec = await checkPayment(inv.reference);
check("unreachable RPC leaves the invoice pending", rec.status === "pending", `status=${rec.status} (port ${brokenPort} closed)`);

fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
