// Minimal read-only Solana mainnet verifier. It accepts no arbitrary RPC method
// or URL from HTTP and never signs or broadcasts a Solana transaction.
// RPC returns the full genesis hash, not the shortened CAIP-2 network identifier.
// https://solana.com/docs/payments/agentic-payments/x402#solana-networks-and-assets
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const signaturePattern=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const publicKeyPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createSolanaReceiptVerifier(rpcUrl="https://api.mainnet-beta.solana.com", fetcher=fetch) {
  if(new URL(rpcUrl).protocol!=="https:")throw new Error("HTTPS Solana RPC required.");
  let requestId=0;
  const rpc=async(method,params=[])=>{
    if(!["getGenesisHash","getTransaction"].includes(method))throw new Error("Unsupported Solana RPC method.");
    const id=++requestId;
    const response=await fetcher(rpcUrl,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
    let bytes=0;const chunks=[];
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>524288)throw new Error("Oversized Solana RPC response.");chunks.push(chunk);}
    if(!response.ok)throw new Error("Solana RPC unavailable.");
    const json=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(json?.jsonrpc!=="2.0"||json.id!==id||json.error)throw new Error("Invalid Solana RPC response.");
    return json.result;
  };
  return {
    async ready(){return await rpc("getGenesisHash")===SOLANA_MAINNET_GENESIS;},
    async inspectNativeTransfer(signature,recipient,minimumLamports){
      if(!signaturePattern.test(signature)||!publicKeyPattern.test(recipient)||typeof minimumLamports!=="bigint"||minimumLamports<=0n)throw new Error("Invalid Solana receipt request.");
      const result=await rpc("getTransaction",[signature,{encoding:"jsonParsed",commitment:"finalized",maxSupportedTransactionVersion:0}]);
      if(result===null)return null;
      const signatures=result?.transaction?.signatures,keys=result?.transaction?.message?.accountKeys,meta=result?.meta;
      if(!Array.isArray(signatures)||signatures[0]!==signature||signatures.some(x=>!signaturePattern.test(x))||!Array.isArray(keys)||!Array.isArray(meta?.preBalances)||!Array.isArray(meta?.postBalances)||meta.err!==null||keys.length!==meta.preBalances.length||keys.length!==meta.postBalances.length)throw new Error("Invalid finalized Solana transaction.");
      const normalized=keys.map(k=>typeof k==="string"?k:k?.pubkey);
      if(normalized.some(k=>!publicKeyPattern.test(k)))throw new Error("Invalid Solana account list.");
      const index=normalized.indexOf(recipient);
      if(index<0)throw new Error("Animal Ethics recipient missing from Solana transfer.");
      const before=meta.preBalances[index],after=meta.postBalances[index];
      if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||before<0||after<0)throw new Error("Invalid Solana balance proof.");
      const received=BigInt(after)-BigInt(before);
      if(received<minimumLamports)throw new Error("Solana delivery is below the signed minimum.");
      if(!Number.isSafeInteger(result.blockTime)||result.blockTime<=0||!Number.isSafeInteger(result.slot)||result.slot<=0)throw new Error("Invalid Solana finality metadata.");
      return {finalized:true,amount:received,blockTime:result.blockTime,eventId:`solana:${signature}:${index}`};
    },
  };
}
