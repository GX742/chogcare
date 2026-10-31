import test from "node:test";
import {spawn} from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createState, evaluate } from "../ops/stream/ingress-watchdog.mjs";
import { createPrivateStateStore, EMPTY_EXEC_PROPERTIES, EMPTY_UNIT_PROPERTIES, hooksDisabled, parseEmptyExecProperties, parseSocketCgroup, parseUnitProperties, runWatchdogCycle, safeLoadedConfig, safeUnitDependencies, verifyCgroupOwnership } from "../ops/stream/ingress-watchdog-runtime.mjs";
import { renderIngressWatchdogService, renderIngressWatchdogTimer } from "../ops/stream/ingress-watchdog-units.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const bootId = hash("synthetic-boot"), generation = hash("synthetic-process-and-socket");
const playlist = sequence => ({ eligible: true, initId: hash("synthetic-muxer"), segments: Array.from({ length: 7 }, (_, index) => ({ sequence: sequence + index, id: hash(`synthetic-${sequence + index}`), durationMs: 1000 })) });
const emptyExecProof = "a(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\na(sasbttttuii) 0\n";

function actionableState() {
  let state = createState(bootId, 0);
  for (let nowMs = 0; nowMs <= 60000; nowMs += 5000) state = evaluate(state, { nowMs, bootId, valid: true, safe: true, generation, playlist: playlist(nowMs / 1000) }).state;
  for (let nowMs = 65000; nowMs < 180000; nowMs += 5000) {
    const result = evaluate(state, { nowMs, bootId, valid: true, safe: true, generation, playlist: playlist(60) }); state = result.state;
    if (result.action) return state;
  }
  assert.fail("Synthetic slow timeline should become actionable");
}

function fixture({ confirm, persistFails = false, outcome = { requested: true, succeeded: true } } = {}) {
  const initial = actionableState(), saved = [], calls = [];
  let now = initial.last.atMs + 5000, count = 0, durable = structuredClone(initial);
  const io = {
    bootId: async () => bootId,
    now: () => now,
    store: {
      load: async () => structuredClone(initial),
      save: async value => { if (persistFails && value.intents.length) throw Error("synthetic persistence failure"); durable = structuredClone(value); saved.push(durable); calls.push("persist"); },
    },
    observe: async () => {
      calls.push("observe"); count++;
      if (count === 2) { now += 5000; if (confirm) return confirm(now); }
      return { valid: true, safe: true, generation, playlist: playlist(60) };
    },
    tryRestart: async () => { assert.equal(durable.intents.length, 1); calls.push("restart"); return outcome; },
  };
  return { io, calls, saved };
}

test("a restart reservation is durable before the fixed executor is requested", async () => {
  const f = fixture(); const result = await runWatchdogCycle(f.io);
  assert.equal(result.restartRequested, true); assert.equal(result.restartSucceeded, true); assert.equal(result.intentCount, 1);
  assert.deepEqual(f.calls, ["observe", "persist", "observe", "persist", "restart"]);
});

test("fresh media recovery cancels the action instead of restarting a recovered stream", async () => {
  const f = fixture({ confirm: () => ({ valid: true, safe: true, generation, playlist: playlist(65) }) });
  const result = await runWatchdogCycle(f.io); assert.equal(result.restartRequested, false); assert.equal(result.intentCount, 0); assert.equal(f.calls.includes("restart"), false);
});

test("a changed publisher/socket/muxer generation cancels a stale restart intent", async () => {
  for (const confirm of [
    () => ({ valid: true, safe: true, generation: hash("replacement-socket"), playlist: playlist(60) }),
    () => ({ valid: true, safe: true, generation, playlist: { ...playlist(60), initId: hash("replacement-muxer") } }),
    () => ({ valid: false, safe: false, generation: null, playlist: null }),
  ]) { const f = fixture({ confirm }); assert.equal((await runWatchdogCycle(f.io)).restartRequested, false); assert.equal(f.calls.includes("restart"), false); }
});

