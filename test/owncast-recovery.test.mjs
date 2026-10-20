import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = readFileSync(new URL("../scripts/owncast-admin-recovery.py", import.meta.url), "utf8");
const controller = readFileSync(new URL("../scripts/reset-broadcast-admin.ps1", import.meta.url), "utf8");

test("Owncast recovery is limited to the verified local install and official password flag", () => {
  assert.ok(helper.includes("Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)"));
  assert.match(helper, /UNIT = "owncast\.service"/);
  assert.match(helper, /"--database", str\(DATABASE\)/);
  assert.match(helper, /"--adminpassword", password/);
  assert.doesNotMatch(helper, /"--streamkey"|shell=True|["']pkill|UPDATE\s+datastore|DELETE\s+FROM|INSERT\s+INTO/i);
  assert.match(helper, /if path\.resolve\(strict=True\) != path/);
  assert.match(helper, /starts != \["ExecStart=\/opt\/owncast\/owncast -webserverip 127\.0\.0\.1 -webserverport 8082"\]/);
});

test("Recovery password uses hidden prompts and stdin, not history, files or Windows argv", () => {
  assert.match(controller, /Read-Host 'New Owncast ADMIN password' -AsSecureString/);
  assert.match(controller, /Read-Host 'Repeat new password' -AsSecureString/);
  assert.match(controller, /StandardInput\.Write\(\$PasswordChars\)/);
  assert.match(controller, /ZeroFreeBSTR\(\$passwordPointer\)/);
  assert.match(controller, /\[Array\]::Clear\(\$recoveryChars/);
  assert.doesNotMatch(controller, /GetNetworkCredential|PtrToString|Set-Content|WriteAllText|Start-Transcript|Write-Host\s+\$recovery|Write-Output\s+\$recovery/);
  assert.doesNotMatch(controller, /\$arguments\s*\+?=.*\$(?:PasswordChars|recoveryChars|recoveryPassword)/);
});

test("Recovery keeps backups private and verifies login without admin response body or redirect", () => {
  assert.match(helper, /BACKUPS = Path\("\/var\/backups\/chogcare-owncast"\)/);
  assert.match(helper, /BACKUPS\.mkdir\(mode=0o700\)/);
  assert.match(helper, /os\.O_EXCL \| os\.O_NOFOLLOW, 0o600/);
  assert.match(helper, /DATABASE\.as_uri\(\) \+ "\?mode=ro"/);
  assert.match(helper, /source\.backup\(target/);
  assert.match(helper, /ProxyHandler\(\{\}\), NoRedirect\(\)/);
  assert.match(helper, /local_status\("\/api\/admin\/serverconfig"\)\[0\] != 401/);
  assert.match(helper, /local_status\("\/api\/admin\/serverconfig", password\)\[0\]/);
  assert.match(helper, /finally:[\s\S]*terminate_recovery\(child\)[\s\S]*systemctl\("start"\)/);
  assert.match(helper, /signal\.SIGINT, signal\.SIGTERM, signal\.SIGHUP/);
});

test("Recovery failures expose only fixed phase codes, never raw external error text", () => {
  assert.match(helper, /print\("RECOVERY_ERROR:" \+ phase, file=sys\.stderr, flush=True\)/);
  assert.doesNotMatch(helper, /print\(str\(error\)/);
  assert.match(helper, /problem_phase = error\.phase if isinstance\(error, RecoveryError\) else _failure_phase/);
  assert.match(controller, /\$safeCode = \$helperError\.Trim\(\)/);
  assert.match(controller, /\$safeErrors\.ContainsKey\(\$safeCode\)/);
  assert.doesNotMatch(controller, /(?:throw|Write-Host|Write-Output|Write-Warning)\s+\$helperError/);
  for (const phase of ["INPUT", "PREFLIGHT", "BACKUP", "STOP", "SPAWN", "SAVE", "CLEANUP", "RESTART", "VERIFY", "INTERNAL"]) {
    assert.ok(controller.includes(`'RECOVERY_ERROR:${phase}' = `));
  }
});

test("PowerShell recovery controller parses without executing prompts or service commands", { skip: process.platform !== "win32" }, () => {
  const scriptPath = fileURLToPath(new URL("../scripts/reset-broadcast-admin.ps1", import.meta.url));
  const escapedPath = scriptPath.replaceAll("'", "''");
  const command = `$errors=$null; $tokens=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}',[ref]$tokens,[ref]$errors); if ($errors.Count) { throw 'parse failed' }; Write-Output 'Parse passed; no recovery execution.'`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 15_000 });
  assert.match(output, /Parse passed; no recovery execution/);
});
