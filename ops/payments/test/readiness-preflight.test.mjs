import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assessReadiness, parseMemoryInfo, parseTcpPorts, supportedNode } from "../readiness-preflight.mjs";

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const directory = uid => ({ kind: "directory", uid, mode: 0o40700, symlink: false });
const fixture = () => ({
  platform: "linux", arch: "x64", nodeVersion: "24.22.0", serviceUid: 998,
  systemd: { present: true, credentialsPresent: true, unitValid: true },
  code: { complete: true, entries: [{ kind: "directory", uid: 0, mode: 0o40755, symlink: false }, { kind: "file", uid: 0, mode: 0o100644, symlink: false }] },
  state: { complete: true, entries: Array.from({ length: 7 }, () => directory(998)) },
  ports: { 4174: true, 4175: true },
  resources: { memoryTotal: GIB, memoryAvailable: 661 * MIB, swapTotal: GIB, diskAvailable: Math.floor(6.8 * GIB) },
});

test("measured one GiB host passes only host checks with swap and separate human gates", () => {
  const result = assessReadiness(fixture());
  assert.equal(result.hostChecksPassed, true);
  assert.equal(result.paymentReadiness, "not-assessed");
  assert.deepEqual(result.humanGates, { sourceHostFenced: "required-separately", custodyTransferApproved: "required-separately" });
  assert.deepEqual(result.warnings, ["low-memory-host-use-remux-only"]);
  assert.equal("resources" in result, false);
});

test("missing and invalid facts fail closed without reporting raw input", () => {
  for (const input of [undefined, null, {}, { privateData: "must-not-appear" }, { resources: { memoryTotal: Infinity, memoryAvailable: NaN, swapTotal: -1, diskAvailable: "999999999" } }]) {
    const result = assessReadiness(input);
    assert.equal(result.hostChecksPassed, false);
    assert.doesNotMatch(JSON.stringify(result), /must-not-appear|privateData|Infinity|NaN/);
  }
  for (const key of ["code", "state", "systemd", "ports", "resources"]) {
    const f = fixture(); delete f[key]; assert.equal(assessReadiness(f).hostChecksPassed, false);
  }
});

test("only stable Node 24.22 or later in major 24 on Linux x64 is supported", () => {
  for (const version of ["24.22.0", "v24.23.1", "24.99.0"]) assert.equal(supportedNode(version), true);
  for (const version of ["24.21.9", "22.22.0", "25.0.0", "24.22.0-rc.1", "24.22", undefined]) assert.equal(supportedNode(version), false);
  for (const change of [{ platform: "win32" }, { arch: "arm64" }, { nodeVersion: "24.21.0" }]) assert.equal(assessReadiness({ ...fixture(), ...change }).hostChecksPassed, false);
});

test("low memory host requires one GiB swap and at least 512 MiB available", () => {
  for (const change of [{ swapTotal: 0 }, { swapTotal: GIB - 1 }, { memoryAvailable: 512 * MIB - 1 }, { memoryAvailable: GIB + 1 }, { memoryTotal: 0 }, { diskAvailable: 512 * MIB - 1 }]) {
    const f = fixture(); Object.assign(f.resources, change); assert.equal(assessReadiness(f).hostChecksPassed, false);
  }
  const boundary = fixture(); Object.assign(boundary.resources, { memoryAvailable: 512 * MIB, diskAvailable: 512 * MIB });
  assert.equal(assessReadiness(boundary).hostChecksPassed, true);
  assert.ok(assessReadiness(boundary).warnings.includes("disk-below-2-gib"));
  const larger = fixture(); Object.assign(larger.resources, { memoryTotal: 2 * GIB, swapTotal: 0 });
  assert.equal(assessReadiness(larger).hostChecksPassed, true);
});

test("code must be completely inspected, root owned, unlinked and not writable by other users", () => {
  for (const change of [{ uid: 998 }, { mode: 0o100664 }, { mode: 0o100646 }, { symlink: true }, { kind: "other" }, { mode: -1 }]) {
    const f = fixture(); Object.assign(f.code.entries[1], change); assert.equal(assessReadiness(f).checks.codeProtected, false);
  }
  for (const code of [{ complete: false, entries: fixture().code.entries }, { complete: true, entries: [] }, { complete: true, entries: [null] }]) assert.equal(assessReadiness({ ...fixture(), code }).checks.codeProtected, false);
});

test("every fixed state directory must be private and owned by the dedicated nonroot user", () => {
  for (const change of [{ uid: 0 }, { uid: 999 }, { mode: 0o40750 }, { mode: 0o40777 }, { symlink: true }, { kind: "file" }]) {
    const f = fixture(); Object.assign(f.state.entries[0], change); assert.equal(assessReadiness(f).checks.statePrivate, false);
  }
  const incomplete = fixture(); incomplete.state.entries.pop(); assert.equal(assessReadiness(incomplete).checks.statePrivate, false);
  const root = fixture(); root.serviceUid = 0; assert.equal(assessReadiness(root).checks.statePrivate, false);
  const reader = fixture(); for (const entry of reader.state.entries.slice(0, 3)) entry.mode = 0o40710;
  assert.equal(assessReadiness(reader).checks.statePrivate, true, "named station ACL permits traversal only on ancestors");
  reader.state.entries[3].mode = 0o40710; assert.equal(assessReadiness(reader).checks.statePrivate, false, "custody remains private");
});

