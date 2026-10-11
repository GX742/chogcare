import { decodeEventLog, erc20Abi, isAddress, zeroAddress } from "viem";
import { CHOG, ETHEREUM_USDC } from "../src/route.ts";
import { deliveryNetwork } from "../src/delivery-network.ts";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = value => typeof value === "string" && isAddress(value) && !same(value, zeroAddress);

// Read-only: no RPC-provided status or event is sufficient on its own. Requires a
// trusted chain RPC; a lying RPC remains an operational trust boundary.
export class AwaitingFinalityError extends Error {
  constructor(){super("Transaction included; waiting for network finality.");this.name="AwaitingFinalityError";}
}
export class NonCanonicalReceiptError extends Error {
  constructor(){super("Receipt is not canonical.");this.name="NonCanonicalReceiptError";}
}

// Inclusion and finality are distinct. An included, canonical transfer can be
// shown as pending confirmation, but must never authorize a completed payout.
export async function inspectReceipt(client, chainId, txHash) {
  if (!hash(txHash) || ![1, 10, 143].includes(chainId)) throw new Error("Invalid transaction reference.");
  const [receipt, finalized, actualChain] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }), client.getBlock({ blockTag: "finalized" }), client.getChainId(),
  ]);
  if(actualChain !== chainId) throw new Error("Wrong RPC network.");
  if (receipt.status !== "success" || !same(receipt.transactionHash, txHash) || !hash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n || typeof finalized.number !== "bigint" ||
      finalized.number < 0n) throw new Error("Successful receipt required.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash) || typeof block.timestamp !== "bigint" || block.timestamp < 0n) throw new NonCanonicalReceiptError();
  return { receipt, block, finalized: receipt.blockNumber <= finalized.number };
}

export async function finalizedReceipt(client, chainId, txHash) {
  const result=await inspectReceipt(client,chainId,txHash);
  if(!result.finalized)throw new AwaitingFinalityError();
  return {receipt:result.receipt,block:result.block};
}

function transferAt(receipt, token, logIndex) {
  if (!Number.isSafeInteger(logIndex) || logIndex < 0 || !Array.isArray(receipt.logs)) throw new Error("Invalid transfer event.");
  const logs = receipt.logs.filter(log => log.logIndex === logIndex);
  if (logs.length !== 1) throw new Error("Transfer event is missing or ambiguous.");
  const log = logs[0];
  if (log.removed || !same(log.address, token) || !same(log.transactionHash, receipt.transactionHash) ||
      log.blockNumber !== receipt.blockNumber || !same(log.blockHash, receipt.blockHash)) throw new Error("Transfer provenance does not match.");
  let event;
  try { event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics, strict: true }); }
  catch { throw new Error("Invalid ERC-20 transfer event."); }
  if (event.eventName !== "Transfer" || !address(event.args.from) || !address(event.args.to) || event.args.value <= 0n) throw new Error("Invalid transfer parties or amount.");
  return event.args;
}

// Trusted invoice only: never construct it from a browser's recipient/amount fields.
// Partial/late/excess transfers are rejected for automatic settlement, NOT erased.
export async function verifyChogDeposit(client, invoice, txHash, logIndex) {
  if (invoice?.kind !== "chog-donation" || invoice.state !== "awaiting-payment" || !/^[a-zA-Z0-9-]{1,80}$/.test(invoice.id) ||
      !address(invoice.depositAddress) || typeof invoice.amountUnits !== "bigint" || invoice.amountUnits < 300n * 10n ** 18n ||
      invoice.amountUnits >= 2n ** 256n || typeof invoice.createdBlock !== "bigint" || invoice.createdBlock < 0n ||
      !Number.isSafeInteger(invoice.expiresAt) || invoice.expiresAt <= 0) throw new Error("Invalid payable CHOG invoice.");
  const { receipt, block } = await finalizedReceipt(client, 143, txHash);
  if (receipt.blockNumber <= invoice.createdBlock || block.timestamp * 1000n > BigInt(invoice.expiresAt)) throw new Error("Payment outside invoice window: manual review required.");
  const event = transferAt(receipt, CHOG, logIndex);
  if (!same(event.to, invoice.depositAddress) || same(event.from, invoice.depositAddress) || event.value !== invoice.amountUnits) throw new Error("CHOG destination or exact amount mismatch: manual review required.");
  return { kind: "confirmed-chog-transfer", invoiceId: invoice.id, chainId: 143, txHash: txHash.toLowerCase(), logIndex, sender: event.from, amountUnits: event.value.toString(), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
}

export async function verifyPoolFunding(client, config, txHash, logIndex) {
  if (!address(config?.treasury) || !address(config?.funder) || same(config.treasury, config.funder)) throw new Error("Independent treasury and approved funder required.");
  const network = deliveryNetwork(config.chainId ?? 1);
  const { receipt } = await finalizedReceipt(client, network.id, txHash);
  const event = transferAt(receipt, network.usdc, logIndex);
  if (!same(event.to, config.treasury) || !same(event.from, config.funder) || event.value > 1_000_000_000_000n) throw new Error("Funding does not match approved Ethereum USDC treasury transfer.");
  return { chainId: network.id, txHash: txHash.toLowerCase(), logIndex, units: Number(event.value) };
}

export async function verifyPoolPayout(client, payout, txHash, logIndex) {
  if (!address(payout?.treasury) || !address(payout?.recipient) || same(payout.treasury, payout.recipient) ||
      !hash(payout.txHash) || !same(payout.txHash, txHash)) throw new Error("Payout is not the persisted submission.");
  const network = deliveryNetwork(payout.chainId ?? 1);
  const { receipt } = await finalizedReceipt(client, network.id, txHash);
  const event = transferAt(receipt, network.usdc, logIndex);
  if (!same(event.from, payout.treasury) || !same(event.to, payout.recipient) || event.value !== 500_000n) throw new Error("Expected exactly 0.50 Ethereum USDC to the bound recipient.");
  return { kind: "confirmed-pool-payout", txHash: txHash.toLowerCase(), logIndex, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
}
