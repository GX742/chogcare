import test from "node:test";
import assert from "node:assert/strict";
import { paymentProgress, paymentPollDelay, nftPollDelay, nftProgressNote } from "../src/payment-progress.ts";

test("payment activity separates delivery ETA from receipt confirmation",()=>{
  const now=1_000_000;
  const bridge={state:"bridging",bridgeStartedAt:now-30_000,message:null,bridgeEstimatedSeconds:2,destinationChainId:10};
  const result=paymentProgress(bridge,now,true);
  assert.match(result.estimate,/~2 sec/);assert.equal(result.elapsed,"0:30");assert.equal(result.title,"On its way to the charity");
  assert.match(paymentProgress({state:"confirming",destinationIncludedAt:now-60_000},now,true).estimate,/background/);
  assert.equal(bridge.state,"bridging","timers cannot advance a financial state");
});

test("NFT active polling is faster, bounded and backs off without pretending to confirm a donation", () => {
  for (const state of ["awaiting-payment", "verifying", "verified", "paying"]) assert.equal(nftPollDelay(state), 1500);
  assert.equal(nftPollDelay("confirming"), 10000);
  assert.equal(nftPollDelay("delivered"), 30000);
  assert.equal(nftPollDelay("verifying", true), 10000);
  assert.ok(60000 / nftPollDelay("verifying") + 60000 / 10000 < 60);
  assert.match(nftProgressNote("confirming", true), /background.*CHOG/);
  assert.match(nftProgressNote("verifying", true), /no further MON/);
  assert.match(nftProgressNote("paying", false), /Reconnecting.*Do not send MON again/);
  assert.equal(nftProgressNote("delivered", true), "");
});

test("expired estimates and lost connections never show false countdowns or success",()=>{
  assert.match(paymentProgress({state:"bridging",bridgeStartedAt:1},1_000_000,true).estimate,/longer/);
  assert.match(paymentProgress({state:"bridging",message:"Relay delayed"},1_000_000,true).estimate,/longer/);
  assert.match(paymentProgress({state:"confirming"},1_000_000,false).estimate,/unavailable/);
  assert.equal(paymentProgress({state:"processing"},1_000_000,true).elapsed,null,"old invoices must not get fabricated start times");
  for(const state of ["delivered","expired","manual-review","awaiting-payment"])assert.equal(paymentProgress({state},1_000_000,true),null);
});

test("public payment progress avoids destination network names without claiming early finality",()=>{
  for(const destinationChainId of [1,10,792703809]) {
    for(const state of ["processing","bridging","confirming"]) {
      const copy=paymentProgress({state,destinationChainId},1_000_000,true);
      assert.doesNotMatch(JSON.stringify(copy),/Ethereum|Optimism|Solana/i);
      if(state==="confirming")assert.match(copy.note,/still in progress/);
    }
  }
});

test("fast active polling stays within the shared HTTP limit; failures back off",()=>{
  assert.equal(paymentPollDelay("bridging"),1500);
  assert.equal(paymentPollDelay("processing"),1500);
  assert.equal(paymentPollDelay("confirming"),10000);
  assert.equal(paymentPollDelay("bridging",true),10000);
  assert.ok(60_000/paymentPollDelay("bridging")+60_000/10_000<60);
});
