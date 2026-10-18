import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readRegularFileSync } from "../server/regular-file.mjs";

// Conservative source/release guard, not an exhaustive credential detector.
// Prints only locations and categories, never candidate credential values.
const staged = process.argv.includes("--staged");
const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
const files = [...new Set(execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean))];
const rules = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["GitHub access token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{70,255})\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["literal wallet private key", /\b(?:privateKey|private_key|PRIVATE_KEY)\s*[=:]\s*["'](?:0x)?[a-fA-F0-9]{64}["']/g],
  ["encrypted custody archive", /"encryptedKeystore"\s*:\s*"\{\\"/g],
];
const findings = [];
let checked = 0;
for (const file of files) {
  if (/(^|\/)(work|node_modules|\.vercel|\.git)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-wal|-shm)?|chogbackup|pfx|p12|pem|key)$/i.test(file) && !/(^|\/)\.env\.example$/.test(file)) {
    findings.push(`${file}: forbidden private/runtime artifact`); continue;
  }
  let bytes;
  if (staged) {
    const entry = execFileSync("git", ["ls-files", "--stage", "--", file], { encoding: "utf8" });
    if (!/^100(?:644|755) [a-f0-9]{40,64} 0\t/.test(entry)) { findings.push(`${file}: non-regular staged source file`); continue; }
    bytes = execFileSync("git", ["show", `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  else {
    try { bytes = readRegularFileSync(resolve(file), 32 * 1024 * 1024); }
    catch (error) { if (error.code === "ENOENT") continue; findings.push(`${file}: unsafe, changed or oversized source file`); continue; }
  }
  if (/\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf)$/i.test(file)) continue;
  if (bytes.includes(0)) { findings.push(`${file}: unexpected binary artifact needs review`); continue; }
  const text = bytes.toString("utf8"); checked++;
  for (const [category, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) findings.push(`${file}:${text.slice(0, match.index).split("\n").length}: ${category}`);
  }
}
for (const finding of findings) console.error(finding);
console.log(JSON.stringify({ checkedTextFiles: checked, findings: findings.length, scope: staged ? "staged content" : "tracked and non-ignored source files", exhaustiveSecretScan: false }));
if (findings.length) process.exitCode = 1;
