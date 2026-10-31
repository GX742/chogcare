import { constants } from "node:fs";
import { open, lstat, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { POLICY, createState, validateState, evaluate, reserveRestart, parseMasterPlaylist, parseMediaPlaylist } from "./ingress-watchdog.mjs";

const exec = promisify(execFile);
const STATE_DIRECTORY = "/var/lib/chogcare-ingress-watchdog";
const CREDENTIAL = "/run/credentials/chogcare-ingress-watchdog.service/hls-reader-token";
const OBSERVE_CREDENTIAL = "/run/credentials/chogcare-ingress-watchdog-observe.service/hls-reader-token";
const CONTROL_GROUP = "/system.slice/chogcare-stream.service";
const ACTIVE_CONFIG = "/run/credentials/chogcare-stream.service/mediamtx.json";
const hash = value => createHash("sha256").update(value).digest("hex");
const need = value => { if (!value) throw Error("watchdog_guard_failed"); };
const lease = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
const monoNow = () => Number(process.hrtime.bigint()) / 1e6;
const integer = value => Number.isSafeInteger(value) && value >= 0;

async function boundedDescriptor(path, maximum, { privateMode = null, uid = 0, parentMode = null } = {}) {
  if (parentMode !== null) {
    const parent = await lstat(path.slice(0, path.lastIndexOf("/")), { bigint: true });
    need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === BigInt(uid) && (parent.mode & 0o777n) === BigInt(parentMode));
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(maximum + 1);
  try {
    const before = await file.stat({ bigint: true });
    const acceptedModes = Array.isArray(privateMode) ? privateMode : [privateMode];
    need(before.isFile() && before.nlink === 1n && (privateMode === null || before.uid === BigInt(uid) && before.gid === BigInt(uid) && acceptedModes.some(mode => (before.mode & 0o777n) === BigInt(mode)) && before.size > 0n && before.size <= BigInt(maximum)));
    let count = 0;
    while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
    need(count <= maximum);
    const after = await file.stat({ bigint: true });
    if (privateMode !== null) {
      const named = await lstat(path, { bigint: true });
      need(!named.isSymbolicLink() && lease(before) === lease(after) && lease(before) === lease(named) && BigInt(count) === before.size);
    }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)), metadata: before };
  } finally { bytes.fill(0); await file.close(); }
}

/** A private directory plus fd-pinned reads and durable atomic replacement. */
export function createPrivateStateStore(directory = STATE_DIRECTORY, uid = 0) {
  const path = `${directory}/state.json`;
  let expected = undefined;
  const guardDirectory = async () => {
    const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const value = await descriptor.stat({ bigint: true });
      need(value.isDirectory() && value.uid === BigInt(uid) && (value.mode & 0o777n) === 0o700n);
      const named = await lstat(directory, { bigint: true }); need(!named.isSymbolicLink() && named.dev === value.dev && named.ino === value.ino);
      return descriptor;
    } catch (error) { await descriptor.close(); throw error; }
  };
  const current = async () => {
    try { const read = await boundedDescriptor(path, POLICY.maxStateBytes, { privateMode: 0o600, uid }); return { value: JSON.parse(read.text), identity: lease(read.metadata) }; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  return {
    async load() {
      const parent = await guardDirectory();
      try { const read = await current(); expected = read?.identity ?? null; return read?.value ?? null; }
      finally { await parent.close(); }
    },
    async save(value) {
      need(expected !== undefined);
      const parent = await guardDirectory();
      let file, temporary, own;
      try {
        const before = await current(); need((before?.identity ?? null) === expected);
        const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= POLICY.maxStateBytes);
        temporary = `${directory}/.state-${randomBytes(12).toString("hex")}`;
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        own = await file.stat({ bigint: true }); need(own.isFile() && own.nlink === 1n && own.uid === BigInt(uid) && (own.mode & 0o777n) === 0o600n);
        try {
          for (let offset = 0; offset < bytes.length;) { const result = await file.write(bytes, offset, bytes.length - offset, null); need(result.bytesWritten > 0); offset += result.bytesWritten; }
          await file.sync();
        } finally { bytes.fill(0); }
        const latest = await current(); need((latest?.identity ?? null) === expected);
        const temporaryNamed = await lstat(temporary, { bigint: true }); need(!temporaryNamed.isSymbolicLink() && temporaryNamed.dev === own.dev && temporaryNamed.ino === own.ino);
        await rename(temporary, path);
        // A failed fsync consumes the already-written reservation conservatively;
        // the caller does not request restart after an uncertain persistence.
        const after = await current(); need(after && after.identity === lease(await file.stat({ bigint: true }))); expected = after.identity;
        await parent.sync();
      } finally {
        // Only this invocation's random temporary inode is eligible for cleanup.
        // state.json and its durable restart ledger are never removed here.
        if (temporary && own) {
          try {
            const named = await lstat(temporary, { bigint: true });
            if (named.isFile() && !named.isSymbolicLink() && named.dev === own.dev && named.ino === own.ino && named.uid === BigInt(uid)) { await unlink(temporary); await parent.sync(); }
          } catch { /* ENOENT after successful rename, or cleanup could not be proved. */ }
        }
        try { await file?.close(); } finally { await parent.close(); }
      }
    },
  };
}

