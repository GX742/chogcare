import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

// Explicit, isolated hardware sample. Does not import payment/storage modules,
// open a database, create an invoice or pretend a test is a real delivery.
const args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 1 || !/^COM[1-9]\d{0,2}$/.test(args[0])) throw new Error("Usage: node scripts/check-station-scenes.mjs COM6 (disconnect the admin station first)");
const id = randomBytes(12).toString("hex");
const transport = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/station-serial.ps1"), "-Port", args[0]], { windowsHide: true, stdio:["pipe","pipe","pipe"] });
const send = value => transport.stdin.write(`${JSON.stringify(value)}\n`);
let buffer="", sentAt=0, accepted=false, done=false, failure=null, stopping=false;
const finish=()=>{if(stopping)return;stopping=true;clearInterval(heartbeat);clearTimeout(deadline);transport.stdin.end();};
const heartbeat=setInterval(()=>{if(!stopping)send({v:1,type:"ping"});},1000);
const deadline=setTimeout(()=>{failure="Device did not confirm the screen sample within 25 seconds.";finish();},25000);
transport.stdout.setEncoding("utf8");
transport.stdout.on("data",chunk=>{
  buffer+=chunk;
  if(buffer.length>4096){buffer="";return;}
  let newline;
  while((newline=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
    let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.v!==1)continue;
    if(value.type==="fault"){failure="Device reported a display/storage fault.";finish();return;}
    if(!sentAt && ["hello","pong"].includes(value.type)){
      if(value.scenes!==2){failure="Device still has the old firmware.";finish();return;}
      sentAt=Date.now();
      send({v:1,type:"donation",id,nick:"TEST - NO PAYMENT",amount:"300",cause:"solar-foundation",test:true});
      console.log("Device scenes v2 confirmed. Showing TEST: Solar initiative name -> 300 CHOG -> Thank you. No funds moved.");
    }
    if(value.type==="ack" && value.id===id){
      if(value.status==="accepted"){accepted=true;console.log("Device accepted the explicitly marked screen sample.");}
      if(value.status==="done"){
        done=true;
        if(!accepted||Date.now()-sentAt<14000)failure="Unexpected animation acknowledgement timing.";
        else console.log(JSON.stringify({scenes:2,accepted:true,completed:true,durationMs:Date.now()-sentAt,paymentCreated:false}));
        finish();
      }
    }
  }
});
transport.stderr.on("data",()=>{failure="USB transport error; check COM port.";finish();});
transport.once("error",()=>{failure="Could not start USB transport.";finish();});
transport.stdin.on("error",()=>{failure="USB command pipe closed.";finish();});
await new Promise(resolve=>transport.once("close",resolve));
finish();
if(failure||!done){console.error(failure??"USB disconnected before test confirmation.");process.exitCode=1;}
