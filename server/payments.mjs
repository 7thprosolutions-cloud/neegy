// Solana payments, read-only and dependency-free.
//
// The shape of this is deliberate and worth stating, because it is what makes
// it safe to run with no KYC, no merchant account and no custody:
//
//   we NEVER hold, move, or sign for funds. The player's wallet sends SOL
//   straight to the treasury address, wallet to wallet. This server only
//   WATCHES the chain and, when it sees the transfer land, ticks a number up
//   in players.json. There is no private key here, and nothing here worth
//   stealing.
//
// Correlating a payment with a player is the only real problem, and Solana Pay
// already solves it: every invoice gets a fresh random `reference` public key,
// which the wallet includes in the transaction as a read-only account. Nobody
// spends from it and it holds nothing -- it exists so that
// getSignaturesForAddress(reference) finds precisely the transaction that paid
// this invoice, without us ever needing to know the payer's address up front.
import crypto from "node:crypto";
import { encodeBase58, isValidSolanaAddress } from "./base58.mjs";
import { buildTransferMessageBase58 } from "./solana-tx.mjs";
import {
  createPayment, getPayment, pendingPayments, markPaid, expireStalePayments,
  grantEntitlement, ENTITLEMENTS, signatureAlreadyUsed,
} from "./store.mjs";

export const LAMPORTS_PER_SOL = 1_000_000_000;

const CLUSTER_RPC = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

let config = {
  cluster: "devnet",
  rpcUrl: CLUSTER_RPC.devnet,
  treasury: null,
  enabled: false,
};

export function configurePayments(env) {
  // Devnet unless someone deliberately says otherwise. Defaulting to mainnet
  // would mean a misconfigured deploy quietly asking real people for real
  // money, so the safe value is the one you get by doing nothing.
  const cluster = String(env.SOLANA_CLUSTER || "devnet").trim();
  const treasury = String(env.TREASURY_ADDRESS || "").trim();
  const rpcUrl = String(env.SOLANA_RPC_URL || CLUSTER_RPC[cluster] || "").trim();

  if (!CLUSTER_RPC[cluster] && !env.SOLANA_RPC_URL) {
    console.error(`[pay] unknown SOLANA_CLUSTER "${cluster}" -- payments disabled`);
    config = { ...config, enabled: false };
    return config;
  }
  if (!treasury) {
    console.log("  payments:      TREASURY_ADDRESS not set -- disabled (Upgrades stays locked)");
    config = { ...config, cluster, rpcUrl, enabled: false };
    return config;
  }
  // A mistyped treasury address is unrecoverable: the money goes to a key
  // nobody holds. Refuse to start selling rather than find out afterwards.
  if (!isValidSolanaAddress(treasury)) {
    console.error("[pay] TREASURY_ADDRESS is not a valid Solana address -- payments disabled");
    config = { ...config, cluster, rpcUrl, enabled: false };
    return config;
  }

  config = { cluster, rpcUrl, treasury, enabled: true };
  console.log(`  payments:      ${cluster} -> ${treasury.slice(0, 6)}...${treasury.slice(-4)}`);
  if (cluster !== "mainnet-beta") {
    console.log(`  payments:      TEST MONEY ONLY (${cluster}); set SOLANA_CLUSTER=mainnet-beta to go live`);
  }
  return config;
}

export function paymentConfig() {
  return { ...config };
}

export function productCatalog() {
  return Object.entries(ENTITLEMENTS).map(([key, spec]) => ({
    key,
    label: spec.label,
    priceSol: spec.priceSol,
    type: spec.type,
    perPurchase: spec.perPurchase || null,
    windowHours: spec.windowMs ? Math.round(spec.windowMs / 3600000) : null,
  }));
}

