import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddress, parseAbi, zeroAddress } from "viem";
import { CHOG, NAD_CURVE_ROUTER, NAD_DEX_ROUTER, MONAD_USDC, UNISWAP_ROUTER, UNISWAP_FEES, WMON, sellAbi, swapRouterAbi } from "../src/route.ts";
import { RELAY_DEPOSITORY } from "./relay-route.mjs";

const depositAbi=parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]);
const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
const positive=value=>typeof value==="string"&&/^\d{1,78}$/.test(value)&&BigInt(value)>0n&&BigInt(value)<2n**256n;
const fail=()=>{throw new Error("Source transaction violates the pinned invoice policy.");};

// A second check of locally built calldata before signing AND rebroadcasting.
// Defence in depth, not an isolated signer or protection from process compromise.
export function validateSourceCall(phase,call,invoice,operator,now=Date.now(),persisted=false) {
  const contributionInvoice=invoice?.contributionPercent===10;
  const minimumUnits=(contributionInvoice?330n:300n)*10n**18n,maximumUnits=(contributionInvoice?1_100_000n:1_000_000n)*10n**18n;
  if(!invoice || !positive(invoice.units) || BigInt(invoice.units)<minimumUnits || BigInt(invoice.units)>maximumUnits || typeof call.data!=="string" || call.data.length>2048)fail();
  const payer=invoice.depositAddress;
  const minimumSourceUsdc=invoice.minimumUsd??invoice.minOutput;
  if(!same(call.from,phase==="gas"?operator:payer))fail();
  if(phase==="gas") {
    if(!same(call.to,payer)||call.value!==5n*10n**18n||call.data!=="0x")fail();
    return;
  }
  if(phase!=="swap"&&call.value!==0n)fail();
  let expected, target;
  if(phase==="approve-chog"||phase==="sell") {
    if(![NAD_CURVE_ROUTER,NAD_DEX_ROUTER].some(x=>same(x,invoice.sale?.router))||!positive(invoice.sale?.minMon))fail();
    if(phase==="approve-chog") {
      target=CHOG;expected=encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[invoice.sale.router,BigInt(invoice.units)]});
    }else {
      target=invoice.sale.router;
      let data;try{data=decodeFunctionData({abi:sellAbi,data:call.data});}catch{fail();}
      const deadline=data.args[0].deadline;
      if(deadline<=0n || (!persisted && (deadline<BigInt(Math.floor(now/1000)) || deadline>BigInt(Math.floor(now/1000)+600))))fail();
      expected=encodeFunctionData({abi:sellAbi,functionName:"sell",args:[{amountIn:BigInt(invoice.units),amountOutMin:BigInt(invoice.sale.minMon),token:CHOG,to:payer,deadline}]});
    }
  }else if(phase==="swap") {
    if(!positive(invoice.monToSwap)||!positive(invoice.swap?.minUsdc)||!positive(minimumSourceUsdc)||!UNISWAP_FEES.includes(invoice.swap?.fee)||BigInt(invoice.swap.minUsdc)<BigInt(minimumSourceUsdc)||call.value!==BigInt(invoice.monToSwap))fail();
    target=UNISWAP_ROUTER;
    expected=encodeFunctionData({abi:swapRouterAbi,functionName:"exactInputSingle",args:[{tokenIn:WMON,tokenOut:MONAD_USDC,fee:invoice.swap.fee,recipient:payer,amountIn:BigInt(invoice.monToSwap),amountOutMinimum:BigInt(invoice.swap.minUsdc),sqrtPriceLimitX96:0n}]});
  }else if(phase==="pool-contribution") {
    if(!positive(invoice.poolContributionUsdc)||!isAddress(invoice.poolCollector)||same(invoice.poolCollector,zeroAddress)||same(invoice.poolCollector,payer))fail();
    target=MONAD_USDC;expected=encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[invoice.poolCollector,BigInt(invoice.poolContributionUsdc)]});
  }else if(phase==="approve-usdc"||phase==="bridge") {
    if(!positive(invoice.usdcToBridge))fail();
    if(phase==="approve-usdc") {
      target=MONAD_USDC;expected=encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[RELAY_DEPOSITORY,BigInt(invoice.usdcToBridge)]});
    }else {
      if(!/^0x[\da-f]{64}$/i.test(invoice.bridge?.orderId)||!positive(invoice.bridge?.minOutput))fail();
      if(invoice.destinationChainId===792703809){if(!positive(invoice.bridge.minimumOutputUsdMicros)||BigInt(invoice.bridge.minimumOutputUsdMicros)<BigInt(minimumSourceUsdc))fail();}
      else if(BigInt(invoice.bridge.minOutput)<BigInt(invoice.minOutput))fail();
      target=RELAY_DEPOSITORY;
      expected=encodeFunctionData({abi:depositAbi,functionName:"depositErc20",args:[payer,MONAD_USDC,BigInt(invoice.usdcToBridge),invoice.bridge.orderId]});
    }
  }else fail();
  if(!same(call.to,target)||!same(call.data,expected))fail();
}
