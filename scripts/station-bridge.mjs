import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStationEvents, stationDonation, STATION_MAX_LINE_BYTES, STATION_CAUSES } from "../server/station-events.mjs";
import { createStationLeaderboard } from "./station-leaderboard.mjs";
import { createStationBoardTransport, validStationBoardAck } from "./station-board-wire.mjs";
import { readStationRemoteConfig, createRemoteStationEvents } from "./station-remote-client.mjs";
import { createRemoteBroadcastFreshness } from "./station-broadcast-remote.mjs";

const eventIdPattern = /^[a-f0-9]{24}$/;
const RETRY_MS = 5000, ACCEPTED_TIMEOUT_MS = 60_000;
const ping = { v: 1, type: "ping" };

export function validStationDeviceMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return false;
  if (value.type === "fault") return Object.keys(value).every(key => ["v", "type"].includes(key));
  const scenesValid = value.scenes === undefined || value.scenes === 2;
  const idleValid = value.idle === undefined || value.idle === 1;
  const boardValid = value.board === undefined || value.board === 1;
  if (value.type === "hello") return scenesValid && idleValid && boardValid && Object.keys(value).every(key => ["v", "type", "last", "scenes", "idle", "board"].includes(key)) && (value.last === "" || eventIdPattern.test(value.last ?? ""));
  if (value.type === "pong") return scenesValid && idleValid && boardValid && Object.keys(value).every(key => ["v", "type", "scenes", "idle", "board"].includes(key));
  return value.type === "ack" && Object.keys(value).every(key => ["v", "type", "id", "status"].includes(key)) && eventIdPattern.test(value.id ?? "") && ["accepted", "done"].includes(value.status);
}

// Payment processing is not in this controller. It knows only one bounded,
// sanitized gratitude payload and considers completion only for that exact ID.
export function createStationController({ write, done = () => {}, onFault = () => {}, onTestState = () => {}, now = Date.now }) {
  let current = null, lastSent = -Infinity, acceptedAt = null, ready = false, fault = false, lastPing = -Infinity;
  let testId = null, lastSeen = -Infinity, lastTest = -Infinity;
  let scenes = false, liveStatus = false, testSequence = 0;
  const testState = state => { try { onTestState(state); } catch { /* Diagnostics cannot control the device. */ } };
  const complete = id => {
    if (id === testId) { testId = null; testState("done"); }
    else done(id);
  };
  const send = value => write(`${JSON.stringify(value)}\n`);
  return {
    receive(value) {
      if (!validStationDeviceMessage(value)) return false;
      if (value.type === "fault") {
        const newlyFaulted = !fault; fault = true; ready = false;
        if (testId) { testId = null; current = null; acceptedAt = null; testState("error"); }
        if (newlyFaulted) onFault();
        return true;
      }
      if (value.type === "hello") {
        scenes = value.scenes === 2;
        liveStatus = value.idle === 1;
        fault = false; ready = true; lastSeen = now();
        if (current && value.last === current.id) {
          const id = current.id; complete(id); current = null; acceptedAt = null; lastSent = -Infinity;
        } else if (current) {
          // A reboot interrupted the show. Retry the same unfinished identity
          // immediately, not a new event and not after the accepted timeout.
          acceptedAt = null; lastSent = -Infinity;
        }
        return true;
      }
      if (value.type === "pong") { if (!fault) { scenes = value.scenes === 2; liveStatus = value.idle === 1; ready = true; lastSeen = now(); } return true; }
      if (!current || value.id !== current.id) return false;
      if (value.status === "accepted") { if (acceptedAt === null) acceptedAt = now(); }
      else { const id = current.id; complete(id); current = null; acceptedAt = null; lastSent = -Infinity; }
      return true;
    },
    offer(payload) {
      const normalized = stationDonation(payload);
      if (current && current.id !== normalized.id) return false;
      if (current && JSON.stringify(current) !== JSON.stringify(normalized)) throw new Error("A queued station event cannot change.");
      if (!current) { current = normalized; acceptedAt = null; lastSent = -Infinity; }
      return true;
    },
    test() {
      if (current) return "busy";
      if (!ready || fault || now() - lastSeen > 5000) return "not-ready";
      if (now() - lastTest < 5000) return "busy";
      // Fixed local hardware sample only. Never comes from an invoice or enters
      // the station/payment ledger. The existing firmware displays this label.
      const payload = stationDonation({ id: randomBytes(12).toString("hex"), nick: "TEST - NO PAYMENT", amount: "300", cause: STATION_CAUSES[testSequence++ % STATION_CAUSES.length], test: true });
      testId = payload.id; current = payload; lastTest = now();
      acceptedAt = null; lastSent = -Infinity; testState("running");
      return "accepted";
    },
    tick(healthy = false, broadcastLive = false) {
      const timestamp = now();
      if (timestamp - lastPing >= 1000) { send(liveStatus ? { ...ping, live: broadcastLive === true } : ping); lastPing = timestamp; }
      if ((!healthy && !testId) || !ready || fault || !current) return;
      if (acceptedAt !== null && timestamp - acceptedAt < ACCEPTED_TIMEOUT_MS) return;
      if (timestamp - lastSent >= RETRY_MS) {
        // Negotiate presentation only. Older firmware still receives its exact
        // original schema; event identity and durable outbox are never changed.
        const wire = scenes ? current : { v: current.v, type: current.type, id: current.id, nick: current.nick, amount: current.amount };
        send(wire); lastSent = timestamp; acceptedAt = null;
      }
    },
    resetConnection() { scenes = false; liveStatus = false; ready = false; fault = false; lastSeen = -Infinity; lastSent = -Infinity; acceptedAt = null; lastPing = -Infinity; },
    get pendingId() { return current?.id ?? null; },
    get canShowBoard() { return ready && !fault && !current && now() - lastSeen <= 5000; },
  };
}

