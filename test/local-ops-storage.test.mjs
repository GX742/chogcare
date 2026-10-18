import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync, symlinkSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initLocalOpsDirectory } from "../server/local-ops-storage.mjs";

function fixture(t) {
  const testRoot = resolve("work"); mkdirSync(testRoot, { recursive: true });
  const workspace = mkdtempSync(join(testRoot, "ops-acl-test-"));
  t.after(() => {
    const child = relative(testRoot, resolve(workspace));
    assert.ok(child && !child.startsWith("..") && !child.includes("/") && !child.includes("\\") && basename(workspace).startsWith("ops-acl-test-"));
    rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

test("operations ACL helper protects exact support directory through a fixed script without shell interpolation", t => {
  const workspace = fixture(t), calls = [], dependency = { platform: "win32", run: (...args) => calls.push(args) };
  const directory = initLocalOpsDirectory(workspace, "support", dependency);
  writeFileSync(join(directory, "support.sqlite"), "fixture only"); writeFileSync(join(directory, "support.sqlite-wal"), "fixture only");
  assert.equal(initLocalOpsDirectory(workspace, "support", dependency), directory);
  assert.equal(calls.length, 2);
  for (const [executable, args, options] of calls) {
    assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.stdio, "ignore"); assert.ok(options.timeout <= 15000);
    assert.ok(args.includes("-File")); assert.ok(args.includes("-NoProfile")); assert.ok(args.includes("-NonInteractive"));
    assert.deepEqual(args.slice(-4), ["-WorkspacePath", workspace, "-Kind", "support"]);
    assert.ok(!args.includes("-Command")); assert.ok(!args.includes("/T"));
  }
});

test("operations ACL helper chmods only target and known files on POSIX, never payments or work", t => {
  const workspace = fixture(t), calls = [], dependencies = { platform: "linux", chmod: (...args) => calls.push(args) };
  const directory = initLocalOpsDirectory(workspace, "admin", dependencies);
  writeFileSync(join(directory, "settings.json"), "{}");
  calls.length = 0; initLocalOpsDirectory(workspace, "admin", dependencies);
  assert.deepEqual(calls, [[directory, 0o700], [join(directory, "settings.json"), 0o600]]);
  assert.throws(() => initLocalOpsDirectory(workspace, "payments", dependencies));
});

test("operations ACL setup rejects unexpected files and hard links before any native permission call", t => {
  const workspace = fixture(t), calls = [], dependencies = { platform: "win32", run: (...args) => calls.push(args) };
  const directory = initLocalOpsDirectory(workspace, "support", dependencies);
  calls.length = 0; writeFileSync(join(directory, "unexpected.txt"), "do not modify");
  assert.throws(() => initLocalOpsDirectory(workspace, "support", dependencies), /Unexpected/); assert.equal(calls.length, 0);
  rmSync(join(directory, "unexpected.txt"));
  const outside = join(workspace, "outside.txt"); writeFileSync(outside, "do not modify"); linkSync(outside, join(directory, "support.sqlite"));
  assert.throws(() => initLocalOpsDirectory(workspace, "support", dependencies), /Unexpected/); assert.equal(calls.length, 0);
  assert.equal(readFileSync(outside, "utf8"), "do not modify");
});

test("operations ACL setup rejects an escaping junction without changing its target", t => {
  const workspace = fixture(t), outside = join(workspace, "outside"), work = join(workspace, "work"), calls = [];
  mkdirSync(outside); mkdirSync(work);
  try { symlinkSync(outside, join(work, "support"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("This account cannot create a junction/symlink."); return; } throw error; }
  assert.throws(() => initLocalOpsDirectory(workspace, "support", { platform: "win32", run: (...args) => calls.push(args) }), /linked/);
  assert.equal(calls.length, 0);
});

test("operations ACL failure is fail closed with a generic error and no secret command output", t => {
  const workspace = fixture(t);
  assert.throws(() => initLocalOpsDirectory(workspace, "support", { platform: "win32", run: () => { throw new Error("SECRET_NATIVE_STDERR"); } }), error => /could not be protected/.test(error.message) && !error.message.includes("SECRET"));
});

test("operations storage rejects UNC and forward-slash network scopes before filesystem access", () => {
  for (const workspace of ["\\\\untrusted.example\\share", "//untrusted.example/share"]) assert.throws(() => initLocalOpsDirectory(workspace, "support"), /Invalid local operations storage scope/);
});

test("fixed ACL script persists Access only, verifies exact private DACLs and never widens permissions", () => {
  const source = readFileSync(new URL("../scripts/protect-local-ops-storage.ps1", import.meta.url), "utf8");
  assert.ok(source.includes("SetAccessRuleProtection($true, $false)"));
  assert.ok(source.includes("DirectorySecurity]::new()")); assert.ok(source.includes("FileSecurity]::new()"));
  assert.ok(source.includes("S-1-5-18")); assert.ok(source.includes("S-1-5-32-544"));
  assert.ok(source.includes("AccessControlSections]::Access"));
  assert.ok(source.includes("$Item.GetAccessControl($accessSection)"));
  assert.ok(source.includes("SetSecurityDescriptorSddlForm($desired.GetSecurityDescriptorSddlForm($accessSection), $accessSection)"));
  assert.ok(source.includes("$Item.SetAccessControl($current)"));
  assert.ok(source.includes("if (Test-PrivateDacl $current $isDirectory) { return }"));
  assert.ok(source.includes("Private operations permissions could not be verified."));
  assert.ok(!/^\s*Set-Acl\b/m.test(source));
  assert.ok(!source.includes("AccessControlSections]::All"));
  assert.ok(!/\.(?:GetOwner|SetOwner|GetGroup|SetGroup|GetAuditRules|SetAuditRule)\(/.test(source));
  assert.ok(!/\b(?:Remove-Item|Invoke-Expression|Start-Process|icacls|Get-Content)\b/.test(source));
  assert.ok(!source.includes("-Recurse"));
  assert.doesNotMatch(source, /^\s*(?:Import-Module|Get-Item|Get-ChildItem|Join-Path|Write-Output)\b/m, "Private ACL setup must not wait on first-run PowerShell module discovery");
});

test("native private DACL setup repeats under a normal Windows user without changing file contents", { skip: process.platform !== "win32" }, t => {
  const workspace = fixture(t), executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  const options = { windowsHide: true, shell: false, timeout: 15000, encoding: "utf8", maxBuffer: 8192 };
  const elevated = execFileSync(executable, [...base, "-Command", "([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], options).trim();
  assert.equal(elevated, "False", "The privilege regression must execute without elevation.");
  const script = fileURLToPath(new URL("../scripts/protect-local-ops-storage.ps1", import.meta.url));
  for (const kind of ["admin", "support"]) {
    const directory = join(workspace, "work", kind); mkdirSync(directory, { recursive: true });
    const filename = join(directory, kind === "admin" ? "settings.json" : "support.sqlite");
    writeFileSync(filename, "isolated fixture, never a real inbox");
    for (let attempt = 0; attempt < 3; attempt++) assert.match(execFileSync(executable, [...base, "-File", script, "-WorkspacePath", workspace, "-Kind", kind], options), /storage is restricted/);
    assert.equal(readFileSync(filename, "utf8"), "isolated fixture, never a real inbox");
  }
});
