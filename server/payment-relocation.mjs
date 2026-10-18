import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {paymentStateDigest,PaymentIntegrityError} from "./payment-integrity.mjs";
import {readRegularFileSync} from "./regular-file.mjs";

const digest=rows=>createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Offline migration only, never used by worker startup. Verify the exact old
// checkpoint against BOTH copied DBs before changing only their path binding.
// Financial rows, address allocation, signed bytes and the old checkpoint stay
// untouched. This is not a way to enrol or repair a mismatched database.
export function relocatePaymentCheckpoint({database,requestJournal,sourceCheckpoint,targetCheckpoint}){
  const paths=[database,requestJournal,sourceCheckpoint,targetCheckpoint].map(path=>resolve(path));
  if(new Set(paths).size!==4||existsSync(paths[3]))throw new PaymentIntegrityError();
  let old;
  try { old=JSON.parse(readRegularFileSync(paths[2],4096).toString("utf8")); }
  catch { throw new PaymentIntegrityError(); }
  if(old.version!==1||typeof old.database!=="string"||!old.database||!Array.isArray(old.companions)||old.companions.length!==1||typeof old.companions[0]!=="string"||old.companions[0]===old.database||!/^[a-f0-9]{64}$/.test(old.digest)||!Number.isSafeInteger(old.generation)||old.generation<0||old.generation>=Number.MAX_SAFE_INTEGER)throw new PaymentIntegrityError();
  const state=paths.slice(0,2).map(paymentStateDigest);
  if(digest([[old.database,state[0]],[old.companions[0],state[1]]])!==old.digest)throw new PaymentIntegrityError();
  const next={version:1,database:paths[0],companions:[paths[1]],digest:digest([[paths[0],state[0]],[paths[1],state[1]]]),generation:old.generation+1,recordedAt:new Date().toISOString()};
  const directory=dirname(paths[3]);mkdirSync(directory,{recursive:true,mode:0o700});
  if(lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())throw new PaymentIntegrityError();
  const fd=openSync(paths[3],"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(next),"utf8");fsyncSync(fd);}finally{closeSync(fd);}
  return {verified:true,generation:next.generation};
}
