import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, relative, basename } from "node:path";
import { createAdminController, sanitizePaymentConfig, projectVideoSettings, readLocalJson, createBoundedExecutor } from "../admin/controller.mjs";
import { runPrivatePaymentWorker } from "../admin/payment-worker.mjs";
import { runPrivateStationWorker } from "../admin/station-worker.mjs";
import { startPaymentWorker, PAYMENT_STARTUP_FAILURES } from "../scripts/start-payments.mjs";
import { PaymentIntegrityError } from "../server/payment-integrity.mjs";
import { HOST_RETIRED_MESSAGE, assertPaymentHostActive } from "../server/payment-host-retirement.mjs";

const SECRET = "Never-log-this-custody-password!123";
const config = { chainId: 143, paymentMode: "local-pilot", custodyConfigured: true, integrityLocked: false, paymentsEnabled: true, nftPaymentsEnabled: true, availableClaims: 3, poolHealthy: true, subsidyUsdc: "1.00", readiness: { processing: "connected", custody: "unlocked-local-pilot", pool: "funded" } };
const owncastVersion = "Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)";
const original = { latencyLevel: 2, videoQualityVariants: [{ name: "720p", videoPassthrough: false, audioPassthrough: false, videoBitrate: 1200, audioBitrate: 96, scaledWidth: 720, scaledHeight: 0, framerate: 24, cpuUsageLevel: 2 }] };
const pause = () => new Promise(ok => setImmediate(ok));
const testRoot = resolve("work");
async function removeFixture(path) {
  const child = relative(testRoot, resolve(path));
  assert.ok(child && !child.startsWith("..") && !child.includes("\\") && !child.includes("/") && basename(path).startsWith("admin-test-"));
  await rm(path, { recursive: true, force: true });
}

async function fixture(overrides = {}) {
  await mkdir(testRoot, { recursive: true });
  const workspace = await mkdtemp(join(testRoot, "admin-test-"));
  for (const folder of ["admin", "scripts"]) await mkdir(join(workspace, folder));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "chogcare" }));
  for (const filename of ["scripts/start-payments.mjs", "scripts/station-bridge.mjs", "scripts/station-serial.ps1", "admin/payment-worker.mjs", "admin/station-worker.mjs"]) await writeFile(join(workspace, filename), "// isolated test fixture");
  const calls = [], children = [], snapshots = [], tickets = [{ reference: "ABCDEF123456", status: "new", subject: "Help", message: "Plain ticket text", contact: "private contact", invoiceId: "a".repeat(64), createdAt: 1, updatedAt: 1 }];
  let fallback = null, alive = false, external = overrides.external ?? false;
  let video = structuredClone(original), postCount = 0;
  const deps = {
    assertPaymentHostActive,
    poll: false, startTimeout: 250, stopTimeout: 50,
    initDirectory: async (path, kind) => {
      assert.equal(path, workspace); assert.ok(["admin", "support"].includes(kind));
      calls.push({ protectDirectory: kind });
      const directory = join(workspace, "work", kind); await mkdir(directory, { recursive: true }); return directory;
    },
    exec: async (file, args, options) => { calls.push({ file, args, options }); return args[0] === "--version" ? "v24.22.0\n" : args.at(-2) === "is-active" ? "active\n" : ""; },
    portBusy: async port => external || port === 4174 && (alive || fallback?.listening),
    requestJson: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/payments/config")) {
        if (alive || external) return { ...config, privateKey: SECRET, error: SECRET, version: SECRET };
        if (fallback?.listening) return { ...config, paymentMode: "offline", custodyConfigured: false, paymentsEnabled: false, nftPaymentsEnabled: false, readiness: { processing: "offline" } };
        throw new Error(SECRET);
      }
      if (url.endsWith("/api/config")) return { version: owncastVersion };
      if (url.endsWith("/api/admin/serverconfig")) return { videoCodec: "libx264", videoSettings: structuredClone(video), adminPassword: SECRET, streamKey: SECRET, storageSecret: SECRET };
      if (options.method === "POST") {
        postCount++; const body = JSON.parse(options.body);
        if (overrides.failPost === postCount) throw new Error(SECRET);
        if (url.endsWith("streamoutputvariants")) video.videoQualityVariants = body.value;
        else if (url.endsWith("streamlatencylevel")) video.latencyLevel = body.value;
        return { success: true };
      }
      throw new Error(SECRET);
    },
    createOfflineOperationsService: options => {
      calls.push({ offlineOptions: options });
      const server = new EventEmitter(); server.listening = false;
      server.listen = (port, host, callback) => { calls.push({ listen: { port, host } }); server.listening = true; queueMicrotask(callback); return server; };
      server.close = callback => { calls.push({ closeFallback: true }); server.listening = false; server.emit("close"); queueMicrotask(() => callback?.()); return server; };
      fallback = server; return server;
    },
    supportStore: {
      list: () => structuredClone(tickets), summary: () => ({ total: 1, new: tickets[0].status === "new" ? 1 : 0, read: tickets[0].status === "read" ? 1 : 0 }),
      setStatus: (id, status) => { if (id !== tickets[0].reference) return null; tickets[0].status = status; return structuredClone(tickets[0]); }, close() { calls.push({ supportClosed: true }); },
    },
    quoteService: { async quote(input) { calls.push({ quote: input }); return { checkedAt: 1, amountChog: input.amount, totalChog: "330", bridgeFeeUsd: "0.2", notice: "Estimate only; source gas and slippage are separate." }; }, close() { calls.push({ quotesClosed: true }); } },
    fork: (file, args, options) => {
      calls.push({ fork: { file, args, options } });
      const child = new EventEmitter(); child.connected = true; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.sent = [];
      child.kill = () => { throw new Error("TEST FORBIDS child.kill"); };
      child.send = (message, callback) => {
        child.sent.push(structuredClone(message)); callback?.();
        if (message.type === "secret") { alive = true; queueMicrotask(() => child.emit("message", { type: "ready" })); }
        if (message.type === "stop" && !overrides.stallStop) { alive = false; child.connected = false; queueMicrotask(() => child.emit("exit", 0)); }
        if (message.type === "test" && !overrides.stallTest) queueMicrotask(()=>child.emit("message",{type:"test-result",requestId:message.requestId,status:overrides.testStatus??"accepted"}));
      };
      children.push(child);
      queueMicrotask(() => child.emit("message", { type: file.endsWith("payment-worker.mjs") ? "secret-request" : "ready" }));
      return child;
    },
    ...overrides.dependencies,
  };
  let admin;
  try { admin = await createAdminController({ workspacePath: workspace, nodePath: process.execPath, onChange: value => snapshots.push(value) }, deps); }
  catch (error) { await removeFixture(workspace); throw error; }
  return { admin, calls, children, workspace, snapshots, video: () => video,
    async dispose() { for (const child of children) if (child.connected) { child.connected = false; alive = false; child.emit("exit", 0); } await admin.close(); await removeFixture(workspace); } };
}

