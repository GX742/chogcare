import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { optimism } from "viem/chains";
import { NFT_POOL_FUNDER } from "../server/nft-pool-config.mjs";
import { verifyApprovedNftFunding } from "../server/nft-pool-funding.mjs";
import { createPoolLedger } from "../server/pool-ledger.mjs";
import { acquireOperatorLease } from "../server/operator-lease.mjs";
import { openPaymentIntegrity } from "../server/payment-integrity.mjs";
import { createServer } from "node:net";

// Explicit local operator command: finalized native-USDC receipt only. No keys,
// signing, transfers, cursor rewinds, or HTTP administrative endpoints.
const [txHash, index, funder, ...extra] = process.argv.slice(2);
if (!/^0x[\da-f]{64}$/i.test(txHash ?? "") || !/^\d+$/.test(index ?? "") || !funder || extra.length) {
  throw new Error("Usage: node scripts/reconcile-nft-funding.mjs <txHash> <logIndex> <approvedFunder>");
}
const filename = fileURLToPath(new URL("../work/payments/processor.sqlite", import.meta.url));
if (!existsSync(filename)) throw new Error("Existing processor database required.");
const lease=await acquireOperatorLease();
let probe;
try {
probe=createServer();
await new Promise((ok,bad)=>{probe.once("error",bad);probe.listen(4174,"127.0.0.1",ok);});
const integrity=openPaymentIntegrity(filename,fileURLToPath(new URL("../work/payments/integrity/checkpoint.json",import.meta.url)),[fileURLToPath(new URL("../work/payments/preview.sqlite",import.meta.url))]);
const read = new DatabaseSync(filename, { readOnly: true });
let meta;
try { meta = read.prepare("SELECT treasury,funder,chain_id FROM nft_pool_meta WHERE singleton=1").get(); }
finally { read.close(); }
if (!meta || meta.chain_id !== 10 || meta.funder.toLowerCase() !== NFT_POOL_FUNDER.toLowerCase()) {
  throw new Error("Unexpected NFT pool database binding.");
}
const client = createPublicClient({ chain: optimism, transport: http("https://mainnet.optimism.io", { timeout: 15000, retryCount: 0 }) });
const verified = await verifyApprovedNftFunding(client, meta.treasury, funder, txHash, Number(index));
const db = new DatabaseSync(filename);
try {
  const current = db.prepare("SELECT treasury,funder,chain_id FROM nft_pool_meta WHERE singleton=1").get();
  if (JSON.stringify(current) !== JSON.stringify(meta)) throw new Error("Pool binding changed during verification.");
  const ledger = createPoolLedger(db, 10);
  ledger.creditVerifiedFunding(verified); // Unique chain:hash:logIndex prevents double credit.
  integrity.checkpoint();
  console.log(JSON.stringify({ event: `${verified.chainId}:${verified.txHash}:${verified.logIndex}`, verifiedUsdc: verified.units / 1e6, treasury: meta.treasury, ...ledger.summary() }, null, 2));
  console.log("Finalized funding reconciled. No funds moved; safe to repeat without double credit.");
} finally { db.close(); }
} finally {if(probe?.listening)await new Promise(ok=>probe.close(ok));await lease.close();}
