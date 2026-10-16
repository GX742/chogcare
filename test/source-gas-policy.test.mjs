import test from "node:test";
import assert from "node:assert/strict";
import {Wallet} from "ethers";
import {DatabaseSync} from "node:sqlite";
import {SOURCE_GAS_GRANT,LEGACY_SOURCE_GAS_GRANT,SOURCE_PHASE_GAS_LIMITS,SOURCE_MAX_FEE,OPERATOR_READY_BALANCE,sourceGasGrant,validateSourceGas,sourceGasCharge} from "../server/source-gas-policy.mjs";
import {sourceJournal} from "../server/source-journal.mjs";
import {validateSourceCall} from "../server/source-policy.mjs";

const plan={sourceGasPlanVersion:2,gasGrantUnits:String(SOURCE_GAS_GRANT)};
const payer="0x1111111111111111111111111111111111111111";

test("the new gas grant covers every phase at the maximum allowed gas price",()=>{
  const childGas=Object.entries(SOURCE_PHASE_GAS_LIMITS).filter(([phase])=>phase!=="gas").reduce((sum,[,limit])=>sum+limit,0n);
  assert.equal(childGas,2_600_000n);
  assert.ok(SOURCE_GAS_GRANT>childGas*SOURCE_MAX_FEE);
  assert.ok(OPERATOR_READY_BALANCE>=SOURCE_GAS_GRANT+SOURCE_PHASE_GAS_LIMITS.gas*SOURCE_MAX_FEE);
  assert.ok(SOURCE_GAS_GRANT<LEGACY_SOURCE_GAS_GRANT);
});

test("legacy invoices keep their five-MON grant and unknown gas plans fail closed",()=>{
  assert.equal(sourceGasGrant({}),LEGACY_SOURCE_GAS_GRANT);
  assert.equal(sourceGasGrant(plan),SOURCE_GAS_GRANT);
  for(const changed of [{sourceGasPlanVersion:2},{gasGrantUnits:String(SOURCE_GAS_GRANT)},{...plan,sourceGasPlanVersion:3},{...plan,gasGrantUnits:String(LEGACY_SOURCE_GAS_GRANT)},{sourceGasPlanVersion:null,gasGrantUnits:null}])assert.throws(()=>sourceGasGrant(changed),/Unknown source gas plan/);
});

test("every new-invoice source phase has an enforced gas and fee ceiling",()=>{
  for(const [phase,gasLimit] of Object.entries(SOURCE_PHASE_GAS_LIMITS)){
    const call={gasLimit,maxFeePerGas:SOURCE_MAX_FEE};
    assert.doesNotThrow(()=>validateSourceGas(phase,call,plan));
    for(const change of [{gasLimit:gasLimit+1n},{gasLimit:20_999n},{gasLimit:Number(gasLimit)},{maxFeePerGas:SOURCE_MAX_FEE+1n},{maxFeePerGas:0n}])assert.throws(()=>validateSourceGas(phase,{...call,...change},plan),/funded invoice budget/);
  }
  assert.throws(()=>validateSourceGas("unknown",{gasLimit:21_000n,maxFeePerGas:1n},plan));
  assert.doesNotThrow(()=>validateSourceGas("sell",{gasLimit:1_500_000n,maxFeePerGas:SOURCE_MAX_FEE},{}),"old signed calls remain valid under their original policy");
});

test("funding calldata must match the invoice-bound gas plan, not a global new default",()=>{
  const operator="0x2222222222222222222222222222222222222222";
  const invoice={depositAddress:payer,units:String(300n*10n**18n)};
  const call={from:operator,to:payer,value:SOURCE_GAS_GRANT,data:"0x",gasLimit:21_000n,maxFeePerGas:100_000_000_000n};
  assert.doesNotThrow(()=>validateSourceCall("gas",call,{...invoice,...plan},operator));
  assert.throws(()=>validateSourceCall("gas",call,invoice,operator));
  assert.doesNotThrow(()=>validateSourceCall("gas",{...call,value:LEGACY_SOURCE_GAS_GRANT},invoice,operator));
  assert.throws(()=>validateSourceCall("gas",{...call,value:LEGACY_SOURCE_GAS_GRANT},{...invoice,...plan},operator));
});

test("reduced gas funding is journaled only for a persisted matching invoice",async()=>{
  const db=new DatabaseSync(":memory:"),wallet=Wallet.createRandom(),journal=sourceJournal(db),id="ab".repeat(32);
  db.exec("CREATE TABLE chog_invoices (id TEXT PRIMARY KEY, document TEXT NOT NULL)");
  const raw=await wallet.signTransaction({type:2,chainId:143,nonce:0,to:payer,value:SOURCE_GAS_GRANT,data:"0x",gasLimit:21_000n,maxFeePerGas:100_000_000_000n,maxPriorityFeePerGas:1n});
  try{
    assert.throws(()=>journal.persist(id,"gas",wallet.address,0,raw),/persisted invoice/);
    db.prepare("INSERT INTO chog_invoices VALUES(?,?)").run(id,"{}");
    assert.throws(()=>journal.persist(id,"gas",wallet.address,0,raw),/persisted invoice/);
    db.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify(plan),id);
    const row=journal.persist(id,"gas",wallet.address,0,raw);
    assert.equal(journal.persist(id,"gas",wallet.address,0,raw).hash,row.hash);
    assert.equal(db.prepare("SELECT count(*) AS n FROM source_sends").get().n,1);
  }finally{db.close();}
});

test("Monad source cost uses the signed gas limit, not the lower executed gasUsed",async()=>{
  const wallet=Wallet.createRandom(),price=100_000_000_000n;
  const raw=await wallet.signTransaction({type:2,chainId:143,nonce:0,to:payer,value:0n,data:"0x",gasLimit:125_000n,maxFeePerGas:price*2n,maxPriorityFeePerGas:1n});
  assert.equal(sourceGasCharge({raw},{effectiveGasPrice:price,gasUsed:100_000n}),125_000n*price);
  for(const value of [undefined,0n,price*2n+1n,Number(price)])assert.throws(()=>sourceGasCharge({raw},{effectiveGasPrice:value,gasUsed:100_000n}),/could not be verified/);
});