test("offline admin hosts only an owned loopback operations service and publishes a secret-free snapshot", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.calls.find(item => item.listen).listen, { port: 4174, host: "127.0.0.1" });
    assert.equal(f.admin.snapshot().payments.paymentMode, "offline");
    assert.equal(f.admin.snapshot().services.find(item => item.id === "payments").state, "stopped");
    assert.deepEqual(f.admin.snapshot().support, { total: 1, open: 1 });
    assert.equal(JSON.stringify(f.admin.snapshot()).includes("private contact"), false);
    assert.equal(JSON.stringify(f.admin.snapshot()).includes("Plain ticket text"), false);
    assert.equal(JSON.stringify(f.admin.settings()).includes("password"), false);
    assert.equal(f.calls.some(item => item.args?.includes("stop")), false);
    assert.deepEqual(f.calls.filter(item => item.protectDirectory).map(item => item.protectDirectory), ["admin", "support"]);
    assert.ok(f.calls.findIndex(item => item.protectDirectory === "support") < f.calls.findIndex(item => item.offlineOptions), "private storage is protected before inbox/API initialization");
  } finally { await f.dispose(); }
});

test("retired desktop host rejects payment launch before forking or sending its password", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workspace, "work/payments/integrity"), { recursive: true });
    // Corrupt metadata is a hold too; it cannot silently reactivate custody.
    await writeFile(join(f.workspace, "work/payments/integrity/host-retired.json"), "{");
    await assert.rejects(f.admin.action({ type: "payments.start", password: SECRET }), { message: HOST_RETIRED_MESSAGE });
    assert.equal(f.children.length, 0);
    assert.equal(JSON.stringify(f.admin.snapshot()).includes(SECRET), false);
  } finally { await f.dispose(); }
});

test("controller refuses either UNC spelling before local filesystem initialization", async () => {
  let initialized = 0;
  for (const workspacePath of ["//untrusted.invalid/share/chogcare", "\\\\untrusted.invalid\\share\\chogcare", "\\\\?\\C:\\project"]) {
    await assert.rejects(createAdminController({ workspacePath }, { initDirectory() { initialized++; throw Error("must not call"); } }), /Choose the trusted local/);
  }
  assert.equal(initialized, 0);
});

test("failed operations directory protection aborts startup before inbox or fallback API", async () => {
  await assert.rejects(fixture({ dependencies: { initDirectory: () => { throw Error("Directory permission protection failed."); } } }), /Directory permission protection failed/);
});

test("existing financial workers stay external and cannot be stopped or replaced by GUI", async () => {
  const f = await fixture({ external: true });
  try {
    assert.equal(f.calls.some(item => item.listen), false);
    assert.equal(f.admin.snapshot().services.find(item => item.id === "payments").state, "external");
    await assert.rejects(f.admin.action({ type: "payments.stop" }), /does not own/);
    await assert.rejects(f.admin.action({ type: "payments.start", password: SECRET }), /existing payment/);
    assert.equal(f.children.length, 0);
    assert.equal(JSON.stringify(f.snapshots).includes(SECRET), false);
  } finally { await f.dispose(); }
});

test("one-use custody IPC waits for the child's preflight request, never argv/env/stdout", async () => {
  const f = await fixture();
  try {
    const input = { type: "payments.start", password: SECRET };
    await f.admin.action(input);
    assert.equal(input.password, "");
    const launch = f.calls.find(item => item.fork).fork, child = f.children[0];
    assert.deepEqual(launch.args, []); assert.deepEqual(launch.options.execArgv, []);
    assert.equal(launch.options.execPath, process.execPath);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(JSON.stringify(launch).includes(SECRET), false);
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "HTTP_PROXY", "HTTPS_PROXY", "ELECTRON_RUN_AS_NODE"]) assert.equal(launch.options.env[name], undefined);
    assert.equal(launch.options.env.OS, process.platform === "win32" ? "Windows_NT" : undefined);
    assert.equal(launch.options.env.PSModulePath, join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"));
    assert.equal(launch.options.env.CHOGCARE_PUBLIC_ORIGIN,"https://chogcare.xyz");
    assert.deepEqual(child.sent, [{ type: "secret", password: SECRET }]);
    child.emit("message", { type: "secret-request" });
    child.stdout.write(SECRET); child.stderr.write(SECRET);
    child.emit("message", { type: "event", code: SECRET, level: "error" });
    child.emit("message", { type: "event", code: "chog-network", level: "error", detail: SECRET });
    assert.equal(child.sent.length, 1);
    assert.equal(JSON.stringify(f.snapshots).includes(SECRET), false);
    await f.admin.action({ type: "payments.stop" }); await pause();
    assert.deepEqual(child.sent.at(-1), { type: "stop" });
    assert.equal(f.calls.filter(item => item.listen).length, 2, "offline support returns only after the managed signer exits");
  } finally { await f.dispose(); }
});

