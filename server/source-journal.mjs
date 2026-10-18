import { keccak256 } from "viem";
import { atomic } from "./sqlite-transaction.mjs";
import { Transaction } from "ethers";
import {SOURCE_GAS_GRANT,LEGACY_SOURCE_GAS_GRANT,sourceGasGrant} from "./source-gas-policy.mjs";

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
      if(!/^[a-f0-9]{64}$/.test(id) || !["gas","approve-chog","sell","swap","pool-contribution","approve-usdc","bridge","pool-gas","pool-approve","pool-bridge"].includes(phase) ||
        !tx.isSigned() || tx.chainId!==143n || tx.type!==2 || tx.from.toLowerCase()!==sender.toLowerCase() || tx.nonce!==nonce ||
        !tx.to || tx.accessList?.length || tx.gasLimit<21_000n || tx.gasLimit>1_500_000n || tx.maxFeePerGas<=0n || tx.maxFeePerGas>500_000_000_000n || tx.maxPriorityFeePerGas>tx.maxFeePerGas ||
        (phase==="gas" ? ![LEGACY_SOURCE_GAS_GRANT,SOURCE_GAS_GRANT].includes(tx.value) || tx.data!=="0x" : phase==="pool-gas" ? tx.value!==1n*10n**18n || tx.data!=="0x" : phase!=="swap" && tx.value!==0n))throw new Error("Invalid signed source transaction.");
      if(phase==="gas"&&tx.value===SOURCE_GAS_GRANT){
        const invoice=db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id);
        if(!invoice||sourceGasGrant(JSON.parse(invoice.document))!==SOURCE_GAS_GRANT)throw new Error("Gas funding does not match the persisted invoice.");
      }
      return atomic(db,()=>{
        const hash=keccak256(raw), day=new Date(now).toISOString().slice(0,10);
        const old=this.get(id,phase);
        if(old) { if(old.hash!==hash)throw new Error("Transaction replacement prohibited."); return old; }
        if(["gas","pool-gas"].includes(phase) && db.prepare("SELECT COUNT(*) AS n FROM source_sends WHERE phase IN ('gas','pool-gas') AND day=?").get(day).n>=20)throw new Error("Daily gas funding limit reached.");
        db.prepare("INSERT INTO source_sends VALUES(?,?,?,?,?,?,?)").run(id,phase,sender.toLowerCase(),nonce,hash,raw,day);
        return this.get(id,phase);
      });
    },
  };
}
