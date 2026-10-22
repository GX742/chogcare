import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Wallet } from "ethers";
import { sourceJournal, assertSourceNonceAvailable } from "../server/source-journal.mjs";
import { encodeFunctionData, erc20Abi } from "viem";
import { CHOG } from "../src/route.ts";
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

test("refund source phases pin the verified full amount, original sender and bounded operator funding",async()=>{
  const db=new DatabaseSync(":memory:"),journal=sourceJournal(db),operator=Wallet.createRandom(),child=Wallet.createRandom();
  try{
    db.exec("CREATE TABLE chog_refunds(invoice_id TEXT PRIMARY KEY,proof TEXT,operator TEXT)");
    const proof={kind:"wrong-chog-amount-deposit",invoiceId:id(1),depositAddress:child.address,sender:to,amountUnits:String(300n*10n**18n),quotedUnits:String(330n*10n**18n)};
    db.prepare("INSERT INTO chog_refunds VALUES(?,?,?)").run(id(1),JSON.stringify(proof),operator.address);
    const refund={...tx,to:CHOG,value:0n,nonce:0,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[to,BigInt(proof.amountUnits)]})};
    for(const patch of [{to},{value:1n},{nonce:1},{gasLimit:150001n},{data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[operator.address,BigInt(proof.amountUnits)]})},{data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[to,1n]})}]){
      const raw=await child.signTransaction({...refund,...patch});assert.throws(()=>journal.persist(id(1),"refund-chog",child.address,patch.nonce??0,raw));
    }
    const gas={...tx,to:child.address,nonce:0,value:1_000_000_000_000_000n};
    for(const patch of [{to},{value:50_000_000_000_000_000n},{data:"0x01"},{gasLimit:150001n}]){
      const raw=await operator.signTransaction({...gas,...patch});assert.throws(()=>journal.persist(id(1),"refund-gas",operator.address,0,raw));
    }
    journal.persist(id(1),"refund-gas",operator.address,0,await operator.signTransaction(gas));
    journal.persist(id(1),"refund-chog",child.address,0,await child.signTransaction(refund));
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_sends").get().n,2);
    assert.throws(()=>assertSourceNonceAvailable(db,child.address,0),/owns this nonce/);
  }finally{db.close();}
});

test("source nonce ownership includes private maintenance gas and refund journals before a new signature",()=>{
  const db=new DatabaseSync(":memory:"),wallet=Wallet.createRandom();sourceJournal(db);
  try{
    db.exec("CREATE TABLE manual_chog_refunds_fixture(gas_raw TEXT,gas_hash TEXT,gas_sender TEXT,gas_nonce INTEGER,refund_raw TEXT,refund_hash TEXT,refund_sender TEXT,refund_nonce INTEGER)");
    db.prepare("INSERT INTO manual_chog_refunds_fixture VALUES(?,?,?,?,?,?,?,?)").run("reserved","0x"+"a".repeat(64),wallet.address,7,"reserved","0x"+"b".repeat(64),wallet.address,8);
    assert.throws(()=>assertSourceNonceAvailable(db,wallet.address,7),/maintenance transaction/);
    assert.throws(()=>assertSourceNonceAvailable(db,wallet.address,8),/maintenance transaction/);
    assert.doesNotThrow(()=>assertSourceNonceAvailable(db,wallet.address,9));
  }finally{db.close();}
});