export function hooksDisabled(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(([key, entry]) => /^runOn/.test(key)
    ? entry === "" || entry === false
    : hooksDisabled(entry, depth + 1));
}

export function safeLoadedConfig(config) {
  return config && hooksDisabled(config) && config.api === false && config.metrics === false && config.pprof === false && config.playback === false && config.rtsp === false &&
    config.rtmp === true && config.rtmpEncryption === "strict" && config.rtmpsAddress === "0.0.0.0:1936" &&
    config.hls === true && config.hlsAddress === "127.0.0.1:8888" && config.hlsEncryption === false && config.hlsAlwaysRemux === true && config.hlsVariant === "lowLatency" && config.hlsDirectory === "" &&
    config.authMethod === "internal" && config.pathDefaults?.source === "publisher" && config.pathDefaults?.overridePublisher === false && config.pathDefaults?.record === false && config.pathDefaults?.alwaysAvailable === false &&
    Object.keys(config.paths ?? {}).length === 1 && Object.hasOwn(config.paths, "station") && Object.keys(config.paths.station).length === 0 &&
    typeof config.hlsCDNSecret === "string" && config.hlsCDNSecret.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(config.hlsCDNSecret);
}

export function parseUnitProperties(text) {
  need(typeof text === "string" && text.length <= 16384);
  const properties = Object.fromEntries(text.trim().split("\n").map(line => { const at = line.indexOf("="); need(at > 0); return [line.slice(0, at), line.slice(at + 1)]; }));
  need(properties.ActiveState === "active" && properties.SubState === "running" && /^\d{1,10}$/.test(properties.MainPID) && Number(properties.MainPID) > 1 && /^[a-f0-9]{32}$/.test(properties.InvocationID) && ["", "0"].includes(properties.Job));
  const start = properties.ExecStart ?? "";
  need((start.match(/\bpath=/g) ?? []).length === 1 && (start.match(/argv\[\]=/g) ?? []).length === 1 &&
    /(?:^|\s)path=\/opt\/chogcare-stream\/mediamtx\s*;/.test(start) &&
    /argv\[\]=\/opt\/chogcare-stream\/mediamtx \/run\/credentials\/chogcare-stream.service\/mediamtx\.json\s*;/.test(start));
  need(properties.ControlGroup === CONTROL_GROUP && safeUnitDependencies(properties));
  return { pid: Number(properties.MainPID), invocation: properties.InvocationID, controlGroup: properties.ControlGroup };
}

export function parseSocketCgroup(text) {
  need(typeof text === "string" && Buffer.byteLength(text) <= 16384);
  const lines = text.trim().split("\n").filter(Boolean); need(lines.length === 1);
  const line = lines[0], words = line.trim().split(/\s+/), local = words[0] === "ESTAB" ? words[3] : words[2];
  need(local?.endsWith(":1936"));
  const value = expression => { const matches = [...line.matchAll(expression)]; need(matches.length === 1); return matches[0][1]; };
  const uid = value(/(?:^|\s)uid:(\d{1,10})(?=\s|$)/g), inode = value(/(?:^|\s)ino:(\d{1,20})(?=\s|$)/g);
  const cgroup = value(/(?:^|\s)cgroup:([^\s]+)(?=\s|$)/g);
  need(Number(uid) > 0 && BigInt(inode) > 0n && cgroup === CONTROL_GROUP);
  return { uid: Number(uid), inode, cgroup };
}

export function verifyCgroupOwnership({ pid, uid, socket, controlGroup, cgroupInode, procs }) {
  need(integer(pid) && pid > 1 && integer(uid) && uid > 0 && socket.uid === uid && socket.cgroup === CONTROL_GROUP && controlGroup === CONTROL_GROUP && typeof cgroupInode === "bigint" && cgroupInode > 0n);
  const members = procs.trim().split(/\s+/); need(members.length === 1 && /^\d{1,10}$/.test(members[0]) && Number(members[0]) === pid);
}

