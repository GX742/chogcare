// Read-only: no vault, DB, wallet, signing, invoice creation or broadcasts.
import { createPublicClient, http, formatUnits } from "viem";
import { monad } from "viem/chains";
import { saleQuote, usdcQuote } from "../server/source-quotes.mjs";
import { bridgeQuote } from "../server/relay-route.mjs";
import { assertBridgeDelivery, assertCrossAssetBridgeDelivery } from "../server/bridge-cost-policy.mjs";
const client=createPublicClient({chain:monad,transport:http("https://rpc.monad.xyz",{timeout:15000,retryCount:0})});
const payer="0x1111111111111111111111111111111111111111";
if(await client.getChainId()!==143)throw Error("Wrong source network");
const baseline=300n*10n**18n;
const sale=await saleQuote(client,baseline);
// Reverse only quote haircuts to obtain an executable reference, NOT a spot price.
const baseSwap=await usdcQuote(client,BigInt(sale.minMon)*100n/99n);
const reference=BigInt(baseSwap.minUsdc)*100n/99n;
const routes=[
  {id:"school-supplies",chainId:10,asset:"USDC",decimals:6},
  {id:"solar-foundation",chainId:10,asset:"USDC",decimals:6},
  {id:"vida-verde",chainId:10,asset:"USDC",decimals:6},
  {id:"animal-ethics",chainId:792703809,asset:"SOL",decimals:9},
];
console.log(JSON.stringify({readOnly:true,checkedAt:new Date().toISOString(),referenceChog:"300",referenceUsdc:formatUnits(reference,6),notice:"CHOG equivalent uses a 300-CHOG executable conversion reference, not an independent USD spot price. Source gas extra. Slippage reserves are not fixed fees. Bridge-only rows start AFTER the CHOG conversion."}));
for(const amount of [5000000n,10000000n]) {
  const equivalent=baseline*amount/reference;
  if(equivalent<baseline) console.log(JSON.stringify({inputUsdcEquivalent:formatUnits(amount,6),chog:formatUnits(equivalent,18),error:"Below the 300 CHOG checkout minimum"}));
  else {
    const s=await saleQuote(client,equivalent),u=await usdcQuote(client,BigInt(s.minMon));
    for(const route of routes) {
      try {
        const q=await bridgeQuote(payer,BigInt(u.minUsdc),1n,route.chainId,route.id);
        let accepted=true;try{assertBridgeDelivery(q,1n);if(route.asset==="SOL")assertCrossAssetBridgeDelivery(q,1n);}catch{accepted=false;}
        console.log(JSON.stringify({kind:"CHOG-conservative-route",project:route.id,inputUsdcEquivalent:formatUnits(amount,6),chog:formatUnits(equivalent,18),conversionMinimumUsdc:formatUnits(BigInt(u.minUsdc),6),outputAsset:route.asset,expectedRecipient:formatUnits(BigInt(q.expectedOutput),route.decimals),minimumRecipient:formatUnits(BigInt(q.minOutput),route.decimals),expectedRecipientUsd:formatUnits(BigInt(q.expectedOutputUsdMicros),6),minimumRecipientUsd:formatUnits(BigInt(q.minimumOutputUsdMicros),6),accepted,solverSignatureVerified:true}));
      } catch(e) {console.log(JSON.stringify({project:route.id,error:e.message}));process.exitCode=1;}
    }
  }
  for(const route of routes) {
    try {const q=await bridgeQuote(payer,amount,1n,route.chainId,route.id);console.log(JSON.stringify({kind:"bridge-only",project:route.id,inputUsdc:formatUnits(amount,6),outputAsset:route.asset,expectedRecipient:formatUnits(BigInt(q.expectedOutput),route.decimals),minimumRecipient:formatUnits(BigInt(q.minOutput),route.decimals),expectedRecipientUsd:formatUnits(BigInt(q.expectedOutputUsdMicros),6),minimumRecipientUsd:formatUnits(BigInt(q.minimumOutputUsdMicros),6),solverSignatureVerified:true}));}
    catch(e){console.log(JSON.stringify({project:route.id,error:e.message}));process.exitCode=1;}
  }
}
