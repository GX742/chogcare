import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { validateSourceCall } from "../server/source-policy.mjs";
import { CHOG, NAD_DEX_ROUTER, MONAD_USDC, UNISWAP_ROUTER, WMON, sellAbi, swapRouterAbi } from "../src/route.ts";
import { RELAY_DEPOSITORY } from "../server/relay-route.mjs";
const payer="0x1111111111111111111111111111111111111111",operator="0x2222222222222222222222222222222222222222";
const poolCollector="0x3333333333333333333333333333333333333333";
const now=1800000000000;
const invoice={depositAddress:payer,units:String(300n*10n**18n),sale:{router:NAD_DEX_ROUTER,minMon:String(10n**18n)},monToSwap:String(10n**18n),swap:{fee:500,minUsdc:"950000"},minOutput:"900000",usdcToBridge:"1000000",bridge:{orderId:`0x${"ab".repeat(32)}`,minOutput:"930000"}};
const approve=(to,spender,amount)=>({from:payer,to,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[spender,amount]})});
const calls={
  gas:{from:operator,to:payer,value:5n*10n**18n,data:"0x"},
  "approve-chog":approve(CHOG,NAD_DEX_ROUTER,BigInt(invoice.units)),
  sell:{from:payer,to:NAD_DEX_ROUTER,value:0n,data:encodeFunctionData({abi:sellAbi,functionName:"sell",args:[{amountIn:BigInt(invoice.units),amountOutMin:10n**18n,token:CHOG,to:payer,deadline:BigInt(now/1000+300)}]})},
  swap:{from:payer,to:UNISWAP_ROUTER,value:10n**18n,data:encodeFunctionData({abi:swapRouterAbi,functionName:"exactInputSingle",args:[{tokenIn:WMON,tokenOut:MONAD_USDC,fee:500,recipient:payer,amountIn:10n**18n,amountOutMinimum:950000n,sqrtPriceLimitX96:0n}]})},
  "approve-usdc":approve(MONAD_USDC,RELAY_DEPOSITORY,1000000n),
  bridge:{from:payer,to:RELAY_DEPOSITORY,value:0n,data:encodeFunctionData({abi:parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]),functionName:"depositErc20",args:[payer,MONAD_USDC,1000000n,invoice.bridge.orderId]})},
};
test("every source phase binds recipient, exact amount, spender, token and canonical calldata",()=>{
  for(const [phase,call] of Object.entries(calls)) {
    assert.doesNotThrow(()=>validateSourceCall(phase,call,invoice,operator,now));
    for(const change of [{to:operator},{value:call.value+1n},{data:call.data+"00"},{from:phase==="gas"?payer:operator}])assert.throws(()=>validateSourceCall(phase,{...call,...change},invoice,operator,now));
  }
  assert.throws(()=>validateSourceCall("approve-chog",approve(CHOG,NAD_DEX_ROUTER,2n**256n-1n),invoice,operator,now));
  assert.throws(()=>validateSourceCall("approve-usdc",approve(MONAD_USDC,operator,1000000n),invoice,operator,now));
  assert.throws(()=>validateSourceCall("sell",calls.sell,{...invoice,sale:{...invoice.sale,router:operator}},operator,now));
  assert.throws(()=>validateSourceCall("bridge",calls.bridge,{...invoice,bridge:{...invoice.bridge,orderId:`0x${"cd".repeat(32)}`}},operator,now));
});
test("new expired sale cannot be signed, old immutable bytes retain their original deadline",()=>{
  assert.throws(()=>validateSourceCall("sell",calls.sell,invoice,operator,now+700000));
  assert.doesNotThrow(()=>validateSourceCall("sell",calls.sell,invoice,operator,now+700000,true));
});
test("mandatory contribution binds the exact pool collector and exact USDC units",()=>{
  const contributionInvoice={...invoice,units:String(330n*10n**18n),contributionPercent:10,poolCollector,poolContributionUsdc:"100000"};
  const call={from:payer,to:MONAD_USDC,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[poolCollector,100000n]})};
  assert.doesNotThrow(()=>validateSourceCall("pool-contribution",call,contributionInvoice,operator,now));
  assert.throws(()=>validateSourceCall("pool-contribution",{...call,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[poolCollector,99999n]})},contributionInvoice,operator,now));
  assert.throws(()=>validateSourceCall("pool-contribution",call,{...contributionInvoice,poolCollector:operator},operator,now));
});

test("source approvals and sale bind full proof-backed excess while preserving the original invoice limits",()=>{
  const txHash=`0x${"ac".repeat(32)}`,received=333n*10n**18n;
  const overpaid={...invoice,id:"a".repeat(64),units:String(330n*10n**18n),contributionPercent:10,receivedUnits:String(received),depositHash:txHash,
    depositProof:{kind:"confirmed-chog-transfer",invoiceId:"a".repeat(64),chainId:143,txHash,sender:operator,amountUnits:String(received),logIndex:0,blockNumber:"100",blockHash:`0x${"bd".repeat(32)}`}};
  const approval=approve(CHOG,NAD_DEX_ROUTER,received);
  const sale={...calls.sell,data:encodeFunctionData({abi:sellAbi,functionName:"sell",args:[{amountIn:received,amountOutMin:10n**18n,token:CHOG,to:payer,deadline:BigInt(now/1000+300)}]})};
  assert.doesNotThrow(()=>validateSourceCall("approve-chog",approval,overpaid,operator,now));
  assert.doesNotThrow(()=>validateSourceCall("sell",sale,overpaid,operator,now));
  assert.throws(()=>validateSourceCall("approve-chog",approve(CHOG,NAD_DEX_ROUTER,330n*10n**18n),overpaid,operator,now));
  assert.throws(()=>validateSourceCall("sell",calls.sell,overpaid,operator,now));
  for(const invalid of [{...overpaid,depositProof:null},{...overpaid,units:"1"},{...overpaid,units:String(1_100_001n*10n**18n)},
    {...overpaid,receivedUnits:String(received+1n)}, {...overpaid,depositProof:{...overpaid.depositProof,blockHash:"0x"}}]){
    assert.throws(()=>validateSourceCall("approve-chog",approval,invalid,operator,now));
    assert.throws(()=>validateSourceCall("gas",calls.gas,invalid,operator,now));
  }
});