// Public, read-only stream status. This never gates a donation or reads an
// Owncast password. An absent, stale or malformed response cannot assert LIVE.
export async function stationBroadcastLive(fetcher = fetch) {
  try {
    const response = await fetcher("http://127.0.0.1:8082/api/status", { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 16384 || !response.body) return false;
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); return false; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const status = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return status?.online === true;
  } catch { return false; }
}

export async function stationWorkerHealthy(fetcher = fetch) {
  try {
    const response = await fetcher("http://127.0.0.1:4174/api/payments/config", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 16_384) return false;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 16_384) return false;
    const status = JSON.parse(text);
    // New-invoice availability can be paused for gas/capacity while a previously
    // finalized donation remains valid. It is not a gratitude security gate.
    return status?.custodyConfigured === true && status?.integrityLocked === false && status?.readiness?.processing === "connected";
  } catch { return false; }
}

export function parseStationArgs(args) {
  let port = null, demo = false, simulate = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--port" && port === null) port = args[++index]?.toUpperCase();
    else if (arg === "--demo" && !demo) demo = true;
    else if (arg === "--simulate" && !simulate) simulate = true;
    else throw new Error("Use --port COM6, optionally --demo; or --simulate without a USB port.");
  }
  if (simulate ? port !== null : !/^COM[1-9]\d{0,2}$/.test(port ?? "")) throw new Error("Choose a valid --port COM number, or --simulate without opening USB.");
  return { port, demo, simulate };
}

