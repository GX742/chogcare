import { Interface, Transaction, getAddress } from "ethers";
import { ETHEREUM_USDC, GIVETH_PROJECT_RECIPIENT } from "../src/route.ts";
import { atomic } from "./sqlite-transaction.mjs";
import { createPoolLedger } from "./pool-ledger.mjs";
import { verifyPoolPayout } from "./chain-receipts.mjs";
import { createNftProofLedger } from "./nft-proof-ledger.mjs";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { nftGrantScope } from "./nft-repeat-policy.mjs";
import { chogBeneficiary, supportsNft } from "../src/chog-beneficiary.ts";

const transferAbi = new Interface(["function transfer(address to,uint256 amount) returns(bool)"]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// INTERNAL PRIMITIVE, no public endpoint and no private-key access. A future
// isolated signer must be fed only verified invoice jobs. No bridge calldata here.
export function createPayoutOutbox(db, treasury, chainId = 1) {
  const network = deliveryNetwork(chainId);
  treasury = getAddress(treasury);
  if (/^0x0{40}$/i.test(treasury) || same(treasury, GIVETH_PROJECT_RECIPIENT) || same(treasury, ETHEREUM_USDC)) throw new Error("Invalid treasury.");
  const ledger = createPoolLedger(db, chainId);
  createNftProofLedger(db);
  db.exec(`CREATE TABLE IF NOT EXISTS pool_outbox (
    invoice_id TEXT PRIMARY KEY REFERENCES pool_reservations(invoice_id),
    treasury TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    signed_tx TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('persisted','submitted','unknown','delivered')),
    UNIQUE(treasury, nonce)
  );`);
  const load = invoiceId => {
    const row = db.prepare("SELECT * FROM pool_outbox WHERE invoice_id=?").get(invoiceId);
    if (!row || !same(row.treasury, treasury)) throw new Error("No persisted payout for this treasury.");
    return row;
  };
  return {
    persistSignedGrant(invoiceId, initiativeId, serialized, now = Date.now()) {
      // Fail closed for all other initiatives until their recipients are approved.
      if (!supportsNft(initiativeId)) throw new Error("Recipient not approved for settlement.");
      const recipient = chogBeneficiary(initiativeId,chainId);
      if (typeof serialized !== "string" || !/^0x[0-9a-f]+$/i.test(serialized) || serialized.length > 2048) throw new Error("Invalid signed payout.");
      let tx;
      try { tx = Transaction.from(serialized); } catch { throw new Error("Invalid signed payout."); }
      if (!tx.isSigned() || tx.type !== 2 || tx.chainId !== BigInt(chainId) || !same(tx.from, treasury) || !same(tx.to, network.usdc) ||
          tx.value !== 0n || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || tx.accessList?.length ||
          tx.gasLimit < 21_000n || tx.gasLimit > 150_000n || tx.maxFeePerGas <= 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas ||
          tx.gasLimit * tx.maxFeePerGas > 1_000_000_000_000_000n) throw new Error("Payout violates chain, sender, asset or gas policy.");
      // Exact canonical data: no approve(), extra calls, hidden trailing payload,
      // foreign recipient or bridge/provider-specific bytes are accepted.
      const expectedData = transferAbi.encodeFunctionData("transfer", [recipient, 500_000n]);
      if (tx.data.toLowerCase() !== expectedData.toLowerCase()) throw new Error("Payout must send exactly 0.50 USDC to the approved beneficiary.");
      return atomic(db, () => {
        // Bind the signing job to the invoice, not just to any approved recipient.
        // Older single-beneficiary databases/tests have no nft_invoices table.
        const hasInvoices=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nft_invoices'").get();
        const invoice=hasInvoices?db.prepare("SELECT document FROM nft_invoices WHERE id=?").get(invoiceId):null;
        if (hasInvoices && (!invoice || (JSON.parse(invoice.document).initiativeId??"burundi")!==initiativeId)) throw new Error("Payout initiative does not match invoice.");
        if (!hasInvoices && initiativeId!=="burundi") throw new Error("Matching invoice required for this initiative.");
        const old = db.prepare("SELECT * FROM pool_outbox WHERE invoice_id=?").get(invoiceId);
        if (old) {
          if (!same(old.treasury, treasury) || old.tx_hash !== tx.hash) throw new Error("Existing payout cannot be replaced. Reconcile its original hash.");
          return old.tx_hash;
        }
        const eligible = db.prepare(`SELECT r.invoice_id,r.claim_scope,p.document FROM pool_reservations r JOIN nft_proofs p ON p.invoice_id=r.invoice_id
          WHERE r.invoice_id=? AND p.chain_id=143 AND p.collection=r.collection AND p.token_id=r.token_id AND p.campaign=r.claim_scope || ':' || r.day`).get(invoiceId);
        if (!eligible) throw new Error("Matching verified NFT proof and daily reservation required.");
        if(eligible.claim_scope!=="daily"&&eligible.claim_scope!==nftGrantScope(JSON.parse(eligible.document).sender,invoiceId))throw new Error("Repeat grant requires proof from the allowlisted holder.");
        ledger.recordSubmission(invoiceId, tx.hash, now);
        db.prepare("INSERT INTO pool_outbox VALUES (?, ?, ?, ?, ?, ?, 'persisted')").run(invoiceId, treasury.toLowerCase(), tx.nonce, recipient.toLowerCase(), serialized, tx.hash);
        return tx.hash;
      });
    },
    async broadcast(client, invoiceId, checkpoint=()=>{}) {
      const row = load(invoiceId);
      if (row.state === "delivered") return row.tx_hash;
      if (await client.getChainId() !== chainId) throw new Error("Wrong payout network.");
      checkpoint(); // No asynchronous gap between the final guard and broadcast.
      try {
        const result = await client.sendRawTransaction({ serializedTransaction: row.signed_tx });
        if (!same(result, row.tx_hash)) throw new Error("RPC hash mismatch.");
        db.prepare("UPDATE pool_outbox SET state='submitted' WHERE invoice_id=? AND state!='delivered'").run(invoiceId);
        return row.tx_hash;
      } catch {
        db.prepare("UPDATE pool_outbox SET state='unknown' WHERE invoice_id=? AND state!='delivered'").run(invoiceId);
        // A timeout is not failure. Rebroadcast is permitted ONLY for these exact
        // signed bytes, hence the same nonce/hash, never a fresh payment.
        throw new Error("Payout result unknown. Reconcile the persisted transaction hash; do not create another payout.");
      }
    },
    async confirm(client, invoiceId, logIndex) {
      const row = load(invoiceId);
      await verifyPoolPayout(client, { treasury, recipient: row.recipient, txHash: row.tx_hash, chainId }, row.tx_hash, logIndex);
      atomic(db, () => {
        ledger.markPaid(invoiceId, row.tx_hash);
        db.prepare("UPDATE pool_outbox SET state='delivered' WHERE invoice_id=?").run(invoiceId);
      });
      return row.tx_hash;
    },
    status(invoiceId) {
      const row = load(invoiceId);
      // Never return signed bytes or internal filesystem details to the UI.
      return { invoiceId, hash: row.tx_hash, state: row.state };
    },
  };
}
