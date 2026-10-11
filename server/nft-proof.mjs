import { isAddress, parseAbi, parseEther, zeroAddress } from "viem";
import { PAYMENT_POLICY } from "./policy.mjs";
import { AwaitingFinalityError } from "./chain-receipts.mjs";
import { verifyInternalNftTransfer } from "./nft-transfer-trace.mjs";

const nftAbi = parseAbi(["function ownerOf(uint256) view returns (address)"]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// Validation failures are never treated as RPC outages. Transport failures retain
// their original typed cause, allowing the worker to retry only a narrow allowlist.
export class InvalidNftProofError extends Error {
  constructor(message) { super(message); this.name = "InvalidNftProofError"; }
}

export function isRetryableNftProofError(error) {
  const seen = new Set();
  let retryable = false;
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause) && seen.size < 12; cause = cause.cause) {
    seen.add(cause);
    if (cause instanceof InvalidNftProofError || ["InvalidNftProofError", "ContractFunctionRevertedError", "ExecutionRevertedError"].includes(cause.name)) return false;
    if (cause instanceof AwaitingFinalityError || ["AwaitingFinalityError", "TimeoutError", "TransactionNotFoundError", "TransactionReceiptNotFoundError", "BlockNotFoundError", "ResourceUnavailableRpcError", "LimitExceededRpcError"].includes(cause.name)) retryable = true;
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(cause.code)) retryable = true;
    if (cause.name === "HttpRequestError" && (cause.status === undefined || [408, 429, 500, 502, 503, 504].includes(cause.status))) retryable = true;
  }
  return retryable;
}

// Read-only verification for the worker. Invoices come from trusted storage.
// Internal native transfers additionally require a successful canonical call trace.
export async function verifyNftDeposit(client, invoice, txHash) {
  if (invoice.kind !== "nft-verification" || invoice.state !== "awaiting-payment") throw new InvalidNftProofError("No payable verification invoice.");
  if (typeof invoice.id !== "string" || !invoice.id) throw new InvalidNftProofError("Missing invoice ID.");
  if (![invoice.depositAddress, invoice.holderAddress].every(a => isAddress(a) && !same(a, zeroAddress))) throw new InvalidNftProofError("Invalid invoice address.");
  if (same(invoice.depositAddress, invoice.holderAddress)) throw new InvalidNftProofError("The verification address must be independent of the holder.");
  if (!/^\d{1,78}$/.test(invoice.tokenId) || BigInt(invoice.tokenId) >= 2n ** 256n) throw new InvalidNftProofError("Invalid NFT token ID.");
  if (typeof invoice.createdBlock !== "bigint" || invoice.createdBlock < 0n || !Number.isSafeInteger(invoice.expiresAt) || invoice.expiresAt <= 0) throw new InvalidNftProofError("Invalid invoice window.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new InvalidNftProofError("Invalid transaction hash.");
  if (await client.getChainId() !== PAYMENT_POLICY.chainId) throw new InvalidNftProofError("RPC is not on Monad.");
  const [tx, receipt, finalized] = await Promise.all([
    client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash }), client.getBlock({ blockTag: "finalized" }),
  ]);
  if (typeof finalized.number !== "bigint" || typeof receipt.blockNumber !== "bigint" || finalized.number < 0n || receipt.blockNumber < 0n) throw new InvalidNftProofError("RPC did not provide a finalized block.");
  if (receipt.status !== "success" || !same(receipt.transactionHash, txHash) || !same(tx.hash, txHash)) throw new InvalidNftProofError("Successful transaction not found.");
  if (tx.blockNumber === null || receipt.blockNumber <= invoice.createdBlock) throw new InvalidNftProofError("Payment is outside the confirmed invoice window.");
  if (tx.blockNumber !== receipt.blockNumber || !same(tx.blockHash, receipt.blockHash)) throw new InvalidNftProofError("Inconsistent transaction receipt.");
  if (!same(receipt.from, tx.from) || !same(receipt.to, tx.to)) throw new InvalidNftProofError("Transaction and receipt identities differ.");
  const direct=same(tx.from,invoice.holderAddress)&&same(tx.to,invoice.depositAddress);
  if (direct && (tx.value !== parseEther("1") || tx.input !== "0x")) throw new InvalidNftProofError("Expected a direct transfer of exactly 1 MON.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash) || typeof block.timestamp !== "bigint" || block.timestamp < 0n) throw new InvalidNftProofError("Transaction was reorganized out of the canonical chain.");
  if (block.timestamp * 1000n > BigInt(invoice.expiresAt)) throw new InvalidNftProofError("Payment arrived after invoice expiry. Manual review required.");
  if (receipt.blockNumber > finalized.number) throw new AwaitingFinalityError();
  if(!direct)await verifyInternalNftTransfer(client,tx,invoice.holderAddress,invoice.depositAddress);
  const args = { address: PAYMENT_POLICY.nftCollection, abi: nftAbi, functionName: "ownerOf", args: [BigInt(invoice.tokenId)] };
  const [ownerThen, ownerNow] = await Promise.all([
    client.readContract({ ...args, blockNumber: receipt.blockNumber }),
    client.readContract({ ...args, blockNumber: finalized.number }),
  ]);
  if (!same(ownerThen, invoice.holderAddress) || !same(ownerNow, invoice.holderAddress)) throw new InvalidNftProofError("The sender does not own this NFT at both verification snapshots.");
  return {
    kind: "confirmed-nft-transfer", invoiceId: invoice.id, chainId: PAYMENT_POLICY.chainId,
    collection: PAYMENT_POLICY.nftCollection, tokenId: String(BigInt(invoice.tokenId)),
    txHash: txHash.toLowerCase(), sender: invoice.holderAddress, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
  };
}
