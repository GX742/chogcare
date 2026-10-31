import { lstat, readdir, readFile, statfs } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const CODE = "/opt/chogcare-payments";
const STATE = "/var/lib/chogcare";
const UNIT = "/etc/systemd/system/chogcare-payments.service";
const PORTS = [4174, 4175];
const STATE_DIRECTORIES = [STATE, `${STATE}/work`, `${STATE}/work/payments`, `${STATE}/work/payments/custody`, `${STATE}/work/payments/integrity`, `${STATE}/work/payments/backups`, `${STATE}/work/support`];
const positiveBytes = value => Number.isSafeInteger(value) && value >= 0;
const validMetadata = entry => entry && ["file", "directory"].includes(entry.kind) && entry.symlink === false && Number.isSafeInteger(entry.uid) && entry.uid >= 0 && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o177777;

export function supportedNode(version) {
  const match = typeof version === "string" && /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) === 24 && Number(match[2]) >= 22;
}

// Host prerequisites only. These facts cannot authorize a custody move, prove
// the old signer is fenced, or establish financial/payment readiness.
export function assessReadiness(facts = {}) {
  const resource = facts?.resources ?? {}, uid = facts?.serviceUid;
  const code = facts?.code, state = facts?.state;
  const checks = {
    linuxX64: facts?.platform === "linux" && facts?.arch === "x64",
    supportedNode: supportedNode(facts?.nodeVersion),
    systemdPresent: facts?.systemd?.present === true,
    credentialToolPresent: facts?.systemd?.credentialsPresent === true,
    serviceUnitValid: facts?.systemd?.unitValid === true,
    codeProtected: code?.complete === true && Array.isArray(code.entries) && code.entries.length > 0 && code.entries.every(entry => validMetadata(entry) && entry.uid === 0 && (entry.mode & 0o022) === 0),
    statePrivate: Number.isSafeInteger(uid) && uid > 0 && state?.complete === true && Array.isArray(state.entries) && state.entries.length === STATE_DIRECTORIES.length && state.entries.every((entry, index) => validMetadata(entry) && entry.kind === "directory" && entry.uid === uid && ((entry.mode & 0o777) === 0o700 || index < 3 && (entry.mode & 0o777) === 0o710)),
    paymentPortsFree: PORTS.every(port => facts?.ports?.[port] === true),
    memoryAvailable: positiveBytes(resource.memoryTotal) && resource.memoryTotal > 0 && positiveBytes(resource.memoryAvailable) && resource.memoryAvailable <= resource.memoryTotal && resource.memoryAvailable >= 512 * MIB,
    swapProvisioned: positiveBytes(resource.memoryTotal) && resource.memoryTotal > 0 && positiveBytes(resource.swapTotal) && (resource.memoryTotal > GIB || resource.swapTotal >= GIB),
    diskHeadroom: positiveBytes(resource.diskAvailable) && resource.diskAvailable >= 512 * MIB,
  };
  const warnings = [];
  if (positiveBytes(resource.diskAvailable) && resource.diskAvailable < 2 * GIB) warnings.push("disk-below-2-gib");
  if (positiveBytes(resource.memoryTotal) && resource.memoryTotal <= GIB) warnings.push("low-memory-host-use-remux-only");
  return {
    version: 1,
    scope: "host-prerequisites-only",
    hostChecksPassed: Object.values(checks).every(Boolean),
    paymentReadiness: "not-assessed",
    checks,
    warnings,
    humanGates: { sourceHostFenced: "required-separately", custodyTransferApproved: "required-separately" },
  };
}

export function parseMemoryInfo(text) {
  if (typeof text !== "string" || text.length > 65536) return null;
  const result = {};
  for (const [field, name] of [["MemTotal", "memoryTotal"], ["MemAvailable", "memoryAvailable"], ["SwapTotal", "swapTotal"]]) {
    const matches = [...text.matchAll(new RegExp(`^${field}:\\s+(\\d+) kB\\s*$`, "gm"))];
    if (matches.length !== 1) return null;
    const bytes = Number(matches[0][1]) * 1024;
    if (!positiveBytes(bytes)) return null;
    result[name] = bytes;
  }
  return result;
}

