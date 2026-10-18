import { setTimeout as delay } from "node:timers/promises";

const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();

// The caller has already validated and durably journaled these signed bytes.
// A failed send is ambiguous: observe the SAME hash, never build another tx.
// A short observation window lets a fast confirmed transaction advance to its
// next phase immediately instead of waiting for the next one-second worker tick.
export async function observeSourceSubmission(client, row, {checkpoint=()=>{},waitMs=1200,pollMs=200,now=Date.now,sleep=delay,onPending=()=>{}}={}) {
  if(!/^0x[0-9a-f]{64}$/i.test(row?.hash??"")||typeof row?.raw!=="string"||!Number.isFinite(waitMs)||waitMs<0||waitMs>2000||!Number.isFinite(pollMs)||pollMs<50||pollMs>500)throw new Error("Invalid persisted source observation.");
  const read=async()=>{
    try{return await client.getTransactionReceipt({hash:row.hash});}
    catch(error){if(error.name!=="TransactionReceiptNotFoundError")throw error;return null;}
  };
  let receipt=await read();
  if(receipt)return receipt;
  checkpoint();
  try{
    const returned=await client.sendRawTransaction({serializedTransaction:row.raw});
    if(!same(returned,row.hash))throw new Error("RPC hash mismatch.");
  }catch{onPending();}
  const deadline=now()+waitMs;
  // Both a clock bound and an attempt bound prevent an unhealthy/injected clock
  // from keeping the signer occupied indefinitely. Every attempt is read-only.
  for(let attempt=0;attempt<=Math.ceil(waitMs/pollMs);attempt++){
    receipt=await read();
    if(receipt)return receipt;
    const remaining=deadline-now();
    if(remaining<=0||attempt===Math.ceil(waitMs/pollMs))break;
    await sleep(Math.min(pollMs,remaining));
  }
  return null;
}
