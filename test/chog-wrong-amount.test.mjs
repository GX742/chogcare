import test from "node:test";
import assert from "node:assert/strict";
import { Transaction, Wallet } from "ethers";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { CHOG } from "../src/route.ts";
import { AwaitingFinalityError, NonCanonicalReceiptError } from "../server/chain-receipts.mjs";
import { WrongAmountRefundEligibilityError, verifyWrongAmountDeposit, buildWrongAmountRefundCall, validateWrongAmountRefundRaw, verifyWrongAmountRefundReceipt } from "../server/chog-wrong-amount.mjs";

// Test-only wallets and RPC objects. No database, vault or network is opened.
const child = new Wallet("0x" + "22".repeat(32)), sender = new Wallet("0x" + "11".repeat(32));
const other = "0x3333333333333333333333333333333333333333";
const depositHash = "0x" + "ab".repeat(32), depositBlockHash = "0x" + "cd".repeat(32), refundBlockHash = "0x" + "ef".repeat(32);
const quoted = 330n * 10n ** 18n;
function log(from, to, value, changes = {}) {
  return { address: CHOG, transactionHash: depositHash, blockNumber: 100n, blockHash: depositBlockHash, logIndex: 2, removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]), ...changes };
}
function fixture(actual = 1n * 10n ** 18n) {
  const invoice = { id: "a".repeat(64), depositAddress: child.address, units: String(quoted), amount: formatUnits(quoted, 18), createdBlock: "99", expiresAt: 200_000 };
  const incoming = log(sender.address, child.address, actual);
  const state = { chain: 143, final: 110n, incoming: [incoming], outgoing: [], balance: actual, finalizedBalance: actual, latestNonce: 0, pendingNonce: 0,
    senderCode: "0x", childCode: "0x", scanned: [], receiptReads: 0,
    block: { number: 100n, hash: depositBlockHash, timestamp: 100n },
    receipt: { status: "success", transactionHash: depositHash, from: sender.address, to: CHOG, blockNumber: 100n, blockHash: depositBlockHash, logs: [incoming] },
    transaction: { hash: depositHash, from: sender.address, to: CHOG, input: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [child.address, actual] }),
      value: 0n, chainId: 143, blockNumber: 100n, blockHash: depositBlockHash },
  };
  const source = {
    getChainId: async () => state.chain,
    getBlock: async args => args.blockTag ? { number: state.final } : args.blockNumber === 105n ? state.refundBlock : state.block,
    getContractEvents: async args => {
      state.scanned.push({ direction: args.args.from ? "outgoing" : "incoming", from: args.fromBlock, to: args.toBlock });
      return (args.args.from ? state.outgoing : state.incoming).filter(item => item.blockNumber >= args.fromBlock && item.blockNumber <= args.toBlock);
    },
    getTransactionReceipt: async args => { state.receiptReads++; return args.hash === depositHash ? state.receipt : state.refundReceipt; },
    getTransaction: async args => args.hash === depositHash ? state.transaction : state.refundTransaction,
    getCode: async args => args.address.toLowerCase() === child.address.toLowerCase() ? state.childCode : state.senderCode,
    readContract: async args => args.blockTag === "finalized" ? state.finalizedBalance : state.balance,
    getTransactionCount: async args => args.blockTag === "pending" ? state.pendingNonce : state.latestNonce,
  };
  const attachRefund = raw => {
    const tx = Transaction.from(raw);
    state.refundBlock = { number: 105n, hash: refundBlockHash, timestamp: 105n };
    state.refundTransaction = { hash: tx.hash, from: tx.from, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce, chainId: Number(tx.chainId),
      type: "eip1559", gas: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: [], blockNumber: 105n, blockHash: refundBlockHash };
    state.refundReceipt = { status: "success", transactionHash: tx.hash, from: child.address, to: CHOG, blockNumber: 105n, blockHash: refundBlockHash,
      logs: [log(child.address, sender.address, actual, { transactionHash: tx.hash, blockNumber: 105n, blockHash: refundBlockHash })] };
  };
  return { source, state, invoice, attachRefund };
}
const signed = (proof, changes = {}, wallet = child) => wallet.signTransaction({ ...buildWrongAmountRefundCall(proof), chainId: 143, type: 2, nonce: 0,
  gasLimit: 60_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n, ...changes });

test("positive underpayments and all uint256 overpayments bind the complete original amount and sender", async () => {
  for (const amount of [1n, 1n * 10n ** 18n, 300n * 10n ** 18n, quoted + 1n, 2n ** 255n]) {
    const f = fixture(amount), proof = await verifyWrongAmountDeposit(f.source, f.invoice);
    assert.deepEqual(proof, { kind: "wrong-chog-amount-deposit", invoiceId: f.invoice.id, depositAddress: child.address.toLowerCase(), sender: sender.address.toLowerCase(),
      amountUnits: String(amount), quotedUnits: String(quoted), txHash: depositHash, logIndex: 2, blockNumber: "100", blockHash: depositBlockHash });
    assert.ok(Object.isFrozen(proof));
    assert.equal(buildWrongAmountRefundCall(proof).data, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [sender.address, amount] }));
  }
  for (const amount of [0n, quoted]) { const f = fixture(amount); await assert.rejects(verifyWrongAmountDeposit(f.source, f.invoice), WrongAmountRefundEligibilityError); }
});

