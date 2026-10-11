import { DatabaseSync, backup } from "node:sqlite";
import { createServer } from "node:net";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { enrollPaymentIntegrity, openPaymentIntegrity } from "../server/payment-integrity.mjs";
import { acquireOperatorLease } from "../server/operator-lease.mjs";

// No vault/password/key access, signing or network calls. SQLite backup includes
// committed WAL data. Never copy just the .sqlite file while it is being used.
const filename=resolve("work/payments/processor.sqlite");
const journal=resolve("work/payments/preview.sqlite");
const checkpoint=resolve("work/payments/integrity/checkpoint.json");
const [mode,...extra]=process.argv.slice(2);
let probe,lease;
try {
  if(!["--enroll","--check","--backup"].includes(mode) || extra.length)throw new Error("Use --enroll, --check or --backup.");
  lease=await acquireOperatorLease();
  // Retain the port for the entire operation so the normal worker cannot start.
  probe=createServer();
  await new Promise((ok,bad)=>{probe.once("error",bad);probe.listen(4174,"127.0.0.1",ok);});
  if(!existsSync(filename)||!existsSync(journal))throw new Error("Both existing payment databases are required. No database was created.");
  if(mode==="--enroll" && existsSync(checkpoint))throw new Error("Checkpoint already exists. Use --check; never replace a mismatched checkpoint.");
  if(mode!=="--enroll")openPaymentIntegrity(filename,checkpoint,[journal]);
  if(mode!=="--check") {
    const directory=resolve("work/payments/backups");mkdirSync(directory,{recursive:true,mode:0o700});
    const group=`${Date.now()}-${randomBytes(6).toString("hex")}`;
    for(const [name,source] of [["processor",filename],["preview",journal]]) {
    const path=join(directory,`${name}-${group}.sqlite`);
    closeSync(openSync(path,"wx",0o600));
    const db=new DatabaseSync(source,{readOnly:true});
    try {
      if(db.prepare("PRAGMA quick_check").get().quick_check!=="ok")throw new Error("Database integrity check failed; preserve the original files.");
      await backup(db,path);
    }finally{db.close();}
    console.log(`Consistent database backup saved: ${path}`);
    }
    if(mode==="--enroll")enrollPaymentIntegrity(filename,checkpoint,[journal]);
    console.log("Contains private payment history and signed transactions, NOT the vault. Keep protected backups of BOTH the database and encrypted vault.");
  }
  console.log("Local payment checkpoint verified. No keys read and no funds moved.");
  console.log("This detects database-only rollback. Restoring both database and checkpoint defeats it; reconcile chain history after any recovery.");
}catch(error){
  console.error(error.code==="EADDRINUSE"?"Stop the payment terminal (Ctrl+C) first. Do not stop it during an unresolved operation without keeping its invoice.":error.message);
  process.exitCode=1;
}finally{if(probe?.listening)await new Promise(ok=>probe.close(ok));await lease?.close();}
