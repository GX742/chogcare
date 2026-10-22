// Read-only proof and calldata policy. The caller owns custody/allocation,
// downstream-work exclusions, durable journals and all signing/submission.
import { Transaction } from "ethers";
import { decodeEventLog, encodeFunctionData, erc20Abi, formatUnits, isAddress, zeroAddress } from "viem";
import { CHOG } from "../src/route.ts";
import { finalizedReceipt, NonCanonicalReceiptError } from "./chain-receipts.mjs";

export class WrongAmountRefundEligibilityError extends Error {
  constructor() { super("This transfer is not eligible for an automatic wrong-amount refund."); this.name = "WrongAmountRefundEligibilityError"; }
}
const reject = () => { throw new WrongAmountRefundEligibilityError(); };
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const exact = (value, pattern) => typeof value === "string" && value.match(pattern)?.[0] === value;
const hash = value => exact(value, /^0x[0-9a-f]{64}$/i);
const address = value => typeof value === "string" && isAddress(value) && !same(value, zeroAddress);
const decimal = value => exact(value, /^(?:0|[1-9]\d{0,77})$/);
const proofs = new WeakSet();
const fields = ["kind", "invoiceId", "depositAddress", "sender", "amountUnits", "quotedUnits", "txHash", "logIndex", "blockNumber", "blockHash"];
const MAX_COST = 50_000_000_000_000_000n;

function terms(invoice) {
  if (!invoice || !exact(invoice.id, /^[a-f0-9]{64}$/) || !address(invoice.depositAddress) || same(invoice.depositAddress, CHOG) ||
      !decimal(invoice.units) || BigInt(invoice.units) <= 0n || BigInt(invoice.units) >= 2n ** 256n ||
      !decimal(invoice.createdBlock) || !Number.isSafeInteger(invoice.expiresAt) || invoice.expiresAt <= 0 ||
      invoice.amount !== undefined && invoice.amount !== formatUnits(BigInt(invoice.units), 18)) reject();
  return { quoted: BigInt(invoice.units), created: BigInt(invoice.createdBlock) };
}

function transfer(log, receipt) {
  if (!same(log?.address, CHOG)) return null;
  if (log.removed || !hash(log.transactionHash) || !hash(log.blockHash) ||
      typeof log.blockNumber !== "bigint" || log.blockNumber < 0n || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) reject();
  if (receipt && (!same(log.transactionHash, receipt.transactionHash) || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber)) throw new NonCanonicalReceiptError();
  try {
    const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data, strict: true });
    return { from: event.args.from, to: event.args.to, value: event.args.value };
  } catch { return null; }
}

function authentic(proof) {
  if (!proof || !proofs.has(proof)) reject();
}

function referenceShape(reference, invoice, quoted) {
  if (!reference || reference.kind !== "wrong-chog-amount-deposit" || reference.invoiceId !== invoice.id ||
      reference.depositAddress !== invoice.depositAddress.toLowerCase() || !address(reference.sender) ||
      !decimal(reference.amountUnits) || BigInt(reference.amountUnits) <= 0n || BigInt(reference.amountUnits) >= 2n ** 256n ||
      BigInt(reference.amountUnits) === quoted || reference.quotedUnits !== String(quoted) ||
      !hash(reference.txHash) || !hash(reference.blockHash) || !decimal(reference.blockNumber) ||
      !Number.isSafeInteger(reference.logIndex) || reference.logIndex < 0) reject();
}