test("initial proof scans every bounded finalized block in both directions and ignores only validated zero spam", async () => {
  const f = fixture(); f.state.final = 10_099n;
  f.state.incoming.push(log(other, child.address, 0n, { logIndex: 3 }));
  f.state.outgoing.push(log(child.address, other, 0n, { logIndex: 4 }));
  await verifyWrongAmountDeposit(f.source, f.invoice);
  for (const direction of ["incoming", "outgoing"]) assert.deepEqual(f.state.scanned.filter(item => item.direction === direction),
    [[100n,2099n],[2100n,4099n],[4100n,6099n],[6100n,8099n],[8100n,10099n]].map(([from,to]) => ({ direction, from, to })));
  const old = fixture(); old.state.final = 10_100n;
  await assert.rejects(verifyWrongAmountDeposit(old.source, old.invoice), WrongAmountRefundEligibilityError);
});

test("ambiguous, malformed, used, late or contract-funded deposits never authorize a refund", async () => {
  for (const change of [
    f => f.state.incoming.push(log(other, child.address, 1n, { logIndex: 3 })),
    f => f.state.outgoing.push(log(child.address, other, 1n)),
    f => f.state.outgoing.push(log(other, child.address, 0n)),
    f => f.state.outgoing.push(log(child.address, other, 0n, { address: other })),
    f => f.state.outgoing.push(log(child.address, other, 0n, { data: "0x" })),
    f => f.state.outgoing.push(log(child.address, other, 0n, { removed: true })),
    f => f.state.incoming[0].address = other,
    f => f.state.incoming[0].removed = true,
    f => f.state.receipt.logs.push({ ...f.state.receipt.logs[0] }),
    f => f.state.block.timestamp = 201n,
    f => f.state.transaction.from = other,
    f => f.state.transaction.to = other,
    f => f.state.transaction.input = "0x",
    f => f.state.transaction.value = 1n,
    f => f.state.receipt.from = other,
    f => f.state.senderCode = "0x60016000",
    f => f.state.senderCode = "0xef0100" + "12".repeat(19),
    f => f.state.senderCode = "0xef0100" + "12".repeat(20) + "\n",
    f => f.state.childCode = "0x6000",
    f => f.state.balance = 0n,
    f => f.state.finalizedBalance = 0n,
    f => f.state.latestNonce = 1,
    f => f.state.pendingNonce = 1,
    f => f.invoice.units = "0330",
    f => f.invoice.units += "\n",
    f => f.invoice.createdBlock += "\n",
    f => f.invoice.id += "\n",
    f => f.state.incoming[0].transactionHash += "\n",
    f => f.invoice.amount = "300",
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(verifyWrongAmountDeposit(f.source, f.invoice), WrongAmountRefundEligibilityError);
  }
  const delegated = fixture(); delegated.state.senderCode = "0xef0100" + "12".repeat(20);
  assert.equal((await verifyWrongAmountDeposit(delegated.source, delegated.invoice)).sender, sender.address.toLowerCase());
});

test("transport, wrong-network, finality and noncanonical observations remain distinct from permanent eligibility", async () => {
  const outage = new Error("Synthetic RPC outage"), f = fixture(); f.source.getTransactionReceipt = async () => { throw outage; };
  await assert.rejects(verifyWrongAmountDeposit(f.source, f.invoice), error => error === outage);
  const network = fixture(); network.state.chain = 10;
  await assert.rejects(verifyWrongAmountDeposit(network.source, network.invoice), error => !(error instanceof WrongAmountRefundEligibilityError));
  const pending = fixture(); let heads = 0;
  pending.source.getBlock = async args => args.blockTag ? { number: ++heads === 1 ? 110n : 99n } : pending.state.block;
  await assert.rejects(verifyWrongAmountDeposit(pending.source, pending.invoice), AwaitingFinalityError);
  const reorg = fixture(); reorg.state.block.hash = refundBlockHash;
  await assert.rejects(verifyWrongAmountDeposit(reorg.source, reorg.invoice), NonCanonicalReceiptError);
});

test("restart reanchors only the immutable original proof and allows its own refund to have consumed the child", async () => {
  const f = fixture(), proof = await verifyWrongAmountDeposit(f.source, f.invoice), reference = JSON.parse(JSON.stringify(proof));
  f.state.balance = 0n; f.state.finalizedBalance = 0n; f.state.latestNonce = 1; f.state.pendingNonce = 1;
  f.source.getContractEvents = async () => { throw new Error("Restart must not rescan own outgoing refund"); };
  const resumed = await verifyWrongAmountDeposit(f.source, f.invoice, reference);
  assert.deepEqual(resumed, proof); assert.notEqual(resumed, proof);
  assert.equal(buildWrongAmountRefundCall(resumed).to, CHOG);
  for (const [field, value] of [["invoiceId", "b".repeat(64)], ["depositAddress", other], ["sender", other], ["amountUnits", "2"],
    ["quotedUnits", "1"], ["txHash", refundBlockHash], ["logIndex", 3], ["blockNumber", "101"], ["blockHash", refundBlockHash], ["kind", "other"]]) {
    await assert.rejects(verifyWrongAmountDeposit(f.source, f.invoice, { ...reference, [field]: value }));
  }
  assert.throws(() => buildWrongAmountRefundCall(reference), WrongAmountRefundEligibilityError);
  f.state.transaction.to = other;
  await assert.rejects(verifyWrongAmountDeposit(f.source, f.invoice, reference), WrongAmountRefundEligibilityError);
});

test("signed refund bytes pin network, child, nonce, recipient, complete amount and strict gas budget", async () => {
  const f = fixture(), proof = await verifyWrongAmountDeposit(f.source, f.invoice), raw = await signed(proof);
  const checked = validateWrongAmountRefundRaw(raw, proof);
  assert.equal(checked.hash, Transaction.from(raw).hash); assert.equal(checked.nonce, 0); assert.equal(checked.sender, child.address.toLowerCase());
  // Sign each mutation before the synchronous policy assertion; no send occurs.
  const mutations = [{ chainId: 1 }, { nonce: 1 }, { to: other }, { value: 1n }, { data: "0x" }, { gasLimit: 20_999n },
    { gasLimit: 150_001n }, { maxFeePerGas: 501_000_000_000n }, { gasLimit: 150_000n, maxFeePerGas: 500_000_000_000n },
    { accessList: [{ address: CHOG, storageKeys: [] }] },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [other, BigInt(proof.amountUnits)] }) },
    { data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [sender.address, BigInt(proof.amountUnits) - 1n] }) }];
  for (const change of mutations) { const changed = await signed(proof, change); assert.throws(() => validateWrongAmountRefundRaw(changed, proof), WrongAmountRefundEligibilityError); }
  const wrongSigner = await signed(proof, {}, sender); assert.throws(() => validateWrongAmountRefundRaw(wrongSigner, proof), WrongAmountRefundEligibilityError);
  const cap = await signed(proof, { gasLimit: 100_000n, maxFeePerGas: 500_000_000_000n });
  assert.equal(validateWrongAmountRefundRaw(cap, proof).nonce, 0);
  assert.throws(() => validateWrongAmountRefundRaw(raw, { ...proof }), WrongAmountRefundEligibilityError);
});