export async function runStationBridge(args = process.argv.slice(2), { onTestState = () => {} } = {}) {
  const options = parseStationArgs(args);
  if (!options.simulate && process.platform !== "win32") throw new Error("The native USB transport is for Windows; --simulate works without opening USB.");
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const remoteConfig = !options.demo && !options.simulate ? readStationRemoteConfig(project) : null;
  const remoteBroadcast = remoteConfig ? createRemoteBroadcastFreshness() : null;
  let events = null, serial = null, timer = null, stopping = false, tickRunning = false, healthy = options.demo, outputBuffer = "";
  if (remoteConfig) events = createRemoteStationEvents({ filename: resolve(project, "work/station/remote-acks.sqlite"), ...remoteConfig });
  let broadcastLive = false, broadcastCheckedAt = -Infinity, broadcastCheck = null;
  let boardTransport, leaderboard, boardTask = null, lastBoardAttemptAt = Date.now() - 8000;
  const demoPayload = options.demo ? stationDonation({ id: randomBytes(12).toString("hex"), nick: "DEMO", amount: "300", cause: "solar-foundation", test: true }) : null;
  let demoDone = false;
  let closePromise, finishClose;
  const finished = new Promise(ok => { finishClose = ok; });
  const close = () => closePromise ??= (async () => {
    stopping = true; clearInterval(timer);
    remoteBroadcast?.dispose();
    boardTransport?.close(); leaderboard?.close();
    // On Windows ChildProcess.kill is an abrupt TerminateProcess, not a
    // graceful signal. EOF lets the native transport dispose the USB handle.
    if (serial && serial.exitCode === null && serial.signalCode === null) {
      const exited = new Promise(ok => { serial.once("exit", ok); serial.once("close", ok); serial.once("error", ok); });
      serial.stdin.end();
      await exited;
    }
    try { await events?.close(); } catch { console.error("Station queue close failed. Preserve its database; payments were not changed."); process.exitCode = 1; }
    finishClose();
  })();
  const write = line => {
    if (Buffer.byteLength(line.trimEnd(), "utf8") > STATION_MAX_LINE_BYTES) throw new Error("Station wire payload exceeds the limit.");
    if (options.simulate) { if (JSON.parse(line).type === "donation") console.log(line.trimEnd()); return; }
    if (!serial?.stdin.writable || serial.stdin.writableLength > 8192) throw new Error("Station USB output is unavailable.");
    serial.stdin.write(line, "utf8");
  };
  const controller = createStationController({ write, onTestState, onFault() { console.error("Station display or storage reported a hardware fault. Gratitude is held; reconnect after fixing the device. Payments are unaffected."); }, done(id) { if (options.demo) { demoDone = true; console.log("Demo completed. This did not create or change a payment."); close(); } else events.complete(id); } });
  if (!options.demo && !options.simulate) {
    leaderboard = createStationLeaderboard({ remote: remoteConfig !== null });
    boardTransport = createStationBoardTransport({ write, canSend: () => !stopping && healthy && controller.canShowBoard });
  }
  try {
    if (!options.simulate) {
      serial = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(project, "scripts/station-serial.ps1"), "-Port", options.port], { cwd: project, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      serial.stdout.setEncoding("utf8"); serial.stderr.setEncoding("utf8");
      serial.stdout.on("data", chunk => {
        outputBuffer += chunk;
        if (outputBuffer.length > 4096) { outputBuffer = ""; return; }
        let newline;
        while ((newline = outputBuffer.indexOf("\n")) >= 0) {
          const line = outputBuffer.slice(0, newline).trim(); outputBuffer = outputBuffer.slice(newline + 1);
          if (!line || Buffer.byteLength(line, "utf8") > 512) continue;
          try {
            const message = JSON.parse(line);
            if (validStationBoardAck(message)) boardTransport?.receive(message);
            else if (controller.receive(message)) {
              if (message.type === "hello") { boardTransport?.cancel(); lastBoardAttemptAt = Date.now() - 8000; }
              if (message.type === "hello" || message.type === "pong") boardTransport?.setSupported(message.board === 1);
              if (message.type === "fault") boardTransport?.setSupported(false);
            }
          } catch { /* Boot chatter and unknown firmware messages never acknowledge gifts. */ }
        }
      });
      serial.stderr.on("data", () => console.error("Station USB reported an error. Check COM port and close Serial Monitor; payments are unaffected."));
      serial.on("error", () => { console.error("Could not start the native Windows USB transport. Payments are unaffected."); close(); process.exitCode = 1; });
      serial.on("exit", code => { if (!stopping) { console.error("Station USB disconnected. Restart the bridge after reconnecting; the pending gratitude is preserved."); close(); process.exitCode = code || 1; } });
      serial.stdin.on("error", () => { console.error("Station USB connection closed; the pending gratitude is preserved."); close(); process.exitCode = 1; });
    } else controller.receive({ v: 1, type: "hello", last: "" });
    console.log(options.demo ? "ChogCare STATION DEMO: simulated 300 CHOG, no real payment or wallet access." : "ChogCare station: verified destination receipts, USB gratitude only; finality remains separate. First activation skips old donations.");
    if (options.simulate) console.log("SIMULATION: USB is not opened; commands are printed locally using a separate simulation ledger. The live station queue is untouched.");
    let previousHealthy = null;
    const tick = async () => {
      if (stopping || tickRunning) return; tickRunning = true;
      try {
        if (!options.simulate && !broadcastCheck && Date.now() - broadcastCheckedAt >= 5000) {
          broadcastCheck = (remoteBroadcast ? remoteBroadcast.check() : stationBroadcastLive()).then(value => { broadcastLive = value; broadcastCheckedAt = Date.now(); }).finally(() => { broadcastCheck = null; });
        }
        healthy = options.demo || (remoteConfig ? await events.refresh(controller.pendingId) : await stationWorkerHealthy());
        if (stopping) return;
        if (healthy !== previousHealthy && !options.demo) { console.log(healthy ? "Payment worker is healthy; waiting for verified destination receipts." : "Station held: payment worker is offline, locked or not ready. No gratitude command is sent."); previousHealthy = healthy; }
        let allowedId = null;
        if (options.demo) { if (!demoDone) controller.offer(demoPayload); }
        else {
          // Do not even open payment databases until the trusted local worker
          // says that custody, processing and integrity are ready.
          if (!events && healthy) events = openStationEvents({ processorFilename: resolve(project, "work/payments/processor.sqlite"), profileFilename: resolve(project, "work/payments/preview.sqlite"), stationFilename: resolve(project, options.simulate ? "work/station/simulation.sqlite" : "work/station/station.sqlite") });
          if (!remoteConfig) events?.sync(healthy);
          const payload = events?.next(Date.now(), controller.pendingId);
          if (payload) { allowedId = payload.id; boardTransport?.cancel(); controller.offer(payload); }
        }
        // A previously offered arrival can become unverifiable after a reorg.
        // Revalidate its identity before retrying USB; test displays are separate.
        controller.tick(healthy && (options.demo || allowedId === controller.pendingId), remoteBroadcast ? remoteBroadcast.live : broadcastLive && Date.now() - broadcastCheckedAt <= 8000);
        // Public board refresh/thumbnail work never occupies the donation tick.
        // Every upload uses a fresh wire nonce, so late thumbnail ACKs cannot
        // acknowledge a new rotation or a real gratitude event.
        if (leaderboard && boardTransport?.supported && healthy && controller.canShowBoard && !boardTask && Date.now() - lastBoardAttemptAt >= 16000) {
          lastBoardAttemptAt = Date.now();
          boardTask = leaderboard.next().then(card => {
            if (!card || stopping || !healthy || !controller.canShowBoard) return false;
            return boardTransport.show({ ...card, id: randomBytes(12).toString("hex") });
          }).catch(() => false).finally(() => { lastBoardAttemptAt = Date.now(); boardTask = null; });
        }
        if (options.simulate && controller.pendingId) controller.receive({ v: 1, type: "ack", id: controller.pendingId, status: "done" });
      } catch { console.error("Station safety check failed; forwarding is paused. Preserve station and payment databases. Payments were not changed."); healthy = false; if (!remoteConfig) events?.sync(false); }
      finally { tickRunning = false; }
    };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await tick(); if (!stopping) timer = setInterval(tick, 1000);
    return { close, finished, test() {
      if (stopping || options.demo || options.simulate) return "not-ready";
      // All queue offers are synchronous. Never replace an in-flight event or
      // jump ahead of a real gratitude already present in the durable queue.
      if (controller.pendingId || events?.next()) return "busy";
      const result = controller.test(); if (result === "accepted") boardTransport?.cancel(); return result;
    } };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStationBridge().catch(error => { console.error(error.message); process.exitCode = 1; });
}
