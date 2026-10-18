import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,readdirSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPoolLedger } from "../server/pool-ledger.mjs";
import { createNftProofLedger } from "../server/nft-proof-ledger.mjs";
import { canRepeatNftGrant,nftGrantScope,NFT_REPEAT_HOLDER } from "../server/nft-repeat-policy.mjs";
import { PAYMENT_POLICY } from "../server/policy.mjs";
import { getAddress } from "viem";
const day=Date.parse("2026-10-09T12:00:00Z"),collection=PAYMENT_POLICY.nftCollection;
test("the authorized repeat holder can reserve three grants on one NFT while the global daily cap and other-holder token limit remain",()=>{
  const db=new DatabaseSync(":memory:");try {
    const ledger=createPoolLedger(db,10);
    ledger.creditVerifiedFunding({chainId:10,txHash:"0x"+"ab".repeat(32),logIndex:0,units:20000000});
    assert.equal(canRepeatNftGrant(NFT_REPEAT_HOLDER.toUpperCase()),true);
    assert.equal(canRepeatNftGrant(NFT_REPEAT_HOLDER+"0"),false);
    assert.equal(canRepeatNftGrant("0x1111111111111111111111111111111111111111"),false);
    assert.equal(nftGrantScope(NFT_REPEAT_HOLDER,"first"),"repeat:first");
    assert.equal(nftGrantScope("0x1111111111111111111111111111111111111111","first"),"daily");
    const first=ledger.reserve({invoiceId:"first",collection,tokenId:"1638",holderAddress:NFT_REPEAT_HOLDER},day);
    assert.equal(first.claim_scope,"repeat:first");
    assert.equal(first.units,1000000);
    assert.equal(ledger.summary(day).reservedTodayUnits,1000000);
    assert.throws(()=>ledger.reserve({invoiceId:"same-token",collection,tokenId:"1638",holderAddress:"0x1111111111111111111111111111111111111111"},day),/NFT already/);
    assert.throws(()=>ledger.reserve({invoiceId:"zero-padded-token",collection:getAddress(collection),tokenId:"0001638",holderAddress:"0x1111111111111111111111111111111111111111"},day),/NFT already/);
    assert.throws(()=>ledger.reserve({invoiceId:"another-owner",collection,tokenId:"1638"},day));
    for(const [index,invoiceId] of ["first","second","third"].entries()){
      const reservation=ledger.reserve({invoiceId,collection,tokenId:"1638",holderAddress:getAddress(NFT_REPEAT_HOLDER)},day);
      assert.equal(reservation.claim_scope,`repeat:${invoiceId}`);
      assert.equal(reservation.units,1000000);
      const hash=`0x${String(index+1).repeat(64)}`;
      ledger.recordSubmission(invoiceId,hash,day);ledger.markPaid(invoiceId,hash);
    }
    assert.equal(ledger.summary(day).reservedTodayUnits,3000000);
    assert.equal(ledger.summary(day).availableClaims,0);
    assert.throws(()=>ledger.reserve({invoiceId:"fourth",collection,tokenId:"1638",holderAddress:NFT_REPEAT_HOLDER},day),/daily pool limit/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_reservations").get().n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_payout_days").get().n,3);
  }finally{db.close();}
});

