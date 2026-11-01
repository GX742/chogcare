import { constants } from "node:fs";
import { open, lstat, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:https";
import { createServer } from "node:net";
import { uptime } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectLocalObs } from "./obs-client.mjs";
import { createState, validateState, evaluate, recoverPublisher } from "./obs-publisher-recovery.mjs";
import { parseMasterPlaylist, parseMediaPlaylist } from "./ingress-watchdog.mjs";

const exec = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const names = new Set(["binding.json", "state.json", "status.json", "pause.flag"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const need = value => { if (!value) throw Error("publisher_runtime_refused"); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.exec(value)?.[0] === value;
const identity = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
const delay = milliseconds => new Promise(yes => setTimeout(yes, milliseconds));
const now = () => Math.floor(uptime() * 1000);

const aclScript = String.raw`
$ErrorActionPreference='Stop'
try {
 Import-Module ([IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
 $path=$env:CHOGCARE_PUBLISHER_PATH
 $item=Get-Item -LiteralPath $path -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'reparse'}
 if($item.PSIsContainer -ne ($env:CHOGCARE_PUBLISHER_DIRECTORY -eq '1')){throw 'type'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $profile=(Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$sid.Value) -Name ProfileImagePath).ProfileImagePath
 if([Environment]::ExpandEnvironmentVariables($profile).TrimEnd('\') -ine [Environment]::GetFolderPath('UserProfile').TrimEnd('\')){throw 'profile'}
 $acl=Get-Acl -LiteralPath $path
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}
 if($item.PSIsContainer -and -not $acl.AreAccessRulesProtected){throw 'inheritance'}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 $allowed=@($sid.Value,'S-1-5-18')
 if($rules.Count -ne 2){throw 'count'}
 foreach($rule in $rules){if($allowed -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'rule'};if($item.PSIsContainer -and ($rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None)){throw 'child_inheritance'}}
 if(@($rules.IdentityReference.Value | Select-Object -Unique).Count -ne 2){throw 'duplicate'}
 [Console]::Out.Write('true')
} catch { [Console]::Out.Write('false'); exit 1 }
`;

export async function verifyPrivateAcl(path, directory, command = exec) {
  need(process.platform === "win32");
  const result = await command(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(aclScript, "utf16le").toString("base64")], {
    timeout: 5000, maxBuffer: 4096, windowsHide: true, shell: false,
    env: { ...process.env, CHOGCARE_PUBLISHER_PATH: path, CHOGCARE_PUBLISHER_DIRECTORY: directory ? "1" : "0" },
  });
  need(result.stdout === "true");
}

export async function readBoundedDescriptor(file, path, maximum = 32768) {
  need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 131072);
  const before = await file.stat({ bigint: true });
  need(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum));
  const namedBefore = await lstat(path, { bigint: true });
  need(namedBefore.isFile() && !namedBefore.isSymbolicLink() && identity(before) === identity(namedBefore));
  const bytes = Buffer.alloc(maximum + 1); let count = 0;
  while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
  const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
  need(count <= maximum && BigInt(count) === before.size && named.isFile() && !named.isSymbolicLink() && identity(before) === identity(after) && identity(before) === identity(named));
  return { bytes: bytes.subarray(0, count), lease: identity(before), metadata: before };
}

export async function readBoundedFile(path, maximum = 32768) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try { return await readBoundedDescriptor(file, path, maximum); }
  finally { await file.close(); }
}

