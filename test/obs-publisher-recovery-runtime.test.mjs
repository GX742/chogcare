import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm, link, lstat, realpath, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { createState } from "../ops/stream/obs-publisher-recovery.mjs";
import { acquireSingleton, createEventGuard, createPrivateStore, createPublisherAdapter, createSessionTracker,
  getHttpsText, obsConfigurationPath, parseArguments, probeHls, readBoundedDescriptor, readBoundedFile, runPublisherLoop, sourceHash, validateBinding, validateOrigin } from "../ops/stream/obs-publisher-recovery-runtime.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const bootId = hash("synthetic-boot");
const source = { profile: "synthetic-profile", service: { streamServiceSettings: { key: "synthetic-key" } }, video: { outputWidth: 720 }, collection: "synthetic-collection" };
const binding = { version: 1, salt: "A".repeat(43), sourceHash: sourceHash("A".repeat(43), source), publicOrigin: "https://site.example", origin: "https://origin.example",
  moduleHashes: Object.fromEntries(["runtime", "engine", "client", "parser"].map(name => [name, hash(name)])) };

async function cleanupFixture(directory) {
  const target = resolve(directory), temporaryRoot = await realpath(tmpdir());
  assert.match(basename(target), /^publisher-(?:store|flush|file)-[A-Za-z0-9]+$/);
  assert.equal(await realpath(dirname(target)), temporaryRoot);
  const info = await lstat(target);
  assert.equal(info.isDirectory() && !info.isSymbolicLink(), true);
  assert.equal(dirname(await realpath(target)), temporaryRoot);
  await rm(target, { recursive: true });
}

test("enrolled origins accept only bounded HTTPS roots, and later CLI modes cannot override them", () => {
  assert.equal(validateOrigin("https://site.example/"), binding.publicOrigin);
  assert.equal(validateBinding(binding), binding);
  for (const invalid of ["http://site.example", "https://user:password@site.example", "https://site.example/live/station/", "https://site.example?key=x", "https://site.example/#x", "https://site.example:1936", "https://localhost", "https://127.0.0.1", "https://10.0.0.1", "https://172.16.1.2", "https://192.168.1.2", "https://[::1]"]) assert.throws(() => validateOrigin(invalid));
  assert.equal(parseArguments(["--enroll", "--directory", "C:/synthetic/private", "--public-origin", binding.publicOrigin, "--origin", binding.origin]).mode, "--enroll");
  for (const args of [["--run"], ["--run", "--directory", "C:/synthetic/private", "--origin", binding.origin], ["--run", "--directory", "C:/a", "--directory", "C:/b"], ["--run", "--directory", "\\\\server\\share"], ["--unknown", "--directory", "C:/a"],
    ["--run", "--directory", "C:/a", "__proto__", "synthetic"], ["--run", "--directory", "C:/a", "constructor", "synthetic"], ["--enroll", "--directory", "C:/a", "--origin", binding.origin, "--origin", binding.origin, "--public-origin", binding.publicOrigin]]) assert.throws(() => parseArguments(args));
});

test("OBS configuration uses the OS KnownFolder query and refuses malformed or remote returned roots", async () => {
  const result = await obsConfigurationPath(async (executable, args, options) => {
    assert.equal(executable, "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.equal(Buffer.from(args[3], "base64").toString("utf16le"), "$ErrorActionPreference='Stop';[Console]::Out.Write([Environment]::GetFolderPath('ApplicationData'))");
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
    return { stdout: "C:\\synthetic\\Roaming" };
  });
  assert.equal(result, "C:\\synthetic\\Roaming\\obs-studio\\plugin_config\\obs-websocket\\config.json");
  for (const stdout of ["", "C:relative", "\\root-relative", "\\\\server\\share", "C:\\synthetic\\..\\other", "C:\\synthetic\ninvalid", "x".repeat(2049)])
    await assert.rejects(() => obsConfigurationPath(async () => ({ stdout })));
});

test("HLS health follows only one validated video child with one shared endpoint deadline", async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nvideo.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-MAP:URI="abcdef_video_init.mp4"\n#EXTINF:1,\nabcdef_video_seg3.mp4\n#EXTINF:1,\nabcdef_video_seg4.mp4\n';
  let time = 0; const calls = [];
  const get = async (url, remaining) => { calls.push({ url, remaining }); time += 700; return { status: 200, text: calls.length === 1 ? master : media }; };
  const result = await probeHls(binding.publicOrigin, { get, clock: () => time });
  assert.equal(result.valid, true); assert.match(result.mediaIdHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(value => value.url), ["https://site.example/live/station/index.m3u8", "https://site.example/live/station/video.m3u8"]);
  assert.deepEqual(calls.map(value => value.remaining), [3000, 2300]);
  for (const child of ["../video.m3u8", "https://other.example/video.m3u8", "video.m3u8?secret=x"]) {
    let count = 0;
    const bad = await probeHls(binding.publicOrigin, { get: async () => { count++; return { status: 200, text: master.replace("video.m3u8", child) }; } });
    assert.equal(bad.valid, false); assert.equal(count, 1);
  }
  assert.deepEqual(await probeHls(binding.origin, { get: async () => ({ status: 404, text: "" }) }), { status: 404, valid: false, mediaIdHash: null });
});

