import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw Error("Hosted CI only.");
execFileSync(process.execPath, ["scripts/compile-contracts.mjs"], { stdio: "inherit", windowsHide: true });
const files = readdirSync("test").filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`);
// Serialize files on the small hosted Windows VM: cold PowerShell ACL probes
// otherwise compete with crypto/SQLite workers and hit their production timeout.
// Keep that fail-closed timeout and every security assertion unchanged.
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 1;