test("busy or unknown ports and unavailable systemd capabilities block host approval", () => {
  for (const port of [4174, 4175]) {
    for (const value of [false, undefined, "true"]) {
      const f = fixture(); f.ports[port] = value; assert.equal(assessReadiness(f).checks.paymentPortsFree, false);
    }
  }
  for (const key of ["present", "credentialsPresent", "unitValid"]) {
    const f = fixture(); f.systemd[key] = false; assert.equal(assessReadiness(f).hostChecksPassed, false);
  }
});

test("fixed proc parsers reject malformed or incomplete facts and detect IPv4 and IPv6 port use", () => {
  assert.deepEqual(parseMemoryInfo("MemTotal: 1048576 kB\nMemAvailable: 676864 kB\nSwapTotal: 1048576 kB\n"), { memoryTotal: GIB, memoryAvailable: 661 * MIB, swapTotal: GIB });
  for (const value of ["", "MemTotal: 1 kB\n", "MemTotal: 1 kB\nMemTotal: 2 kB\nMemAvailable: 1 kB\nSwapTotal: 0 kB\n", "MemTotal: -1 kB\nMemAvailable: 1 kB\nSwapTotal: 0 kB\n"]) assert.equal(parseMemoryInfo(value), null);
  const header = "sl local_address rem_address st\n";
  assert.deepEqual(parseTcpPorts(header), { 4174: true, 4175: true });
  assert.deepEqual(parseTcpPorts(header + "0: 0100007F:104E 00000000:0000 0A\n"), { 4174: false, 4175: true });
  assert.deepEqual(parseTcpPorts(header + "0: 00000000000000000000000000000000:104F 00000000000000000000000000000000:0000 0A\n"), { 4174: true, 4175: false });
  assert.deepEqual(parseTcpPorts(header + "0: 0100007F:104E 00000000:0000 06\n"), { 4174: true, 4175: true });
  for (const value of ["", "wrong header", header + "malformed row", header + "0: BAD:104E 00000000:0000 0A\n"]) assert.equal(parseTcpPorts(value), null);
});

test("real mkswap header leaves the old allocation below the strict gate and padded allocation above it", { skip: process.platform === "win32" && process.env.CHOGCARE_STATION_WSL_TEST !== "1", timeout: 10000 }, () => {
  const provisioner = readFileSync(new URL("../provision-stage.sh", import.meta.url), "utf8");
  const allocation = Number(provisioner.match(/fallocate -l (\d+) \/swapfile\.chogcare/)?.[1]);
  assert.equal(allocation, GIB + MIB, "keep the extra allocation bounded to one MiB");
  const script = String.raw`
import json,os,pathlib,shutil,struct,subprocess,sys,tempfile
allocation=json.load(sys.stdin)["allocation"]
page=os.sysconf("SC_PAGE_SIZE")
binary=shutil.which("mkswap")
if not binary:raise RuntimeError("ISOLATED_MKSWAP_MISSING")
def capacity(path,size):
    # Sparse disposable files exercise only mkswap metadata, not swap activation;
    # they allocate no GiB of RAM/disk and are never passed to swapon.
    with path.open("xb") as file:file.truncate(size)
    path.chmod(0o600)
    result=subprocess.run([binary,str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
    if result.returncode!=0:raise RuntimeError("ISOLATED_MKSWAP_FAILED")
    with path.open("rb") as file:header=file.read(page)
    if header[-10:]!=b"SWAPSPACE2":raise RuntimeError("ISOLATED_SWAP_SIGNATURE_INVALID")
    version,last_page,bad_pages=struct.unpack_from("=III",header,1024)
    if version!=1 or bad_pages!=0:raise RuntimeError("ISOLATED_SWAP_HEADER_INVALID")
    return (last_page-bad_pages)*page
with tempfile.TemporaryDirectory(prefix="chogcare-swap-header-test-") as directory:
    parent=pathlib.Path(directory)
    old=capacity(parent/"old.swap",1073741824)
    new=capacity(parent/"padded.swap",allocation)
print(json.dumps({"pageBytes":page,"oldUsableBytes":old,"newUsableBytes":new}))
`;
  const windows = process.platform === "win32", binary = windows ? "C:\\Windows\\System32\\wsl.exe" : "/usr/bin/python3";
  const args = windows ? ["--exec", "/usr/bin/python3", "-c", script] : ["-c", script];
  const result = spawnSync(binary, args, { input: JSON.stringify({ allocation }), encoding: "utf8", timeout: 8000, maxBuffer: 1024, windowsHide: true });
  assert.equal(result.status, 0, "Disposable mkswap header fixture failed; no swap was activated or live file touched.");
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.oldUsableBytes, GIB - measured.pageBytes);
  assert.ok(measured.newUsableBytes >= GIB);
  const old = fixture(); old.resources.swapTotal = measured.oldUsableBytes;
  assert.equal(assessReadiness(old).checks.swapProvisioned, false);
  const padded = fixture(); padded.resources.swapTotal = measured.newUsableBytes;
  assert.equal(assessReadiness(padded).checks.swapProvisioned, true);
});