// reference is ONLY a previously persisted proof from a successful initial
// verification. A browser-supplied or freshly fabricated reference is forbidden.
// Resume rechecks the original anchor while allowing our own refund to have
// consumed the child balance/nonce. It never creates a fresh spend authorization.
export async function verifyWrongAmountDeposit(source, invoice, reference) {
  const { quoted, created } = terms(invoice);
  if (await source.getChainId() !== 143) throw new Error("Wrong source RPC network.");
  let selected, scanHead;
  if (reference !== undefined) {
    referenceShape(reference, invoice, quoted);
    selected = { transactionHash: reference.txHash, logIndex: reference.logIndex,
      blockHash: reference.blockHash, blockNumber: BigInt(reference.blockNumber) };
  } else {
    const head = await source.getBlock({ blockTag: "finalized" });
    if (typeof head.number !== "bigint" || head.number < 0n) throw new Error("Invalid source finality observation.");
    if (head.number <= created || head.number - created > 10_000n) reject();
    scanHead = head.number;
    for (let start = created + 1n; start <= scanHead; start += 2000n) {
      const end = start + 1999n < scanHead ? start + 1999n : scanHead;
      const [incoming, outgoing] = await Promise.all([
        source.getContractEvents({ address: CHOG, abi: erc20Abi, eventName: "Transfer", args: { to: invoice.depositAddress }, fromBlock: start, toBlock: end, strict: true }),
        source.getContractEvents({ address: CHOG, abi: erc20Abi, eventName: "Transfer", args: { from: invoice.depositAddress }, fromBlock: start, toBlock: end, strict: true }),
      ]);
      if (!Array.isArray(incoming) || !Array.isArray(outgoing)) throw new Error("Invalid source event observation.");
      if (incoming.length > 2000 || outgoing.length > 2000) reject();
      for (const log of outgoing) {
        const event = transfer(log);
        if (!event || !same(event.from, invoice.depositAddress) || log.blockNumber < start || log.blockNumber > end || event.value > 0n) reject();
      }
      for (const log of incoming) {
        const event = transfer(log);
        if (!event || !same(event.to, invoice.depositAddress) || log.blockNumber < start || log.blockNumber > end) reject();
        if (event.value > 0n) { if (selected) reject(); selected = log; }
      }
    }
    if (!selected) reject();
  }
  const { receipt, block } = await finalizedReceipt(source, 143, selected.transactionHash);
  if (!Array.isArray(receipt.logs)) reject();
  if (block.number <= created || block.timestamp * 1000n > BigInt(invoice.expiresAt)) reject();
  if (scanHead !== undefined && block.number > scanHead) throw new NonCanonicalReceiptError();
  if (block.number !== selected.blockNumber || !same(block.hash, selected.blockHash)) throw new NonCanonicalReceiptError();
  const matching = receipt.logs.filter(log => log.logIndex === selected.logIndex);
  if (matching.length !== 1) reject();
  const event = transfer(matching[0], receipt);
  if (!event || !same(event.to, invoice.depositAddress) || !address(event.from) || same(event.from, invoice.depositAddress) ||
      event.value <= 0n || event.value >= 2n ** 256n || event.value === quoted) reject();
  const positives = receipt.logs.map(log => transfer(log, receipt)).filter(item => item && same(item.to, invoice.depositAddress) && item.value > 0n);
  if (positives.length !== 1) reject();
  const [transaction, senderCode] = await Promise.all([
    source.getTransaction({ hash: selected.transactionHash }), source.getCode({ address: event.from, blockTag: "finalized" }),
  ]);
  const expected = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [invoice.depositAddress, event.value] });
  if (!same(transaction.hash, selected.transactionHash) || !same(transaction.from, event.from) || !same(transaction.to, CHOG) ||
      !same(transaction.input, expected) || transaction.value !== 0n || !same(receipt.from, event.from) || !same(receipt.to, CHOG) ||
      transaction.chainId !== undefined && transaction.chainId !== 143 ||
      senderCode && senderCode !== "0x" && !exact(senderCode, /^0xef0100[0-9a-f]{40}$/i)) reject();
  if (transaction.blockNumber !== receipt.blockNumber || !same(transaction.blockHash, receipt.blockHash)) throw new NonCanonicalReceiptError();
  const proof = { kind: "wrong-chog-amount-deposit", invoiceId: invoice.id, depositAddress: invoice.depositAddress.toLowerCase(), sender: event.from.toLowerCase(),
    amountUnits: String(event.value), quotedUnits: String(quoted), txHash: selected.transactionHash.toLowerCase(), logIndex: selected.logIndex,
    blockNumber: String(block.number), blockHash: block.hash.toLowerCase() };
  if (reference !== undefined) {
    if (fields.some(key => reference[key] !== proof[key])) reject();
  } else {
    const [latestBalance, finalizedBalance, latestNonce, pendingNonce, childCode] = await Promise.all([
      source.readContract({ address: CHOG, abi: erc20Abi, functionName: "balanceOf", args: [invoice.depositAddress], blockTag: "latest" }),
      source.readContract({ address: CHOG, abi: erc20Abi, functionName: "balanceOf", args: [invoice.depositAddress], blockTag: "finalized" }),
      source.getTransactionCount({ address: invoice.depositAddress, blockTag: "latest" }),
      source.getTransactionCount({ address: invoice.depositAddress, blockTag: "pending" }),
      source.getCode({ address: invoice.depositAddress, blockTag: "latest" }),
    ]);
    if (latestBalance !== event.value || finalizedBalance !== event.value || latestNonce !== 0 || pendingNonce !== 0 || childCode && childCode !== "0x") reject();
  }
  Object.freeze(proof); proofs.add(proof); return proof;
}