test("uncertain persistence never reaches systemctl and unknown restart consumes its budget", async () => {
  const failed = fixture({ persistFails: true }); await assert.rejects(runWatchdogCycle(failed.io)); assert.equal(failed.calls.includes("restart"), false);
  const unknown = fixture({ outcome: { requested: true, succeeded: false } }); const result = await runWatchdogCycle(unknown.io);
  assert.equal(result.restartRequested, true); assert.equal(result.restartSucceeded, false); assert.equal(unknown.saved.at(-1).intents.length, 1);
  const moved = fixture({ outcome: { requested: false, succeeded: false } }); assert.equal((await runWatchdogCycle(moved.io)).restartRequested, false); assert.equal(moved.saved.at(-1).intents.length, 1);
});

test("observe-only never writes or restarts even when the prior state recommends restart", async () => {
  const f=fixture();const result=await runWatchdogCycle(f.io,{observeOnly:true});
  assert.equal(result.runtimeGuardsPassed,true);assert.equal(result.wouldRestart,true);assert.equal(result.restartRequested,false);assert.deepEqual(f.calls,["observe"]);assert.equal(f.saved.length,0);
});

test("corrupt state fails closed before any runtime observation or restart", async () => {
  let observed = false;
  await assert.rejects(runWatchdogCycle({ bootId: async () => bootId, now: () => 1, store: { load: async () => ({ version: 99 }) }, observe: async () => { observed = true; } }));
  assert.equal(observed, false);
});

test("only the exact running unit, fixed command, and an idle job are accepted", () => {
  const guards = Object.entries({...Object.fromEntries(EMPTY_UNIT_PROPERTIES.map(key=>[key, ""])),ControlGroup:"/system.slice/chogcare-stream.service",Conflicts:"shutdown.target",ConflictedBy:"",Requires:"system.slice -.mount sysinit.target tmp.mount",Wants:"network-online.target",FileDescriptorStoreMax:"0",NFileDescriptorStore:"0",FailureAction:"none",SuccessAction:"none",StartLimitAction:"none"}).map(([key,value])=>`${key}=${value}`).join("\n");
  const unit = `ActiveState=active\nSubState=running\nMainPID=123\nInvocationID=${"a".repeat(32)}\nJob=\nExecStart={ path=/opt/chogcare-stream/mediamtx ; argv[]=/opt/chogcare-stream/mediamtx /run/credentials/chogcare-stream.service/mediamtx.json ; ignore_errors=no ; }\n${guards}\n`;
  assert.equal(parseUnitProperties(unit, emptyExecProof).pid, 123);
  for (const invalid of [unit.replace("Job=", "Job=42"), unit.replace("MainPID=123", "MainPID=0"), unit.replace("ActiveState=active", "ActiveState=inactive"), unit.replace("path=/opt/chogcare-stream/mediamtx", "path=/usr/bin/other"), unit.replace("mediamtx.json ;", "mediamtx.json extra ;")]) assert.throws(() => parseUnitProperties(invalid, emptyExecProof));
  // Ubuntu/systemd 255 omits all five empty compound Exec arrays. Sockets is
  // not an exported D-Bus property. Neither omission is accepted as proof.
  const actualFormat = unit.split("\n").filter(line => !EMPTY_EXEC_PROPERTIES.some(key => line.startsWith(`${key}=`))).join("\n").replace("Wants=network-online.target", "Wants=network-online.target tmp.mount");
  assert.equal(EMPTY_UNIT_PROPERTIES.includes("Sockets"), false);
  assert.equal(parseUnitProperties(actualFormat, emptyExecProof).pid, 123);
  assert.throws(() => parseUnitProperties(actualFormat));
  assert.throws(() => parseUnitProperties(unit));
  for (const key of EMPTY_EXEC_PROPERTIES) assert.throws(() => parseUnitProperties(`${actualFormat}\n${key}={ path=/usr/bin/true ; }`, emptyExecProof));
  assert.throws(() => parseUnitProperties(actualFormat.replace("RequiredBy=\n", ""), emptyExecProof));
});

