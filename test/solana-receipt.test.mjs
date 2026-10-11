import test from "node:test";
import assert from "node:assert/strict";
import { createSolanaReceiptVerifier, SOLANA_MAINNET_GENESIS } from "../server/solana-receipt.mjs";

const signature="2".repeat(64),recipient="J7XmJiC44bFTbTzoAF69qhWPZq6LUkvf8wPk2UV4zXXL";
function response(result,id){return {ok:true,status:200,body:[Buffer.from(JSON.stringify({jsonrpc:"2.0",id,result}))]};}
function fetcher({genesis=SOLANA_MAINNET_GENESIS,received=4_900_000n,error=null,missing=false}={}){
  let id=0;return async(_url,init)=>{const request=JSON.parse(init.body);id++;assert.equal(request.id,id);
    if(request.method==="getGenesisHash")return response(genesis,id);
    if(missing)return response(null,id);
    return response({slot:123,blockTime:1_791_000_000,meta:{err:error,preBalances:[1_000_000,3_000_000],postBalances:[900_000,Number(3_000_000n+received)]},transaction:{signatures:[signature],message:{accountKeys:[{pubkey:"11111111111111111111111111111111"},{pubkey:recipient}]}}},id);
  };
}

test("finalized Solana receipt proves the exact published Animal Ethics account gained the signed minimum",async()=>{
  const verifier=createSolanaReceiptVerifier("https://rpc.example",fetcher());
  assert.equal(await verifier.ready(),true);
  const proof=await verifier.inspectNativeTransfer(signature,recipient,4_800_000n);
  assert.equal(proof.amount,4_900_000n);assert.equal(proof.eventId,`solana:${signature}:1`);
});

test("Solana verifier rejects wrong network, recipient, failed transaction and insufficient delivery",async()=>{
  assert.equal(await createSolanaReceiptVerifier("https://rpc.example",fetcher({genesis:"devnet"})).ready(),false);
  await assert.rejects(createSolanaReceiptVerifier("https://rpc.example",fetcher()).inspectNativeTransfer(signature,"3".repeat(44),1n));
  await assert.rejects(createSolanaReceiptVerifier("https://rpc.example",fetcher({error:{InstructionError:[0,"Custom"]}})).inspectNativeTransfer(signature,recipient,1n));
  await assert.rejects(createSolanaReceiptVerifier("https://rpc.example",fetcher({received:10n})).inspectNativeTransfer(signature,recipient,11n));
  assert.equal(await createSolanaReceiptVerifier("https://rpc.example",fetcher({missing:true})).inspectNativeTransfer(signature,recipient,1n),null);
});