test("HTTPS transport keeps TLS verification and sends no credentials, cookies, redirect or media request", async () => {
  let options, requests = 0; const req = new EventEmitter(); req.destroy = () => req.emit("close");
  req.end = () => { const response = new EventEmitter(); response.statusCode = 302; response.headers = { location: "https://other.example/private" }; response.destroy = () => {};
    queueMicrotask(() => callback(response)); };
  let callback;
  const result = await getHttpsText("https://site.example/live/station/index.m3u8", 1000, (_url, settings, cb) => { requests++; options = settings; callback = cb; return req; });
  assert.equal(result.status, 302); assert.equal(requests, 1); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  assert.equal(options.method, "GET"); assert.equal("Authorization" in options.headers, false); assert.equal("Cookie" in options.headers, false);
});

test("private store checks missing files before ACL, caches inherited ownership and preserves concurrent changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-store-")); const proofs = [];
  try {
    const store = createPrivateStore(directory, { prove: async (path, isDirectory) => proofs.push({ path, isDirectory }) });
    assert.equal(await store.load("state.json"), null); assert.equal(proofs.length, 1);
    await store.create("state.json", { intents: [1] });
    for (let index = 0; index < 10; index++) { assert.equal(await store.paused(), false); await store.save("state.json", { intents: [1], index }); }
    assert.equal(proofs.length, 1, "RPC pause checks and owned inherited files must not launch ACL subprocesses");
    await store.verify(); assert.equal(proofs.length, 2);
    await writeFile(join(directory, "state.json"), '{"otherWriter":true}');
    await assert.rejects(() => store.save("state.json", { intents: [] }));
    assert.equal((await readFile(join(directory, "state.json"), "utf8")), '{"otherWriter":true}');
    assert.equal((await readdir(directory)).some(name => name.endsWith(".tmp")), false);
    await store.create("pause.flag", { version: 1 }); assert.equal(await store.paused(), true);
  } finally { await cleanupFixture(directory); }
});

test("a post-replacement flush failure preserves the reserved ledger and must propagate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-flush-")); let fail = false;
  try {
    const store = createPrivateStore(directory, { prove: async () => {}, flush: async (file, phase) => { await file.sync(); if (fail && phase === "replaced") throw Error("synthetic uncertain flush"); } });
    await store.create("state.json", { intents: [] }); await store.load("state.json"); fail = true;
    await assert.rejects(() => store.save("state.json", { intents: [123] }));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")), { intents: [123] });
    fail = false; await assert.rejects(() => store.save("state.json", { intents: [] }), "The stale pre-reservation lease cannot refund a possibly durable intent");
    assert.deepEqual((await readdir(directory)).sort(), ["state.json"]);
  } finally { await cleanupFixture(directory); }
});

test("bounded private descriptors reject zero, excessive bytes and multiple links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-file-")); const path = join(directory, "synthetic.json");
  try {
    await writeFile(path, ""); await assert.rejects(() => readBoundedFile(path));
    await writeFile(path, "x".repeat(100)); await assert.rejects(() => readBoundedFile(path, 50));
    await writeFile(path, "synthetic"); await link(path, join(directory, "hardlink")); await assert.rejects(() => readBoundedFile(path));
  } finally { await cleanupFixture(directory); }
});

