import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { hostRetirementPath, assertPaymentHostActive, readHostRetirement, writeHostRetirement } from "../server/payment-host-retirement.mjs";
import { retirePaymentHost } from "../ops/payments/retire-host.mjs";

const evidence = { retiredAt: "2026-10-31T12:00:00.000Z", backupCreatedAt: "2026-10-31T11:59:00.000Z", releaseSha: "a".repeat(40), backupSha256: "b".repeat(64) };
function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), "chog-retirement-test-"));
  mkdirSync(join(workspace, "work/payments/integrity"), { recursive: true, mode: 0o700 });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test("persistent retirement blocks later custody starts without changing financial files", t => {
  const workspace = fixture(t), state = join(workspace, "work/payments/processor.sqlite");
  writeFileSync(state, "synthetic financial bytes");
  assertPaymentHostActive(workspace);
  writeHostRetirement(workspace, evidence);
  assert.deepEqual(readHostRetirement(workspace), { version: 1, kind: "chogcare-payment-host-retired", ...evidence });
  assert.throws(() => assertPaymentHostActive(workspace), { code: "HOST_RETIRED" });
  assert.throws(() => writeHostRetirement(workspace, evidence), { code: "HOST_RETIRED" });
  assert.equal(readFileSync(state, "utf8"), "synthetic financial bytes");
});

test("malformed, oversized or symlink retirement metadata always holds custody", t => {
  const workspace = fixture(t), marker = hostRetirementPath(workspace);
  for (const contents of ["{", "{}", JSON.stringify({ version: 1, ...evidence }), "x".repeat(2049)]) {
    writeFileSync(marker, contents, { mode: 0o600 });
    assert.throws(() => assertPaymentHostActive(workspace), { code: "HOST_RETIRED" });
  }
  rmSync(marker);
  const outside = join(workspace, "outside"); writeFileSync(outside, "{}");
  try { symlinkSync(outside, marker); } catch (error) { if (process.platform === "win32" && error.code === "EPERM") return; throw error; }
  assert.throws(() => assertPaymentHostActive(workspace), { code: "HOST_RETIRED" });
});

test("a linked retirement directory cannot bypass the persistent fence", t => {
  const workspace = fixture(t), target = join(workspace, "elsewhere"); mkdirSync(target);
  rmSync(join(workspace, "work/payments/integrity"), { recursive: true });
  symlinkSync(target, join(workspace, "work/payments/integrity"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertPaymentHostActive(workspace), { code: "HOST_RETIRED" });
});

test("POSIX retirement metadata refuses group-readable markers", { skip: process.platform === "win32" }, t => {
  const workspace = fixture(t); writeHostRetirement(workspace, evidence); chmodSync(hostRetirementPath(workspace), 0o640);
  assert.throws(() => readHostRetirement(workspace), { code: "HOST_RETIRED" });
});

function retirementDependencies(overrides = {}) {
  const calls = [];
  const probe = new EventEmitter(); probe.listen = (_port, _host, ok) => { calls.push("probe"); queueMicrotask(ok); }; probe.close = ok => ok();
  return { calls, dependencies: {
    acquireOperatorLease: async () => { calls.push("lease"); return { close: async () => calls.push("release") }; },
    assertPaymentHostActive: () => calls.push("active"), createServer: () => probe,
    openPaymentIntegrity: () => calls.push("integrity"),
    readFile: async name => name.endsWith("vault.json") ? "{}" : Buffer.from("fixture encrypted bundle"),
    unlockCustodyVault: async () => calls.push("password-checked"),
    createBackupProtection: () => ({ close: () => calls.push("key-cleared") }),
    createPaymentBackup: () => { calls.push("fresh-backup"); return { output: "synthetic-only", createdAt: evidence.backupCreatedAt }; },
    verifyRecoveryBundle: () => { calls.push("verified"); return { verified: true, signingStarted: false, files: 4, createdAt: evidence.backupCreatedAt }; },
    writeHostRetirement: (_workspace, proof) => { calls.push("fenced"); assert.match(proof.backupSha256, /^[a-f0-9]{64}$/); },
    ...overrides,
  } };
}

test("offline retirement verifies a fresh coherent snapshot before persisting the fence", async () => {
  const f = retirementDependencies();
  const result = await retirePaymentHost({ releaseSha: evidence.releaseSha, passwordProvider: async () => { f.calls.push("password"); return "fixture-password-only"; } }, f.dependencies);
  assert.deepEqual(result, { hostRetired: true, recoveryVerified: true, signingStarted: false, liveFilesMoved: false });
  assert.deepEqual(f.calls, ["lease", "active", "probe", "integrity", "password", "password-checked", "fresh-backup", "verified", "fenced", "key-cleared", "release"]);
});

test("retirement never asks for custody on a busy host, and never fences invalid recovery", async () => {
  const busy = retirementDependencies({ acquireOperatorLease: async () => { throw Object.assign(Error("busy"), { code: "EADDRINUSE" }); } });
  await assert.rejects(retirePaymentHost({ releaseSha: evidence.releaseSha, passwordProvider: async () => assert.fail("password requested") }, busy.dependencies), { code: "EADDRINUSE" });
  const broken = retirementDependencies({ verifyRecoveryBundle: () => ({ verified: false }) });
  await assert.rejects(retirePaymentHost({ releaseSha: evidence.releaseSha, passwordProvider: async () => "fixture-password-only" }, broken.dependencies));
  assert.equal(broken.calls.includes("fenced"), false); assert.equal(broken.calls.at(-1), "release");
  const badState = retirementDependencies({ openPaymentIntegrity: () => { throw Error("inconsistent fixture"); } });
  await assert.rejects(retirePaymentHost({ releaseSha: evidence.releaseSha, passwordProvider: async () => assert.fail("password requested") }, badState.dependencies));
  assert.equal(badState.calls.includes("fresh-backup"), false);
});

test("cloud custody stop requires graceful drain instead of a timed forced kill", () => {
  const unit = readFileSync(new URL("../ops/payments/chogcare-payments.service", import.meta.url), "utf8");
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^SendSIGKILL=no$/m);
  assert.match(unit, /^ExecStart=\/opt\/chogcare-node-v24\.22\.0\/bin\/node /m);
});
