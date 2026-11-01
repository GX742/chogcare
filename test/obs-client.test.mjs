import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { connectLocalObs } from "../ops/stream/obs-client.mjs";

const password="synthetic-local-test-password", salt="synthetic-salt-long-enough", challenge="synthetic-challenge-long-enough";
// Fixed synthetic protocol vector calculated independently of the client.
// A duplicated implementation here could reproduce the same hashing bug.
const authentication="EEyz2LaWJ53lRcZHJZdJYj8Ww/P/4mMPe4mmWAJK7UA=";

async function fixture(t, handle, { authenticated=true, eventSubscriptions=0 }={}) {
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  await new Promise(resolve=>server.once("listening",resolve));
  t.after(async()=>{ for(const client of server.clients)client.terminate(); await new Promise(resolve=>server.close(resolve)); });
  server.on("connection",socket=>{
    socket.send(JSON.stringify({op:0,d:{rpcVersion:1,...authenticated?{authentication:{salt,challenge}}:{}}}));
    socket.on("message",raw=>{
      const message=JSON.parse(raw);
      if(message.op===1){
        assert.equal(message.d.authentication,authentication);
        assert.equal(message.d.eventSubscriptions,eventSubscriptions);
        socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));
      } else handle(socket,message);
    });
  });
  return (settings={})=>connectLocalObs({port:server.address().port,password,timeoutMs:200,...settings});
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

test("recovery subscriptions project only output states and config event types, never private names",async t=>{
  const events=[];
  const connect=await fixture(t,(socket,message)=>{
    socket.send(JSON.stringify({op:5,d:{eventType:"StreamStateChanged",eventData:{outputActive:true,outputState:"OBS_WEBSOCKET_OUTPUT_STARTED",privateValue:"PRIVATE_KEY"}}}));
    socket.send(JSON.stringify({op:5,d:{eventType:"CurrentProfileChanged",eventData:{profileName:"PRIVATE_PROFILE"}}}));
    socket.send(JSON.stringify({op:7,d:{...message.d,requestStatus:{result:true,code:100},responseData:{}}}));
  },{eventSubscriptions:66});
  const client=await connect({onRecoveryEvent:event=>events.push(event)});t.after(()=>client.close());await client.request("GetStreamStatus");
  assert.deepEqual(events,[{type:"StreamStateChanged",outputActive:true,outputState:"OBS_WEBSOCKET_OUTPUT_STARTED"},{type:"CurrentProfileChanged"}]);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
  client.close();assert.equal(events.at(-1).type,"ConnectionClosed");
});

test("collection changing immediately rejects pending and new RPC until the matching changed event",async t=>{
  let peer,received=0;const events=[];
  const connect=await fixture(t,(socket,message)=>{
    peer=socket;received++;
    if(received===1)socket.send(JSON.stringify({op:5,d:{eventType:"CurrentSceneCollectionChanging",eventData:{sceneCollectionName:"PRIVATE_COLLECTION"}}}));
    else socket.send(JSON.stringify({op:7,d:{...message.d,requestStatus:{result:true,code:100},responseData:{}}}));
  },{eventSubscriptions:66});
  const client=await connect({onRecoveryEvent:event=>events.push(event)});t.after(()=>client.close());
  await assert.rejects(client.request("GetStreamStatus"),/configuration is changing/);
  await assert.rejects(client.request("StartStream"),/Invalid or unavailable/);assert.equal(received,1);
  peer.send(JSON.stringify({op:5,d:{eventType:"CurrentSceneCollectionChanged",eventData:{sceneCollectionName:"PRIVATE_COLLECTION"}}}));
  await new Promise(resolve=>setTimeout(resolve,20));await client.request("GetStreamStatus");assert.equal(received,2);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE/);
});

test("malformed recovery states or a throwing consumer close safely instead of allowing later RPC",async t=>{
  for(const eventData of [{outputActive:true,outputState:"PRIVATE_STATE"},{outputActive:"true",outputState:"OBS_WEBSOCKET_OUTPUT_STARTED"}]){
    const connect=await fixture(t,(socket)=>socket.send(JSON.stringify({op:5,d:{eventType:"StreamStateChanged",eventData}})),{eventSubscriptions:66});
    const client=await connect({onRecoveryEvent:()=>{}});t.after(()=>client.close());await assert.rejects(client.request("GetStats"),/connection closed/);await assert.rejects(client.request("StartStream"),/Invalid or unavailable/);
  }
  const connect=await fixture(t,socket=>socket.send(JSON.stringify({op:5,d:{eventType:"StreamStateChanged",eventData:{outputActive:true,outputState:"OBS_WEBSOCKET_OUTPUT_STARTED"}}})),{eventSubscriptions:66});
  const client=await connect({onRecoveryEvent:()=>{throw Error("synthetic consumer");}});t.after(()=>client.close());await assert.rejects(client.request("GetStats"),/connection closed/);
});
