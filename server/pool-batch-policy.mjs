import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { MONAD_USDC } from "../src/route.ts";
import { NFT_POOL_TREASURY } from "../src/chog-beneficiary.ts";
import { RELAY_DEPOSITORY } from "./relay-route.mjs";
import { NFT_POOL_SOURCE_GAS_GRANT } from "./nft-pool-config.mjs";

const depositAbi=parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]);
const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
const positive=value=>typeof value==="string"&&/^\d{1,78}$/.test(value)&&BigInt(value)>0n&&BigInt(value)<2n**256n;
const fail=()=>{throw new Error("NFT pool batch transaction violates the pinned policy.");};

export function validatePoolBatchCall(phase,call,batch,operator,collector) {
  if(!batch||!same(batch.collector,collector)||!same(batch.treasury,NFT_POOL_TREASURY)||batch.destinationChainId!==10||
      !positive(batch.amount)||typeof call?.data!=="string"||call.data.length>2048)fail();
  if(phase==="pool-gas") {
    if(!same(call.from,operator)||!same(call.to,collector)||call.value!==NFT_POOL_SOURCE_GAS_GRANT||call.data!=="0x")fail();
    return;
  }
  if(!same(call.from,collector)||call.value!==0n)fail();
  let target,expected;
  if(phase==="pool-approve") {
    target=MONAD_USDC;
    expected=encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[RELAY_DEPOSITORY,BigInt(batch.amount)]});
  } else if(phase==="pool-bridge") {
    if(!positive(batch.minOutput)||!/^0x[\da-f]{64}$/i.test(batch.bridge?.orderId)||!positive(batch.bridge?.minOutput)||BigInt(batch.bridge.minOutput)<BigInt(batch.minOutput))fail();
    target=RELAY_DEPOSITORY;
    expected=encodeFunctionData({abi:depositAbi,functionName:"depositErc20",args:[collector,MONAD_USDC,BigInt(batch.amount),batch.bridge.orderId]});
  } else fail();
  if(!same(call.to,target)||!same(call.data,expected))fail();
}
