import test from "node:test";
import assert from "node:assert/strict";
import {observeSourceSubmission} from "../server/source-submission.mjs";

const row={hash:"0x"+"a".repeat(64),raw:"0x1234"};
const missing=()=>{throw Object.assign(new Error("not included"),{name:"TransactionReceiptNotFoundError"});};
test("a fast included source transaction advances without waiting for another worker tick",async()=>{
  let sent=0,checkpointed=false;
  const receipt={status:"success"};
  const result=await observeSourceSubmission({getTransactionReceipt:async()=>sent?receipt:missing(),sendRawTransaction:async({serializedTransaction})=>{assert.ok(checkpointed);assert.equal(serializedTransaction,row.raw);sent++;return row.hash;}},row,{checkpoint(){checkpointed=true;}});
  assert.equal(result,receipt);assert.equal(sent,1);
});
test("an ambiguous accepted broadcast checks the original receipt and never resubmits in the observation window",async()=>{
  let sent=0,pending=0,clock=0,reads=0;
  const receipt={status:"success"};
  const result=await observeSourceSubmission({getTransactionReceipt:async()=>++reads>=4?receipt:missing(),sendRawTransaction:async()=>{sent++;throw Error("timeout after submission");}},row,{now:()=>clock,sleep:async ms=>{clock+=ms;},onPending(){pending++;}});
  assert.equal(result,receipt);assert.equal(sent,1);assert.equal(pending,1);assert.equal(clock,400);
});
test("pending observation is bounded and an existing receipt never triggers another broadcast",async()=>{
  let sent=0,clock=0,reads=0;
  const client={getTransactionReceipt:async()=>{reads++;return missing();},sendRawTransaction:async()=>{sent++;return row.hash;}};
  assert.equal(await observeSourceSubmission(client,row,{now:()=>clock,sleep:async ms=>{clock+=ms;}}),null);
  assert.equal(sent,1);assert.equal(clock,1200);assert.equal(reads,8);
  client.getTransactionReceipt=async()=>({status:"reverted"});
  assert.equal((await observeSourceSubmission(client,row)).status,"reverted");assert.equal(sent,1);
});
test("RPC read failures cannot authorize broadcasting or fabricate confirmation",async()=>{
  let sent=0;
  await assert.rejects(observeSourceSubmission({getTransactionReceipt:async()=>{throw Error("network down");},sendRawTransaction:async()=>{sent++;}},row),/network down/);
  assert.equal(sent,0);
});
