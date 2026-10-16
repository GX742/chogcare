import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentPerformance } from "../server/payment-performance.mjs";

test("performance diagnostics retain only 128 numeric samples and accurate window percentiles",async()=>{
  let clock=0;const metrics=createPaymentPerformance(()=>clock);
  for(let i=1;i<=200;i++)await metrics.measure("source-preflight",()=>{clock+=i;return i;});
  const row=metrics.snapshot()["source-preflight"];
  assert.deepEqual(row,{count:200,failed:0,inFlight:0,sampleCount:128,lastMs:200,p50Ms:136,p95Ms:194,maxMs:200});
  row.count=999;assert.equal(metrics.snapshot()["source-preflight"].count,200);
});

test("diagnostics preserve results and original errors without retaining financial data",async()=>{
  const metrics=createPaymentPerformance();
  const secret="private-invoice-and-signed-bytes",error=new Error(secret);
  const value={privateKey:secret};assert.equal(await metrics.measure("nft-proof",async()=>value),value);
  await assert.rejects(metrics.measure("nft-proof",async()=>{throw error;}),e=>e===error);
  const snapshot=metrics.snapshot();assert.equal(snapshot["nft-proof"].failed,1);
  assert.equal(snapshot["nft-proof"].inFlight,0);assert.doesNotMatch(JSON.stringify(snapshot),/private|signed|Error/);
  await assert.rejects(metrics.measure(secret,async()=>{}),/Unknown payment performance stage/);
  assert.equal(Object.keys(metrics.snapshot()).length,1);
});

test("concurrent measurements are drained and counted separately",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const metrics=createPaymentPerformance();
  const one=metrics.measure("nft-discovery",()=>gate),two=metrics.measure("nft-discovery",()=>gate);
  assert.equal(metrics.snapshot()["nft-discovery"].inFlight,2);release();await Promise.all([one,two]);
  assert.equal(metrics.snapshot()["nft-discovery"].count,2);assert.equal(metrics.snapshot()["nft-discovery"].inFlight,0);
});