test("inherited system-directory variables cannot choose worker command binaries", async () => {
  const previous = Object.fromEntries(["SystemRoot", "WINDIR", "ComSpec"].map(key => [key, process.env[key]]));
  let f;
  try {
    process.env.SystemRoot = "Z:\\untrusted"; process.env.WINDIR = "Z:\\untrusted"; process.env.ComSpec = "Z:\\untrusted\\cmd.exe";
    f = await fixture();
    await f.admin.action({ type: "payments.start", password: SECRET });
    const environment = f.calls.find(item => item.fork).fork.options.env;
    assert.equal(environment.SystemRoot, "C:\\Windows"); assert.equal(environment.WINDIR, "C:\\Windows");
    assert.equal(environment.ComSpec, join("C:\\Windows", "System32", "cmd.exe"));
    assert.equal(environment.PSModulePath, join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"));
    assert.equal(environment.PATH.includes("untrusted"), false);
    await f.admin.action({ type: "broadcast.start", confirmed: true });
    const serviceCalls = f.calls.filter(item => item.args?.includes("/bin/systemctl"));
    assert.ok(serviceCalls.length > 0);
    assert.ok(serviceCalls.every(item => item.file === "C:\\Windows\\System32\\wsl.exe"));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f?.dispose();
  }
});

test("sanitized Windows worker environment supports real private operations ACL initialization without custody", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture();
  try {
    await f.admin.action({ type: "payments.start", password: SECRET });
    const launch = f.calls.find(item => item.fork).fork;
    const source = `import { initLocalOpsDirectory } from './server/local-ops-storage.mjs';
      import { execFileSync } from 'node:child_process';
      const run = (file, args, options) => {
        try { return execFileSync(file, args, options); }
        catch (error) { console.error('Isolated ACL probe:', JSON.stringify({code:error.code, status:error.status, signal:error.signal})); throw error; }
      };
      for (let repeat = 0; repeat < 2; repeat++) for (const kind of ['support', 'admin']) initLocalOpsDirectory(process.argv[1], kind, {run});`;
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", source, f.workspace], {
      cwd: resolve("."), env: launch.options.env, shell: false, windowsHide: true,
      timeout: 60000, stdio: ["ignore", "ignore", "inherit"],
    }));
  } finally { await f.dispose(); }
});

test("a concurrent status poll cannot reclaim the offline API during signer port handoff", async () => {
  let poll, hold = false, probing = false, finishProbe;
  const f = await fixture({ dependencies: {
    poll: true,
    setInterval(callback) { poll = callback; return { unref() {} }; }, clearInterval() {},
    portBusy: async port => {
      if (hold && port === 4174 && !probing) { probing = true; poll(); return await new Promise(ok => { finishProbe = ok; }); }
      return false;
    },
  } });
  try {
    hold = true;
    const starting = f.admin.action({ type: "payments.start", password: SECRET });
    await pause(); assert.equal(probing, true); await pause();
    assert.equal(f.calls.filter(item => item.listen).length, 1, "poll must not reopen 4174 after owned fallback close");
    assert.equal(f.calls.some(item => item.closeFallback), true);
    finishProbe(false); await starting;
    assert.equal(f.children.length, 1);
    assert.equal(f.admin.snapshot().services.find(item => item.id === "payments").managed, true);
  } finally { finishProbe?.(false); await f.dispose(); }
});

test("graceful stop timeout preserves managed worker; it never uses abrupt Windows kill", async () => {
  const f = await fixture({ stallStop: true });
  try {
    await f.admin.action({ type: "payments.start", password: SECRET });
    await assert.rejects(f.admin.action({ type: "payments.stop" }), /no force termination/);
    assert.equal(f.children[0].connected, true);
    assert.equal(f.admin.snapshot().services.find(item => item.id === "payments").managed, true);
    assert.equal(f.calls.filter(item => item.listen).length, 1);
    await assert.rejects(f.admin.close(), /no force termination/);
  } finally { await f.dispose(); }
});

test("strict action schemas reject arbitrary command, URL, PID, workspace or port injection", async () => {
  const f = await fixture();
  try {
    for (const input of [
      { type: "shell", command: "whoami" }, { type: "payments.stop", pid: 123 }, { type: "payments.start", password: SECRET, url: "http://evil" },
      { type: "station.start", port: "COM4;bad" }, { type: "station.start", port: "COM0" }, { type: "gateway.start" },
      { type: "broadcast.stop", confirmed: false }, { type: "broadcast.start", confirmed: true, unit: "ssh" },
      { type: "settings.save", stationPort: "COM4", workspacePath: "C:\\Windows" }, { type: "settings.save", stationPort: "COM4", nodePath: "evil.exe" },
    ]) await assert.rejects(f.admin.action(input));
    assert.equal(f.children.length, 0);
    assert.equal(f.calls.some(item => item.args?.includes("stop") || item.args?.includes("start")), false);
    await f.admin.action({ type: "settings.save", stationPort: "COM8", workspacePath: f.workspace });
    assert.equal(f.admin.settings().stationPort, "COM8");
    const settings = await readFile(join(f.workspace, "work/admin/settings.json"), "utf8");
    assert.equal(settings.includes(SECRET), false);
    await f.admin.action({ type: "refresh" });
  } finally { await f.dispose(); }
});

test("broadcast and gateway commands use fixed WSL units, explicit confirmation and no tunnel mutation", async () => {
  const f = await fixture();
  try {
    await f.admin.action({ type: "broadcast.stop", confirmed: true });
    await f.admin.action({ type: "broadcast.start", confirmed: true });
    await f.admin.action({ type: "gateway.start", confirmed: true });
    const mutations = f.calls.filter(item => item.args?.includes("start") || item.args?.includes("stop"));
    assert.deepEqual(mutations.map(item => item.args.slice(-2)), [["stop", "owncast"], ["start", "owncast"], ["start", "nginx"]]);
    for (const item of mutations) assert.deepEqual(item.args.slice(0, -2), ["--distribution", "Ubuntu", "--user", "root", "--exec", "/bin/systemctl"]);
    assert.equal(JSON.stringify(mutations).includes("tailscale"), false);
    assert.match(f.admin.snapshot().services.find(item => item.id === "gateway").detail, /connectivity is not verified/);
  } finally { await f.dispose(); }
});

test("Owncast GUI config backs up only video fields, verifies fixed output and never persists credentials", async () => {
  const f = await fixture();
  try {
    await f.admin.action({ type: "broadcast.configure", password: SECRET });
    const backups = await readdir(join(f.workspace, "work/broadcast"));
    assert.equal(backups.length, 1);
    const backup = await readFile(join(f.workspace, "work/broadcast", backups[0]), "utf8");
    assert.deepEqual(JSON.parse(backup), original); assert.equal(backup.includes(SECRET), false);
    assert.equal(f.video().latencyLevel, 0);
    assert.deepEqual(f.video().videoQualityVariants[0], { name: "1080p", videoPassthrough: false, audioPassthrough: false, videoBitrate: 4500, audioBitrate: 128, scaledWidth: 1080, scaledHeight: 0, framerate: 30, cpuUsageLevel: 2 });
    assert.equal(f.admin.settings().owncastPasswordSet, true);
    assert.equal(JSON.stringify(f.snapshots).includes(SECRET), false);
    assert.equal(f.calls.some(item => item.args?.includes("stop") || item.args?.includes("start")), false);
  } finally { await f.dispose(); }
});

