import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { verifyChogDeposit, verifyPoolFunding, verifyPoolPayout } from "../server/chain-receipts.mjs";
import { CHOG, ETHEREUM_USDC } from "../src/route.ts";

const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
const hash = "0x" + "ab".repeat(32);
const blockHash = "0x" + "cd".repeat(32);
const amount = 300n * 10n ** 18n;
const invoice = { kind: "chog-donation", state: "awaiting-payment", id: "invoice-a", depositAddress: to, amountUnits: amount, createdBlock: 99n, expiresAt: 200_000 };
function fixture(token = CHOG, units = amount, chainId = 143) {
  const log = { address: token, blockHash, blockNumber: 100n, transactionHash: hash, logIndex: 2, removed: false,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [units]) };
  const receipt = { status: "success", transactionHash: hash, blockNumber: 100n, blockHash, logs: [log] };
  const block = { number: 100n, hash: blockHash, timestamp: 100n };
  const rpc = { getChainId: async () => chainId, getTransactionReceipt: async () => receipt,
    getBlock: async args => args.blockTag ? { number: 110n } : block };
  return { rpc, receipt, log, block };
}

test("CHOG proof validates canonical finalized Transfer from the actual CHOG contract", async () => {
  const result = await verifyChogDeposit(fixture().rpc, invoice, hash, 2);
  assert.equal(result.kind, "confirmed-chog-transfer");
  assert.equal(result.amountUnits, String(amount));
  assert.equal(result.invoiceId, invoice.id);
});

test("CHOG verifier rejects counterfeit tokens, recipient/amount substitutions and malformed logs", async () => {
  for (const mutate of [
    f => f.log.address = other,
    f => f.log.data = encodeAbiParameters([{ type: "uint256" }], [amount - 1n]),
    f => f.log.data = encodeAbiParameters([{ type: "uint256" }], [amount + 1n]),
    f => f.log.topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to: other } }),
    f => f.log.topics = [], f => f.log.data = "0x", f => f.log.removed = true,
    f => f.log.transactionHash = blockHash, f => f.log.blockNumber = 101n,
    f => f.receipt.logs.push({ ...f.log }),
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(verifyChogDeposit(f.rpc, invoice, hash, 2));
  }
});

test("CHOG verifier rejects stale, late, failed, unfinalized, reorganized or wrong-network payments", async () => {
  for (const mutate of [
    f => f.receipt.status = "reverted", f => f.receipt.transactionHash = blockHash,
    f => f.rpc.getChainId = async () => 1,
    f => f.rpc.getBlock = async () => ({ number: 99n }),
    f => f.block.hash = hash, f => f.block.number = 101n, f => f.block.timestamp = 201n,
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(verifyChogDeposit(f.rpc, invoice, hash, 2));
  }
  await assert.rejects(verifyChogDeposit(fixture().rpc, { ...invoice, createdBlock: 100n }, hash, 2));
  await assert.rejects(verifyChogDeposit(fixture().rpc, { ...invoice, kind: "preview" }, hash, 2));
});

test("funding credits only an approved funder and treasury on Ethereum USDC", async () => {
  const f = fixture(ETHEREUM_USDC, 10_000_000n, 1);
  const config = { treasury: to, funder: from };
  assert.deepEqual(await verifyPoolFunding(f.rpc, config, hash, 2), { chainId: 1, txHash: hash, logIndex: 2, units: 10_000_000 });
  await assert.rejects(verifyPoolFunding(f.rpc, { ...config, treasury: other }, hash, 2));
  await assert.rejects(verifyPoolFunding(f.rpc, { ...config, funder: other }, hash, 2));
  await assert.rejects(verifyPoolFunding(f.rpc, { ...config, treasury: from }, hash, 2));
  await assert.rejects(verifyPoolFunding(fixture(CHOG, 10_000_000n, 1).rpc, config, hash, 2));
  await assert.rejects(verifyPoolFunding(fixture(ETHEREUM_USDC, 10_000_000n, 143).rpc, config, hash, 2));
});

test("pool delivery requires the exact reserved amount for new and legacy grants", async () => {
  for(const amount of [500_000,1_000_000]){
  const payout = { treasury: from, recipient: to, txHash: hash,units:amount };
  assert.equal((await verifyPoolPayout(fixture(ETHEREUM_USDC, BigInt(amount), 1).rpc, payout, hash, 2)).kind, "confirmed-pool-payout");
  for (const units of [BigInt(amount)-1n,BigInt(amount)+1n]) await assert.rejects(verifyPoolPayout(fixture(ETHEREUM_USDC, units, 1).rpc, payout, hash, 2));
  await assert.rejects(verifyPoolPayout(fixture(ETHEREUM_USDC, BigInt(amount), 1).rpc, { ...payout, recipient: other }, hash, 2));
  await assert.rejects(verifyPoolPayout(fixture(ETHEREUM_USDC, BigInt(amount), 1).rpc, { ...payout, txHash: blockHash }, hash, 2));
  }
});
