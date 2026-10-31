import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { connectLocalObs } from "../ops/stream/obs-client.mjs";

const digest=value=>createHash("sha256").update(value).digest("base64");
const password="synthetic-local-test-password", salt="synthetic-salt-long-enough", challenge="synthetic-challenge-long-enough";

async function fixture(t, handle, { authenticated=true }={}) {
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  await new Promise(resolve=>server.once("listening",resolve));
  t.after(async()=>{ for(const client of server.clients)client.terminate(); await new Promise(resolve=>server.close(resolve)); });
  server.on("connection",socket=>{
    socket.send(JSON.stringify({op:0,d:{rpcVersion:1,...authenticated?{authentication:{salt,challenge}}:{}}}));
    socket.on("message",raw=>{
      const message=JSON.parse(raw);
      if(message.op===1){
        assert.equal(message.d.authentication,digest(digest(password+salt)+challenge));
        assert.equal(message.d.eventSubscriptions,0);
        socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));
      } else handle(socket,message);
    });
  });
  return ()=>connectLocalObs({port:server.address().port,password,timeoutMs:200});
}

test("local OBS challenge authentication precedes correlated RPC and never transmits the password",async t=>{
  const connect=await fixture(t,(socket,message)=>{
    assert.equal(message.op,6);
    assert.equal(message.d.requestType,"GetStreamStatus");
    assert.equal(JSON.stringify(message).includes(password),false);
    socket.send(JSON.stringify({op:7,d:{...message.d,requestStatus:{result:true,code:100},responseData:{outputActive:true}}}));
  });
  const client=await connect();t.after(()=>client.close());
  assert.deepEqual(await client.request("GetStreamStatus"),{outputActive:true});
});

test("local OBS refuses an unauthenticated server and invalid remote endpoints",async t=>{
  const connect=await fixture(t,()=>assert.fail("No RPC may be sent"),{authenticated:false});
  await assert.rejects(connect(),/unavailable/);
  for(const settings of [{port:80},{port:"4455"},{password:""},{timeoutMs:Infinity}]) {
    assert.throws(()=>connectLocalObs({password,...settings}),/Invalid/);
  }
});

test("OBS failures suppress arbitrary service comments and request timeouts release pending work",async t=>{
  const connect=await fixture(t,(socket,message)=>{
    if(message.d.requestType==="StartStream") socket.send(JSON.stringify({op:7,d:{...message.d,requestStatus:{result:false,code:500,comment:"PRIVATE_DESTINATION_AND_STREAM_KEY"}}}));
  });
  const client=await connect();t.after(()=>client.close());
  await assert.rejects(client.request("StartStream"),error=>error.message==="Local OBS request rejected (500).");
  await assert.rejects(client.request("GetStreamStatus"),/timed out/);
  const pending=client.request("GetStats"); client.close();
  await assert.rejects(pending,/connection closed/);
});

test("malformed OBS JSON frames close pending requests without an uncaught event-handler exception",async t=>{
  for (const frame of [null, [], {op:7,d:null}, {op:"7",d:{}}]) {
    const connect=await fixture(t,(socket)=>socket.send(JSON.stringify(frame)));
    const client=await connect();t.after(()=>client.close());
    await assert.rejects(client.request("GetStats"),/connection closed/);
    await assert.rejects(client.request("GetStats\n"),/Invalid or unavailable/);
  }
});
