import test from "node:test";
import assert from "node:assert/strict";
import { prepareMonadTransaction } from "../server/monad-preflight.mjs";

const address="0x1111111111111111111111111111111111111111";
const call={to:address,value:5n*10n**18n,data:"0x"};
const client=(overrides={})=>({getTransactionCount:async()=>7,getGasPrice:async()=>100n,
  estimateGas:async()=>21_000n,getBalance:async()=>10n**21n,...overrides});

test("plain simulated 21k Monad transfer pays no unnecessary 25% gas-limit margin",async()=>{
  const result=await prepareMonadTransaction(client(),address,call);
  assert.deepEqual(result,{nonce:7,gasLimit:21_000n,maxFeePerGas:200n,maxPriorityFeePerGas:10n});
  assert.equal(26_250n-result.gasLimit,5_250n); // 20% less gas than the old padded limit.
});

test("contract calls and non-21k native estimates retain a rounded-up 25% margin",async()=>{
  for(const [data,estimate,expected] of [["0x1234",21_000n,26_250n],["0x",30_001n,37_502n],["0x1234",100_000n,125_000n]]){
    assert.equal((await prepareMonadTransaction(client({estimateGas:async()=>estimate}),address,{...call,data})).gasLimit,expected);
  }
});

test("all five independent preflight reads start before any RPC response completes",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const started=[];
  const read=(name,value)=>async args=>{started.push(name+(args?.blockTag??""));await gate;return value;};
  const rpc={getTransactionCount:read("nonce",7),getGasPrice:read("price",100n),estimateGas:read("estimate",21_000n),getBalance:read("balance",10n**21n)};
  const pending=prepareMonadTransaction(rpc,address,call);
  try{assert.deepEqual(started,["noncelatest","noncepending","price","estimate","balance"]);}finally{release();}
  assert.equal((await pending).nonce,7);
});

test("pending nonce is never replaced or incremented optimistically",async()=>{
  assert.equal(await prepareMonadTransaction(client({getTransactionCount:async args=>args.blockTag==="pending"?8:7}),address,call),null);
});

test("invalid fees, nonces, gas, value and insufficient funds fail closed",async()=>{
  for(const overrides of [
    {getTransactionCount:async()=>-1},{getTransactionCount:async()=>7n},{getTransactionCount:async()=>NaN},
    {getGasPrice:async()=>0n},{getGasPrice:async()=>250_000_000_001n},{getGasPrice:async()=>100},
    {estimateGas:async()=>20_999n},{estimateGas:async()=>1_200_001n},{estimateGas:async()=>NaN},
    {getBalance:async()=>call.value+21_000n*200n-1n},
  ])await assert.rejects(prepareMonadTransaction(client(overrides),address,call));
  await assert.rejects(prepareMonadTransaction(client(),address,{...call,value:-1n}));
  await assert.rejects(prepareMonadTransaction(client({getGasPrice:async()=>{throw new Error("RPC unavailable");}}),address,call),/RPC unavailable/);
});
