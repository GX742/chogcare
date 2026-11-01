import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { POLICY, createState, validateState, evaluate, reserveRecovery, recoverPublisher } from "../ops/stream/obs-publisher-recovery.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const bootId = hash("synthetic-boot"), sessionHash = hash("synthetic-session"), bindingHash = hash("synthetic-binding");
const missing = { status: 404, valid: false };
function sample(nowMs, change = {}) {
  const media = { status: 200, valid: true, mediaIdHash: hash(`synthetic-video-${nowMs}`) };
  return { nowMs, bootId, enabled: true, connected: true, configChanging: false, unexpectedStop: false,
    outputActive: true, outputReconnecting: false, sessionHash, bindingHash,
    outputBytes: (nowMs + 1000) * 100, outputDuration: nowMs + 150000, outputTotalFrames: (nowMs + 1000) * 30,
    publicHls: media, originHls: media, ...change };
}
function healthy() {
  let state = createState(bootId, 0);
  for (let at = 0; at <= 30000; at += 5000) state = evaluate(state, sample(at)).state;
  assert.notEqual(state.healthyAnchor, null); return state;
}
function actionable() {
  let state = healthy(), result;
  for (let at = 35000; at <= 95000; at += 5000) { result = evaluate(state, sample(at, { publicHls: missing, originHls: missing })); state = result.state; }
  assert.ok(result.action); return result;
}
test("only a previously healthy producing session with sustained confirmed dual 404 recommends recovery", () => {
  let state = healthy();
  for (let at = 35000; at < 95000; at += 5000) { const result = evaluate(state, sample(at, { publicHls: missing, originHls: missing })); assert.equal(result.action, null); state = result.state; }
  assert.ok(evaluate(state, sample(95000, { publicHls: missing, originHls: missing })).action);
  let cold = createState(bootId, 0);
  for (let at = 0; at <= 240000; at += 5000) { const result = evaluate(cold, sample(at, { publicHls: missing, originHls: missing })); assert.equal(result.action, null); cold = result.state; }
});
test("frozen 200 media never establishes a healthy anchor and startup requires 120 seconds", () => {
  const media = { status: 200, valid: true, mediaIdHash: hash("frozen-video") }; let state = createState(bootId, 0);
  for (let at = 0; at <= 60000; at += 5000) state = evaluate(state, sample(at, { publicHls: media, originHls: media })).state;
  assert.equal(state.healthyAnchor, null);
  state = createState(bootId, 0);
  for(let at=0;at<=30000;at+=5000)state=evaluate(state,sample(at,{outputDuration:at})).state;
  assert.notEqual(state.healthyAnchor,null);
  for (let at = 35000; at < 120000; at += 5000) { const result = evaluate(state, sample(at, { outputDuration: at, publicHls: missing, originHls: missing })); assert.equal(result.action, null); state = result.state; }
  let result;for(let at=120000;at<=180000;at+=5000){result=evaluate(state,sample(at,{outputDuration:at,publicHls:missing,originHls:missing}));state=result.state;if(at<180000)assert.equal(result.action,null);}assert.ok(result.action);
});
test("timeouts, 5xx, auth errors, bad media and one-sided failure break consecutive evidence", () => {
  for (const response of [{status:0}, {status:500}, {status:503}, {status:401}, {status:403}, {status:200,valid:false}]) {
    let state = actionable().state;
    const held = evaluate(state, sample(100000, { publicHls: response, originHls: missing }));
    assert.equal(held.action, null); assert.equal(held.state.failureSince, null); assert.equal(held.state.failureSamples, 0);
    assert.notEqual(held.state.healthyAnchor, null);
    assert.equal(evaluate(held.state, sample(105000, { publicHls: missing, originHls: missing })).action, null);
  }
});
test("pause, inactive/manual stop, configuration changes and API loss disarm prior intent", () => {
  for (const change of [{enabled:false}, {connected:false}, {configChanging:true}, {configChanging:undefined}, {unexpectedStop:true}, {unexpectedStop:undefined}, {outputActive:false}, {outputReconnecting:true}]) {
    const result = evaluate(actionable().state, sample(100000, {...change, publicHls:missing,originHls:missing}));
    assert.equal(result.status,"disarmed"); assert.equal(result.action,null); assert.equal(result.state.healthyAnchor,null);
    assert.equal(evaluate(result.state, sample(105000,{publicHls:missing,originHls:missing})).action,null);
  }
});
test("session/config replacement, counter reset and observation gap cannot reuse a healthy anchor", () => {
  for (const change of [{sessionHash:hash("other-session")},{bindingHash:hash("other-config")},{outputBytes:1},{outputDuration:1},{outputTotalFrames:1}]) {
    const result=evaluate(actionable().state,sample(100000,{...change,publicHls:missing,originHls:missing}));
    assert.equal(result.action,null); assert.equal(result.state.healthyAnchor,null);
  }
  const result=evaluate(actionable().state,sample(110001,{publicHls:missing,originHls:missing}));
  assert.equal(result.action,null); assert.equal(result.state.healthyAnchor,null);
});
test("flat bytes, duration or frames suspend missing evidence; four close samples cannot bypass 60 seconds",()=>{
  for(const field of ["outputBytes","outputDuration","outputTotalFrames"]){
    const ready=actionable(),previous={outputBytes:ready.state.last.bytes,outputDuration:ready.state.last.duration,outputTotalFrames:ready.state.last.frames};
    const result=evaluate(ready.state,sample(100000,{[field]:previous[field],publicHls:missing,originHls:missing}));
    assert.equal(result.action,null);assert.equal(result.state.failureSamples,0);
  }
  let state=healthy();for(const at of [35000,35001,35002,35003]){const result=evaluate(state,sample(at,{publicHls:missing,originHls:missing}));assert.equal(result.action,null);state=result.state;}
});
test("reservation survives serialization, sessions and reboot without granting a fresh rolling budget",()=>{
  const ready=actionable();let state=reserveRecovery(ready.state,ready.action,ready.action.atMs);
  state=validateState(JSON.parse(JSON.stringify(state)),bootId,100000);assert.deepEqual(state.intents,[95000]);
  let result;
  for(let at=100000;at<=395000;at+=5000){result=evaluate(state,sample(at,{publicHls:missing,originHls:missing}));state=result.state;if(at<395000)assert.equal(result.action,null);}
  assert.ok(result.action);state=reserveRecovery(state,result.action,395000);
  for(let at=400000;at<=700000;at+=5000){const held=evaluate(state,sample(at,{publicHls:missing,originHls:missing}));assert.equal(held.action,null);state=held.state;}
  assert.equal(state.intents.length,2);
  const rebooted=validateState(state,hash("new-boot"),100);assert.deepEqual(rebooted.intents,[100,100]);assert.equal(rebooted.healthyAnchor,null);
  assert.throws(()=>reserveRecovery(state,result.action,395000));
});
test("malformed persistence and reversed time fail closed without accepting private state fields",()=>{
  const state=healthy();for(const bad of [{...state,extra:"private"},{...state,version:2},{...state,intents:[NaN]},{...state,last:{...state.last,bytes:-1}},{...state,healthyAnchor:Infinity}])assert.throws(()=>validateState(bad,bootId,40000));
  assert.throws(()=>validateState(state,bootId,1));
  assert.doesNotMatch(JSON.stringify(state),/password|profileName|streamServiceSettings|server_password/);
});

