import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";

function fixture(t) {
  const parent = resolve("work"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "source-guard-test-"));
  t.after(() => { assert.equal(dirname(resolve(directory)), parent); assert.ok(basename(directory).startsWith("source-guard-test-")); rmSync(directory, { recursive: true, force: true }); });
  for (const folder of ["scripts", "server"]) mkdirSync(join(directory, folder));
  for (const file of ["scripts/check-source-security.mjs", "server/regular-file.mjs"]) copyFileSync(file, join(directory, file));
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
  git(["init", "--quiet"]);
  return {
    stage(contents, mode = "100644") {
      const object = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: directory, input: contents, encoding: "utf8", windowsHide: true }).trim();
      git(["update-index", "--add", "--cacheinfo", `${mode},${object},sample.mjs`]);
    },
    check: () => spawnSync(process.execPath, ["scripts/check-source-security.mjs", "--staged"], { cwd: directory, encoding: "utf8", windowsHide: true }),
  };
}

test("source guard accepts regular staged source", t => {
  const f = fixture(t); f.stage("export const sample = 1;");
  assert.equal(f.check().status, 0);
});

test("source guard rejects an index symlink without relying on working-tree metadata", t => {
  const f = fixture(t); f.stage("../work/custody/vault.json", "120000");
  const result = f.check(); assert.equal(result.status, 1); assert.match(result.stderr, /non-regular staged/);
});

test("source guard rejects an in-memory synthetic credential without printing it", t => {
  const f = fixture(t), canary = randomBytes(32).toString("hex");
  f.stage(`const privateKey = "0x${canary}";`);
  const result = f.check(); assert.equal(result.status, 1); assert.match(result.stderr, /literal wallet private key/);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
});
