import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw Error("Hosted CI only.");
// Start-Process -Credential loads the account profile but inherits the runner's
// environment. Do not make the disposable user use the administrator's profile
// directories (including PowerShell's module-analysis cache).
const profile = userInfo().homedir;
process.env.USERPROFILE = profile;
process.env.APPDATA = join(profile, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(profile, "AppData", "Local");
// Provisioning a brand-new Windows profile is CI setup, not worker startup.
// Warm the engine once; actual ACL tests retain the production 15-second bound.
execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { stdio: "inherit", windowsHide: true, timeout: 60000 });
execFileSync(process.execPath, ["scripts/compile-contracts.mjs"], { stdio: "inherit", windowsHide: true });
const files = readdirSync("test").filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`);
// Serialize files on the small hosted Windows VM: cold PowerShell ACL probes
// otherwise compete with crypto/SQLite workers and hit their production timeout.
// Keep that fail-closed timeout and every security assertion unchanged.
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 1;
