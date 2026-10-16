import test from "node:test";
import assert from "node:assert/strict";
import {readSystemdPassword} from "../scripts/cloud-payments.mjs";

const directory="/run/credentials/chogcare-payments.service";
const metadata={isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:33,mode:0o100400,uid:1001};
const password="fixture-custody-password-for-tests";
test("cloud startup consumes a protected systemd credential and clears its input buffer",async()=>{
  const bytes=Buffer.from(password+"\n");
  const result=await readSystemdPassword({platform:"linux",directory,uid:1001,stat:async()=>metadata,read:async path=>{assert.equal(path,directory+"/custody-password");return bytes;}});
  assert.equal(result,password);assert.ok(bytes.every(byte=>byte===0));
});
test("cloud startup rejects arbitrary credential locations, writable files, links and malformed secrets",async()=>{
  for(const change of [{platform:"win32"},{directory:"/tmp/credentials"},{stat:async()=>({...metadata,mode:0o100600})},{stat:async()=>({...metadata,isSymbolicLink:()=>true})},{stat:async()=>({...metadata,uid:999})},{read:async()=>Buffer.from("short")},{read:async()=>Buffer.from(password+"\nextra")}]){
    await assert.rejects(readSystemdPassword({platform:"linux",directory,uid:1001,stat:async()=>metadata,read:async()=>Buffer.from(password),...change}));
  }
});