/** The caller creates the owner+SYSTEM directory before any private bytes exist. */
export function createPrivateStore(directory, { prove = verifyPrivateAcl, flush = file => file.sync() } = {}) {
  const leases = new Map(), trusted = new Map(); let directoryIdentity = null;
  const inode = info => `${info.dev}:${info.ino}`;
  const guard = async (refresh = false) => {
    const before = await lstat(directory, { bigint: true }); need(before.isDirectory() && !before.isSymbolicLink());
    need(directoryIdentity === null || directoryIdentity === inode(before));
    if (directoryIdentity === null || refresh) await prove(directory, true);
    const after = await lstat(directory, { bigint: true }); need(before.dev === after.dev && before.ino === after.ino);
    directoryIdentity = inode(after);
  };
  const path = name => { need(names.has(name)); return join(directory, name); };
  const read = async name => {
    try {
      const result = await readBoundedFile(path(name), name === "binding.json" ? 16384 : 8192);
      if (trusted.get(name) !== inode(result.metadata)) await prove(path(name), false);
      const named = await lstat(path(name), { bigint: true });
      need(!named.isSymbolicLink() && identity(named) === identity(result.metadata));
      trusted.set(name, inode(result.metadata)); return result;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  return {
    verify: () => guard(true),
    async load(name) {
      await guard(); const result = await read(name); leases.set(name, result?.lease ?? null);
      return result ? JSON.parse(result.bytes.toString("utf8")) : null;
    },
    async paused() { await guard(); try { await lstat(path("pause.flag")); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } },
    async create(name, value) {
      await guard(); const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= 8192);
      const file = await open(path(name), "wx", 0o600);
      try {
        const own = await file.stat({ bigint: true }); need(own.isFile() && own.nlink === 1n);
        // Windows creates the file under the proven owner+SYSTEM inheritable
        // DACL. No per-RPC or per-write PowerShell process is needed.
        trusted.set(name, inode(own)); await file.writeFile(bytes); await flush(file, "created");
      }
      finally { bytes.fill(0); await file.close(); }
      const readback = await read(name); need(readback !== null); leases.set(name, readback.lease);
    },
    async save(name, value) {
      need(name === "state.json" || name === "status.json"); need(leases.has(name)); await guard();
      const expected = leases.get(name), before = await read(name); need((before?.lease ?? null) === expected);
      const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= 8192);
      const temporary = join(directory, `.publisher-${randomBytes(12).toString("hex")}.tmp`);
      const file = await open(temporary, "wx", 0o600); const own = await file.stat({ bigint: true });
      try {
        need(own.isFile() && own.nlink === 1n); await file.writeFile(bytes); await flush(file, "prepared");
        const latest = await read(name); need((latest?.lease ?? null) === expected);
        const temp = await lstat(temporary, { bigint: true }); need(!temp.isSymbolicLink() && temp.dev === own.dev && temp.ino === own.ino);
        await rename(temporary, path(name));
        // On Windows rename does not request WRITE_THROUGH. Flush the same
        // owned handle again after replacement before acknowledging the ledger.
        await flush(file, "replaced");
        trusted.set(name, inode(own));
        const result = await read(name); need(result && result.lease === identity(await file.stat({ bigint: true })) && result.bytes.equals(bytes));
        leases.set(name, result.lease);
      } finally {
        bytes.fill(0); await file.close();
        try { const remaining = await lstat(temporary, { bigint: true }); if (remaining.isFile() && remaining.dev === own.dev && remaining.ino === own.ino) await unlink(temporary); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  };
}

export function validateOrigin(value) {
  need(typeof value === "string" && value.length <= 253); const url = new URL(value);
  need(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && (!url.port || url.port === "443"));
  const host = url.hostname.toLowerCase();
  need(!host.includes(":") && !host.endsWith(".local") && !host.endsWith(".localhost") && host !== "localhost" && /^[a-z0-9.-]+$/.test(host));
  if (/^[0-9.]+$/.test(host)) { const parts = host.split(".").map(Number); need(parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && ![0, 10, 127].includes(parts[0]) && !(parts[0] === 169 && parts[1] === 254) && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) && !(parts[0] === 192 && parts[1] === 168) && parts[0] < 224); }
  else need(host.includes(".") && !host.includes("..") && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  return url.origin;
}

export function validateBinding(value) {
  need(value && Object.keys(value).sort().join(",") === "moduleHashes,origin,publicOrigin,salt,sourceHash,version" && value.version === 1 && typeof value.salt === "string" && /^[A-Za-z0-9_-]{43}$/.exec(value.salt)?.[0] === value.salt && hex(value.sourceHash));
  need(validateOrigin(value.publicOrigin) === value.publicOrigin && validateOrigin(value.origin) === value.origin && value.origin !== value.publicOrigin);
  need(value.moduleHashes && Object.keys(value.moduleHashes).sort().join(",") === "client,engine,parser,runtime" && Object.values(value.moduleHashes).every(hex));
  return value;
}
const bindingHash = binding => hash(JSON.stringify(canonical(binding)));
export const sourceHash = (salt, source) => hash(`${salt}:${JSON.stringify(canonical(source))}`);

async function moduleHashes() {
  const result = {};
  for (const [name, file] of [["runtime", "obs-publisher-recovery-runtime.mjs"], ["engine", "obs-publisher-recovery.mjs"], ["client", "obs-client.mjs"], ["parser", "ingress-watchdog.mjs"]]) result[name] = hash((await readBoundedFile(join(here, file), 131072)).bytes);
  return result;
}

export async function obsConfigurationPath(command = exec) {
  const script = String.raw`$ErrorActionPreference='Stop';[Console]::Out.Write([Environment]::GetFolderPath('ApplicationData'))`;
  const result = await command(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 5000, maxBuffer: 8192, windowsHide: true, shell: false });
  const directory = result.stdout;
  need(typeof directory === "string" && directory.length > 0 && directory.length <= 2048 && win32.isAbsolute(directory) && /^[A-Za-z]:\\/.test(directory) && !directory.startsWith("\\\\") && directory === win32.normalize(directory) && !/[\x00-\x1f]/.test(directory));
  return win32.join(directory, "obs-studio", "plugin_config", "obs-websocket", "config.json");
}

export async function readObsConfiguration() {
  need(process.platform === "win32");
  const { bytes } = await readBoundedFile(await obsConfigurationPath(), 65536);
  try { const value = JSON.parse(bytes.toString("utf8")); need(value.server_enabled === true && value.auth_required === true && value.server_port === 4455 && typeof value.server_password === "string" && value.server_password.length >= 8 && value.server_password.length <= 1024); return { port: 4455, password: value.server_password }; }
  finally { bytes.fill(0); }
}

export function getHttpsText(url, milliseconds, requestImpl = request) {
  need(milliseconds > 0 && milliseconds <= 3000);
  return new Promise((yes, no) => {
    let size = 0; const chunks = []; let timer;
    const req = requestImpl(url, { method: "GET", agent: false, rejectUnauthorized: true, headers: { Accept: "application/vnd.apple.mpegurl", Connection: "close" } }, response => {
      if (response.statusCode !== 200) { response.destroy(); req.destroy(); yes({ status: response.statusCode, text: "" }); return; }
      if (Number(response.headers["content-length"] ?? 0) > 65536) { response.destroy(); req.destroy(); no(Error("playlist_bound")); return; }
      response.on("data", chunk => { size += chunk.length; if (size > 65536) { response.destroy(); req.destroy(); no(Error("playlist_bound")); } else chunks.push(chunk); });
      response.once("error", no); response.once("end", () => { try { yes({ status: 200, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)) }); } catch { no(Error("playlist_encoding")); } });
    });
    timer = setTimeout(() => { req.destroy(); no(Error("playlist_deadline")); }, milliseconds);
    req.once("error", no); req.once("close", () => clearTimeout(timer)); req.end();
  });
}

