import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";
import { parseUnits } from "viem";

test("leaderboard ranks exact CHOG units and exposes no invoice or wallet identity",()=>{
  const store=openInvoiceStore(":memory:");
  store.publishDonorProfile({invoiceId:"a".repeat(64),nickname:"Small Chog",initiativeId:"burundi",amount:"999.9",amountUnits:"999900000000000000000",avatarTokenId:null,avatarName:null,avatarImage:null,publishedAt:2});
  store.publishDonorProfile({invoiceId:"b".repeat(64),nickname:"Big Chog",initiativeId:"solar-foundation",amount:"1000",amountUnits:"1000000000000000000000",avatarTokenId:"1",avatarName:"CHOG #1462",avatarImage:"https://gateway.pinata.cloud/ipfs/bafybeihau2egcccbdxymeckmmbrqytbfor5gkt3en6d5fsbueymdbq7g6e/1462.webp",publishedAt:1});
  const result=store.leaderboard();
  assert.deepEqual(result.map(item=>[item.rank,item.nickname,item.amount]),[[1,"Big Chog","1000"],[2,"Small Chog","999.9"]]);
  assert.doesNotMatch(JSON.stringify(result),/"invoice|wallet|0x/i);
  store.close();
});

test("HTTP leaderboard aggregates all published donations before ranking and leaks no donor identity",async()=>{
  const store=openInvoiceStore(":memory:"), contexts=new Map();
  for(let index=1;index<=50;index++){
    const invoiceId=index.toString(16).padStart(64,"0");
    store.publishDonorProfile({invoiceId,nickname:index===50?"Updated GX":"GX",initiativeId:"school-supplies",amount:"300",amountUnits:parseUnits("300",18).toString(),avatarTokenId:null,publishedAt:index});
    contexts.set(invoiceId,{sender:"0x1111111111111111111111111111111111111111",state:"delivered",amount:"300",initiativeId:"school-supplies"});
  }
  assert.equal(store.leaderboardRecords().length,50);
  const service=createPaymentService(store,"http://127.0.0.1:4173",true,{leaderboardDonation:id=>contexts.get(id)});
  service.listen(0,"127.0.0.1");await once(service,"listening");
  try{
    const response=await fetch(`http://127.0.0.1:${service.address().port}/api/payments/leaderboard`), body=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(body.entries.map(entry=>[entry.rank,entry.nickname,entry.amount]),[[1,"Updated GX","15000"]]);
    assert.doesNotMatch(JSON.stringify(body),/invoice|sender|wallet|0x/i);
  }finally{service.close();await once(service,"close");store.close();}
});

test("verified confirming donations appear as finalizing without exposing payment identity",async()=>{
  const invoiceId="c".repeat(64),store=openInvoiceStore(":memory:");
  let state="confirming";
  const processor={
    profileNfts:async id=>{assert.equal(id,invoiceId);return{state,initiativeId:"school-supplies",amount:"300",nfts:[]};},
    get:id=>id===invoiceId?{state}:null,
    leaderboardDonation:id=>id===invoiceId?{sender:"0x1111111111111111111111111111111111111111",state,initiativeId:"school-supplies",amount:"300"}:null,
    checkpoint:async()=>{},
  };
  const service=createPaymentService(store,"http://127.0.0.1:4173",true,processor);
  service.listen(0,"127.0.0.1");await once(service,"listening");
  const base=`http://127.0.0.1:${service.address().port}`;
  try{
    const published=await fetch(`${base}/api/payments/leaderboard`,{method:"POST",headers:{Origin:"http://127.0.0.1:4173","Content-Type":"application/json"},body:JSON.stringify({invoiceId,nickname:"Fresh Chog",avatarTokenId:null})});
    assert.equal(published.status,201);
    let response=await fetch(`${base}/api/payments/leaderboard`),body=await response.json();
    assert.deepEqual(body.entries.map(entry=>[entry.nickname,entry.amount,entry.status]),[["Fresh Chog","300","confirming"]]);
    assert.doesNotMatch(JSON.stringify(body),new RegExp(`${invoiceId}|wallet`,"i"));
    state="processing";
    response=await fetch(`${base}/api/payments/leaderboard`);body=await response.json();
    assert.deepEqual(body.entries,[]);
    state="delivered";
    response=await fetch(`${base}/api/payments/leaderboard`);body=await response.json();
    assert.equal(body.entries[0].status,"delivered");
  }finally{service.close();await once(service,"close");store.close();}
});
