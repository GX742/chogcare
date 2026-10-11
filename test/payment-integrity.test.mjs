import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollPaymentIntegrity, openPaymentIntegrity, paymentStateDigest } from "../server/payment-integrity.mjs";

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"chogcare-integrity-")),filename=join(dir,"processor.sqlite"),checkpoint=join(dir,"integrity/checkpoint.json");
  const db=new DatabaseSync(filename);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE state (id TEXT PRIMARY KEY,value TEXT); INSERT INTO state VALUES ('nonce','1')");
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,filename,checkpoint,db};
}
test("integrity enrolment is explicit, exclusive, key-free and survives normal restart",t=>{
  const f=fixture(t);
  assert.throws(()=>openPaymentIntegrity(f.filename,f.checkpoint));
  enrollPaymentIntegrity(f.filename,f.checkpoint);
  assert.throws(()=>enrollPaymentIntegrity(f.filename,f.checkpoint));
  const guard=openPaymentIntegrity(f.filename,f.checkpoint);
  f.db.exec("UPDATE state SET value='2'");guard.checkpoint();
  assert.equal(openPaymentIntegrity(f.filename,f.checkpoint).locked,false);
  assert.doesNotMatch(readFileSync(f.checkpoint,"utf8"),/nonce|privateKey|signed_tx/);
});
test("old database, missing checkpoint or changed checkpoint never silently resume",async t=>{
  const f=fixture(t),old=join(f.dir,"old.sqlite");await backup(f.db,old);
  enrollPaymentIntegrity(f.filename,f.checkpoint);
  const guard=openPaymentIntegrity(f.filename,f.checkpoint);
  f.db.exec("UPDATE state SET value='3'");guard.checkpoint();
  const oldRead=new DatabaseSync(old);
  // Restore only the old contents using SQLite, not copying over an open WAL DB.
  f.db.prepare("UPDATE state SET value=?").run(oldRead.prepare("SELECT value FROM state").get().value);oldRead.close();
  assert.throws(()=>openPaymentIntegrity(f.filename,f.checkpoint),/integrity is locked/);
  const before=readFileSync(f.checkpoint,"utf8");
  writeFileSync(f.checkpoint,"{}");assert.throws(()=>guard.checkpoint());
  writeFileSync(f.checkpoint,before);assert.throws(()=>guard.checkpoint(),"failure stays latched until operator reconciliation");
});
test("checkpoint digest includes WAL commits, schema and persisted signed bytes",t=>{
  const f=fixture(t),first=paymentStateDigest(f.filename);
  f.db.exec("CREATE TABLE outbox (raw TEXT); INSERT INTO outbox VALUES ('0x1234')");
  const second=paymentStateDigest(f.filename);assert.notEqual(first,second);
  f.db.exec("UPDATE outbox SET raw='0x5678'");assert.notEqual(second,paymentStateDigest(f.filename));
  const third=paymentStateDigest(f.filename);f.db.exec("CREATE UNIQUE INDEX history_id ON state(value)");assert.notEqual(third,paymentStateDigest(f.filename));
});
test("companion request journal rollback also locks startup",t=>{
  const f=fixture(t),journal=join(f.dir,"requests.sqlite"),extra=new DatabaseSync(journal);
  try {
    extra.exec("CREATE TABLE requests (id TEXT); INSERT INTO requests VALUES ('one')");
    enrollPaymentIntegrity(f.filename,f.checkpoint,[journal]);
    const guard=openPaymentIntegrity(f.filename,f.checkpoint,[journal]);
    extra.exec("INSERT INTO requests VALUES ('two')");guard.checkpoint();
    extra.exec("DELETE FROM requests WHERE id='two'");
    assert.throws(()=>openPaymentIntegrity(f.filename,f.checkpoint,[journal]));
    assert.throws(()=>openPaymentIntegrity(f.filename,f.checkpoint));
  }finally{extra.close();}
});
