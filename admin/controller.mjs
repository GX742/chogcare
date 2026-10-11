import { fork, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { lstat, readFile, mkdir, realpath, open, rename } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const COM = /^COM[1-9]\d{0,2}$/;
const REFERENCES = /^[A-F0-9]{12}$/;
const VERSION = "Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)";
const SERVICES = ["payments", "broadcast", "gateway", "station"];
const PASSWORD = value => typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
class SafeAdminError extends Error {}
const failure = message => new SafeAdminError(message);
const DESIRED_VIDEO = Object.freeze({ latencyLevel: 0, videoQualityVariants: [{ name: "1080p", videoPassthrough: false, audioPassthrough: false, videoBitrate: 4500, audioBitrate: 128, scaledWidth: 1080, scaledHeight: 0, framerate: 30, cpuUsageLevel: 2 }] });
const CHILD_EVENTS = Object.freeze({
  "ready": ["info", "Service is ready."], "stopped": ["info", "Service stopped gracefully."],
  "busy": ["warning", "Another payment or maintenance worker owns the local ports. It was not stopped."],
  "integrity-locked": ["error", "Payment integrity is locked. Preserve the databases and checkpoint; reconcile before restarting."],
  "startup-failed": ["error", "Payment startup failed. Check the custody password, backup and local network; no new payments were enabled."],
  "chog-network": ["warning", "Payment network readiness failed; the worker will retry."],
  "nft-network": ["warning", "NFT pool readiness failed. New NFT claims stay paused."],
  "station-failed": ["error", "USB bridge failed. Check the COM port and close Serial Monitor; payments were not changed."],
  "shutdown-failed": ["error", "Graceful shutdown failed. Keep this app open and inspect the local service; no force termination was attempted."],
});

function record(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw failure("Unsupported admin request.");
  return value;
}

function integer(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw failure("Unexpected local service response.");
  return value;
}

// Exact response projection, never a spread of /api/admin/serverconfig. That
// response also contains stream/admin/storage credentials and must not escape.
export function projectVideoSettings(response) {
  if (response?.videoCodec !== "libx264" || !Array.isArray(response?.videoSettings?.videoQualityVariants) || response.videoSettings.videoQualityVariants.length < 1 || response.videoSettings.videoQualityVariants.length > 10) throw failure("Unsupported Owncast codec or video settings. Nothing was changed.");
  return {
    latencyLevel: integer(response.videoSettings.latencyLevel, 4),
    videoQualityVariants: response.videoSettings.videoQualityVariants.map(value => {
      if (typeof value?.name !== "string" || value.name.length > 128 || /[\x00-\x1f\x7f]/.test(value.name) || typeof value.videoPassthrough !== "boolean" || typeof value.audioPassthrough !== "boolean") throw failure("Unexpected local service response.");
      return { name: value.name, videoPassthrough: value.videoPassthrough, audioPassthrough: value.audioPassthrough,
        videoBitrate: integer(value.videoBitrate, 100000), audioBitrate: integer(value.audioBitrate, 1024),
        scaledWidth: integer(value.scaledWidth ?? 0, 8192), scaledHeight: integer(value.scaledHeight ?? 0, 8192),
        framerate: integer(value.framerate, 240), cpuUsageLevel: integer(value.cpuUsageLevel, 4) };
    }),
  };
}

export function sanitizePaymentConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.chainId !== 143 || typeof value.integrityLocked !== "boolean" || typeof value.custodyConfigured !== "boolean") return null;
  const result = { chainId: 143 };
  if (["offline", "local-pilot"].includes(value.paymentMode)) result.paymentMode = value.paymentMode;
  for (const key of ["paymentsEnabled", "nftPaymentsEnabled", "poolFunded", "custodyConfigured", "nftSupported", "nftQueueFull", "poolGasReady", "poolHealthy", "integrityLocked"]) if (typeof value[key] === "boolean") result[key] = value[key];
  for (const key of ["availableClaims", "maxDailyClaims", "availableCheckoutSlots", "poolContributionPercent"]) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 100) result[key] = value[key];
  for (const key of ["subsidyUsdc", "dailyPoolLimitUsdc", "reservedTodayUsdc", "poolContributionBatchMinimumUsdc", "poolContributionPendingUsdc"]) if (typeof value[key] === "string" && /^(?:0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(value[key])) result[key] = value[key];
  // Version fields are intentionally omitted: a compromised local response
  // must not smuggle arbitrary error text, credentials or file paths to the UI.
  result.readiness = {};
  for (const [key, allowed] of Object.entries({ custody: ["unlocked-local-pilot", "not-configured", "locked"], processing: ["connected", "offline", "paused"], pool: ["funded", "unfunded", "unavailable"] })) if (allowed.includes(value.readiness?.[key])) result.readiness[key] = value.readiness[key];
  return result;
}