test("partial Owncast failure rolls back exactly attempted streaming fields", async () => {
  const f = await fixture({ failPost: 2 });
  try {
    await assert.rejects(f.admin.action({ type: "broadcast.configure", password: SECRET }), /restored and verified/);
    assert.deepEqual(f.video(), original);
    assert.equal(f.admin.settings().owncastPasswordSet, false);
    assert.equal(JSON.stringify(f.snapshots).includes(SECRET), false);
  } finally { await f.dispose(); }
});

test("local support is private, bounded, status-only mutable and absent from public snapshots", async () => {
  const f = await fixture();
  try {
    assert.equal(f.admin.listSupport({ limit: 10 })[0].id, "ABCDEF123456");
    assert.equal(f.admin.updateSupport({ id: "ABCDEF123456", status: "resolved" }).status, "resolved");
    assert.equal(f.admin.snapshot().support.open, 0);
    for (const input of [{ id: "bad", status: "read" }, { id: "ABCDEF123456", status: "deleted" }, { id: "ABCDEF123456", status: "read", message: "overwrite" }]) assert.throws(() => f.admin.updateSupport(input));
    for (const input of [{ status: "bad" }, { limit: 101 }, { url: "https://evil" }]) assert.throws(() => f.admin.listSupport(input));
    assert.equal(JSON.stringify(f.admin.snapshot()).includes("private contact"), false);
  } finally { await f.dispose(); }
});

test("read-only quote IPC never starts the signer or creates an invoice", async () => {
  const f = await fixture();
  try {
    const result = await f.admin.quote({ amount: "300", initiativeId: "solar-foundation" });
    assert.equal(result.amountChog, "300"); assert.equal(f.children.length, 0);
    await assert.rejects(f.admin.quote({ amount: "300", initiativeId: "solar-foundation", destination: "evil" }));
  } finally { await f.dispose(); }
});

test("config projections strip every unrelated key and reject wrong chain/schema", () => {
  assert.equal(sanitizePaymentConfig({ ...config, chainId: 1 }), null);
  assert.equal(sanitizePaymentConfig({ ...config, integrityLocked: undefined }), null);
  const result = sanitizePaymentConfig({ ...config, operatorKey: SECRET, error: SECRET, workerVersion: SECRET, poolTreasury: SECRET });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(projectVideoSettings({ videoCodec: "libx264", videoSettings: original, password: SECRET }), original);
  assert.throws(() => projectVideoSettings({ videoCodec: "evil", videoSettings: original }));
});

test("local JSON transport refuses external origins, redirects-by-URL and arbitrary API routes", async () => {
  for (const url of ["https://127.0.0.1:8082/api/config", "http://localhost:8082/api/config", "http://evil.example/api/config", "http://user:secret@127.0.0.1:8082/api/config", "http://127.0.0.1:8082/api/admin/serverconfig?url=evil", "http://127.0.0.1:4174/private", "http://127.0.0.1:22/api/config"]) await assert.rejects(readLocalJson(url), /Unsupported local service/);
});

test("native loopback JSON transport rejects redirects, chunked overflow, invalid length and UTF-8", async () => {
  const factory = ({ status = 200, length, chunks }) => (_url, options, callback) => {
    assert.equal(options.timeout, 10000);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = status; res.headers = length === undefined ? {} : { "content-length": length }; res.destroyed = false;
        res.destroy = () => { res.destroyed = true; };
        callback(res);
        for (const chunk of chunks ?? []) if (!res.destroyed) res.emit("data", Buffer.from(chunk));
        if (!res.destroyed) res.emit("end");
      });
    }; return req;
  };
  const url = "http://127.0.0.1:8082/api/config";
  assert.deepEqual(await readLocalJson(url, {}, 16, factory({ chunks: ["{\"ok\":true}"] })), { ok: true });
  for (const response of [
    { status: 302, chunks: ["{}"] }, { length: "99", chunks: ["{}"] }, { length: "2x", chunks: ["{}"] },
    { chunks: ["x".repeat(10), "x".repeat(10)] }, { length: "1", chunks: ["x".repeat(17)] }, { chunks: [Buffer.from([0xff])] },
  ]) await assert.rejects(readLocalJson(url, {}, 16, factory(response)), /Local service is unavailable/);
});

test("absolute local HTTP deadline rejects slow-drip headers/body and is cleared on settlement", async () => {
  let destroyed = 0, drip;
  const factory = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed++; clearInterval(drip); };
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; res.destroy = () => clearInterval(drip);
      callback(res);
      drip = setInterval(() => res.emit("data", Buffer.from(" ")), 1);
    };
    return req;
  };
  await assert.rejects(readLocalJson("http://127.0.0.1:8082/api/config", {}, 1024, factory, 15), /Local service is unavailable/);
  assert.equal(destroyed, 1); clearInterval(drip);
  let afterSuccess = 0;
  const success = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { afterSuccess++; };
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; callback(res); res.emit("data", Buffer.from("{}")); res.emit("end"); };
    return req;
  };
  await readLocalJson("http://127.0.0.1:8082/api/config", {}, 16, success, 10);
  await new Promise(ok => setTimeout(ok, 20)); assert.equal(afterSuccess, 0);
  const noHeaders = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed++; }; return req; };
  await assert.rejects(readLocalJson("http://127.0.0.1:8082/api/config", {}, 16, noHeaders, 10));
  assert.equal(destroyed, 2);
});

test("diagnostic command deadline never kills or respawns an unresolved subprocess", async () => {
  const children = [];
  const execute = createBoundedExecutor({ deadlineMilliseconds: 10, spawnChild() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { throw Error("forbidden"); }; children.push(child); return child;
  } });
  const args = ["--exec", "/bin/systemctl", "is-active", "owncast"];
  const pending = execute("wsl.exe", args);
  assert.equal(execute("wsl.exe", args), pending);
  await assert.rejects(pending, /deadline expired/);
  for (let index = 0; index < 5; index++) await assert.rejects(execute("wsl.exe", args), /still pending/);
  assert.equal(children.length, 1); assert.equal(execute.hasPendingMutations(), false);
  children[0].emit("exit", 3);
  const replacement = execute("wsl.exe", args, { acceptedExitCodes: [0, 3] });
  children[0].emit("close", 3); // An old close cannot remove a newer lease.
  assert.equal(execute("wsl.exe", args), replacement);
  children[1].stdout.write("inactive"); children[1].emit("exit", 3);
  assert.equal(await replacement, "inactive"); assert.equal(children.length, 2);
});