test("refund completion needs the same signed transaction and one canonical-finalized outgoing transfer", async () => {
  const f = fixture(), proof = await verifyWrongAmountDeposit(f.source, f.invoice), raw = await signed(proof); f.attachRefund(raw);
  const reads = f.state.receiptReads;
  assert.deepEqual(await verifyWrongAmountRefundReceipt(f.source, proof, raw, f.state.refundReceipt),
    { txHash: Transaction.from(raw).hash, blockNumber: "105", blockHash: refundBlockHash, logIndex: 2 });
  assert.equal(f.state.receiptReads, reads, "observed receipt avoids a duplicate read");
  for (const change of [
    x => x.state.refundTransaction.input = "0x", x => x.state.refundTransaction.nonce = 1,
    x => x.state.refundTransaction.maxFeePerGas++, x => x.state.refundTransaction.from = other,
    x => x.state.refundTransaction.type = "legacy",
    x => x.state.refundReceipt.to = other,
    x => x.state.refundReceipt.logs[0] = log(child.address, other, BigInt(proof.amountUnits), { transactionHash: Transaction.from(raw).hash, blockNumber: 105n, blockHash: refundBlockHash }),
    x => x.state.refundReceipt.logs.push(log(child.address, other, 1n, { transactionHash: Transaction.from(raw).hash, blockNumber: 105n, blockHash: refundBlockHash, logIndex: 3 })),
  ]) {
    const x = fixture(); x.attachRefund(raw); change(x);
    await assert.rejects(verifyWrongAmountRefundReceipt(x.source, proof, raw, x.state.refundReceipt), WrongAmountRefundEligibilityError);
  }
  const pending = fixture(); pending.attachRefund(raw); pending.state.final = 104n;
  await assert.rejects(verifyWrongAmountRefundReceipt(pending.source, proof, raw), AwaitingFinalityError);
  const reorg = fixture(); reorg.attachRefund(raw); reorg.state.refundBlock.hash = depositBlockHash;
  await assert.rejects(verifyWrongAmountRefundReceipt(reorg.source, proof, raw), NonCanonicalReceiptError);
});
