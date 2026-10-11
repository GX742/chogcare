import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, parseUnits, zeroAddress } from "viem";
import {
  blocksResubmit, buildCalls, makeQuote, parseSubmission, quoteIsCurrent,
  readableError, requireAtomicWallet, sendAtomic, storageKey, validateBridgeQuote,
} from "../src/transactions.ts";
import {
  CHOG, MONAD_USDC, ETHEREUM_USDC, LIFI_DIAMOND, GIVETH_PROJECT_RECIPIENT,
  NAD_DEX_ROUTER, UNISWAP_ROUTER, sellAbi, swapRouterAbi,
} from "../src/route.ts";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const bridgeAmount = 530443n;
function bridge(receiver = GIVETH_PROJECT_RECIPIENT) {
  const data = encodeAbiParameters([{ type: "tuple", components: [
    { name: "transactionId", type: "bytes32" }, { name: "bridge", type: "string" },
    { name: "integrator", type: "string" }, { name: "referrer", type: "address" },
    { name: "sendingAssetId", type: "address" }, { name: "receiver", type: "address" },
    { name: "minAmount", type: "uint256" }, { name: "destinationChainId", type: "uint256" },
    { name: "hasSourceSwaps", type: "bool" }, { name: "hasDestinationCall", type: "bool" },
  ] }], [{ transactionId: `0x${"01".repeat(32)}`, bridge: "across", integrator: "chogcare", referrer: zeroAddress, sendingAssetId: MONAD_USDC, receiver, minAmount: bridgeAmount, destinationChainId: 1n, hasSourceSwaps: false, hasDestinationCall: false }]);
  return {
    action: { fromChainId: 143, toChainId: 1, fromAmount: String(bridgeAmount), fromAddress: owner, toAddress: GIVETH_PROJECT_RECIPIENT, fromToken: { address: MONAD_USDC }, toToken: { address: ETHEREUM_USDC } },
    estimate: { approvalAddress: LIFI_DIAMOND, toAmountMin: "400000" },
    transactionRequest: { to: LIFI_DIAMOND, data: `0x12345678${data.slice(2)}`, value: "0x0", chainId: 143 },
    tool: "across",
  };
}
const quote = { owner, mode: "chog", createdAt: Date.now(), amountIn: parseUnits("300", 18), bridgeAmount, minUsdc: 400000n, bridgeTool: "across", router: NAD_DEX_ROUTER, minMon: parseUnits("22", 18), swapMonAmount: parseUnits("21", 18), uniFee: 3000 };

test("atomic route orders approval, CHOG sale, USDC swap, bridge and approval cleanup", () => {
  const calls = buildCalls(quote, bridge());
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map(c => c.to), [CHOG, NAD_DEX_ROUTER, UNISWAP_ROUTER, CHOG, MONAD_USDC, LIFI_DIAMOND, MONAD_USDC]);
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
  assert.equal(approve.args[1], quote.amountIn);
  const sell = decodeFunctionData({ abi: sellAbi, data: calls[1].data }).args[0];
  assert.equal(sell.to.toLowerCase(), owner);
  assert.equal(sell.amountOutMin, quote.minMon);
  const swap = decodeFunctionData({ abi: swapRouterAbi, data: calls[2].data }).args[0];
  assert.equal(swap.amountOutMinimum, bridgeAmount);
  assert.equal(calls[2].value, quote.swapMonAmount);
  assert.equal(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args[1], bridgeAmount);
  for (const i of [3, 6]) assert.equal(decodeFunctionData({ abi: erc20Abi, data: calls[i].data }).args[1], 0n);
});

test("USDC recovery does not include any CHOG or MON swap", () => {
  const calls = buildCalls({ ...quote, mode: "usdc", amountIn: bridgeAmount }, bridge());
  assert.deepEqual(calls.map(c => c.to), [MONAD_USDC, LIFI_DIAMOND, MONAD_USDC]);
  assert.ok(calls.every(c => c.value === 0n));
});

test("rejects bridge payload recipient substitution even when display metadata is correct", () => {
  assert.throws(() => validateBridgeQuote(bridge(other), owner, bridgeAmount), /validation failed/);
});

test("rejects wrong spender, input amount, network or native value", () => {
  for (const change of [
    q => q.estimate.approvalAddress = other,
    q => q.action.fromAmount = "999999",
    q => q.action.fromAddress = other,
    q => q.action.toChainId = 8453,
    q => q.transactionRequest.value = "1",
    q => q.transactionRequest.to = other,
  ]) {
    const q = bridge(); change(q);
    assert.throws(() => validateBridgeQuote(q, owner, bridgeAmount));
  }
});

test("lower fresh output and less than 300 CHOG cannot be submitted", async () => {
  const q = bridge(); q.estimate.toAmountMin = "399999";
  assert.throws(() => buildCalls(quote, q), /less than agreed/);
  assert.throws(() => buildCalls({ ...quote, amountIn: parseUnits("299", 18) }, bridge()));
  await assert.rejects(makeQuote({}, owner, "chog", "299.999999999999999999"), /300 CHOG/);
});

test("quotes are tied to the wallet and expire after two minutes", () => {
  assert.ok(quoteIsCurrent(quote, owner, quote.createdAt + 119999));
  assert.ok(!quoteIsCurrent(quote, owner, quote.createdAt + 120000));
  assert.ok(!quoteIsCurrent(quote, other));
});

test("timeout and pending states remain locked across serialization and reload", () => {
  for (const state of ["submitting", "pending", "unknown", "source-confirmed"]) {
    const s = { owner, chainId: 143, state, bridgeAmount: "530443", createdAt: Date.now(), bridgeTool: "across", id: "batch-id" };
    assert.ok(blocksResubmit(parseSubmission(JSON.stringify(s), owner)));
    assert.throws(() => parseSubmission(JSON.stringify(s), other));
  }
  assert.ok(!blocksResubmit({ state: "failed" }));
  assert.ok(!blocksResubmit({ state: "complete" }));
  assert.equal(storageKey(owner), storageKey(owner.toUpperCase()));
});

test("retired wallet route never signs, even if a wallet supports atomic batches", async () => {
  let requests = 0;
  const wallet = {
    chain: { id: 143 }, getChainId: async () => 143, getAddresses: async () => [owner],
    getCapabilities: async () => ({ atomic: { status: "unsupported" } }),
    sendCalls: async args => { requests++; assert.equal(args.forceAtomic, true); assert.equal(args.experimental_fallback, false); return { id: "batch-id" }; },
  };
  await assert.rejects(requireAtomicWallet(wallet, owner), /does not support/);
  assert.equal(requests, 0);
  wallet.getCapabilities = async () => ({ atomic: { status: "supported" } });
  await requireAtomicWallet(wallet, owner);
  await assert.rejects(sendAtomic(wallet, owner, buildCalls(quote, bridge())), /legacy wallet route is disabled/);
  assert.equal(requests, 0);
  wallet.getAddresses = async () => [other];
  await assert.rejects(requireAtomicWallet(wallet, owner), /account changed/);
});

test("relay timeout produces readable instructions without leaking a calldata wall", () => {
  const result = readableError(new Error("An internal error. Request Arguments: data: 0x1234 Details: Transaction relay error - FAILED_TIMEOUT"));
  assert.match(result, /Do not resubmit/);
  assert.ok(!result.includes("0x1234"));
});
