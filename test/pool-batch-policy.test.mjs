import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { validatePoolBatchCall } from "../server/pool-batch-policy.mjs";
import { NFT_POOL_TREASURY } from "../src/chog-beneficiary.ts";
import { MONAD_USDC } from "../src/route.ts";
import { RELAY_DEPOSITORY } from "../server/relay-route.mjs";
import { NFT_POOL_SOURCE_GAS_GRANT } from "../server/nft-pool-config.mjs";

const operator="0x1111111111111111111111111111111111111111";
const collector="0x2222222222222222222222222222222222222222";
const orderId=`0x${"ab".repeat(32)}`;
const amount=5_000_000n;
const depositAbi=parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]);
const batch={
  collector,treasury:NFT_POOL_TREASURY,destinationChainId:10,amount:String(amount),minOutput:"4900000",
  bridge:{orderId,minOutput:"4950000"},
};
const calls={
  "pool-gas":{from:operator,to:collector,value:NFT_POOL_SOURCE_GAS_GRANT,data:"0x"},
  "pool-approve":{from:collector,to:MONAD_USDC,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[RELAY_DEPOSITORY,amount]})},
  "pool-bridge":{from:collector,to:RELAY_DEPOSITORY,value:0n,data:encodeFunctionData({abi:depositAbi,functionName:"depositErc20",args:[collector,MONAD_USDC,amount,orderId]})},
};

test("pool batches can only fund the pinned Optimism treasury with exact canonical calls",()=>{
  for(const [phase,call] of Object.entries(calls)){
    assert.doesNotThrow(()=>validatePoolBatchCall(phase,call,batch,operator,collector));
    assert.throws(()=>validatePoolBatchCall(phase,{...call,to:operator},batch,operator,collector));
    assert.throws(()=>validatePoolBatchCall(phase,{...call,value:call.value+1n},batch,operator,collector));
    assert.throws(()=>validatePoolBatchCall(phase,{...call,data:call.data+"00"},batch,operator,collector));
  }
  for(const changed of [
    {treasury:operator},
    {collector:operator},
    {destinationChainId:1},
    {amount:"4999999"},
    {minOutput:"5000001"},
    {bridge:{...batch.bridge,orderId:`0x${"cd".repeat(32)}`}},
  ])assert.throws(()=>validatePoolBatchCall("pool-bridge",calls["pool-bridge"],{...batch,...changed},operator,collector));
});
