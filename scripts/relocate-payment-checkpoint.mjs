import {resolve} from "node:path";
import {createServer} from "node:net";
import {acquireOperatorLease} from "../server/operator-lease.mjs";
import {relocatePaymentCheckpoint} from "../server/payment-relocation.mjs";

let lease,probe;
try{
  if(process.argv.slice(2).join(" ")!=="--verify-relocation")throw Error("Use --verify-relocation only for an offline migration of existing databases.");
  lease=await acquireOperatorLease();probe=createServer();
  await new Promise((ok,bad)=>{probe.once("error",bad);probe.listen(4174,"127.0.0.1",ok);});
  const result=relocatePaymentCheckpoint({database:resolve("work/payments/processor.sqlite"),requestJournal:resolve("work/payments/preview.sqlite"),sourceCheckpoint:resolve("work/payments/integrity/checkpoint.source.json"),targetCheckpoint:resolve("work/payments/integrity/checkpoint.json")});
  console.log(JSON.stringify(result));
}catch{console.error("Migration verification failed. Keep both databases and the original checkpoint; do not enrol a replacement baseline.");process.exitCode=1;}
finally{if(probe?.listening)await new Promise(ok=>probe.close(ok));await lease?.close();}