export function parseTcpPorts(text) {
  if (typeof text !== "string" || text.length > 4 * MIB) return null;
  const lines = text.trim().split(/\r?\n/);
  if (!/\blocal_address\b/.test(lines.shift() ?? "")) return null;
  const free = Object.fromEntries(PORTS.map(port => [port, true]));
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const local = /^(?:[a-f0-9]{8}|[a-f0-9]{32}):([a-f0-9]{4})$/i.exec(fields[1] ?? "");
    if (!/^\d+:$/.test(fields[0] ?? "") || !local || !/^[a-f0-9]{2}$/i.test(fields[3] ?? "")) return null;
    const port = parseInt(local[1], 16);
    // TIME_WAIT does not own a listening socket. All other observed uses of a
    // payment port block this conservative pre-start check, on any interface.
    if (PORTS.includes(port) && fields[3].toUpperCase() !== "06") free[port] = false;
  }
  return free;
}

function commandSucceeds(binary, args) {
  try {
    execFileSync(binary, args, { timeout: 5000, maxBuffer: 8192, stdio: "ignore", shell: false });
    return true;
  } catch { return false; }
}
function metadata(stat) {
  return { kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", symlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode };
}
async function codeMetadata() {
  const entries = [], pending = [CODE];
  try {
    while (pending.length) {
      if (entries.length >= 100000) return { complete: false, entries: [] };
      const path = pending.pop(), stat = await lstat(path);
      entries.push(metadata(stat));
      if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of await readdir(path)) pending.push(join(path, name));
    }
    return { complete: true, entries };
  } catch { return { complete: false, entries: [] }; }
}

// Optional, read-only Linux collector. Only public code metadata, fixed state
// directory metadata and fixed /proc files are read. No state file, vault,
// credential, database, invoice or support contents are opened or enumerated.
export async function collectHostFacts() {
  const facts = { platform: process.platform, arch: process.arch };
  if (process.platform !== "linux") return facts;
  try {
    // Check the exact ExecStart interpreter, which may differ from this CLI's.
    const version = execFileSync("/opt/chogcare-node-v24.22.0/bin/node", ["--version"], { timeout: 5000, maxBuffer: 64, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false }).trim();
    if (/^v\d+\.\d+\.\d+$/.test(version)) facts.nodeVersion = version;
  } catch { /* A missing or unsupported service interpreter blocks the check. */ }
  try {
    const uidText = execFileSync("/usr/bin/id", ["-u", "chogcare"], { timeout: 5000, maxBuffer: 64, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false });
    if (/^\d+\n?$/.test(uidText) && Number.isSafeInteger(Number(uidText))) facts.serviceUid = Number(uidText);
  } catch { /* Missing account is a failed prerequisite. */ }
  facts.systemd = {
    present: commandSucceeds("/usr/bin/systemctl", ["--version"]),
    credentialsPresent: commandSucceeds("/usr/bin/systemd-creds", ["--version"]),
    unitValid: commandSucceeds("/usr/bin/systemd-analyze", ["verify", UNIT]),
  };
  try { facts.systemd.present &&= (await lstat("/run/systemd/system")).isDirectory(); } catch { facts.systemd.present = false; }
  facts.code = await codeMetadata();
  try { facts.state = { complete: true, entries: await Promise.all(STATE_DIRECTORIES.map(async path => metadata(await lstat(path)))) }; }
  catch { facts.state = { complete: false, entries: [] }; }
  try {
    const memory = parseMemoryInfo(await readFile("/proc/meminfo", "utf8"));
    const disk = await statfs(STATE);
    facts.resources = { ...memory, diskAvailable: disk.bavail * disk.bsize };
  } catch { facts.resources = {}; }
  try {
    const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map(async path => parseTcpPorts(await readFile(path, "utf8"))));
    if (tables.every(Boolean)) facts.ports = Object.fromEntries(PORTS.map(port => [port, tables.every(table => table[port] === true)]));
  } catch { /* Missing/unreadable tables never establish free ports. */ }
  return facts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(" ") !== "--check") {
    console.error("Use --check for read-only host prerequisites; custody and payment readiness are not assessed.");
    process.exitCode = 1;
  } else {
    try {
      const result = assessReadiness(await collectHostFacts());
      console.log(JSON.stringify(result, null, 2));
      if (!result.hostChecksPassed) process.exitCode = 1;
    } catch {
      console.error("Host prerequisite collection failed. No payment state or credentials were accessed.");
      process.exitCode = 1;
    }
  }
}