// Native HTTP ignores environment/system proxies and never follows redirects.
// The entire transport, including chunked bodies, is bounded before JSON parse.
export function readLocalJson(url, options = {}, maximum = 262144, requestFactory = httpRequest, deadlineMilliseconds = 10000) {
  const target = new URL(url);
  const allowed = target.protocol === "http:" && target.hostname === "127.0.0.1" && !target.username && !target.password && !target.search && !target.hash &&
    (target.port === "4174" && target.pathname === "/api/payments/config" || target.port === "8080" && ["/api/config", "/api/admin/serverconfig", "/api/admin/config/video/streamoutputvariants", "/api/admin/config/video/streamlatencylevel"].includes(target.pathname));
  if (!allowed) return Promise.reject(failure("Unsupported local service request."));
  return new Promise((ok, bad) => {
    let settled = false, req, response;
    const fail = (message = "Local service is unavailable.") => { if (!settled) { settled = true; clearTimeout(deadline); bad(failure(message)); } };
    // Socket timeout alone is an inactivity limit. A byte every few seconds
    // would keep it alive forever, so this deadline includes headers and body.
    const deadline = setTimeout(() => { response?.destroy(); req?.destroy(); fail(); }, deadlineMilliseconds);
    try { req = requestFactory(target, { method: options.method ?? "GET", headers: options.headers ?? {}, timeout: 10000 }, res => {
      response = res;
      if (settled) { res.destroy(); return; }
      if (res.statusCode === 401) { res.destroy(); fail("Owncast admin login rejected. Use the admin password, not the OBS stream key."); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); fail(); return; }
      const declared = res.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { res.destroy(); fail(); return; }
      const chunks = []; let bytes = 0;
      res.on("data", chunk => {
        bytes += chunk.byteLength;
        if (bytes > maximum) { res.destroy(); fail(); return; }
        chunks.push(chunk);
      });
      res.on("error", () => fail());
      res.on("end", () => {
        if (settled) return;
        try { const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); settled = true; clearTimeout(deadline); ok(parsed); } catch { fail(); }
      });
    });
    req.on("error", () => fail());
    req.on("timeout", () => { req.destroy(); fail(); });
    if (options.body !== undefined) req.end(options.body); else req.end();
    } catch { req?.destroy(); fail(); }
  });
}

async function privateDirectory(workspace, suffix) {
  let current = workspace;
  for (const name of suffix.split("/")) {
    current = join(current, name);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("Admin storage must be a local, non-linked directory.");
  }
  return current;
}

async function regularFile(filename, maximum = 65536) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw failure("Admin workspace contains an unsupported file.");
}

