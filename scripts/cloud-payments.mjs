import {readFile,lstat} from "node:fs/promises";
import {resolve,posix} from "node:path";
import {pathToFileURL} from "node:url";
import {startPaymentWorker,PAYMENT_STARTUP_FAILURES} from "./start-payments.mjs";

// systemd decrypts the credential into a private, read-only /run directory.
// Only its directory name is in the environment, never the custody password.
export async function readSystemdPassword({platform=process.platform,directory=process.env.CREDENTIALS_DIRECTORY,uid=process.getuid?.(),read=readFile,stat=lstat}={}){
  if(platform!=="linux"||directory!=="/run/credentials/chogcare-payments.service")throw new Error("Protected systemd credentials are required.");
  const path=posix.resolve(directory,"custody-password"),metadata=await stat(path);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.size<16||metadata.size>1024||(metadata.mode&0o222)!==0||![0,uid].includes(metadata.uid))throw new Error("Protected custody credential is unavailable.");
  const bytes=await read(path);
  try{
    const password=new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/\r?\n$/,"");
    if(password.length<16||password.length>256||/[\x00-\x1f\x7f]/.test(password))throw new Error("Invalid custody credential.");
    return password;
  }finally{bytes.fill(0);}
}

export async function runCloudPayments(start=startPaymentWorker,channel=process){
  let stop;
  const shutdown=()=>{void stop?.().catch(()=>{channel.exitCode=1;});};
  channel.once("SIGINT",shutdown);channel.once("SIGTERM",shutdown);
  try{return await start({passwordProvider:()=>readSystemdPassword(),registerStop(value){stop=value;},onEvent(event){
    if(Object.hasOwn(PAYMENT_STARTUP_FAILURES,event.code))console.error(PAYMENT_STARTUP_FAILURES[event.code]);
  }});}finally{
    // Keep handlers for a successfully running worker. A failed startup must not
    // retain listeners if this entry point is called by an isolated test.
    if(!stop){channel.removeListener("SIGINT",shutdown);channel.removeListener("SIGTERM",shutdown);}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runCloudPayments().catch(()=>{console.error("Payment service startup failed. Check the protected credential, checkpoint and network locally.");process.exitCode=1;});
}
