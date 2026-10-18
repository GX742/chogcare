import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync,backup} from "node:sqlite";
import {enrollPaymentIntegrity,openPaymentIntegrity,paymentStateDigest} from "../server/payment-integrity.mjs";
import {relocatePaymentCheckpoint} from "../server/payment-relocation.mjs";

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),"payment-relocation-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const old=join(root,"original"),next=join(root,"destination");mkdirSync(old);mkdirSync(next);
  const original=[join(old,"processor.sqlite"),join(old,"preview.sqlite")];
  for(const file of original){const db=new DatabaseSync(file);db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('original allocation and signed transaction')");db.close();}
  const sourceCheckpoint=join(old,"checkpoint.json");enrollPaymentIntegrity(original[0],sourceCheckpoint,[original[1]]);
  const copied=[join(next,"processor.sqlite"),join(next,"preview.sqlite")];
  for(let i=0;i<2;i++){const db=new DatabaseSync(original[i],{readOnly:true});await backup(db,copied[i]);db.close();}
  return {database:copied[0],requestJournal:copied[1],sourceCheckpoint,targetCheckpoint:join(next,"checkpoint.json")};
}
test("offline relocation verifies both copied databases, preserves rows and advances the existing checkpoint generation",async t=>{
  const f=await fixture(t),before=[f.database,f.requestJournal].map(paymentStateDigest),source=readFileSync(f.sourceCheckpoint,"utf8");
  assert.equal(relocatePaymentCheckpoint(f).verified,true);
  assert.deepEqual([f.database,f.requestJournal].map(paymentStateDigest),before);
  assert.equal(readFileSync(f.sourceCheckpoint,"utf8"),source);
  assert.equal(JSON.parse(readFileSync(f.targetCheckpoint,"utf8")).generation,1);
  assert.equal(openPaymentIntegrity(f.database,f.targetCheckpoint,[f.requestJournal]).locked,false);
  assert.throws(()=>relocatePaymentCheckpoint(f));
});
test("a changed payment or request database never becomes a newly trusted baseline during migration",async t=>{
  for(const changed of ["database","requestJournal"]){
    const f=await fixture(t),db=new DatabaseSync(f[changed]);db.exec("UPDATE preserved SET value='different history'");db.close();
    assert.throws(()=>relocatePaymentCheckpoint(f));assert.equal(existsSync(f.targetCheckpoint),false);
  }
});
test("malformed source checkpoints and pre-existing destination checkpoints cannot be overwritten",async t=>{
  const f=await fixture(t);writeFileSync(f.targetCheckpoint,"keep");
  assert.throws(()=>relocatePaymentCheckpoint(f));assert.equal(readFileSync(f.targetCheckpoint,"utf8"),"keep");
  const g=await fixture(t);writeFileSync(g.sourceCheckpoint,'{"version":1}');
  assert.throws(()=>relocatePaymentCheckpoint(g));assert.equal(existsSync(g.targetCheckpoint),false);
});