test("timed-out service changes stay tracked until exit so quitting cannot abandon a mutation", async () => {
  let child;
  const execute = createBoundedExecutor({ deadlineMilliseconds: 10, spawnChild() { child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child; } });
  await assert.rejects(execute("wsl.exe", ["--exec", "/bin/systemctl", "start", "owncast"]), /deadline expired/);
  assert.equal(execute.hasPendingMutations(), true);
  await assert.rejects(execute("wsl.exe", ["--exec", "/bin/systemctl", "stop", "owncast"]), /still pending/);
  child.emit("exit", 0); assert.equal(execute.hasPendingMutations(), false);
  let mutation = false;
  const mockExec = async (_file, args) => args[0] === "--version" ? "v24.22.0" : "active";
  mockExec.hasPendingMutations = () => mutation;
  const f = await fixture({ dependencies: { exec: mockExec } });
  try { mutation = true; await assert.rejects(f.admin.close(), /confirmed local service change is still pending/); mutation = false; await f.admin.close(); }
  finally { mutation = false; await f.dispose(); }
});

function privateChannel(args = []) {
  const channel = new EventEmitter(); channel.connected = true; channel.sent = []; channel.argv = ["node", "worker.mjs", ...args];
  channel.send = (value, callback) => { channel.sent.push(structuredClone(value)); callback?.(); };
  channel.disconnect = () => { channel.connected = false; channel.emit("disconnect"); };
  return channel;
}

test("private custody child accepts exactly one inherited secret and redacts errors", async () => {
  const channel = privateChannel(); let secret, closes = 0;
  const started = runPrivatePaymentWorker(channel, async options => {
    options.registerStop(async () => { closes++; });
    secret = await options.passwordProvider(); options.onEvent({ code: "ready", level: "info", detail: SECRET });
    return { close: async () => { closes++; } };
  });
  await pause();
  channel.emit("message", { type: "secret", password: SECRET, extra: true });
  assert.equal(secret, undefined);
  const input = { type: "secret", password: SECRET }; channel.emit("message", input);
  await started; assert.equal(secret, SECRET); assert.equal(input.password, "");
  channel.emit("message", { type: "secret", password: "ignored" });
  channel.emit("message", { type: "stop" }); await pause();
  assert.equal(closes, 1); assert.equal(channel.connected, false);
  assert.equal(JSON.stringify(channel.sent).includes(SECRET), false);
});

test("private station close drains its bridge over IPC and rejects demo/simulation", async () => {
  const channel = privateChannel(["--port", "COM7"]); let closed = 0;
  await runPrivateStationWorker(channel, async args => { assert.deepEqual(args, ["--port", "COM7"]); return { close: async () => { closed++; } }; });
  channel.emit("message", { type: "stop" }); await pause();
  assert.equal(closed, 1); assert.equal(channel.connected, false);
  await assert.rejects(runPrivateStationWorker(privateChannel(["--simulate"]), async () => {}));
});

test("station test is a strict owned-child command with no renderer-controlled amount or payload",async()=>{
  const f=await fixture();try{
    await assert.rejects(f.admin.action({type:"station.test"}),/Connect the station/);
    await f.admin.action({type:"station.start",port:"COM6"});
    for(const extra of [{amount:"300"},{port:"COM6"},{requestId:"a".repeat(24)},{payload:{type:"donation"}}])await assert.rejects(f.admin.action({type:"station.test",...extra}),/Unsupported/);
    await f.admin.action({type:"station.test"});const child=f.children[0],wire=child.sent.find(x=>x.type==="test");
    assert.deepEqual(Object.keys(wire),["type","requestId"]);assert.match(wire.requestId,/^[a-f0-9]{24}$/);
    assert.equal(f.admin.snapshot().stationTest,"running");await assert.rejects(f.admin.action({type:"station.test"}),/already running/);
    child.emit("message",{type:"event",code:"station-test-done",level:"info"});assert.equal(f.admin.snapshot().stationTest,"done");
    await f.admin.action({type:"station.test"});await f.admin.action({type:"station.stop"});assert.equal(f.admin.snapshot().stationTest,"idle");
    assert.equal(f.calls.filter(x=>x.fork).length,1,"no second process or serial connection is created for a test");
  }finally{await f.dispose();}
});

test("station test rejects busy/offline devices and clears a timed-out request without retrying it",async()=>{
  for(const options of [{testStatus:"busy"},{testStatus:"not-ready"},{stallTest:true,dependencies:{stationTestTimeout:10}}]){
    const f=await fixture(options);try{await f.admin.action({type:"station.start",port:"COM6"});await assert.rejects(f.admin.action({type:"station.test"}));
      assert.equal(f.admin.snapshot().stationTest,"error");assert.equal(f.children[0].sent.filter(x=>x.type==="test").length,1);
    }finally{await f.dispose();}
  }
});

test("private station test IPC strips arbitrary data and reports only fixed device test states",async()=>{
  const channel=privateChannel(["--port","COM6"]);let tests=0,callbacks;
  await runPrivateStationWorker(channel,async(_args,options)=>{callbacks=options;return {test(){tests++;return "accepted";},close:async()=>{}};});
  const requestId="a".repeat(24);
  for(const msg of [{type:"test"},{type:"test",requestId,amount:"999"},{type:"test",requestId:123},{type:"test",requestId:"bad"}])channel.emit("message",msg);
  assert.equal(tests,0);channel.emit("message",{type:"test",requestId});assert.equal(tests,1);
  assert.deepEqual(channel.sent.at(-1),{type:"test-result",requestId,status:"accepted"});
  callbacks.onTestState("done");assert.equal(channel.sent.at(-1).code,"station-test-done");
  const before=channel.sent.length;callbacks.onTestState(SECRET);assert.equal(channel.sent.length,before);
  channel.emit("message",{type:"stop"});await pause();assert.equal(channel.connected,false);
});