export const EMPTY_UNIT_PROPERTIES = Object.freeze(["RequiredBy", "Requisite", "RequisiteOf", "BoundBy", "ConsistsOf", "PartOf", "BindsTo", "PropagatesStopTo", "StopPropagatedFrom", "Upholds", "UpheldBy", "OnFailure", "OnSuccess", "TriggeredBy", "Triggers", "Sockets", "ExecCondition", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"]);
export function safeUnitDependencies(properties) {
  if (!EMPTY_UNIT_PROPERTIES.every(key => Object.hasOwn(properties, key) && properties[key] === "")) return false;
  if (!["Conflicts", "ConflictedBy", "Requires", "Wants"].every(key => Object.hasOwn(properties, key))) return false;
  const values = key => properties[key].trim().split(/\s+/).filter(Boolean);
  return ["Conflicts", "ConflictedBy"].every(key => values(key).every(unit => unit === "shutdown.target")) &&
    values("Requires").every(unit => ["sysinit.target", "system.slice", "-.mount", "tmp.mount"].includes(unit)) && values("Wants").every(unit => unit === "network-online.target") &&
    properties.FileDescriptorStoreMax === "0" && properties.NFileDescriptorStore === "0" &&
    properties.FailureAction === "none" && properties.SuccessAction === "none" && properties.StartLimitAction === "none";
}

async function inspectRuntime(token, bootId) {
  let guard = "unit_guard_failed";
  try {
  const { stdout } = await exec("/usr/bin/systemctl", ["show", "chogcare-stream.service", `--property=ActiveState,SubState,MainPID,InvocationID,Job,ExecStart,ControlGroup,Conflicts,ConflictedBy,Requires,Wants,FileDescriptorStoreMax,NFileDescriptorStore,FailureAction,SuccessAction,StartLimitAction,${EMPTY_UNIT_PROPERTIES.join(",")}`], { timeout: 2000, maxBuffer: 16384 });
  const unit = parseUnitProperties(stdout);
  guard = "process_guard_failed";
  const status = (await boundedDescriptor(`/proc/${unit.pid}/status`, 65536)).text;
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status); need(ids && ids.slice(1).every(value => value === ids[1]) && Number(ids[1]) > 0);
  const stat = (await boundedDescriptor(`/proc/${unit.pid}/stat`, 16384)).text;
  const start = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]; need(/^\d{1,20}$/.test(start));
  guard = "socket_cgroup_guard_failed";
  const diagnostic = await exec("/usr/bin/ss", ["-H", "-t", "-n", "-e", "--cgroup", "state", "established", "( sport = :1936 )"], { timeout: 2000, maxBuffer: 16384 });
  const socket = parseSocketCgroup(diagnostic.stdout);
  const cgroupPath = "/sys/fs/cgroup/system.slice/chogcare-stream.service";
  const group = await open(cgroupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let cgroupInode;
  try {
    const before = await group.stat({ bigint: true }); need(before.isDirectory() && before.uid === 0n);
    const procs = (await boundedDescriptor("/sys/fs/cgroup/system.slice/chogcare-stream.service/cgroup.procs", 4096)).text;
    verifyCgroupOwnership({ pid: unit.pid, uid: Number(ids[1]), socket, controlGroup: unit.controlGroup, cgroupInode: before.ino, procs });
    const after = await lstat(cgroupPath, { bigint: true }); need(!after.isSymbolicLink() && after.dev === before.dev && after.ino === before.ino);
    cgroupInode = before.ino.toString();
  } finally { await group.close(); }
  guard = "active_config_guard_failed";
  const active = await boundedDescriptor(ACTIVE_CONFIG, 32768, { privateMode: 0o440, parentMode: 0o550 });
  const config = JSON.parse(active.text); need(safeLoadedConfig(config));
  const configured = Buffer.from(config.hlsCDNSecret), supplied = Buffer.from(token);
  try { need(configured.length === supplied.length && timingSafeEqual(configured, supplied)); }
  finally { configured.fill(0); supplied.fill(0); config.hlsCDNSecret = ""; }
  return hash(`${bootId}:${unit.invocation}:${unit.pid}:${start}:${socket.inode}:${cgroupInode}:${hash(active.text)}`);
  } catch { throw Object.assign(Error("watchdog_guard_failed"), { guard }); }
}

function readLoopbackPlaylist(child, token) {
  need(typeof child === "string" && child.length <= 165 && /^[A-Za-z0-9_-]{1,160}\.m3u8$/.exec(child)?.[0] === child);
  return new Promise((yes, no) => {
    let timer, size = 0; const chunks = [];
    const req = request({ hostname: "127.0.0.1", port: 8888, method: "GET", agent: false, path: `/station/${child}`, headers: { Authorization: `Bearer ${token}`, Connection: "close" } }, response => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"] ?? 0) > 65536) { response.destroy(); req.destroy(); no(Error("playlist_unavailable")); return; }
      response.on("data", chunk => { size += chunk.length; if (size > 65536) { response.destroy(); req.destroy(); no(Error("playlist_limit")); } else chunks.push(chunk); });
      response.once("error", no);
      response.once("end", () => { try { yes(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { no(Error("playlist_invalid")); } });
    });
    timer = setTimeout(() => { req.destroy(); no(Error("playlist_deadline")); }, 1500);
    req.once("error", no); req.once("close", () => clearTimeout(timer)); req.end();
  });
}

export async function runWatchdogCycle(io, { observeOnly = false } = {}) {
  const bootId = await io.bootId(), initialNow = io.now();
  let state = await io.store.load(); state = state === null ? createState(bootId, initialNow) : validateState(state, bootId, initialNow);
  const first = await io.observe(bootId);
  let decision = evaluate(state, { ...first, bootId, nowMs: io.now() });
  if (observeOnly) return { status: decision.status, observationOnly: true, eligible: first.valid === true && first.safe === true, runtimeGuardsPassed: first.valid === true && first.safe === true, reason: first.reason ?? "none", wouldRestart: decision.action !== null, restartRequested: false, restartSucceeded: false, intentCount: decision.state.intents.length };
  await io.store.save(decision.state);
  if (!decision.action) return { status: decision.status, restartRequested: false, restartSucceeded: false, intentCount: decision.state.intents.length };
  const fresh = await io.observe(bootId), finalNow = io.now();
  const final = evaluate(decision.state, { ...fresh, bootId, nowMs: finalNow });
  if (!final.action || fresh.generation !== first.generation || final.action.generation !== decision.action.generation) {
    await io.store.save(final.state);
    return { status: "recovery_or_generation_change", restartRequested: false, restartSucceeded: false, intentCount: final.state.intents.length };
  }
  const reserved = reserveRestart(final.state, final.action, finalNow);
  await io.store.save(reserved);
  // Persisted budget is never refunded, including timeout/unknown systemctl result.
  const outcome = await io.tryRestart(fresh, bootId);
  return { status: outcome.requested ? "restart_requested" : "runtime_lease_changed", restartRequested: outcome.requested, restartSucceeded: outcome.succeeded, intentCount: reserved.intents.length };
}

export async function createProductionIo() {
  need(process.platform === "linux" && process.getuid?.() === 0);
  const credentialPath = process.env.CREDENTIALS_DIRECTORY === "/run/credentials/chogcare-ingress-watchdog.service" ? CREDENTIAL : process.env.CREDENTIALS_DIRECTORY === "/run/credentials/chogcare-ingress-watchdog-observe.service" ? OBSERVE_CREDENTIAL : null; need(credentialPath);
  const secret = await boundedDescriptor(credentialPath, 44, { privateMode: [0o400, 0o440] });
  const token = secret.text.replace(/\n$/, ""); need(token.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, "base64url").toString("base64url") === token);
  const readBoot = async () => { const value = (await boundedDescriptor("/proc/sys/kernel/random/boot_id", 64)).text.trim(); need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)); return hash(value); };
  return {
    bootId: readBoot, now: monoNow, store: createPrivateStateStore(),
    async observe(bootId) {
      try {
        const before = await inspectRuntime(token, bootId);
        const child = parseMasterPlaylist(await readLoopbackPlaylist("index.m3u8", token));
        const playlist = parseMediaPlaylist(await readLoopbackPlaylist(child, token));
        const after = await inspectRuntime(token, bootId);
        return { valid: before === after && playlist.eligible === true, safe: before === after, generation: after, playlist };
      } catch (error) { return { valid: false, safe: false, generation: null, playlist: null, reason: ["unit_guard_failed", "process_guard_failed", "socket_cgroup_guard_failed", "active_config_guard_failed"].includes(error.guard) ? error.guard : "playlist_guard_failed" }; }
    },
    async tryRestart(fresh, bootId) {
      try { if (await inspectRuntime(token, bootId) !== fresh.generation) return { requested: false, succeeded: false }; }
      catch { return { requested: false, succeeded: false }; }
      try { await exec("/usr/bin/systemctl", ["--job-mode=fail", "try-restart", "chogcare-stream.service"], { timeout: 20000, maxBuffer: 4096 }); return { requested: true, succeeded: true }; }
      catch { return { requested: true, succeeded: false }; }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    need(process.argv.length === 3 && ["--tick", "--observe-only"].includes(process.argv[2]));
    const io = await createProductionIo();
    const observationOnly = process.argv[2] === "--observe-only";
    const result = await runWatchdogCycle(io, { observeOnly: observationOnly });
    console.log(JSON.stringify(result));
    if (observationOnly && result.runtimeGuardsPassed !== true) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ status: "watchdog_refused", restartRequested: false, rawDetailsSuppressed: true })); process.exitCode = 1; }
}
