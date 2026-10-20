import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Owncast tuning uses the verified build, hidden password and fixed local admin API", () => {
  const source = readFileSync(new URL("../scripts/configure-broadcast.ps1", import.meta.url), "utf8");
  assert.ok(source.includes("Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)"));
  assert.match(source, /Read-Host 'Owncast admin password' -AsSecureString/);
  assert.match(source, /AllowAutoRedirect = \$false/);
  assert.match(source, /UseProxy = \$false/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8082/);
  assert.doesNotMatch(source, /\/api\/admin\/config\/(?:admin|streamkey|serverurl)|Set-Content|Restart-Service|Stop-Process/);
});

test("Owncast backup projection preserves one variant and excludes secrets", { skip: process.platform !== "win32" }, () => {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./broadcast-config.test.ps1", import.meta.url))], { encoding: "utf8", timeout: 15_000 });
  assert.match(output, /isolated checks passed; no live requests or writes/);
});