function startupDependencies(overrides = {}) {
  const calls = [];
  const probe = new EventEmitter(); probe.listen = (_port, _host, ok) => queueMicrotask(ok); probe.close = ok => ok();
  const processor = { operatorAddress: "public-operator", treasuryAddress: "public-treasury", tick: async () => {}, close: async () => { calls.push("processor-close"); }, publicStatus: () => config };
  const api = new EventEmitter(); api.listen = (_port, _host, ok) => queueMicrotask(ok); api.close = ok => { calls.push("api-close"); ok(); };
  return { calls, dependencies: {
    assertPaymentHostActive: () => { calls.push("host-active"); },
    acquireOperatorLease: async () => { calls.push("lease"); return { close: async () => { calls.push("lease-close"); } }; },
    createServer: () => { calls.push("port-probe"); return probe; },
    openPaymentIntegrity: () => { calls.push("integrity"); return { locked: false, checkpoint() { calls.push("checkpoint"); } }; },
    readFile: async () => { calls.push("vault-read"); return "{}"; },
    unlockCustodyVault: async (_vault, password) => { assert.equal(password, SECRET); calls.push("unlock"); return {}; },
    createBackupProtection: () => ({ close() { calls.push("backup-close"); } }),
    createPaymentBackup: () => { calls.push("backup"); return { output: "mock-backup" }; },
    verifyRecoveryBundle: () => ({ verified: true }),
    createChogProcessor: () => processor, createNftProcessor: () => processor,
    openInvoiceStore: () => ({ close() { calls.push("store-close"); } }), createPaymentService: () => api,
    ...overrides,
  } };
}

test("NFT pool public impact is read-only and unavailable during integrity hold or after stop", async () => {
  let combined, locked = false, reads = 0;
  const expected = { donatedUsdc: "1500000", donations: 2 };
  const f = startupDependencies({
    openPaymentIntegrity: () => ({ get locked() { return locked; }, checkpoint() {} }),
    createNftProcessor: () => ({ treasuryAddress: "public-treasury", publicStatus: () => ({ nftPaymentsEnabled: true, poolHealthy: true }), tick: async () => {}, close: async () => {}, nftPoolImpact() { reads++; return expected; } }),
    createPaymentService: (_store, _origin, _custody, processor) => {
      combined = processor;
      const api = new EventEmitter(); api.listen = (_port, _host, ok) => queueMicrotask(ok); api.close = ok => ok(); return api;
    },
  });
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {} }, f.dependencies);
  try {
    assert.deepEqual(combined.nftPoolImpact(), expected); assert.equal(reads, 1);
    locked = true;
    assert.equal(combined.nftPoolImpact(), null); assert.equal(reads, 1);
  } finally { await worker.close(); }
  locked = false;
  assert.equal(combined.nftPoolImpact(), null); assert.equal(reads, 1);
});

test("startup diagnostics identify initialization failures without forwarding caught secrets", async () => {
  const fail = () => { throw Error(SECRET); };
  const cases = [
    ["startup-vault-read", { readFile: async () => fail() }],
    ["startup-vault-unlock", { unlockCustodyVault: async () => fail() }],
    ["startup-chog-init", { createChogProcessor: fail }],
    ["startup-nft-init", { createNftProcessor: fail }],
  ];
  for (const [expected, overrides] of cases) {
    const events = [], f = startupDependencies(overrides);
    await assert.rejects(startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {}, onEvent: event => events.push(event) }, f.dependencies));
    assert.ok(events.some(event => event.code === expected && event.level === "error"));
    assert.equal(JSON.stringify(events).includes(SECRET), false);
    assert.equal(f.calls.at(-1), "lease-close");
    assert.equal(f.calls.includes("api-close"), false);
    assert.ok(Object.hasOwn(PAYMENT_STARTUP_FAILURES, expected));
  }
});

test("desktop recognizes only fixed startup reasons, not raw diagnostic messages", async () => {
  const f = await fixture();
  try {
    const opening = f.admin.action({ type: "payments.start", password: SECRET });
    await pause(); const child = f.children.at(-1);
    for (const code of Object.keys(PAYMENT_STARTUP_FAILURES)) child.emit("message", { type: "event", code, level: "error" });
    child.emit("message", { type: "event", code: "startup-vault-unlock", level: "error", message: SECRET });
    child.emit("message", { type: "ready" }); await opening;
    const events = f.admin.snapshot().events;
    for (const message of Object.values(PAYMENT_STARTUP_FAILURES)) assert.ok(events.some(event => event.message === message));
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  } finally { await f.dispose(); }
});

test("encrypted backup is verified on startup and sealed again before lease release", async () => {
  const events = [], f = startupDependencies();
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {}, onEvent: event => events.push(event) }, f.dependencies);
  assert.equal(worker.diagnostics().backup.verifiedAtStartup, true);
  assert.ok(worker.diagnostics().backup.lastBackupAt > 0);
  assert.ok(events.some(event => event.code === "backup-verified"));
  await worker.close();
  assert.equal(f.calls.filter(call => call === "backup").length, 2);
  assert.ok(f.calls.lastIndexOf("backup") < f.calls.indexOf("backup-close"));
  assert.ok(f.calls.indexOf("backup-close") < f.calls.indexOf("lease-close"));
});

test("backup failure is sanitized and does not interrupt existing payment processing", async () => {
  const events = [], f = startupDependencies({ createPaymentBackup() { throw Error(SECRET); } });
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {}, onEvent: event => events.push(event) }, f.dependencies);
  assert.ok(worker);
  assert.equal(worker.diagnostics().backup.verifiedAtStartup, false);
  assert.equal(worker.diagnostics().backup.lastBackupAt, 0);
  assert.ok(events.some(event => event.code === "backup-failed" && event.level === "warning"));
  assert.equal(JSON.stringify(events).includes(SECRET), false);
  await worker.close();
});

test("operations initialization failures are safely diagnosed and close the read-only impact source", async () => {
  const events = [];
  let impactClosed = false, apiCreated = false;
  const f = startupDependencies({
    openReadOnlyImpactSource: () => ({ summary: () => ({}), close() { impactClosed = true; } }),
    createOperationsRuntime: () => { throw Error(SECRET); },
    createPaymentService: () => { apiCreated = true; },
  });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => SECRET, onEvent: event => events.push(event) }, f.dependencies));
  assert.ok(events.some(event => event.code === "startup-operations-init" && event.level === "error"));
  assert.equal(JSON.stringify(events).includes(SECRET), false);
  assert.equal(impactClosed, true); assert.equal(apiCreated, false);
  assert.equal(f.calls.at(-1), "lease-close");
});

test("shared worker requests GUI password only after lease, port and integrity checks; closes checkpoint before lease", async () => {
  const f = startupDependencies(); let close;
  const worker = await startPaymentWorker({ passwordProvider: async () => { f.calls.push("password"); return SECRET; }, registerStop(value) { close = value; }, serviceOptions: {} }, f.dependencies);
  assert.ok(worker);
  assert.deepEqual(f.calls.slice(0, 7), ["lease", "host-active", "port-probe", "integrity", "vault-read", "password", "unlock"]);
  await close();
  assert.ok(f.calls.lastIndexOf("checkpoint") < f.calls.lastIndexOf("lease-close"));
  assert.ok(f.calls.indexOf("api-close") < f.calls.indexOf("processor-close"));
});

