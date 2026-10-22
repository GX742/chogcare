import { Transaction } from "ethers";
import { encodeFunctionData, erc20Abi, isAddress, zeroAddress } from "viem";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { chogBeneficiary, supportsNft } from "../src/chog-beneficiary.ts";

const MAX_RECORDS = 10_000;
const MAX_GRANT_UNITS = 1_000_000_000_000;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const address = value => typeof value === "string" && isAddress(value) && !same(value, zeroAddress);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);

// Projection only: no RPC, migrations, signer, reservation changes or funding
// credit. The outbox marks delivered + the reservation paid in one transaction
// only AFTER verifyPoolPayout has proved an exact, canonical finalized receipt.
// This reads those durable conclusions; it does not claim to re-query the chain.
export function readNftPoolImpact(db, treasury, chainId = 10) {
  try {
    if (![1, 10].includes(chainId) || !address(treasury)) return null;
    const network = deliveryNetwork(chainId);
    const binding = db.prepare("SELECT chain_id FROM pool_network WHERE singleton=1").get();
    const meta = db.prepare("SELECT treasury,chain_id FROM nft_pool_meta WHERE singleton=1").get();
    if (binding?.chain_id !== chainId || meta?.chain_id !== chainId || !same(meta.treasury, treasury)) return null;

    // Full joins expose a missing or torn final record instead of silently
    // returning a smaller total. Pending/funding-only records are not selected.
    // All amount/provenance fields are read in the same SQLite statement snapshot.
    const rows = db.prepare(`SELECT
      o.invoice_id AS outbox_id,o.treasury,o.nonce,o.recipient,o.signed_tx,o.tx_hash,o.state AS outbox_state,
      r.invoice_id AS reservation_id,r.units,r.state AS reservation_state,r.payout_hash,
      i.id AS invoice_id,i.state AS invoice_state,i.document
      FROM pool_outbox o FULL OUTER JOIN pool_reservations r ON r.invoice_id=o.invoice_id
      FULL OUTER JOIN nft_invoices i ON i.id=COALESCE(o.invoice_id,r.invoice_id)
      WHERE o.state='delivered' OR r.state='paid' OR i.state='delivered'
      LIMIT ${MAX_RECORDS + 1}`).iterate();
    const invoices = new Set(), transactions = new Set();
    let donated = 0n, donations = 0;
    for (const row of rows) {
      if (donations >= MAX_RECORDS || typeof row.invoice_id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(row.invoice_id) ||
          row.outbox_id !== row.invoice_id || row.reservation_id !== row.invoice_id ||
          row.outbox_state !== "delivered" || row.reservation_state !== "paid" ||
          !["paying", "confirming", "delivered", "manual-review"].includes(row.invoice_state) ||
          !Number.isSafeInteger(row.units) || row.units <= 0 || row.units > MAX_GRANT_UNITS ||
          !Number.isSafeInteger(row.nonce) || row.nonce < 0 || !same(row.treasury, treasury) || !address(row.recipient) ||
          !hash(row.tx_hash) || !same(row.payout_hash, row.tx_hash) ||
          typeof row.signed_tx !== "string" || !/^0x[0-9a-f]+$/i.test(row.signed_tx) || row.signed_tx.length > 2048) return null;

      const document = JSON.parse(row.document);
      if (document?.id !== row.invoice_id || document.state !== row.invoice_state || !same(document.destinationHash, row.tx_hash)) return null;
      const initiativeId = document.initiativeId ?? "burundi";
      if (!supportsNft(initiativeId) || !same(row.recipient, chogBeneficiary(initiativeId, chainId))) return null;
      if (document.subsidyUnits != null && String(document.subsidyUnits) !== String(row.units)) return null;
      const tx = Transaction.from(row.signed_tx);
      const expected = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [row.recipient, BigInt(row.units)] });
      if (!tx.isSigned() || tx.chainId !== BigInt(chainId) || !same(tx.hash, row.tx_hash) ||
          !same(tx.from, treasury) || tx.nonce !== row.nonce || !same(tx.to, network.usdc) ||
          tx.value !== 0n || !same(tx.data, expected)) return null;
      const normalizedHash = row.tx_hash.toLowerCase();
      if (invoices.has(row.invoice_id) || transactions.has(normalizedHash)) return null;
      invoices.add(row.invoice_id); transactions.add(normalizedHash);
      // Historical signed/reserved units win. Never multiply today's grant by
      // a claim count, use the MON verification amount, or convert to CHOG.
      donated += BigInt(row.units); donations++;
    }
    return { donatedUsdc: String(donated), donations };
  } catch {
    // Unknown or inconsistent data is unavailable, never a fabricated zero.
    // Do not attach rows, identifiers, addresses or signed bytes to an error.
    return null;
  }
}
