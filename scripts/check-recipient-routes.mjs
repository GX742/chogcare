// Read-only discovery. No vault, wallet, database, signing or broadcast imports.
import { recipientCandidates } from "../server/recipient-candidates.mjs";
const payer="0x1111111111111111111111111111111111111111";
const originCurrency="0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const amount=process.argv[2]??"500000";
if(!/^[1-9]\d{0,11}$/.test(amount))throw new Error("Pass a positive USDC amount in base units, e.g. 500000 for 0.50 USDC.");
console.log(JSON.stringify({readOnly:true,checkedAt:new Date().toISOString(),amount,notice:"Indicative bridge-only quotes. CHOG sale, source gas, and recipient conversion costs are not included. Nothing is activated or signed."}));
for(const project of recipientCandidates)for(const route of project.routes){
  try{
    const response=await fetch("https://api.relay.link/quote/v2",{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(15000),body:JSON.stringify({
      user:payer,originChainId:143,destinationChainId:route.chainId,originCurrency,destinationCurrency:route.token,
      recipient:route.recipient,refundTo:payer,amount,tradeType:"EXACT_INPUT",includeProtocolData:true,slippageTolerance:"50",
    })});
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw new Error("Oversized quote.");chunks.push(chunk);}
    const quote=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!response.ok)throw new Error(`Quote HTTP ${response.status}`);
    const detail=quote.details,output=detail?.currencyOut;
    const same=(a,b)=>route.chainId===792703809?a===b:typeof a==="string"&&a.toLowerCase()===b.toLowerCase();
    if(!same(detail?.recipient,route.recipient)||output?.currency?.chainId!==route.chainId||!same(output.currency.address,route.token)||detail?.currencyIn?.amount!==amount)throw new Error("Unexpected quote destination or input.");
    console.log(JSON.stringify({project:project.id,chainId:route.chainId,asset:route.asset,recipient:route.recipient,expectedOutput:output.amount,minimumOutput:output.minimumAmount,expectedUsd:output.amountUsd,sourceGasUsd:quote.fees?.gas?.amountUsd,estimatedBridgeSeconds:detail.timeEstimate,blocker:project.blocker,paymentsEnabled:false}));
  }catch(error){console.log(JSON.stringify({project:project.id,chainId:route.chainId,error:error.message,paymentsEnabled:false}));process.exitCode=1;}
}