test("a descriptor and a different file's pathname are rejected before any payload read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-file-")), path = join(directory, "other.json"); let file, other;
  try {
    file = await open(join(directory, "original.json"), "wx+", 0o600); other = await open(path, "wx+", 0o600);
    const payload = Buffer.from("original-synthetic");
    for (const descriptor of [file, other]) await descriptor.write(payload, 0, payload.length, 0);
    const originalInfo = await file.stat({ bigint: true }), otherInfo = await other.stat({ bigint: true });
    for (const info of [originalInfo, otherInfo]) { assert.equal(info.isFile(), true); assert.equal(info.nlink, 1n); assert.equal(info.size, BigInt(payload.length)); }
    assert.notDeepEqual([originalInfo.dev, originalInfo.ino], [otherInfo.dev, otherInfo.ino]);
    assert.deepEqual((await readBoundedDescriptor(other, path)).bytes, payload, "the matching descriptor/name pair must remain readable");
    await assert.rejects(() => readBoundedDescriptor(file, path));
    const first = Buffer.alloc(1); await file.read(first, 0, 1, null); assert.equal(first.toString(), "o", "rejection must precede reading the original descriptor");
  } finally { await other?.close(); await file?.close(); await cleanupFixture(directory); }
});

test("symbolic links fail both no-follow opening and named-descriptor verification", { skip: process.platform === "win32" ? "Unprivileged Windows symlink creation is not assumed; exercised in Linux fixture" : false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "publisher-file-")), target = join(directory, "target.json"), path = join(directory, "symbolic.json"); let file;
  try {
    await writeFile(target, "synthetic"); await symlink(target, path);
    await assert.rejects(() => readBoundedFile(path));
    file = await open(path, "r"); await assert.rejects(() => readBoundedDescriptor(file, path));
  } finally { await file?.close(); await cleanupFixture(directory); }
});

test("session continuity resets on any counter rollback or more than two seconds of start-time drift", () => {
  let id = 0; const tracker = createSessionTracker(() => hash(String(id++)));
  const stream = { outputDuration: 10000, outputBytes: 1000, outputTotalFrames: 300 };
  const first = tracker.update(stream, 20000);
  assert.equal(tracker.update({ outputDuration: 11000, outputBytes: 1100, outputTotalFrames: 330 }, 21000), first);
  assert.notEqual(tracker.update({ ...stream, outputBytes: 1 }, 22000), first);
  const second = tracker.hash; tracker.update({ ...stream, outputDuration: 10000 }, 30001); assert.notEqual(tracker.hash, second);
});

test("manual stop/config/disconnect cancel, while only the owned stopping phase accepts its stop events", () => {
  for (const event of [{ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPING" }, { type: "CurrentProfileChanging" }, { type: "CurrentSceneCollectionChanging" }, { type: "ConnectionClosed" }]) {
    const guard = createEventGuard(); guard.state.connected = true; guard.event(event); assert.ok(guard.state.cancelEpoch > 0);
  }
  const own = createEventGuard(); own.state.phase = "stopping";
  own.event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPING" });
  own.event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
  assert.equal(own.state.cancelEpoch, 0); assert.equal(own.state.unexpectedStop, false);
  own.event({ type: "CurrentProfileChanged" }); assert.equal(own.state.cancelEpoch, 1);
  for (const outputState of ["OBS_WEBSOCKET_OUTPUT_STARTING", "OBS_WEBSOCKET_OUTPUT_STARTED"]) {
    const changed = createEventGuard(); changed.state.phase = "stopping";
    changed.event({ type: "StreamStateChanged", outputState });
    changed.event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    assert.equal(changed.state.unexpectedStop, true); assert.ok(changed.state.cancelEpoch > 0, "An intervening user Start then Stop cannot reuse our owned stop lease");
  }
});

function adapterFixture() {
  let active = true, paused = false, event, probes = 0, proofs = 0;
  const requests = [];
  const client = {
    async request(type, data) {
      requests.push(type);
      if (type === "GetProfileList") return { currentProfileName: source.profile };
      if (type === "GetStreamServiceSettings") return structuredClone(source.service);
      if (type === "GetVideoSettings") return structuredClone(source.video);
      if (type === "GetSceneCollectionList") return { currentSceneCollectionName: source.collection };
      if (type === "GetStreamStatus") return { outputActive: active, outputReconnecting: false, outputDuration: active ? 150000 : 0, outputBytes: active ? 10000 : 0, outputTotalFrames: active ? 4500 : 0 };
      if (["GetRecordStatus", "GetVirtualCamStatus"].includes(type)) return { outputActive: false };
      if (type === "GetReplayBufferStatus") throw Error("Local OBS request rejected (604).");
      if (type === "GetProfileParameter") return { parameterValue: data.parameterName === "Mode" ? "Advanced" : "false" };
      if (type === "StopStream") { active = false; event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputActive: false }); return {}; }
      if (type === "StartStream") { active = true; event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputActive: true }); return {}; }
      throw Error("unexpected synthetic RPC");
    }, close() {},
  };
  const adapter = createPublisherAdapter({ binding, clock: () => 200000,
    store: { paused: async () => paused, verify: async () => { proofs++; } }, configuration: async () => ({ port: 4455, password: "synthetic-password" }),
    connect: async options => { event = options.onRecoveryEvent; return client; }, probe: async () => { probes++; return { status: 404, valid: false }; },
  });
  return { adapter, requests, setPaused(value) { paused = value; }, event(value) { event(value); }, get probes() { return probes; }, get proofs() { return proofs; } };
}

