import test from "node:test";
import assert from "node:assert/strict";
import { paymentProgress, paymentPollDelay } from "../src/payment-progress.ts";

test("payment activity separates bridge ETA from Ethereum finality",()=>{
  const now=1_000_000;
  const bridge={state:"bridging",bridgeStartedAt:now-30_000,message:null,bridgeEstimatedSeconds:2,destinationChainId:10};
  const result=paymentProgress(bridge,now,true);
  assert.match(result.estimate,/~2 sec/);assert.equal(result.elapsed,"0:30");assert.match(result.title,/Optimism/);
  assert.match(paymentProgress({state:"confirming",destinationIncludedAt:now-60_000},now,true).estimate,/background/);
  assert.equal(bridge.state,"bridging","timers cannot advance a financial state");
});

test("expired estimates and lost connections never show false countdowns or success",()=>{
  assert.match(paymentProgress({state:"bridging",bridgeStartedAt:1},1_000_000,true).estimate,/longer/);
  assert.match(paymentProgress({state:"bridging",message:"Relay delayed"},1_000_000,true).estimate,/longer/);
  assert.match(paymentProgress({state:"confirming"},1_000_000,false).estimate,/unavailable/);
  assert.equal(paymentProgress({state:"processing"},1_000_000,true).elapsed,null,"old invoices must not get fabricated start times");
  for(const state of ["delivered","expired","manual-review","awaiting-payment"])assert.equal(paymentProgress({state},1_000_000,true),null);
});

test("fast active polling stays within the shared HTTP limit; failures back off",()=>{
  assert.equal(paymentPollDelay("bridging"),3000);
  assert.equal(paymentPollDelay("processing"),3000);
  assert.equal(paymentPollDelay("confirming"),10000);
  assert.equal(paymentPollDelay("bridging",true),10000);
  assert.ok(60_000/paymentPollDelay("bridging")+60_000/10_000<60);
});