export function buildWrongAmountRefundCall(proof) {
  authentic(proof);
  return Object.freeze({ to: CHOG, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [proof.sender, BigInt(proof.amountUnits)] }) });
}

export function validateWrongAmountRefundRaw(raw, proof) {
  const call = buildWrongAmountRefundCall(proof);
  let tx; try { tx = Transaction.from(raw); } catch { reject(); }
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw) || raw.length > 4096 || !tx.isSigned() || tx.chainId !== 143n || tx.type !== 2 ||
      !same(tx.from, proof.depositAddress) || !same(tx.to, call.to) || !same(tx.data, call.data) || tx.value !== 0n || tx.nonce !== 0 || tx.accessList?.length ||
      tx.gasLimit < 21_000n || tx.gasLimit > 150_000n || typeof tx.maxFeePerGas !== "bigint" || tx.maxFeePerGas <= 0n || tx.maxFeePerGas > 500_000_000_000n ||
      typeof tx.maxPriorityFeePerGas !== "bigint" || tx.maxPriorityFeePerGas < 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas || tx.gasLimit * tx.maxFeePerGas > MAX_COST) reject();
  return Object.freeze({ hash: tx.hash.toLowerCase(), nonce: tx.nonce, sender: tx.from.toLowerCase() });
}

export async function verifyWrongAmountRefundReceipt(source, proof, raw, observed) {
  const checked = validateWrongAmountRefundRaw(raw, proof), signed = Transaction.from(raw);
  const { receipt, block } = await finalizedReceipt(source, 143, checked.hash, observed);
  const transaction = await source.getTransaction({ hash: checked.hash });
  if (!same(transaction.hash, checked.hash) || !same(transaction.from, signed.from) || !same(transaction.to, signed.to) ||
      !same(transaction.input, signed.data) || transaction.value !== signed.value || transaction.nonce !== signed.nonce ||
      transaction.chainId !== 143 || transaction.type !== "eip1559" || transaction.gas !== signed.gasLimit || transaction.maxFeePerGas !== signed.maxFeePerGas ||
      transaction.maxPriorityFeePerGas !== signed.maxPriorityFeePerGas || transaction.accessList?.length ||
      !same(receipt.from, signed.from) || !same(receipt.to, signed.to) || !Array.isArray(receipt.logs)) reject();
  if (transaction.blockNumber !== receipt.blockNumber || !same(transaction.blockHash, receipt.blockHash)) throw new NonCanonicalReceiptError();
  const outgoing = receipt.logs.map(log => ({ log, event: transfer(log, receipt) }))
    .filter(item => item.event && same(item.event.from, proof.depositAddress) && item.event.value > 0n);
  if (outgoing.length !== 1 || !same(outgoing[0].event.to, proof.sender) || outgoing[0].event.value !== BigInt(proof.amountUnits)) reject();
  return Object.freeze({ txHash: checked.hash, blockNumber: String(block.number), blockHash: block.hash.toLowerCase(), logIndex: outgoing[0].log.logIndex });
}
