import { keccak256, encodeFunctionData, erc20Abi } from "viem";
import { atomic } from "./sqlite-transaction.mjs";
import { Transaction } from "ethers";
import {SOURCE_GAS_GRANT,LEGACY_SOURCE_GAS_GRANT,sourceGasGrant} from "./source-gas-policy.mjs";
import { CHOG } from "../src/route.ts";

const REFUND_NATIVE_CAP=50_000_000_000_000_000n;
const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
// All source signers share this nonce boundary, including older private
// maintenance journals. A missing RPC pending transaction is not permission to
// sign a different transaction using its persisted nonce.
export function assertSourceNonceAvailable(db,sender,nonce,allowedHash=null) {
  const existing=db.prepare("SELECT hash FROM source_sends WHERE sender=? AND nonce=?").get(sender.toLowerCase(),nonce);
  if(existing&&!same(existing.hash,allowedHash))throw new Error("A persisted source transaction already owns this nonce.");
  for(const {name:table} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'manual_chog_refunds*'").all()){
    if(table.match(/^manual_chog_refunds(?:_[a-z0-9_]+)?$/)?.[0]!==table)throw new Error("Unknown maintenance journal; preserve its nonce reservations.");
    const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
    for(const phase of ["gas","refund"]){
      if(![`${phase}_raw`,`${phase}_sender`,`${phase}_nonce`,`${phase}_hash`].every(key=>columns.has(key)))throw new Error("Unknown maintenance journal layout; preserve its nonce reservations.");
      const row=db.prepare(`SELECT ${phase}_hash AS hash FROM ${table} WHERE ${phase}_raw IS NOT NULL AND lower(${phase}_sender)=? AND ${phase}_nonce=? LIMIT 1`).get(sender.toLowerCase(),nonce);
      if(row&&!same(row.hash,allowedHash))throw new Error("A maintenance transaction already owns this source nonce.");
    }
  }
}

function validateRefundSubmission(db,id,phase,tx) {
  const job=db.prepare("SELECT proof,operator FROM chog_refunds WHERE invoice_id=?").get(id);
  if(!job)throw new Error("A verified immutable refund job is required.");
  const proof=JSON.parse(job.proof),amount=BigInt(proof.amountUnits);
  if(proof.kind!=="wrong-chog-amount-deposit"||proof.invoiceId!==id||amount<=0n||amount>=2n**256n||amount===BigInt(proof.quotedUnits)||
    tx.gasLimit>150_000n||tx.gasLimit*tx.maxFeePerGas>REFUND_NATIVE_CAP)throw new Error("Invalid pinned refund transaction.");
  if(phase==="refund-gas"){
    if(!same(tx.from,job.operator)||!same(tx.to,proof.depositAddress)||tx.data!=="0x"||tx.value<=0n||tx.value+tx.gasLimit*tx.maxFeePerGas>REFUND_NATIVE_CAP)throw new Error("Invalid bounded refund gas funding.");
  }else if(!same(tx.from,proof.depositAddress)||!same(tx.to,CHOG)||tx.nonce!==0||tx.value!==0n||!same(tx.data,encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[proof.sender,amount]})))throw new Error("Refund must return the exact verified payment to its original sender.");
}

// Serialized bytes stay private. A transport timeout never creates a new nonce.
export function sourceJournal(db) {
  db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS source_sends (
      invoice_id TEXT NOT NULL, phase TEXT NOT NULL, sender TEXT NOT NULL, nonce INTEGER NOT NULL,
      hash TEXT NOT NULL UNIQUE, raw TEXT NOT NULL, day TEXT NOT NULL,
      PRIMARY KEY(invoice_id,phase), UNIQUE(sender,nonce)
    );`);
  return {
    get(id,phase) { return db.prepare("SELECT * FROM source_sends WHERE invoice_id=? AND phase=?").get(id,phase); },
    persist(id,phase,sender,nonce,raw,now=Date.now()) {
      const tx=Transaction.from(raw);
      if(typeof id!=="string" || id.length!==64 || !/^[a-f0-9]{64}$/.test(id) || !["gas","approve-chog","sell","swap","pool-contribution","approve-usdc","bridge","pool-gas","pool-approve","pool-bridge","refund-gas","refund-chog"].includes(phase) ||
        !tx.isSigned() || tx.chainId!==143n || tx.type!==2 || tx.from.toLowerCase()!==sender.toLowerCase() || tx.nonce!==nonce ||
        !tx.to || tx.accessList?.length || tx.gasLimit<21_000n || tx.gasLimit>1_500_000n || tx.maxFeePerGas<=0n || tx.maxFeePerGas>500_000_000_000n || tx.maxPriorityFeePerGas>tx.maxFeePerGas ||
        (phase==="gas" ? ![LEGACY_SOURCE_GAS_GRANT,SOURCE_GAS_GRANT].includes(tx.value) || tx.data!=="0x" : phase==="pool-gas" ? tx.value!==1n*10n**18n || tx.data!=="0x" : phase==="refund-gas" ? tx.value<=0n || tx.value>REFUND_NATIVE_CAP || tx.data!=="0x" : phase!=="swap" && tx.value!==0n))throw new Error("Invalid signed source transaction.");
      if(phase==="gas"&&tx.value===SOURCE_GAS_GRANT){
        const invoice=db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id);
        if(!invoice||sourceGasGrant(JSON.parse(invoice.document))!==SOURCE_GAS_GRANT)throw new Error("Gas funding does not match the persisted invoice.");
      }
      if(phase==="refund-gas"||phase==="refund-chog")validateRefundSubmission(db,id,phase,tx);
      return atomic(db,()=>{
        const hash=keccak256(raw), day=new Date(now).toISOString().slice(0,10);
        const old=this.get(id,phase);
        if(old) { if(old.hash!==hash)throw new Error("Transaction replacement prohibited."); return old; }
        assertSourceNonceAvailable(db,sender,nonce);
        if(["gas","pool-gas","refund-gas"].includes(phase) && db.prepare("SELECT COUNT(*) AS n FROM source_sends WHERE phase IN ('gas','pool-gas','refund-gas') AND day=?").get(day).n>=20)throw new Error("Daily gas funding limit reached.");
        db.prepare("INSERT INTO source_sends VALUES(?,?,?,?,?,?,?)").run(id,phase,sender.toLowerCase(),nonce,hash,raw,day);
        return this.get(id,phase);
      });
    },
  };
}
