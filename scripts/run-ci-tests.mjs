import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw Error("Hosted CI only.");
execFileSync(process.execPath, ["scripts/compile-contracts.mjs"], { stdio: "inherit", windowsHide: true });
const files = readdirSync("test").filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`);
// Bounded concurrency prevents cold PowerShell ACL probes from being starved by
// dozens of simultaneous crypto/SQLite workers on the small hosted VM.
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=4", ...files], { stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 1;