function safeWorkerEnvironment(workspace, nodePath) {
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (typeof process.env[key] === "string") environment[key] = process.env[key];
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  environment.PATH = [dirname(nodePath), join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
  environment.CHOGCARE_PUBLIC_ORIGIN = "https://chogcare.vercel.app";
  // No NODE_OPTIONS/NODE_PATH, proxy variables, password, API keys or renderer
  // data are inherited. The workspace is conveyed through trusted cwd only.
  return environment;
}

export function createBoundedExecutor({ spawnChild = spawn, deadlineMilliseconds = 10000 } = {}) {
  const pending = new Map();
  const execute = (file, args, options = {}) => {
    const key = JSON.stringify([file, args]);
    const old = pending.get(key);
    if (old) return old.timedOut ? Promise.reject(failure("Local service command is still pending. No process was forcibly terminated.")) : old.result;
    if (pending.size >= 8) return Promise.reject(failure("Local service command capacity is busy. No extra command was started."));
    const unit = args.at(-1), mutation = args.includes("/bin/systemctl") && ["start", "stop"].includes(args.at(-2));
    if (mutation && [...pending.values()].some(value => value.mutation && value.unit === unit)) return Promise.reject(failure("A local service change is still pending. Wait before changing the same service again."));
    const entry = { timedOut: false, mutation, unit, result: null };
    pending.set(key, entry);
    const forget = () => { if (pending.get(key) === entry) pending.delete(key); };
    entry.result = new Promise((ok, bad) => {
    const { acceptedExitCodes = [0], ...spawnOptions } = options;
    let child;
    try { child = spawnChild(file, args, { ...spawnOptions, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { forget(); bad(failure("Local service command failed.")); return; }
    const chunks = []; let size = 0, oversized = false, finished = false;
    const deadline = setTimeout(() => {
      if (finished) return;
      entry.timedOut = true; finished = true;
      bad(failure("Local service command deadline expired. It may still be running; no process was forcibly terminated."));
    }, deadlineMilliseconds);
    const fail = () => { clearTimeout(deadline); forget(); if (!finished) { finished = true; bad(failure("Local service command failed.")); } };
    child.stdout.on("data", chunk => { size += chunk.byteLength; if (size > 8192) oversized = true; else chunks.push(chunk); });
    child.stderr.resume();
    child.once("error", fail);
    const exited = code => {
      clearTimeout(deadline); forget(); if (finished) return; finished = true;
      if (!acceptedExitCodes.includes(code) || oversized) bad(failure("Local service command failed.")); else ok(Buffer.concat(chunks).toString("utf8"));
    };
    child.once("exit", exited); child.once("close", exited);
    // The result is bounded, but the underlying command is never force-killed.
    // Keep its registry entry until exit so polls cannot multiply stalled WSL
    // diagnostics, and app quit can refuse a still-pending service mutation.
  });
    return entry.result;
  };
  execute.hasPendingMutations = () => [...pending.values()].some(value => value.mutation);
  return execute;
}
const defaultExec = createBoundedExecutor();

function portBusy(port) {
  return new Promise(ok => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); ok(value); };
    socket.setTimeout(750); socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.once("timeout", () => finish(false));
  });
}

const wait = (request, milliseconds, message) => new Promise((ok, bad) => {
  const timer = setTimeout(() => bad(failure(message)), milliseconds);
  request.then(value => { clearTimeout(timer); ok(value); }, error => { clearTimeout(timer); bad(error); });
});

// The second argument exists only for isolated backend tests. It is never
// renderer IPC input and cannot be changed by settings or an action payload.
export async function createAdminController({ workspacePath, nodePath = "C:\\Program Files\\nodejs\\node.exe", onChange = () => {} }, dependencies = {}) {
  if (typeof workspacePath !== "string" || !isAbsolute(workspacePath) || /^[\\/]{2}/.test(workspacePath)) throw failure("Choose the trusted local ChogCare workspace.");
  const resolvedWorkspace = resolve(workspacePath);
  if (resolvedWorkspace.startsWith("\\\\")) throw failure("Choose the trusted local ChogCare workspace.");
  const workspace = await realpath(resolvedWorkspace);
  if (workspace.startsWith("\\\\")) throw failure("Choose the trusted local ChogCare workspace.");
  const packagePath = join(workspace, "package.json"); await regularFile(packagePath);
  if (JSON.parse(await readFile(packagePath, "utf8")).name !== "chogcare") throw failure("This folder is not the ChogCare workspace.");
  for (const filename of ["scripts/start-payments.mjs", "scripts/station-bridge.mjs", "scripts/station-serial.ps1", "admin/payment-worker.mjs", "admin/station-worker.mjs"]) await regularFile(join(workspace, filename), 1048576);
  if (typeof nodePath !== "string" || !isAbsolute(nodePath)) throw failure("The installed Node runtime path is required.");
  await regularFile(nodePath, 268435456);
  const exec = dependencies.exec ?? defaultExec, json = dependencies.requestJson ?? readLocalJson;
  const nodeVersion = await exec(nodePath, ["--version"], { cwd: workspace, env: safeWorkerEnvironment(workspace, nodePath) });
  if (!/^v25\.(?:9|[1-9]\d+)\.\d+\s*$/.test(nodeVersion)) throw failure("Use the installed Node 25.9 or newer Node 25 runtime for the payment worker.");
  // The trusted workspace helper protects only these two private operations
  // directories. It must finish before reading settings or opening any inbox.
  const initDirectory = dependencies.initDirectory ?? (await import(pathToFileURL(join(workspace, "server/local-ops-storage.mjs")).href)).initLocalOpsDirectory;
  const adminDirectory = await initDirectory(workspace, "admin");
  const settingsPath = join(adminDirectory, "settings.json");
  let stationPort = "COM4";
  try {
    await regularFile(settingsPath, 4096);
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    record(saved, ["version", "workspacePath", "stationPort"]);
    if (saved.version !== 1 || saved.workspacePath !== workspace || !COM.test(saved.stationPort)) throw failure("Admin settings do not match this workspace.");
    stationPort = saved.stationPort;
  } catch (error) { if (error.code !== "ENOENT") throw failure("Admin settings are invalid. Preserve the file and check this workspace."); }
  const supportDirectory = await initDirectory(workspace, "support");
  // In an installed app the financial modules remain in the pinned workspace;
  // Electron's packaged renderer has no route to import or select them.
  const support = dependencies.supportStore ?? (await import(pathToFileURL(join(workspace, "server/support-store.mjs")).href)).openSupportStore(join(supportDirectory, "support.sqlite"));
  const quotes = dependencies.quoteService ?? (await import(pathToFileURL(join(workspace, "server/ops-quotes.mjs")).href)).createReadOnlyQuoteService();
  const offlineFactory = dependencies.createOfflineOperationsService ?? (await import(pathToFileURL(join(workspace, "server/operations-runtime.mjs")).href)).createOfflineOperationsService;
  const children = new Map(), events = [], serviceStates = new Map(SERVICES.map(id => [id, { id, state: id === "station" ? "unknown" : "stopped", managed: false, detail: id === "station" ? "External USB bridges are not controlled by this app." : "Not checked yet." }]));
  let payments = null, checkedAt = Date.now(), closed = false, closing = false, busy = false, refreshing, owncastPasswordSet = false, offlineApi = null, openingOffline, paymentHandoff = false;
  const clock = dependencies.clock ?? Date.now, childFork = dependencies.fork ?? fork, isPortBusy = dependencies.portBusy ?? portBusy;
  const notify = () => { if (!closed) { try { onChange(snapshot()); } catch { /* Observer failure cannot mutate a worker. */ } } };
  const event = (service, level, message) => {
    const previous = events.at(-1);
    if (previous?.service === service && previous.level === level && previous.message === message && clock() - previous.at < 30000) return;
    events.push({ id: randomBytes(12).toString("hex"), at: clock(), level, service, message });
    if (events.length > 100) events.shift(); notify();
  };
  const setService = (id, state, managed, detail) => { serviceStates.set(id, { id, state, managed, detail }); notify(); };
  function snapshot() {
    let summary = { total: 0, new: 0, read: 0 };
    try { summary = support.summary(); } catch { /* Private inbox unavailability does not expose its contents. */ }
    return structuredClone({ checkedAt, workspacePath: workspace, stationPort, services: SERVICES.map(id => serviceStates.get(id)), payments,
      support: { open: Number.isSafeInteger(summary.new + summary.read) ? summary.new + summary.read : 0, total: Number.isSafeInteger(summary.total) ? summary.total : 0 }, events });
  }
  const settings = () => ({ workspacePath: workspace, stationPort, owncastPasswordSet });
  const wslPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
  const systemctl = async (verb, unit) => {
    if (!["is-active", "start", "stop"].includes(verb) || !["owncast", "nginx"].includes(unit)) throw failure("Unsupported local service action.");
    return exec(wslPath, ["--distribution", "Ubuntu", "--user", "root", "--exec", "/bin/systemctl", verb, unit], { cwd: workspace, env: safeWorkerEnvironment(workspace, nodePath), ...(verb === "is-active" ? { acceptedExitCodes: [0, 3, 4] } : {}) });
  };
  async function refresh() {
    if (closed) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let current = null;
      try { current = sanitizePaymentConfig(await json("http://127.0.0.1:4174/api/payments/config", { headers: { Accept: "application/json" } }, 16384)); } catch { /* No raw local/RPC/credential error is displayed. */ }
      payments = current;
      const worker = children.get("payments");
      if (worker) setService("payments", worker.ready ? "running" : "unknown", true, worker.ready ? "Managed worker; shutdown drains requests and checkpoints before exit." : "Managed worker is starting or stopping; no force termination.");
      else if ((!offlineApi && (current || await isPortBusy(4174))) || await isPortBusy(4175)) setService("payments", "external", false, "An existing worker or maintenance lease is present. This app will not stop it.");
      else setService("payments", "stopped", false, "No payment API or operator lease detected.");
      await Promise.all([["broadcast", "owncast"], ["gateway", "nginx"]].map(async ([id, unit]) => {
        try {
          const output = await systemctl("is-active", unit);
          if (output.trim() !== "active") { setService(id, "stopped", false, "Local service is not active."); return; }
          const managed = serviceStates.get(id).managed;
          setService(id, managed ? "running" : "external", managed, id === "broadcast" ? "Local Owncast service. Stop requires explicit confirmation." : "Local nginx is active. Public connectivity is not verified; tunnel configuration is untouched.");
        } catch { setService(id, "unknown", false, "Local WSL service status is unavailable; no process was stopped."); }
      }));
      checkedAt = clock(); notify();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function closeOffline() {
    const server = offlineApi; offlineApi = null;
    if (server) await new Promise(ok => server.close(ok));
  }
  async function openOffline() {
    if (closed || closing || paymentHandoff || children.has("payments") || offlineApi) return;
    if (openingOffline) return openingOffline;
    openingOffline = (async () => {
      if (await isPortBusy(4174) || await isPortBusy(4175) || closed || closing || paymentHandoff || children.has("payments")) return;
      const server = offlineFactory({ workspacePath: workspace, allowedOrigin: "https://chogcare.vercel.app" });
      try {
        await new Promise((ok, bad) => { server.once("error", bad); server.listen(4174, "127.0.0.1", ok); });
        if (closed || closing || paymentHandoff || children.has("payments")) { await new Promise(ok => server.close(ok)); return; }
        offlineApi = server;
        server.on("error", () => event("payments", "warning", "Offline support API is unavailable; no financial service was started."));
        event("payments", "info", "Read-only offline dashboard, fee estimates and support are available. Payments remain disabled; custody was not opened.");
      } catch { server.close(); event("payments", "warning", "Offline support API could not bind. An existing process was not stopped."); }
    })().finally(() => { openingOffline = null; });
    return openingOffline;
  }

  async function launchChild(id, password, port) {
    if (children.has(id)) throw failure("This service is already managed by the app.");
    if (id === "payments") paymentHandoff = true;
    try {
    if (id === "payments") { await openingOffline; await closeOffline(); }
    if (id === "payments" && (await isPortBusy(4174) || await isPortBusy(4175))) throw failure("An existing payment or maintenance process owns the local ports. It was not stopped.");
    const path = join(workspace, "admin", id === "payments" ? "payment-worker.mjs" : "station-worker.mjs");
    const child = childFork(path, id === "station" ? ["--port", port] : [], { cwd: workspace, execPath: nodePath, execArgv: [], windowsHide: true, silent: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: safeWorkerEnvironment(workspace, nodePath) });
    let finishReady, failReady, finishExit;
    const ready = new Promise((ok, bad) => { finishReady = ok; failReady = bad; });
    const exited = new Promise(ok => { finishExit = ok; });
    const worker = { child, ready: false, stopping: false, exited, secretSent: false };
    children.set(id, worker); setService(id, "unknown", true, "Starting a managed local service.");
    // Never forward raw stdout/stderr: they can contain RPC payloads, wallet
    // material or third-party errors. Only fixed, allowlisted IPC codes escape.
    child.stdout?.resume(); child.stderr?.resume();
    child.on("message", message => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "secret-request" && Object.keys(message).length === 1 && id === "payments" && !worker.secretSent && !worker.stopping) {
        worker.secretSent = true;
        child.send({ type: "secret", password }, () => {}); password = "";
      } else if (message.type === "ready" && Object.keys(message).length === 1 && !worker.stopping) {
        worker.ready = true; password = ""; setService(id, "running", true, "Managed local service is ready."); finishReady();
      } else if (message.type === "event" && Object.keys(message).every(key => ["type", "code", "level"].includes(key)) && CHILD_EVENTS[message.code]) {
        const [level, text] = CHILD_EVENTS[message.code]; event(id, level, text);
      }
    });
    child.once("error", () => { password = ""; failReady(failure("Could not start the managed local worker.")); event(id, "error", "Could not start the managed local worker. No credentials were printed."); });
    const onExit = code => {
      if (worker.finished) return;
      worker.finished = true;
      password = ""; if (children.get(id) === worker) children.delete(id);
      setService(id, code === 0 ? "stopped" : "error", false, code === 0 ? "Managed service stopped gracefully." : "Managed service exited with an error; check the safe events above.");
      failReady(failure("The managed worker did not finish startup.")); finishExit();
      if (id === "payments" && !closing && !closed) void openOffline().then(refresh).catch(() => {});
    };
    child.once("exit", onExit); child.once("close", onExit);
    try { await wait(ready, dependencies.startTimeout ?? 90000, "Startup is still pending. Keep the app open; the process was not force-stopped."); }
    finally { password = ""; }
    event(id, "info", id === "payments" ? "Payment worker started through private one-use custody IPC." : "USB bridge started. It can display finalized donations but cannot create payments.");
    } finally { if (id === "payments") paymentHandoff = false; }
  }

  async function stopChild(id) {
    const worker = children.get(id);
    if (!worker) throw failure("This app does not own that worker. Stop it in its original terminal; no external process was terminated.");
    worker.stopping = true; setService(id, "unknown", true, "Draining the managed worker gracefully. Keep this app open.");
    if (worker.child.connected) worker.child.send({ type: "stop" }, () => {});
    await wait(worker.exited, dependencies.stopTimeout ?? 60000, "Graceful shutdown is still pending. Keep this app open; no force termination was attempted.");
    event(id, "info", "Managed worker drained and exited. No external process was stopped.");
  }

  async function configureBroadcast(password) {
    const publicConfig = await json("http://127.0.0.1:8080/api/config", { headers: { Accept: "application/json" } }, 262144);
    if (publicConfig?.version !== VERSION) throw failure("Unsupported Owncast build. No streaming settings were changed.");
    const bytes = Buffer.from(`admin:${password}`, "utf8"); let authorization;
    try { authorization = `Basic ${bytes.toString("base64")}`; } finally { bytes.fill(0); password = ""; }
    const api = async (method, route, body) => {
      const value = await json(`http://127.0.0.1:8080${route}`, { method, headers: { Accept: "application/json", "X-Owncast-CSRF-Protection": "1", Authorization: authorization, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, 262144);
      if (method === "POST" && value?.success !== true) throw failure("Owncast did not confirm the settings update.");
      return value;
    };
    const readSettings = async () => projectVideoSettings(await api("GET", "/api/admin/serverconfig"));
    let original, variantsAttempted = false, latencyAttempted = false;
    try {
      original = await readSettings();
      if (JSON.stringify(original) !== JSON.stringify(DESIRED_VIDEO)) {
        const directory = await privateDirectory(workspace, "work/broadcast");
        const backup = await open(join(directory, `owncast-video-${clock()}-${randomBytes(12).toString("hex")}.json`), "wx", 0o600);
        try { await backup.writeFile(JSON.stringify(original, null, 2), "utf8"); await backup.sync(); } finally { await backup.close(); }
        if (JSON.stringify(await readSettings()) !== JSON.stringify(original)) throw failure("Streaming settings changed during setup. Nothing was overwritten.");
        variantsAttempted = true; await api("POST", "/api/admin/config/video/streamoutputvariants", { value: DESIRED_VIDEO.videoQualityVariants });
        latencyAttempted = true; await api("POST", "/api/admin/config/video/streamlatencylevel", { value: DESIRED_VIDEO.latencyLevel });
        if (JSON.stringify(await readSettings()) !== JSON.stringify(DESIRED_VIDEO)) throw failure("Streaming settings readback did not match.");
      }
      owncastPasswordSet = true;
      event("broadcast", "info", "Verified 1080-wide original-aspect output, 30 fps, 4500 kbps, 128 kbps audio, veryfast and minimum HLS latency. Apply on the next OBS stream start.");
    } catch (error) {
      if (original && (variantsAttempted || latencyAttempted)) {
        let restored = true;
        try {
          if (variantsAttempted) await api("POST", "/api/admin/config/video/streamoutputvariants", { value: original.videoQualityVariants });
          if (latencyAttempted) await api("POST", "/api/admin/config/video/streamlatencylevel", { value: original.latencyLevel });
          restored = JSON.stringify(await readSettings()) === JSON.stringify(original);
        } catch { restored = false; }
        throw failure(restored ? "Configuration failed; original streaming settings were restored and verified. Payments and the running stream were not stopped." : "Configuration rollback could not be verified. Do not restart the stream; use the non-secret backup in work/broadcast to restore local video settings.");
      }
      // Never copy the service's exception, response, headers or credentials.
      throw failure(error?.message === "Owncast admin login rejected. Use the admin password, not the OBS stream key." ? error.message : "Owncast configuration failed before a settings change. Check the local admin password and supported server.");
    } finally { authorization = ""; }
  }

  async function action(raw) {
    if (closed) throw failure("The admin controller is closed.");
    if (busy) throw failure("Another admin action is still running.");
    if (!raw || typeof raw.type !== "string") throw failure("Unsupported admin request.");
    let input, password = "";
    switch (raw.type) {
      case "payments.start": case "broadcast.configure":
        input = record(raw, ["type", "password"]);
        if (!PASSWORD(input.password) || raw.type === "payments.start" && input.password.length < 16) throw failure("Enter the correct local service password (custody: 16-256 characters). Do not send it in chat.");
        password = input.password; input.password = ""; break;
      case "payments.stop": case "station.stop": case "obs.open": case "refresh": input = record(raw, ["type"]); break;
      case "broadcast.start": case "broadcast.stop": case "gateway.start": input = record(raw, ["type", "confirmed"]); if (input.confirmed !== true) throw failure("Confirm the streaming service change first."); break;
      case "station.start": input = record(raw, ["type", "port"]); if (!COM.test(input.port)) throw failure("Choose a valid COM port, for example COM4."); break;
      case "settings.save":
        input = record(raw, ["type", "stationPort", "workspacePath"], ["type", "stationPort"]);
        if (!COM.test(input.stationPort) || input.workspacePath !== undefined && (typeof input.workspacePath !== "string" || resolve(input.workspacePath) !== workspace)) throw failure("Settings must use this trusted workspace and a valid COM port. Relaunch to change the workspace.");
        if (children.has("station") && input.stationPort !== stationPort) throw failure("Stop the managed USB bridge before changing its COM port.");
        break;
      default: throw failure("Unsupported admin request.");
    }
    busy = true;
    try {
      switch (input.type) {
        case "refresh": await openOffline(); break;
        case "payments.start": await launchChild("payments", password); break;
        case "payments.stop": await stopChild("payments"); break;
        case "station.start": stationPort = input.port; await launchChild("station", "", stationPort); break;
        case "station.stop": await stopChild("station"); break;
        case "broadcast.configure": await configureBroadcast(password); break;
        case "broadcast.start": await systemctl("start", "owncast"); setService("broadcast", "running", true, "Owncast start was explicitly confirmed."); event("broadcast", "info", "Owncast start requested. OBS and payments were not restarted."); break;
        case "broadcast.stop": await systemctl("stop", "owncast"); setService("broadcast", "stopped", false, "Owncast stop was explicitly confirmed."); event("broadcast", "warning", "Owncast stopped after explicit confirmation. OBS and payment services were not stopped."); break;
        case "gateway.start": await systemctl("start", "nginx"); setService("gateway", "running", true, "Local nginx started; public connectivity is not verified."); event("gateway", "info", "Local nginx started. Public connectivity is not verified. No Funnel, Serve, DNS or payment configuration was changed."); break;
        case "obs.open": {
          const filename = "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
          await regularFile(filename, 268435456);
          const child = (dependencies.spawn ?? spawn)(filename, [], { cwd: dirname(filename), windowsHide: false, shell: false, detached: false, stdio: "ignore", env: safeWorkerEnvironment(workspace, nodePath) });
          child.once("error", () => event("broadcast", "error", "OBS could not be opened. No stream or service was changed.")); child.unref();
          event("broadcast", "info", "OBS opened. Start/stop its stream yourself; the app does not read the OBS stream key."); break;
        }
        case "settings.save": {
          const temporary = join(adminDirectory, `settings-${randomBytes(12).toString("hex")}.tmp`);
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(JSON.stringify({ version: 1, workspacePath: workspace, stationPort: input.stationPort }), "utf8"); await file.sync(); } finally { await file.close(); }
          try { await regularFile(settingsPath, 4096); } catch (error) { if (error.code !== "ENOENT") throw error; }
          await rename(temporary, settingsPath); stationPort = input.stationPort;
          event("station", "info", "Non-secret local admin settings saved."); break;
        }
      }
      await refresh(); return snapshot();
    } catch (error) {
      const message = error?.message;
      // Errors from worker/API/executable dependencies are not trusted text.
      const safe = error instanceof SafeAdminError ? message : "The local admin action failed. No credentials or raw service errors were displayed.";
      event(input.type.split(".")[0], "error", safe); throw failure(safe);
    } finally {
      password = ""; busy = false;
      if (["payments.start", "payments.stop"].includes(input.type) && !children.has("payments")) await openOffline().then(refresh).catch(() => {});
    }
  }

  async function quote(input) {
    if (closed) throw failure("The admin controller is closed.");
    record(input, ["amount", "initiativeId"]);
    try { return await quotes.quote(input); } catch { throw failure("Bridge estimate is temporarily unavailable. No payment was created."); }
  }
  function listSupport(input = {}) {
    if (closed) throw failure("The admin controller is closed.");
    record(input, ["status", "limit"], []);
    if (input.status !== undefined && !["new", "read", "resolved"].includes(input.status) || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw failure("Invalid inbox filter.");
    try { return support.list(input).map(ticket => ({ ...ticket, id: ticket.reference })); } catch { throw failure("The local support inbox is unavailable."); }
  }
  function updateSupport(input) {
    if (closed) throw failure("The admin controller is closed.");
    record(input, ["id", "status"]);
    if (typeof input.id !== "string" || !REFERENCES.test(input.id) || !["new", "read", "resolved"].includes(input.status)) throw failure("Invalid inbox update.");
    try { const ticket = support.setStatus(input.id, input.status); notify(); return ticket ? { ...ticket, id: ticket.reference } : null; } catch { throw failure("The local support inbox could not be updated."); }
  }
  const schedulePoll = dependencies.setInterval ?? setInterval, cancelPoll = dependencies.clearInterval ?? clearInterval;
  const pollTimer = dependencies.poll === false ? null : schedulePoll(() => { void openOffline().then(refresh).catch(() => {}); }, 5000);
  pollTimer?.unref();
  async function close() {
    if (closed) return;
    if (busy) throw failure("An admin action is still running. Keep the app open until it completes.");
    if (exec.hasPendingMutations?.()) throw failure("A confirmed local service change is still pending. Keep the app open until the command exits; no process was forcibly terminated.");
    closing = true; cancelPoll(pollTimer);
    try {
      for (const id of ["station", "payments"]) if (children.has(id)) await stopChild(id);
      await openingOffline; await closeOffline();
      closed = true; await refreshing; support.close(); quotes.close();
    } catch (error) { closing = false; throw error; }
  }
  await openOffline(); await refresh();
  return { snapshot, settings, action, quote, listSupport, updateSupport, close };
}
