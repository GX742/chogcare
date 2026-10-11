import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeFunctionData, parseAbi } from "viem";
import { validateRelayOrder, RELAY_DEPOSITORY } from "../server/relay-route.mjs";
import { evmRelayOrderId } from "../server/relay-order.mjs";
const fixture=JSON.parse(await readFile(new URL("./fixtures/relay-order.json",import.meta.url),"utf8"));
const payer="0x1111111111111111111111111111111111111111";
const now=1791437222000;
const optimismFixture=JSON.parse(await readFile(new URL("./fixtures/relay-optimism-order.json",import.meta.url),"utf8"));
const optimismNow=optimismFixture.protocol.v2.orderData.output.deadline*1000-60_000;

test("signed Optimism quote is bound to chain 10, native USDC and the same verified beneficiary",async()=>{
  const route=await validateRelayOrder(optimismFixture,payer,1_000_000n,200_000n,optimismNow,10);
  assert.equal(route.destinationChainId,10);assert.equal(route.estimatedSeconds,2);
  assert.equal(route.orderId,evmRelayOrderId(optimismFixture.protocol.v2.orderData));
  await assert.rejects(validateRelayOrder(optimismFixture,payer,1_000_000n,200_000n,optimismNow,1));
  await assert.rejects(validateRelayOrder(fixture,payer,1_000_000n,200_000n,now,10));
  for(const chain of [8453,42161,137])await assert.rejects(validateRelayOrder(optimismFixture,payer,1_000_000n,200_000n,optimismNow,chain));
  for(const mutate of [
    q=>q.protocol.v2.orderData.output.payments[0].currency="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    q=>q.protocol.v2.orderData.output.payments[0].recipient=payer,
    q=>q.protocol.v2.orderData.inputs[0].refunds[1].recipient=payer,
    q=>q.protocol.v2.orderData.output.calls=["0x1234"],
  ]){const q=structuredClone(optimismFixture);mutate(q);await assert.rejects(validateRelayOrder(q,payer,1_000_000n,200_000n,optimismNow,10));}
});
test("real signed public Relay fixture matches independently encoded order hash and pinned solver",async()=>{
  assert.equal(evmRelayOrderId(fixture.protocol.v2.orderData),fixture.protocol.v2.orderId);
  const route=await validateRelayOrder(fixture,payer,1_000_000n,200_000n,now);
  assert.equal(route.to,RELAY_DEPOSITORY);assert.equal(route.minOutput,"936082");
  const decoded=decodeFunctionData({abi:parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]),data:route.data});
  assert.equal(decoded.args[0],payer);assert.equal(decoded.args[2],1_000_000n);assert.equal(decoded.args[3],route.orderId);
});
test("route tampering, wrong refund, calldata calls, stale deadlines and fake signatures are rejected",async()=>{
  for(const change of [
    q=>q.protocol.v2.orderData.output.payments[0].recipient=payer,
    q=>q.protocol.v2.orderData.output.payments[0].minimumAmount="1",
    q=>q.protocol.v2.orderData.inputs[0].payment.amount="1000001",
    q=>q.protocol.v2.orderData.inputs[0].refunds[0].recipient=RELAY_DEPOSITORY,
    q=>q.protocol.v2.orderData.output.calls=["0x1234"],
    q=>q.protocol.v2.orderData.output.deadline=1,
    q=>q.protocol.v2.paymentDetails.depository=payer,
    q=>q.protocol.v2.orderId=`0x${"00".repeat(32)}`,
    q=>q.protocol.v2.orderSignature=`0x${"11".repeat(65)}`,
    q=>{q.protocol.v2.orderData.salt="1";q.protocol.v2.orderId=evmRelayOrderId(q.protocol.v2.orderData);},
  ]){const q=structuredClone(fixture);change(q);await assert.rejects(validateRelayOrder(q,payer,1_000_000n,200_000n,now));}
});
