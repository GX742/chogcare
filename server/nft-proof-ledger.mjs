import { isAddress, zeroAddress } from "viem";
import { PAYMENT_POLICY } from "./policy.mjs";
import { nftGrantScope } from "./nft-repeat-policy.mjs";

export function createNftProofLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS nft_proofs (
    invoice_id TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    collection TEXT NOT NULL,
    token_id TEXT NOT NULL,
    campaign TEXT NOT NULL,
    document TEXT NOT NULL,
    UNIQUE(chain_id, tx_hash),
    UNIQUE(chain_id, collection, token_id, campaign)
  );`);
  return {
    // Only internal callers may use the output of verifyNftDeposit here. A typed
    // object is NOT itself a cryptographic proof; never expose this as HTTP input.
    recordVerifiedProof(proof, now = Date.now(), reservationScope) {
      if (proof?.kind !== "confirmed-nft-transfer" || !Number.isSafeInteger(now) || now < 0 ||
          proof.chainId !== 143 || proof.collection?.toLowerCase() !== PAYMENT_POLICY.nftCollection ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(proof.invoiceId) || !/^0x[0-9a-fA-F]{64}$/.test(proof.txHash) ||
          !isAddress(proof.sender) || proof.sender.toLowerCase() === zeroAddress ||
          typeof proof.tokenId !== "string" || !/^\d{1,78}$/.test(proof.tokenId) || BigInt(proof.tokenId) >= 2n ** 256n ||
          !/^\d{1,78}$/.test(proof.blockNumber) || !/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash)) throw new Error("A confirmed Monad NFT proof is required.");
      const allowedScope=nftGrantScope(proof.sender,proof.invoiceId);
      // A new proof is daily by default for every owner. Only the trusted
      // persisted reservation may explicitly resume a legacy repeat scope.
      const scope=reservationScope??"daily";
      if(scope!=="daily"&&scope!==allowedScope)throw new Error("NFT proof is not eligible for repeat grants.");
      const campaign = `${scope}:${new Date(now).toISOString().slice(0, 10)}`;
      db.prepare("INSERT INTO nft_proofs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        proof.invoiceId, proof.chainId, proof.txHash.toLowerCase(), proof.collection.toLowerCase(),
        String(BigInt(proof.tokenId)), campaign, JSON.stringify(proof),
      );
    },
  };
}
