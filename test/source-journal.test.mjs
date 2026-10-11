import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Wallet } from "ethers";
import { sourceJournal } from "../server/source-journal.mjs";
const id=n=>n.toString(16).padStart(64,"0");
const to="0x1111111111111111111111111111111111111111";
const tx={chainId:143,type:2,to,value:5n*10n**18n,data:"0x",gasLimit:100000n,maxFeePerGas:2_000_000_000n,maxPriorityFeePerGas:100000000n};
test("source journal enforces signed network/sender/nonce, immutable phase and daily gas cap",async()=>{
  const db=new DatabaseSync(":memory:"), journal=sourceJournal(db), wallet=Wallet.createRandom();
  try {
    const raw=await wallet.signTransaction({...tx,nonce:0});
    const saved=journal.persist(id(1),"gas",wallet.address,0,raw);
    assert.equal(journal.persist(id(1),"gas",wallet.address,0,raw).hash,saved.hash);
    assert.throws(()=>journal.persist(id(2),"gas",wallet.address,0,raw));
    assert.throws(()=>journal.persist(id(1),"sell",wallet.address,0,raw));
    for(const modified of [{chainId:1},{value:6n*10n**18n},{gasLimit:1500001n},{data:"0x1234"},{maxFeePerGas:501000000000n}]){
      const bad=await wallet.signTransaction({...tx,nonce:1,...modified});
      assert.throws(()=>journal.persist(id(2),"gas",wallet.address,1,bad));
    }
    assert.throws(()=>journal.persist(id(2),"gas",to,0,raw));
    assert.throws(()=>journal.persist(id(2),"gas",wallet.address,1,raw));
    for(let i=1;i<20;i++)journal.persist(id(i+1),"gas",wallet.address,i,await wallet.signTransaction({...tx,nonce:i}));
    assert.throws(()=>journal.persist(id(21),"gas",wallet.address,20,"0x"));
    const next=await wallet.signTransaction({...tx,nonce:20});
    assert.throws(()=>journal.persist(id(21),"gas",wallet.address,20,next),/Daily gas/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_sends").get().n,20);
  }finally{db.close();}
});
