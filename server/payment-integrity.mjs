import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Local crash/rollback tripwire, NOT an independent anti-tampering authority.
// Restoring both files or compromising this OS account defeats this boundary.
// Never auto-enrol, repair a mismatch, or delete the checkpoint on startup.
export class PaymentIntegrityError extends Error {
  constructor(cause) { super("Payment integrity is locked. Stop the worker and reconcile the database/checkpoint; do not delete either file or issue replacement payments.",{cause}); this.name="PaymentIntegrityError"; }
}
const quoted = name => `"${name.replaceAll('"','""')}"`;
const serialize = value => JSON.stringify(value, (_, x) => typeof x === "bigint" ? {integer:String(x)} : x);

export function paymentStateDigest(filename) {
  if (!existsSync(filename) || !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new PaymentIntegrityError();
  const db = new DatabaseSync(filename,{readOnly:true});
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN");
    const digest=createHash("sha256");
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    digest.update(serialize(schema));
    const tables=schema.filter(item=>item.type==='table');
    for (const table of tables) {
      digest.update(serialize(table));
      const statement=db.prepare(`SELECT * FROM ${quoted(table.name)}`); statement.setReadBigInts(true);
      // Sort encoded rows rather than trusting rowid or physical SQLite layout.
      for (const row of statement.all().map(serialize).sort()) digest.update(row).update("\n");
    }
    db.exec("COMMIT");
    return digest.digest("hex");
  } finally {db.close();}
}

const combinedDigest=(filename,companions)=>createHash("sha256").update(serialize([filename,...companions].map(path=>[resolve(path),paymentStateDigest(path)]))).digest("hex");
function descriptor(filename, companions, digest, generation) {
  return {version:1,database:resolve(filename),companions:companions.map(path=>resolve(path)),digest,generation,recordedAt:new Date().toISOString()};
}
function durableWrite(path, value, exclusive=false) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new PaymentIntegrityError();
  const target=exclusive?path:`${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd=openSync(target,"wx",0o600);
  try {writeFileSync(fd,serialize(value),"utf8");fsyncSync(fd);} finally {closeSync(fd);}
  if(!exclusive)renameSync(target,path);
  // Best-effort directory fsync on systems that support it (Windows may not).
  if(process.platform!=="win32") {const dir=openSync(dirname(path),"r");try{fsyncSync(dir);}finally{closeSync(dir);}}
}
function readCheckpoint(path,filename,companions) {
  if(!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).size>4096)throw new PaymentIntegrityError();
  const value=JSON.parse(readFileSync(path,"utf8"));
  if(value.version!==1 || value.database!==resolve(filename) || serialize(value.companions)!==serialize(companions.map(path=>resolve(path))) || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.generation) || value.generation<0)throw new PaymentIntegrityError();
  return value;
}
export function enrollPaymentIntegrity(filename,checkpoint,companions=[]) {
  if(existsSync(checkpoint))throw new PaymentIntegrityError();
  durableWrite(checkpoint,descriptor(filename,companions,combinedDigest(filename,companions),0),true);
}
export function openPaymentIntegrity(filename,checkpoint,companions=[]) {
  let locked=false, current;
  try {
    current=readCheckpoint(checkpoint,filename,companions);
    if(current.digest!==combinedDigest(filename,companions))throw new PaymentIntegrityError();
  } catch {throw new PaymentIntegrityError();}
  return {
    get locked(){return locked;},
    checkpoint() {
      if(locked)throw new PaymentIntegrityError();
      try {
        // Detect deleted/replaced checkpoints while this process is alive.
        const disk=readCheckpoint(checkpoint,filename,companions);
        if(disk.digest!==current.digest || disk.generation!==current.generation)throw new PaymentIntegrityError();
        const digest=combinedDigest(filename,companions);
        if(digest===current.digest)return;
        const next=descriptor(filename,companions,digest,current.generation+1);
        durableWrite(checkpoint,next);current=next;
      } catch(error) {locked=true;throw new PaymentIntegrityError(error);}
    },
  };
}