test("retired shared worker stops under its lease before state, port or password access", async () => {
  const events = [], f = startupDependencies({ assertPaymentHostActive: () => { throw Object.assign(Error("private metadata must not escape"), { code: "HOST_RETIRED" }); } });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => assert.fail("password requested"), onEvent: event => events.push(event) }, f.dependencies), { code: "HOST_RETIRED" });
  assert.deepEqual(f.calls, ["lease", "lease-close"]);
  assert.ok(events.some(event => event.code === "HOST_RETIRED"));
  assert.equal(JSON.stringify(events).includes("private metadata"), false);
});

test("NFT readiness failure keeps CHOG alive, blocks NFT issuance, and retries safely", async () => {
  let combined, networkReady = false, nftIssues = 0, chogIssues = 0, recovered;
  const recovery = new Promise(ok => { recovered = ok; });
  const events = [], f = startupDependencies({
    createChogProcessor: () => ({ operatorAddress: "public-operator", tick: async () => {}, close: async () => {}, publicStatus: () => ({ paymentsEnabled: true }), issue: async () => { chogIssues++; return { mock: true }; } }),
    createNftProcessor: () => ({ treasuryAddress: "public-treasury", tick: async () => { if (!networkReady) throw Error(SECRET); recovered(); }, close: async () => {}, publicStatus: () => ({ nftPaymentsEnabled: true, poolHealthy: true, poolTreasury: "public-treasury" }), issue: async () => { nftIssues++; } }),
    createPaymentService: (_store, _origin, _custody, processor) => {
      combined = processor;
      const api = new EventEmitter(); api.listen = (_port, _host, ok) => queueMicrotask(ok); api.close = ok => ok(); return api;
    },
  });
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {}, onEvent: event => events.push(event) }, f.dependencies);
  try {
    assert.ok(worker);
    assert.equal(combined.publicStatus().paymentsEnabled, true);
    assert.equal(combined.publicStatus().nftPaymentsEnabled, false);
    assert.equal(combined.publicStatus().poolHealthy, false);
    assert.equal(combined.publicStatus().poolTreasury, undefined);
    await assert.rejects(combined.issue({ mode: "nft" }), /not ready/);
    assert.equal(nftIssues, 0);
    await combined.issue({ mode: "chog" }); assert.equal(chogIssues, 1);
    assert.ok(events.some(event => event.code === "nft-network"));
    assert.equal(events.some(event => event.code === "startup-failed"), false);
    assert.equal(JSON.stringify(events).includes(SECRET), false);
    networkReady = true;
    let deadline;
    try { await Promise.race([recovery, new Promise((_ok, bad) => { deadline = setTimeout(() => bad(Error("Retry did not run")), 3000); })]); }
    finally { clearTimeout(deadline); }
    await pause();
    assert.equal(combined.publicStatus().nftPaymentsEnabled, true);
    assert.equal(combined.publicStatus().poolHealthy, true);
    assert.equal(combined.publicStatus().poolTreasury, "public-treasury");
  } finally { await worker.close(); }
});

for (const slowMode of ["chog", "nft"]) test(`slow ${slowMode} processing cannot starve the other mode or overlap its own signer`, async () => {
  let scheduled, release, stalled = false;
  const calls = { chog: 0, nft: 0 };
  const makeProcessor = mode => ({
    operatorAddress: "public-operator", treasuryAddress: "public-treasury",
    publicStatus: () => config,
    async tick() {
      calls[mode]++;
      if (mode === slowMode && stalled) await new Promise(ok => { release = ok; });
    }, close: async () => {},
  });
  const f = startupDependencies({
    createChogProcessor: () => makeProcessor("chog"), createNftProcessor: () => makeProcessor("nft"),
    setInterval(callback) { scheduled = callback; return { mock: true }; }, clearInterval() {},
  });
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {} }, f.dependencies);
  try {
    stalled = true;
    const before = { ...calls }, fastMode = slowMode === "chog" ? "nft" : "chog";
    scheduled(); await pause();
    assert.equal(typeof release, "function");
    scheduled(); await pause();
    assert.equal(calls[slowMode], before[slowMode] + 1, "only one tick per signer may be in flight");
    assert.equal(calls[fastMode], before[fastMode] + 2, "unrelated RPC latency cannot delay this mode's next poll");
  } finally { release?.(); await pause(); await worker.close(); }
  const afterClose = { ...calls }; scheduled(); await pause(); assert.deepEqual(calls, afterClose);
});

test("NFT readiness integrity errors still abort startup and never expose a payment API", async () => {
  let apiCreated = false;
  const f = startupDependencies({
    createNftProcessor: () => ({ tick: async () => { throw new PaymentIntegrityError(); }, close: async () => {} }),
    createPaymentService: () => { apiCreated = true; },
  });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {} }, f.dependencies), PaymentIntegrityError);
  assert.equal(apiCreated, false); assert.equal(f.calls.at(-1), "lease-close");
});

test("read-only heartbeats remain independent of stalled signers and stop with the worker",async()=>{
  let scheduled,release,stall=false;
  const probes={chog:0,nft:0};
  const processor=mode=>({operatorAddress:"public-operator",treasuryAddress:"public-treasury",publicStatus:()=>config,
    async tick(){if(stall)await new Promise(ok=>{release=ok;});},
    async refreshReadiness(){probes[mode]++;},close:async()=>{}});
  const chog=processor("chog"),nft=processor("nft");
  nft.tick=async()=>{};
  const f=startupDependencies({createChogProcessor:()=>chog,createNftProcessor:()=>nft,setInterval(callback){scheduled=callback;return{};},clearInterval(){}});
  const worker=await startPaymentWorker({passwordProvider:async()=>SECRET,serviceOptions:{}},f.dependencies);
  try{stall=true;scheduled();await pause();assert.equal(typeof release,"function");assert.deepEqual(probes,{chog:1,nft:1});}
  finally{release?.();await pause();await worker.close();}
  scheduled();await pause();assert.deepEqual(probes,{chog:1,nft:1});
});