test("repeat permission does not bypass funding or the global submission-day cap for a delayed backlog",()=>{
  const db=new DatabaseSync(":memory:");try{
    const ledger=createPoolLedger(db,10),reservation=invoiceId=>({invoiceId,collection,tokenId:"1638",holderAddress:NFT_REPEAT_HOLDER});
    assert.throws(()=>ledger.reserve(reservation("unfunded"),day),/funding is insufficient/);
    ledger.creditVerifiedFunding({chainId:10,txHash:"0x"+"ab".repeat(32),logIndex:0,units:20000000});
    for(const invoiceId of ["old-first","old-second","old-third"])ledger.reserve(reservation(invoiceId),day);
    ledger.reserve(reservation("new-fourth"),day+86400000);
    for(const [index,invoiceId] of ["old-first","old-second","old-third"].entries())ledger.recordSubmission(invoiceId,`0x${String(index+1).repeat(64)}`,day+86400000);
    assert.throws(()=>ledger.recordSubmission("new-fourth","0x"+"4".repeat(64),day+86400000),/daily payout submission limit/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n,SUM(units) AS units FROM pool_payout_days").get().n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n,SUM(units) AS units FROM pool_payout_days").get().units,3000000);
    assert.equal(db.prepare("SELECT state,payout_hash FROM pool_reservations WHERE invoice_id='new-fourth'").get().state,"reserved");
  }finally{db.close();}
});
test("repeat proof never reuses a transaction hash and cannot assign exception scope to another holder",()=>{
  const db=new DatabaseSync(":memory:");try {
    const ledger=createNftProofLedger(db);
    const proof={kind:"confirmed-nft-transfer",invoiceId:"first",chainId:143,collection,tokenId:"1638",sender:NFT_REPEAT_HOLDER,txHash:"0x"+"aa".repeat(32),blockHash:"0x"+"bb".repeat(32),blockNumber:"100"};
    ledger.recordVerifiedProof(proof,day);
    assert.throws(()=>ledger.recordVerifiedProof({...proof,invoiceId:"second"},day,"repeat:second"));
    assert.throws(()=>ledger.recordVerifiedProof({...proof,invoiceId:"second"},day));
    assert.throws(()=>ledger.recordVerifiedProof({...proof,invoiceId:"other",sender:"0x1111111111111111111111111111111111111111",txHash:"0x"+"cc".repeat(32)},day,"repeat:other"));
    assert.throws(()=>ledger.recordVerifiedProof({...proof,invoiceId:"second",txHash:"0x"+"dd".repeat(32)},day));
    ledger.recordVerifiedProof({...proof,invoiceId:"second",txHash:"0x"+"dd".repeat(32)},day,"repeat:second");
  }finally{db.close();}
});
test("legacy reservations migrate with backup, values and payout foreign keys preserved",()=>{
  const dir=mkdtempSync(join(tmpdir(),"chog-repeat-migration-")),filename=join(dir,"test.sqlite"),db=new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE pool_reservations (
      invoice_id TEXT PRIMARY KEY,collection TEXT NOT NULL,token_id TEXT NOT NULL,day TEXT NOT NULL,
      units INTEGER NOT NULL CHECK(units=500000),state TEXT NOT NULL,payout_hash TEXT UNIQUE,UNIQUE(collection,token_id,day));
      CREATE TABLE nft_invoices(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE preserved_payout(invoice_id TEXT REFERENCES pool_reservations(invoice_id),hash TEXT);`);
    db.prepare("INSERT INTO pool_reservations VALUES ('old',?,'1638','2026-10-09',500000,'submitted',?)").run(collection,"0x"+"ee".repeat(32));
    db.prepare("INSERT INTO nft_invoices VALUES ('old','paying',?)").run(JSON.stringify({holderAddress:NFT_REPEAT_HOLDER}));
    db.exec("INSERT INTO preserved_payout VALUES ('old','unchanged')");
    const ledger=createPoolLedger(db);
    assert.equal(db.prepare("SELECT claim_scope FROM pool_reservations WHERE invoice_id='old'").get().claim_scope,"daily");
    assert.equal(db.prepare("SELECT units FROM pool_reservations WHERE invoice_id='old'").get().units,500000);
    assert.equal(db.prepare("SELECT holder_address FROM pool_reservations WHERE invoice_id='old'").get().holder_address,NFT_REPEAT_HOLDER);
    ledger.creditVerifiedFunding({chainId:1,txHash:"0x"+"ab".repeat(32),logIndex:0,units:10000000});
    ledger.markPaid("old","0x"+"ee".repeat(32));
    db.prepare("UPDATE nft_invoices SET state='delivered' WHERE id='old'").run();
    const repeated=ledger.reserve({invoiceId:"old-wallet-new-token",collection,tokenId:"1639",holderAddress:NFT_REPEAT_HOLDER},day);
    assert.equal(repeated.claim_scope,"repeat:old-wallet-new-token");
    assert.equal(db.prepare("SELECT claim_scope,units FROM pool_reservations WHERE invoice_id='old'").get().claim_scope,"daily");
    assert.equal(db.prepare("SELECT claim_scope,units FROM pool_reservations WHERE invoice_id='old'").get().units,500000);
    assert.throws(()=>ledger.reserve({invoiceId:"old-token-new-wallet",collection,tokenId:"1638",holderAddress:"0x1111111111111111111111111111111111111111"},day),/NFT already/);
    assert.equal(readdirSync(dir).filter(n=>n.includes('.before-dollar-grants-')).length,1);
    assert.equal(db.prepare("SELECT hash FROM preserved_payout").get().hash,"unchanged");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length,0);
    assert.equal(readdirSync(dir).filter(n=>n.includes('.before-repeat-')).length,1);
    assert.equal(readdirSync(dir).filter(n=>n.includes('.before-dollar-grants-')).length,1);
    createPoolLedger(db);
    assert.equal(readdirSync(dir).filter(n=>n.includes('.before-repeat-')).length,1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