test("every command array requires explicit typed-empty D-Bus proof without extras", () => {
  assert.deepEqual(Object.keys(parseEmptyExecProperties(emptyExecProof)), ["ExecCondition", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"]);
  assert.deepEqual(parseEmptyExecProperties(emptyExecProof), parseEmptyExecProperties(emptyExecProof.slice(0, -1)));
  for (const invalid of [undefined, "", emptyExecProof.split("\n").slice(1).join("\n"), emptyExecProof + "a(sasbttttuii) 0\n", emptyExecProof.replace("a(sasbttttuii) 0", "a(sasbttttuii) 1"), emptyExecProof.replace("a(sasbttttuii)", "as"), emptyExecProof + "\n", " "+emptyExecProof, emptyExecProof.replace(" 0", " 00"), "x".repeat(1025)]) assert.throws(() => parseEmptyExecProperties(invalid));
});

test("a UID or cgroup path prefix alone cannot establish exact service socket ownership", () => {
  const row="0 0 192.0.2.1:1936 198.51.100.2:12345 uid:61234 ino:9988 sk:a cgroup:/system.slice/chogcare-stream.service <->";
  const socket=parseSocketCgroup(row); assert.deepEqual(socket,{uid:61234,inode:"9988",cgroup:"/system.slice/chogcare-stream.service"});
  const input={pid:123,uid:61234,socket,controlGroup:"/system.slice/chogcare-stream.service",cgroupInode:12345n,procs:"123\n"};
  verifyCgroupOwnership(input);
  for(const invalid of [row.replace(".service", ".service-other"),row+"\n"+row,row.replace(" cgroup:/system.slice/chogcare-stream.service", ""),row.replace("uid:61234", "uid:0")])assert.throws(()=>parseSocketCgroup(invalid));
  for(const invalid of [{...input,procs:"123\n124\n"},{...input,procs:"124\n"},{...input,uid:999},{...input,cgroupInode:0n},{...input,controlGroup:"/other"}])assert.throws(()=>verifyCgroupOwnership(invalid));
});

test("stop propagation, reverse dependencies, hooks and descriptor transfer fail closed", () => {
  const safe={...Object.fromEntries(EMPTY_UNIT_PROPERTIES.map(key=>[key,""])),Conflicts:"shutdown.target",ConflictedBy:"shutdown.target",Requires:"system.slice -.mount sysinit.target tmp.mount",Wants:"network-online.target",FileDescriptorStoreMax:"0",NFileDescriptorStore:"0",FailureAction:"none",SuccessAction:"none",StartLimitAction:"none"};
  assert.equal(safeUnitDependencies(safe),true);
  assert.equal(safeUnitDependencies({...safe,Wants:"network-online.target tmp.mount"}),true);
  for(const key of EMPTY_UNIT_PROPERTIES)assert.equal(safeUnitDependencies({...safe,[key]:"unexpected.service"}),false);
  for(const bad of [{...safe,Conflicts:"other.service"},{...safe,ConflictedBy:"other.service"},{...safe,Requires:"payment.service"},{...safe,Wants:"network-online.target chogcare-stream.socket"},{...safe,Wants:"network-online.target other.service"},{...safe,Wants:"tmp.mount.socket"},{...safe,FileDescriptorStoreMax:"1"},{...safe,NFileDescriptorStore:"1"},{...safe,FailureAction:"reboot"},{...safe,SuccessAction:"poweroff"},{...safe,StartLimitAction:"reboot-force"}])assert.equal(safeUnitDependencies(bad),false);
  const incomplete={...safe};delete incomplete.RequiredBy;assert.equal(safeUnitDependencies(incomplete),false);
});

test("loaded media safety policy refuses active APIs, publisher replacement and other paths", () => {
  const config = { api: false, metrics: false, pprof: false, playback: false, rtsp: false, rtmp: true, rtmpEncryption: "strict", rtmpsAddress: "0.0.0.0:1936", hls: true, hlsAddress: "127.0.0.1:8888", hlsEncryption: false, hlsAlwaysRemux: true, hlsVariant: "lowLatency", hlsDirectory: "", authMethod: "internal", pathDefaults: { source: "publisher", overridePublisher: false, record: false, alwaysAvailable: false }, paths: { station: {} }, hlsCDNSecret: "a".repeat(43) };
  assert.equal(safeLoadedConfig(config), true);
  for (const bad of [{ ...config, api: true }, { ...config, pathDefaults: { ...config.pathDefaults, overridePublisher: true } }, { ...config, paths: { all_others: {} } }, { ...config, hlsAddress: "0.0.0.0:8888" }, { ...config, hlsCDNSecret: "a".repeat(43) + "\n" }, { ...config, runOnDisconnect: "/usr/bin/true" }, { ...config, pathDefaults: { ...config.pathDefaults, runOnNotReady: "/usr/bin/true" } }]) assert.equal(Boolean(safeLoadedConfig(bad)), false);
  assert.equal(safeLoadedConfig({ ...config, runOnConnect: "", runOnConnectRestart: false }), true);
  assert.equal(hooksDisabled({ paths: { station: { runOnUnread: "/usr/bin/true" } } }), false);
  assert.equal(hooksDisabled({ paths: { station: { runOnUnread: "", runOnUnreadRestart: false } } }), true);
});

test("units retain dedicated credentials, fixed runtime, bounded timer and no activation side effects", () => {
  const service = renderIngressWatchdogService(), timer = renderIngressWatchdogTimer();
  assert.match(service, /ExecStart=\/usr\/bin\/flock .*\/opt\/chogcare-node-v24\.22\.0\/bin\/node \/opt\/chogcare-ingress-watchdog\/ingress-watchdog-runtime\.mjs --tick/);
  assert.match(service, /LoadCredential=hls-reader-token:\/etc\/chogcare-stream\/hls-reader-token/);
  assert.match(service, /StateDirectoryMode=0700/); assert.match(service, /CapabilityBoundingSet=\n/); assert.doesNotMatch(service, /SYS_PTRACE|NET_ADMIN|payments|ExecStartPost|ExecStopPost/);
  assert.match(service, /IPAddressDeny=any/); assert.match(service, /IPAddressAllow=localhost/); assert.match(timer, /OnUnitInactiveSec=5s/);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
  assert.doesNotMatch(service, /WantedBy|Requires=chogcare-stream|PartOf=chogcare-stream/);
});

test("private state uses durable replacement and rejects corruption, symlinks and concurrent changes", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ingress-watchdog-state-")); await chmod(directory, 0o700);
  try {
    const store = createPrivateStateStore(directory, process.getuid()); assert.equal(await store.load(), null);
    const state = createState(bootId, 0); await store.save(state); assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")), state);
    const concurrent = { toJSON() { writeFileSync(join(directory, "state.json"), JSON.stringify({ concurrent: true }), { mode: 0o600 }); return state; } };
    await assert.rejects(store.save(concurrent));
    assert.equal((await readdir(directory)).some(name => name.startsWith(".state-")), false);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")), { concurrent: true });
    await writeFile(join(directory, "state.json"), "{", { mode: 0o600 }); await assert.rejects(store.save(state));
    await rm(join(directory, "state.json")); await symlink(join(directory, "outside"), join(directory, "state.json")); await assert.rejects(createPrivateStateStore(directory, process.getuid()).load());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the unit kernel lock refuses a simultaneous owner before it can run", {skip:process.platform!=="linux"},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"ingress-watchdog-lock-")),lock=join(directory,"execution.lock");let first;
  try{
    first=spawn("/usr/bin/flock",["--exclusive","--nonblock","--conflict-exit-code=75","--no-fork",lock,"/usr/bin/sleep","2"],{stdio:"ignore"});
    const exited=new Promise((yes,no)=>{first.once("error",no);first.once("exit",yes)});
    let owns=false;for(let attempt=0;attempt<100;attempt++){try{if((await readFile(`/proc/${first.pid}/comm`,"utf8")).trim()==="sleep"){owns=true;break}}catch{}await new Promise(yes=>setTimeout(yes,10))}assert.equal(owns,true);
    const refused=await new Promise((yes,no)=>{const child=spawn("/usr/bin/flock",["--exclusive","--nonblock","--conflict-exit-code=75","--no-fork",lock,"/usr/bin/true"],{stdio:"ignore"});child.once("error",no);child.once("exit",yes)});
    assert.equal(refused,75);assert.equal(await exited,0);
  }finally{if(first&&first.exitCode===null)first.kill();await rm(directory,{recursive:true,force:true})}
});