test("production adapter retains only its owned stop session and does no HTTP or ACL process per post-stop poll", async () => {
  const f = adapterFixture(); await f.adapter.observe();
  const tx = f.adapter.transaction(async () => {}), before = await tx.inspect();
  assert.equal(before.bothMissing, true); await tx.stop(); const probes = f.probes, proofs = f.proofs;
  for (let index = 0; index < 3; index++) {
    const stopped = await tx.inspect(); assert.equal(stopped.outputActive, false); assert.equal(stopped.sessionHash, before.sessionHash);
    assert.equal(stopped.cancelEpoch, before.cancelEpoch); assert.equal(stopped.unexpectedStop, false);
  }
  assert.equal(f.probes, probes); assert.equal(f.proofs, proofs);
  await tx.start(); f.adapter.finishTransaction();
  assert.deepEqual(f.requests.filter(type => ["StopStream", "StartStream"].includes(type)), ["StopStream", "StartStream"]);
  f.adapter.close();
});

test("pause immediately before Stop and a distinguishable user start/stop prevent automatic continuation", async () => {
  const paused = adapterFixture(); await paused.adapter.observe(); const pausedTx = paused.adapter.transaction(async () => {}); await pausedTx.inspect();
  paused.setPaused(true); await assert.rejects(() => pausedTx.stop()); assert.equal(paused.requests.includes("StopStream"), false);
  const changed = adapterFixture(); await changed.adapter.observe(); const tx = changed.adapter.transaction(async () => {}); const before = await tx.inspect(); await tx.stop();
  changed.event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputActive: true });
  changed.event({ type: "StreamStateChanged", outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputActive: false });
  const after = await tx.inspect(); assert.equal(after.unexpectedStop, true); assert.ok(after.cancelEpoch > before.cancelEpoch);
  assert.equal(changed.requests.includes("StartStream"), false); paused.adapter.close(); changed.adapter.close();
});

function loopFixture({ missingState = false, uncertainPersist = false, stopUnknown = false } = {}) {
  let time = 0, session = 0, sessionBegan = -150000, stopped = false, paused = false;
  const data = { "state.json": missingState ? null : createState(bootId, 0), "status.json": null }, calls = { stop: 0, start: 0, finish: 0, observe: 0, writes: 0 };
  const canonicalBinding = value => Array.isArray(value) ? value.map(canonicalBinding) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalBinding(value[key])])) : value;
  const enrolled = hash(JSON.stringify(canonicalBinding(binding)));
  const sample = () => {
    const healthy = time - sessionBegan <= 180000 && (session === 0 ? time <= 30000 : time - sessionBegan <= 30000);
    const hls = healthy ? { status: 200, valid: true, mediaIdHash: hash(String(time)) } : { status: 404, valid: false };
    return { enabled: !paused, connected: true, configChanging: false, unexpectedStop: false, cancelEpoch: 0, connectionHash: hash("connection"), sessionHash: hash(`session-${session}`), bindingHash: enrolled,
      outputActive: !stopped, outputReconnecting: false, outputDuration: time - sessionBegan, outputBytes: (time - sessionBegan + 1000) * 100, outputTotalFrames: (time - sessionBegan + 1000) * 30,
      publicHls: hls, originHls: hls, bothMissing: hls.status === 404 };
  };
  const store = {
    async load(name) { return structuredClone(data[name] ?? null); },
    async save(name, value) { calls.writes++; data[name] = structuredClone(value); if (uncertainPersist && name === "state.json" && value.intents.length) throw Error("synthetic post-write flush failure"); },
    async paused() { return paused; }, async create(name) { assert.equal(name, "pause.flag"); paused = true; },
  };
  const adapter = {
    async observe() { calls.observe++; return sample(); },
    transaction(persist) { return { persist, now: () => time, cancelled: () => paused,
      inspect: async () => sample(), async stop() { assert.equal(data["state.json"].intents.length, calls.stop + 1); calls.stop++; if (stopUnknown) throw Error("unknown Stop result"); stopped = true; return true; },
      async start() { calls.start++; stopped = false; return true; }, sleep: async () => { time += 500; } }; },
    finishTransaction() { calls.finish++; session++; sessionBegan = time; }, cancel() { paused = true; },
  };
  return { data, calls, store, adapter, clock: () => time, sleep: async milliseconds => { time += milliseconds; }, get paused() { return paused; }, binding, bootId };
}