function transaction(change={}) {
  const ready=actionable(),calls=[],saved=[];let clock=ready.action.atMs,active=true,cancelled=false;
  const lease=()=>({connected:true,enabled:true,configChanging:false,unexpectedStop:false,sessionHash,bindingHash,connectionHash:hash("synthetic-connection"),cancelEpoch:0,outputActive:active,outputReconnecting:false,bothMissing:true});
  const io={now:()=>clock,cancelled:()=>cancelled,persist:async state=>{calls.push("persist");saved.push(state);},inspect:async()=>{calls.push("inspect");return lease();},stop:async()=>{assert.equal(saved[0].intents.length,1);calls.push("stop");active=false;return true;},start:async()=>{calls.push("start");return true;},sleep:async()=>{clock+=POLICY.pollMs;},...change};
  return {io,calls,saved,ready,cancel:()=>{cancelled=true;},setClock:value=>{clock=value;},lease};
}
const run=f=>recoverPublisher(f.io,{state:f.ready.state,action:f.ready.action,nowMs:f.ready.action.atMs});
test("a durable reservation precedes one acknowledged stop, fresh same-connection checks and one start",async()=>{
  const f=transaction();const result=await run(f);assert.equal(result.status,"start_acknowledged");assert.deepEqual(f.calls,["persist","inspect","stop","inspect","inspect","start"]);assert.equal(result.state.intents.length,1);
});
test("uncertain persistence, stop or stale fresh HTTP proof cannot reach StartStream",async()=>{
  const f=transaction({persist:async()=>{throw Error("synthetic");}});await assert.rejects(run(f));assert.equal(f.calls.includes("stop"),false);
  for(const stop of [async()=>false,async()=>{throw Error("synthetic timeout");}]){const g=transaction({stop});const result=await run(g);assert.equal(result.startRequested,false);assert.equal(g.calls.includes("start"),false);assert.equal(result.state.intents.length,1);}
  const h=transaction();h.io.inspect=async()=>({...h.lease(),bothMissing:false});assert.equal((await run(h)).startRequested,false);assert.equal(h.calls.includes("stop"),false);
});
test("manual pause, connection/config changes and deadline after stop prevent restart",async()=>{
  for(const mode of ["pause","connection","config","deadline","event","final"]){
    const f=transaction();const stop=f.io.stop;f.io.stop=async()=>{await stop();if(mode==="pause")f.cancel();if(mode==="deadline")f.setClock(f.ready.action.atMs+POLICY.stopDeadlineMs);return true;};
    if(["connection","config","event","final"].includes(mode)){let reads=0;f.io.inspect=async()=>{const value=f.lease();if(++reads>1){if(mode==="connection")value.connectionHash=hash("replacement");if(mode==="config"||mode==="final"&&reads===3)value.bindingHash=hash("changed");if(mode==="event")value.cancelEpoch++;}return value;};}
    assert.equal((await run(f)).startRequested,false);assert.equal(f.calls.includes("start"),false);
  }
});
test("a positively acknowledged but still-active StopStream is polled finitely and never started",async()=>{
  const f=transaction({stop:async()=>true});let reads=0;f.io.inspect=async()=>{reads++;return f.lease();};
  const result=await run(f);assert.equal(result.status,"recovery_held");assert.equal(result.startRequested,false);assert.ok(reads<=POLICY.maximumPolls+1);assert.equal(f.calls.includes("start"),false);
});
test("an inactive user stream is never started and an unknown StartStream is never retried",async()=>{
  const f=transaction();f.io.inspect=async()=>({...f.lease(),outputActive:false});assert.equal((await run(f)).startRequested,false);assert.equal(f.calls.includes("stop"),false);
  let starts=0;const g=transaction({start:async()=>{starts++;throw Error("synthetic timeout");}});const result=await run(g);assert.equal(result.status,"start_unknown");assert.equal(starts,1);assert.equal(result.state.intents.length,1);
});
