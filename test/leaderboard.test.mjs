import test from "node:test";
import assert from "node:assert/strict";
import { openInvoiceStore } from "../server/invoice-store.mjs";

test("leaderboard ranks exact CHOG units and exposes no invoice or wallet identity",()=>{
  const store=openInvoiceStore(":memory:");
  store.publishDonorProfile({invoiceId:"a".repeat(64),nickname:"Small Chog",initiativeId:"burundi",amount:"999.9",amountUnits:"999900000000000000000",avatarTokenId:null,avatarName:null,avatarImage:null,publishedAt:2});
  store.publishDonorProfile({invoiceId:"b".repeat(64),nickname:"Big Chog",initiativeId:"solar-foundation",amount:"1000",amountUnits:"1000000000000000000000",avatarTokenId:"1",avatarName:"CHOG #1462",avatarImage:"https://gateway.pinata.cloud/ipfs/bafybeihau2egcccbdxymeckmmbrqytbfor5gkt3en6d5fsbueymdbq7g6e/1462.webp",publishedAt:1});
  const result=store.leaderboard();
  assert.deepEqual(result.map(item=>[item.rank,item.nickname,item.amount]),[[1,"Big Chog","1000"],[2,"Small Chog","999.9"]]);
  assert.doesNotMatch(JSON.stringify(result),/"invoice|wallet|0x/i);
  store.close();
});