test("successful recovery keeps monitoring for a second budgeted incident and preserves the hourly cap", async () => {
  const f = loopFixture(); const result = await runPublisherLoop(f, { durationMs: 900000 });
  assert.equal(f.calls.stop, 2); assert.equal(f.calls.start, 2); assert.equal(f.calls.finish, 2);
  assert.ok(f.calls.observe > 100); assert.equal(f.data["state.json"].intents.length, 2); assert.equal(result.maxSampleGapMs, 5000);
});

test("missing ledger fails before observing OBS; observe mode reports cadence and never writes", async () => {
  const missing = loopFixture({ missingState: true }); await assert.rejects(() => runPublisherLoop(missing, { durationMs: 60000 })); assert.equal(missing.calls.observe, 0);
  const f = loopFixture(); const result = await runPublisherLoop(f, { observeOnly: true, durationMs: 60000 });
  assert.equal(f.calls.writes, 0); assert.equal(f.calls.stop, 0); assert.equal(result.samples, 12); assert.equal(result.armed, true); assert.equal(result.bindingVerified, true); assert.equal(result.maxSampleGapMs, 5000); assert.equal(result.elapsedMs, 60000);
});

test("uncertain reservation persistence exits without Stop or any later old-state save", async () => {
  const f = loopFixture({ uncertainPersist: true }); await assert.rejects(() => runPublisherLoop(f, { durationMs: 300000 }));
  assert.equal(f.calls.stop, 0); assert.equal(f.calls.start, 0); assert.equal(f.data["state.json"].intents.length, 1);
});

test("unknown Stop outcome creates a persistent pause and never retries or starts", async () => {
  const f = loopFixture({ stopUnknown: true }); const result = await runPublisherLoop(f, { durationMs: 600000 });
  assert.equal(f.calls.stop, 1); assert.equal(f.calls.start, 0); assert.equal(f.paused, true); assert.equal(result.manualRecoveryRequired, true); assert.equal(f.data["state.json"].intents.length, 1);
  assert.equal(f.data["status.json"].manualRecoveryRequired, true);
});

test("cancelling an idle or in-flight observation exits without another RPC cycle or writes", async () => {
  for (const during of [false, true]) {
    const f = loopFixture(); let cancelled = !during;
    f.adapter.cancelled = () => cancelled;
    if (during) f.adapter.observe = async () => { f.calls.observe++; cancelled = true; throw Error("synthetic disconnected"); };
    const result = await runPublisherLoop(f, { durationMs: Infinity });
    assert.equal(result.status, "cancelled"); assert.equal(f.calls.observe, during ? 1 : 0);
    assert.equal(f.calls.writes, 0); assert.equal(f.calls.stop, 0); assert.equal(f.calls.start, 0);
  }
});

test("singleton uses only one fixed exclusive loopback listener and closes incoming sockets", async () => {
  let connection, settings, closed = false; const server = new EventEmitter();
  server.listen = (value, callback) => { settings = value; callback(); }; server.close = callback => { closed = true; callback(); };
  const release = await acquireSingleton(callback => { connection = callback; return server; });
  assert.deepEqual(settings, { host: "127.0.0.1", port: 4466, exclusive: true });
  let destroyed = false; connection({ destroy() { destroyed = true; } }); assert.equal(destroyed, true); await release(); assert.equal(closed, true);
});
