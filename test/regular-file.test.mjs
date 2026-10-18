import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, linkSync, rmSync, openSync, fstatSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { readRegularFileSync } from "../server/regular-file.mjs";

function fixture(t) {
  const parent = resolve("work"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "file-read-test-"));
  t.after(() => { assert.equal(dirname(resolve(directory)), parent); assert.ok(basename(directory).startsWith("file-read-test-")); rmSync(directory, { recursive: true, force: true }); });
  const file = join(directory, "sample.txt"); writeFileSync(file, "fixture bytes");
  return { file, directory };
}

test("regular reader accepts an exact size bound and empty files without modifying them", t => {
  const { file } = fixture(t);
  assert.equal(readRegularFileSync(file, 13).toString(), "fixture bytes");
  writeFileSync(file, ""); assert.equal(readRegularFileSync(file, 0).length, 0);
});

test("regular reader rejects directories, oversize, network paths and invalid bounds", t => {
  const { file, directory } = fixture(t);
  assert.throws(() => readRegularFileSync(file, 12));
  assert.throws(() => readRegularFileSync(directory));
  for (const maximum of [-1, Infinity, NaN, 128 * 1024 * 1024 + 1]) assert.throws(() => readRegularFileSync(file, maximum));
  assert.throws(() => readRegularFileSync("\\\\untrusted.example\\share\\file"));
});

test("regular reader refuses hard links rather than reading another path's private data", t => {
  const { file, directory } = fixture(t);
  linkSync(file, join(directory, "linked.txt"));
  assert.throws(() => readRegularFileSync(file), /Unsafe/);
});

test("replacement after open is rejected before reading and the opened handle is closed", t => {
  const { file, directory } = fixture(t); let handle;
  assert.throws(() => readRegularFileSync(file, 100, { open(path, flags) {
    handle = openSync(path, flags);
    renameSync(path, join(directory, "original.txt"));
    writeFileSync(path, "replaced fixture");
    return handle;
  } }), /Unsafe|changed/);
  assert.throws(() => fstatSync(handle), { code: "EBADF" });
  assert.equal(readFileSync(file, "utf8"), "replaced fixture");
});

test("size refusal closes its file descriptor without reading or changing the file", t => {
  const { file } = fixture(t); let handle;
  assert.throws(() => readRegularFileSync(file, 1, { open(path, flags) { return handle = openSync(path, flags); } }));
  assert.throws(() => fstatSync(handle), { code: "EBADF" });
  assert.equal(readFileSync(file, "utf8"), "fixture bytes");
});