function parseHealthMediaPlaylist(text) {
  need(typeof text === "string" && Buffer.byteLength(text) <= 65536);
  // The public classic projection comments out these LL-HLS tags. Restore only
  // their exact line prefixes so the existing parser still checks part URIs
  // and counts only completed EXTINF media. Unknown comments remain rejected.
  return parseMediaPlaylist(text.replace(/^#CHOGCARE-(SERVER-CONTROL|PART-INF|PART|PRELOAD-HINT):/gm, "#EXT-X-$1:"));
}

export async function probeHls(origin, { get = getHttpsText, clock = () => performance.now() } = {}) {
  const fixed = validateOrigin(origin), deadline = clock() + 3000;
  const read = async child => {
    need(/^[A-Za-z0-9_-]{1,160}\.m3u8$/.exec(child)?.[0] === child); const remaining = deadline - clock(); need(remaining > 0);
    return get(`${fixed}/live/station/${child}`, remaining);
  };
  try {
    const master = await read("index.m3u8"); if (master.status !== 200) return { status: master.status, valid: false, mediaIdHash: null };
    const media = await read(parseMasterPlaylist(master.text)); if (media.status !== 200) return { status: media.status, valid: false, mediaIdHash: null };
    const playlist = parseHealthMediaPlaylist(media.text); need(playlist.eligible && playlist.segments.length > 0);
    return { status: 200, valid: true, mediaIdHash: hash(JSON.stringify([playlist.initId, playlist.segments.map(segment => [segment.sequence, segment.id, segment.durationMs])])) };
  } catch { return { status: 0, valid: false, mediaIdHash: null }; }
}

export function createSessionTracker(random = () => randomBytes(32).toString("hex")) {
  let last = null, sessionHash = random();
  return {
    reset() { last = null; sessionHash = random(); },
    update(stream, atMs) {
      need(Number.isFinite(atMs) && ["outputDuration", "outputBytes", "outputTotalFrames"].every(name => Number.isSafeInteger(stream[name]) && stream[name] >= 0));
      if (last && (atMs < last.atMs || ["outputDuration", "outputBytes", "outputTotalFrames"].some(name => stream[name] < last[name]) || Math.abs((atMs - stream.outputDuration) - (last.atMs - last.outputDuration)) > 2000)) this.reset();
      last = { ...stream, atMs }; return sessionHash;
    },
    get hash() { return sessionHash; },
  };
}

export function createEventGuard() {
  const state = { connected: false, configChanging: false, unexpectedStop: false, cancelEpoch: 0, phase: "idle" };
  return {
    state,
    cancel() { state.cancelEpoch++; },
    event(event) {
      if (event.type === "ConnectionClosed") { state.connected = false; state.cancelEpoch++; }
      else if (["CurrentProfileChanging", "CurrentProfileChanged", "CurrentSceneCollectionChanging", "CurrentSceneCollectionChanged"].includes(event.type)) { state.configChanging = event.type.endsWith("Changing"); state.cancelEpoch++; }
      else if (event.type === "StreamStateChanged") {
        const stopEvent = ["OBS_WEBSOCKET_OUTPUT_STOPPING", "OBS_WEBSOCKET_OUTPUT_STOPPED"].includes(event.outputState);
        if (state.phase === "stopping" && !stopEvent || stopEvent && state.phase !== "stopping") { state.unexpectedStop = true; state.cancelEpoch++; }
        else if (event.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED" && state.phase === "idle") { state.unexpectedStop = false; state.cancelEpoch++; }
      }
    },
  };
}

export async function readSource(rpc) {
  const [profile, service, video, collection] = await Promise.all([rpc("GetProfileList"), rpc("GetStreamServiceSettings"), rpc("GetVideoSettings"), rpc("GetSceneCollectionList")]);
  need(typeof profile.currentProfileName === "string" && typeof collection.currentSceneCollectionName === "string" && service && video);
  return { profile: profile.currentProfileName, service, video, collection: collection.currentSceneCollectionName };
}

export function createPublisherAdapter({ binding, store, clock = now, connect = connectLocalObs, configuration = readObsConfiguration, probe = probeHls }) {
  validateBinding(binding); const guard = createEventGuard(), tracker = createSessionTracker();
  let client = null, connectionHash = null, cancelled = false;
  const check = async () => { need(!cancelled && !await store.paused() && guard.state.connected && !guard.state.configChanging); };
  const rpc = async (type, data) => { await check(); const epoch = guard.state.cancelEpoch; const result = await client.request(type, data); await check(); need(epoch === guard.state.cancelEpoch); return result; };
  const ensure = async () => {
    if (client && guard.state.connected) return;
    need(!cancelled && !await store.paused()); const settings = await configuration();
    client?.close(); tracker.reset(); connectionHash = randomBytes(32).toString("hex"); guard.state.configChanging = false; guard.state.unexpectedStop = false;
    client = await connect({ ...settings, timeoutMs: 2000, onRecoveryEvent: event => { guard.event(event); if (event.type !== "StreamStateChanged" || guard.state.phase === "idle") tracker.reset(); } });
    guard.state.connected = true;
  };
  const capture = async () => {
    const source = await readSource(rpc); need(sourceHash(binding.salt, source) === binding.sourceHash);
    const [stream, record, virtual] = await Promise.all([rpc("GetStreamStatus"), rpc("GetRecordStatus"), rpc("GetVirtualCamStatus")]);
    let replay;
    try { replay = await rpc("GetReplayBufferStatus"); }
    catch (error) {
      if (error.message !== "Local OBS request rejected (604).") throw error;
      const mode = await rpc("GetProfileParameter", { parameterCategory: "Output", parameterName: "Mode" });
      const category = (mode.parameterValue ?? mode.defaultParameterValue) === "Advanced" ? "AdvOut" : "SimpleOutput";
      const enabled = await rpc("GetProfileParameter", { parameterCategory: category, parameterName: "RecRB" });
      need([false, "false", "0"].includes(enabled.parameterValue ?? enabled.defaultParameterValue)); replay = { outputActive: false };
    }
    need([record, virtual, replay].every(output => output.outputActive === false));
    need(typeof stream.outputActive === "boolean" && typeof stream.outputReconnecting === "boolean");
    const sessionHash = guard.state.phase === "stopping" && !stream.outputActive ? tracker.hash : tracker.update(stream, clock());
    return { stream, sessionHash, bindingHash: bindingHash(binding), connectionHash, ...guard.state, enabled: !await store.paused() && !cancelled };
  };
  const inspect = async (verify = true) => {
    if (verify) await store.verify?.();
    await ensure(); const before = await capture();
    if (guard.state.phase === "stopping") return { ...before, outputActive: before.stream.outputActive, outputReconnecting: before.stream.outputReconnecting };
    const publicHls = await probe(binding.publicOrigin), originHls = await probe(binding.origin), after = await capture();
    need(before.sessionHash === after.sessionHash && before.cancelEpoch === after.cancelEpoch && before.connectionHash === after.connectionHash);
    return { ...after, outputActive: after.stream.outputActive, outputReconnecting: after.stream.outputReconnecting,
      outputBytes: after.stream.outputBytes, outputDuration: after.stream.outputDuration, outputTotalFrames: after.stream.outputTotalFrames,
      publicHls, originHls, bothMissing: publicHls.status === 404 && originHls.status === 404 };
  };
  return {
    async observe() { return inspect(); },
    transaction(persist) {
      let firstInspection = true;
      return { persist, now: clock, cancelled: () => cancelled,
        inspect() { const verify = firstInspection; firstInspection = false; return inspect(verify); },
        async stop() { await check(); guard.state.phase = "stopping"; await rpc("StopStream"); return true; },
        async start() { await check(); need(guard.state.phase === "stopping"); guard.state.phase = "starting"; await rpc("StartStream"); return true; },
        sleep: () => delay(500),
      };
    },
    finishTransaction() { guard.state.phase = "idle"; tracker.reset(); },
    cancelled: () => cancelled,
    cancel() { cancelled = true; guard.cancel(); client?.close(); },
    close() { client?.close(); },
  };
}

export async function runPublisherLoop({ store, binding, bootId, adapter, clock = now, sleep = delay, report = () => {} }, { observeOnly = false, durationMs = observeOnly ? 60000 : Infinity } = {}) {
  let state = await store.load("state.json"); need(state !== null); state = validateState(state, bootId, clock());
  if (!observeOnly) await store.load("status.json");
  const started = clock(); let samples = 0, dualHealthySamples = 0, lastAt = null, maxSampleGapMs = 0, lastConnected = false, bindingVerified = false;
  const summary = status => ({ status, restartRequested: false, samples, dualHealthySamples, armed: state.healthyAnchor !== null,
    elapsedMs: clock() - started, maxSampleGapMs, lastConnected, bindingVerified });
  while (clock() - started < durationMs) {
    if (adapter.cancelled?.()) return summary("cancelled");
    const began = clock(); let sample;
    try { sample = await adapter.observe(); }
    catch { sample = { enabled: false, connected: false, configChanging: false, unexpectedStop: false }; }
    if (adapter.cancelled?.()) return summary("cancelled");
    const decision = evaluate(state, { ...sample, bootId, nowMs: clock() }); state = decision.state;
    const observedAt = clock(); samples++; if (lastAt !== null) maxSampleGapMs = Math.max(maxSampleGapMs, observedAt - lastAt); lastAt = observedAt;
    lastConnected = sample.connected === true; bindingVerified = sample.bindingHash === bindingHash(binding);
    if (sample.publicHls?.valid === true && sample.originHls?.valid === true) dualHealthySamples++;
    const status = { version: 1, atMs: clock(), mode: observeOnly ? "observe" : "run", status: decision.status,
      connected: sample.connected === true, bindingVerified: sample.bindingHash === bindingHash(binding), armed: state.healthyAnchor !== null,
      dualMediaHealthy: sample.publicHls?.valid === true && sample.originHls?.valid === true, restartRequested: false };
    if (!observeOnly) { await store.save("state.json", state); await store.save("status.json", status); }
    report(status);
    if (await store.paused()) return summary("paused");
    if (decision.action && !observeOnly) {
      // Persistence failures propagate out: never reuse a possibly refunded ledger.
      const result = await recoverPublisher(adapter.transaction(value => store.save("state.json", value)), { state, action: decision.action, nowMs: state.last.atMs });
      state = result.state;
      await store.save("status.json", { ...status, atMs: clock(), status: result.status, restartRequested: result.startRequested,
        manualRecoveryRequired: result.status !== "start_acknowledged" });
      if (result.status === "start_acknowledged") adapter.finishTransaction();
      else {
        // Never resume a partial or ambiguous transaction on a later task start.
        if (!await store.paused()) await store.create("pause.flag", { version: 1 });
        adapter.cancel();
        return { ...summary(result.status), restartRequested: result.startRequested, manualRecoveryRequired: true };
      }
    }
    await sleep(Math.max(0, 5000 - (clock() - began)));
  }
  return summary("observation_complete");
}

async function bootIdentity() {
  const script = String.raw`$ErrorActionPreference='Stop';Import-Module ([IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1')) -ErrorAction Stop;$v=(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime;[Console]::Out.Write($v.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))`;
  const result = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 5000, maxBuffer: 1024, windowsHide: true, shell: false });
  need(/^[1-9]\d{10,20}$/.exec(result.stdout)?.[0] === result.stdout); return hash(result.stdout);
}

export function acquireSingleton(serverFactory = createServer) {
  return new Promise((yes, no) => {
    const server = serverFactory(socket => socket.destroy()); server.maxConnections = 1;
    server.once("error", () => no(Error("publisher_singleton_unavailable")));
    server.listen({ host: "127.0.0.1", port: 4466, exclusive: true }, () => yes(() => new Promise(done => server.close(done))));
  });
}

export function parseArguments(args) {
  const modes = ["--enroll", "--observe", "--run", "--pause"]; need(modes.includes(args[0]));
  const result = { mode: args[0] };
  for (let index = 1; index < args.length; index += 2) {
    const value = args[index + 1]; need(typeof value === "string");
    switch (args[index]) {
      case "--directory": need(!Object.hasOwn(result, "--directory")); result["--directory"] = value; break;
      case "--public-origin": need(!Object.hasOwn(result, "--public-origin")); result["--public-origin"] = value; break;
      case "--origin": need(!Object.hasOwn(result, "--origin")); result["--origin"] = value; break;
      default: throw Error("publisher_runtime_refused");
    }
  }
  need(typeof result["--directory"] === "string" && win32.isAbsolute(result["--directory"]) && !result["--directory"].startsWith("\\\\"));
  if (result.mode === "--enroll") { validateOrigin(result["--public-origin"]); validateOrigin(result["--origin"]); }
  else need(!Object.hasOwn(result, "--public-origin") && !Object.hasOwn(result, "--origin"));
  return result;
}

export async function main(args) {
  need(process.platform === "win32"); const options = parseArguments(args), store = createPrivateStore(resolve(options["--directory"]));
  if (options.mode === "--pause") {
    if (!await store.paused()) await store.create("pause.flag", { version: 1 });
    return { status: "paused", restartRequested: false };
  }
  const release = await acquireSingleton(); let adapter, shuttingDown = false;
  const stop = () => { shuttingDown = true; adapter?.cancel(); }; process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (options.mode === "--enroll") {
      need(await store.load("binding.json") === null && await store.load("state.json") === null && await store.load("status.json") === null && !await store.paused());
      const bootId = await bootIdentity();
      const client = await connectLocalObs({ ...await readObsConfiguration(), timeoutMs: 2000 });
      try {
        const source = await readSource(async (type, data) => {
          need(!shuttingDown && !await store.paused()); const response = await client.request(type, data);
          need(!shuttingDown && !await store.paused()); return response;
        });
        const salt = randomBytes(32).toString("base64url");
        const binding = validateBinding({ version: 1, salt, sourceHash: sourceHash(salt, source), publicOrigin: validateOrigin(options["--public-origin"]), origin: validateOrigin(options["--origin"]), moduleHashes: await moduleHashes() });
        need(!shuttingDown && !await store.paused());
        await store.create("state.json", createState(bootId, now()));
        need(!shuttingDown && !await store.paused());
        await store.create("binding.json", binding);
        await store.save("status.json", { version: 1, status: "enrolled", restartRequested: false });
        return { status: "enrolled", restartRequested: false };
      } finally { client.close(); }
    }
    const binding = validateBinding(await store.load("binding.json")); need(equal(binding.moduleHashes, await moduleHashes()));
    if (shuttingDown) return { status: "cancelled", restartRequested: false };
    adapter = createPublisherAdapter({ binding, store });
    return await runPublisherLoop({ store, binding, bootId: await bootIdentity(), adapter }, { observeOnly: options.mode === "--observe" });
  } finally { adapter?.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch { console.error(JSON.stringify({ status: "publisher_runtime_held", rawDetailsSuppressed: true })); process.exitCode = 1; }
}