async function rpc(method, params) {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

// ---------- creating an invoice ----------

export function startPayment(playerId, product) {
  if (!config.enabled) throw new Error("Payments are not switched on for this server.");
  const spec = ENTITLEMENTS[product];
  if (!spec) throw new Error("Unknown product.");

  // 32 random bytes. A reference does not need to be a key anyone can sign
  // for: it is only ever an address to look up, never an account that is read
  // from or spent. So generating one costs nothing and needs no ed25519.
  const reference = encodeBase58(crypto.randomBytes(32));
  const lamports = Math.round(spec.priceSol * LAMPORTS_PER_SOL);
  const record = createPayment({
    reference, playerId, product, lamports, cluster: config.cluster,
  });

  // Solana Pay transfer request. Wallets read this straight off a QR or a tap.
  const url = `solana:${config.treasury}`
    + `?amount=${spec.priceSol}`
    + `&reference=${reference}`
    + `&label=${encodeURIComponent("Neegy Arena")}`
    + `&message=${encodeURIComponent(spec.label)}`;

  return {
    reference, url,
    amountSol: spec.priceSol,
    lamports,
    recipient: config.treasury,
    cluster: config.cluster,
    product,
    label: spec.label,
    expiresAt: record.expiresAt,
  };
}

// ---------- watching for it to land ----------

// Everything that has to be true before a transaction counts as payment for
// this invoice. Each check is here because skipping it is a way to be robbed:
// a failed transaction still appears on chain; a transaction can carry our
// reference while paying somebody else entirely; and the amount is chosen by
// the payer, not by us.
function transferredToTreasury(tx, lamports) {
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex((k) => (typeof k === "string" ? k : k.pubkey) === config.treasury);
  if (index === -1) return null;

  const pre = tx.meta?.preBalances?.[index];
  const post = tx.meta?.postBalances?.[index];
  if (typeof pre !== "number" || typeof post !== "number") return null;

  // The balance delta, not the instruction. Reading a parsed instruction would
  // miss a transfer routed through a program, and would be fooled by one that
  // looks like a transfer but is undone later in the same transaction. What
  // actually arrived is what the ledger says arrived.
  const delta = post - pre;
  return delta >= lamports ? delta : null;
}

// Checks one invoice against the chain. Returns the updated record. Safe to
// call as often as you like: the credit happens inside markPaid(), which fires
// only once per reference and only once per signature.
export async function checkPayment(reference) {
  const record = getPayment(reference);
  if (!record) return null;
  if (record.status !== "pending") return record;
  if (!config.enabled) return record;

  let signatures;
  try {
    // `finalized`, not `confirmed`: this is money, and a confirmed block can
    // still be dropped. Waiting the extra moment is the right trade.
    signatures = await rpc("getSignaturesForAddress", [
      record.reference, { limit: 10, commitment: "finalized" },
    ]);
  } catch (err) {
    // A flaky public RPC must not look like a failed payment. Stay pending and
    // let the next sweep ask again.
    console.warn(`[pay] lookup failed for ${reference.slice(0, 8)}...:`, err.message);
    return record;
  }
  if (!Array.isArray(signatures) || signatures.length === 0) return record;

  for (const { signature, err } of signatures) {
    if (err) continue;
    if (signatureAlreadyUsed(signature)) continue;
    let tx;
    try {
      tx = await rpc("getTransaction", [
        signature,
        { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
      ]);
    } catch (err2) {
      console.warn(`[pay] tx fetch failed ${signature.slice(0, 8)}...:`, err2.message);
      continue;
    }
    const received = transferredToTreasury(tx, record.lamports);
    if (received === null) continue;

    const paid = markPaid(record.reference, signature);
    if (!paid) return getPayment(reference); // a concurrent sweep got there first

    const spec = ENTITLEMENTS[record.product];
    grantEntitlement(record.playerId, record.product, spec?.type === "window" ? 1 : spec.perPurchase);
    console.log(`[pay] credited ${record.product} to ${record.playerId} (${signature.slice(0, 12)}..., ${received} lamports)`);
    return getPayment(reference);
  }
  return record;
}

// Builds the message a browser wallet will sign for this invoice. The payer's
// address comes from the wallet after it connects; everything else -- who is
// paid, how much, and which reference ties it back to this invoice -- is fixed
// here, so a page cannot be talked into paying a different amount or a
// different address than the invoice it is showing.
export async function buildWalletTransaction(reference, payerAddress) {
  const record = getPayment(reference);
  if (!record) throw new Error("no such payment");
  if (record.status !== "pending") throw new Error("that payment is already settled");
  if (!config.enabled) throw new Error("payments are not switched on");

  // A blockhash goes stale in about a minute, so it is fetched per attempt
  // rather than cached with the invoice.
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
  return {
    message: buildTransferMessageBase58({
      payer: payerAddress,
      recipient: config.treasury,
      reference: record.reference,
      lamports: record.lamports,
      blockhash,
    }),
    blockhash,
    lamports: record.lamports,
    recipient: config.treasury,
  };
}

// The browser polling /api/pay/status covers the normal case. This covers the
// one that actually loses money: the player pays and then closes the tab, or
// a deploy restarts the server while their wallet is still confirming.
// Without it their SOL is gone and their account never changes.
export function startPaymentSweep() {
  if (!config.enabled) return null;
  // The ENTIRE body is guarded, not just the network call. An async
  // setInterval callback that throws produces an unhandled rejection, and
  // Node kills the process for one of those -- so a single bad response from
  // a public RPC endpoint would take the whole game down, restart, and do it
  // again twenty seconds later. A background task that checks for payments
  // must never be able to stop people playing.
  const timer = setInterval(async () => {
    try {
      expireStalePayments();
      // Public RPC endpoints rate limit, and a backlog here is never urgent --
      // a few at a time is plenty.
      for (const record of pendingPayments().slice(0, 5)) {
        try {
          await checkPayment(record.reference);
        } catch (err) {
          console.warn("[pay] sweep error:", err.message);
        }
      }
    } catch (err) {
      console.warn("[pay] sweep failed:", err.message);
    }
  }, 20000);
  timer.unref?.();
  return timer;
}