test("an unconfirmed NFT health check cannot publish its treasury even if tick resolves", async () => {
  let combined;
  const f = startupDependencies({
    createNftProcessor: () => ({ treasuryAddress: "public-treasury", publicStatus: () => ({ nftPaymentsEnabled: true, poolHealthy: false, poolTreasury: "public-treasury" }), tick: async () => {}, close: async () => {} }),
    createPaymentService: (_store, _origin, _custody, processor) => {
      combined=processor; const api=new EventEmitter();api.listen=(_port,_host,ok)=>queueMicrotask(ok);api.close=ok=>ok();return api;
    },
  });
  const worker=await startPaymentWorker({passwordProvider:async()=>SECRET,serviceOptions:{}},f.dependencies);
  try {assert.equal(combined.publicStatus().nftPaymentsEnabled,false);assert.equal(combined.publicStatus().poolTreasury,undefined);}
  finally {await worker.close();}
});

test("a later NFT integrity error gates both modes even when their last status was healthy", async () => {
  let combined, checks = 0;
  const events = [], f = startupDependencies({
    createNftProcessor: () => ({ treasuryAddress: "public-treasury", publicStatus: () => ({ nftPaymentsEnabled: true, poolHealthy: true }), tick: async () => { if (++checks > 1) throw new PaymentIntegrityError(); }, close: async () => {} }),
    createPaymentService: (_store, _origin, _custody, processor) => {
      combined = processor;
      const api = new EventEmitter(); api.listen = (_port, _host, ok) => queueMicrotask(ok); api.close = ok => ok(); return api;
    },
  });
  const worker = await startPaymentWorker({ passwordProvider: async () => SECRET, serviceOptions: {}, onEvent: event => events.push(event) }, f.dependencies);
  try {
    const status = combined.publicStatus();
    assert.equal(status.integrityLocked, true);
    assert.equal(status.paymentsEnabled, false); assert.equal(status.nftPaymentsEnabled, false);
    await assert.rejects(combined.issue({ mode: "chog" }), PaymentIntegrityError);
    await assert.rejects(combined.issue({ mode: "nft" }), PaymentIntegrityError);
    assert.ok(events.some(event => event.code === "integrity-locked"));
  } finally { await worker.close(); }
});

test("integrity failure blocks password request/unlock and does not enroll/reset financial state", async () => {
  const f = startupDependencies({ openPaymentIntegrity: () => { throw new PaymentIntegrityError(); } });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => { throw new Error("must not request"); }, serviceOptions: {} }, f.dependencies), PaymentIntegrityError);
  assert.equal(f.calls.includes("unlock"), false);
  assert.equal(f.calls.includes("vault-read"), false);
  assert.equal(f.calls.at(-1), "lease-close");
});

test("missing vault or busy lease releases startup safely without password or financial writes", async () => {
  const missing = startupDependencies({ readFile: async () => { throw Object.assign(Error("missing fixture vault"), { code: "ENOENT" }); } });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => { throw Error("must not request"); }, serviceOptions: {} }, missing.dependencies));
  assert.equal(missing.calls.includes("unlock"), false); assert.equal(missing.calls.includes("checkpoint"), false); assert.equal(missing.calls.at(-1), "lease-close");
  const busy = startupDependencies({ acquireOperatorLease: async () => { throw Object.assign(Error("busy"), { code: "EADDRINUSE" }); } });
  await assert.rejects(startPaymentWorker({ passwordProvider: async () => { throw Error("must not request"); }, serviceOptions: {} }, busy.dependencies), { code: "EADDRINUSE" });
  assert.deepEqual(busy.calls, []);
});

test("cancelling during custody decryption never initializes signers or publishes the API", async () => {
  let finishUnlock, close, chogCreated = 0;
  const f = startupDependencies({
    unlockCustodyVault: () => new Promise(ok => { finishUnlock = ok; }),
    createChogProcessor: () => { chogCreated++; throw new Error("must not initialize"); },
  });
  const startup = startPaymentWorker({ passwordProvider: async () => SECRET, registerStop(value) { close = value; }, serviceOptions: {} }, f.dependencies);
  await pause(); assert.equal(typeof finishUnlock, "function");
  const stopped = close(); finishUnlock({});
  assert.equal(await startup, null); await stopped;
  assert.equal(chogCreated, 0); assert.equal(f.calls.includes("api-close"), false);
  assert.equal(f.calls.at(-1), "lease-close");
});

test("default ops runtime receives only status and query-only impact, and closes with the signer", async () => {
  let close, statusCalled = false, impactClosed = false, runtimeClosed = false;
  const f = startupDependencies({
    openReadOnlyImpactSource: path => { assert.match(path, /processor\.sqlite$/); return { summary: () => ({ chogDonated: "600", donations: 2 }), close() { impactClosed = true; } }; },
    createOperationsRuntime: options => { assert.equal(options.status().integrityLocked, false); statusCalled = true; assert.deepEqual(options.impact(), { chogDonated: "600", donations: 2 }); return { options: { mockSafe: true }, close() { runtimeClosed = true; } }; },
  });
  await startPaymentWorker({ passwordProvider: async () => SECRET, registerStop(value) { close = value; } }, f.dependencies);
  assert.equal(statusCalled, true); await close();
  assert.equal(runtimeClosed, true); assert.equal(impactClosed, true);
});

test("dependency exceptions cannot smuggle a password by imitating a safe error prefix", async () => {
  const f = await fixture({ dependencies: { exec: async (_file, args) => { if (args[0] === "--version") return "v24.22.0"; if (args.includes("start")) throw new Error(`Configuration failed; ${SECRET}`); return "active"; } } });
  try {
    await assert.rejects(f.admin.action({ type: "gateway.start", confirmed: true }), /No credentials or raw service errors/);
    assert.equal(JSON.stringify(f.snapshots).includes(SECRET), false);
  } finally { await f.dispose(); }
});

test("a disconnected USB bridge makes its private worker drain and disconnect", async () => {
  const channel = privateChannel(["--port", "COM7"]); let finish, closed = 0;
  await runPrivateStationWorker(channel, async () => ({ finished: new Promise(ok => { finish = ok; }), close: async () => { closed++; } }));
  finish(); await pause();
  assert.equal(closed, 1); assert.equal(channel.connected, false);
});

test("station shutdown uses serial EOF and an owned completion promise, never ChildProcess.kill", async () => {
  const script = await readFile(new URL("../scripts/station-bridge.mjs", import.meta.url), "utf8");
  assert.match(script, /serial\.stdin\.end\(\)/);
  assert.match(script, /return \{ close, finished, test\(\)/);
  assert.doesNotMatch(script, /serial\??\.kill\(/);
});
