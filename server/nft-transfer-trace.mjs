const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
// Accept only a successful value-bearing CALL, with no reverted ancestor.
// Delegatecall itself never proves a native transfer. Bound traversal work.
export function matchingNftTransfers(trace,holder,deposit) {
  const matches=[];let visited=0;
  function visit(call,depth) {
    if(++visited>20000||depth>128)throw new Error("NFT trace exceeds verification limits.");
    if(!call||typeof call!=="object"||call.error||call.revertReason)return;
    if(call.type==="CALL"&&same(call.from,holder)&&same(call.to,deposit)&&call.input==="0x"&&
      typeof call.value==="string"&&/^0x[0-9a-f]+$/i.test(call.value)&&BigInt(call.value)===10n**18n)matches.push(call);
    if(call.calls!==undefined&&!Array.isArray(call.calls))throw new Error("Invalid NFT call trace.");
    for(const child of call.calls??[])visit(child,depth+1);
  }
  visit(trace,0);return matches;
}

export async function verifyInternalNftTransfer(client,tx,holder,deposit) {
  if(typeof client.request!=="function")throw new Error("Internal transfer tracing unavailable.");
  const trace=await client.request({method:"debug_traceTransaction",params:[tx.hash,{tracer:"callTracer"}]});
  if(!trace||trace.error||!same(trace.from,tx.from)||!same(trace.to,tx.to)||trace.input!==tx.input||
    typeof trace.value!=="string"||!/^0x[0-9a-f]+$/i.test(trace.value)||BigInt(trace.value)!==tx.value||
    matchingNftTransfers(trace,holder,deposit).length!==1)throw new Error("Internal NFT transfer does not match the confirmed transaction.");
}
