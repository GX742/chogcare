import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HDNodeWallet } from "ethers";
import { DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { enrollPaymentIntegrity } from "../server/payment-integrity.mjs";
import { createBackupProtection, createPaymentBackup, openRecoveryBundle, verifyRecoveryBundle } from "../server/payment-backup.mjs";

const password = "only-a-fixture-backup-password-123";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "chog-backup-test-"));
  mkdirSync(join(dir, "custody"));
  const root = HDNodeWallet.createRandom("", DEPOSIT_BASE_PATH), xpub = root.neuter().extendedKey;
  writeFileSync(join(dir, "custody", "vault.json"), JSON.stringify({ version: 1, basePath: DEPOSIT_BASE_PATH, xpub, keyId: createHash("sha256").update(xpub).digest("hex"), encryptedKeystore: "fixture-encrypted-only" }));
  const dbs = ["processor.sqlite", "preview.sqlite"].map(name => {
    const db = new DatabaseSync(join(dir, name)); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE financial (id TEXT); INSERT INTO financial VALUES ('private-fixture-row')"); return db;
  });
  enrollPaymentIntegrity(join(dir, "processor.sqlite"), join(dir, "integrity", "checkpoint.json"), [join(dir, "preview.sqlite")]);
  const protection = createBackupProtection(password);
  t.after(() => { protection.close(); dbs.forEach(db => db.close()); rmSync(dir, { recursive: true, force: true }); });
  return { dir, dbs, protection };
}
test("encrypted complete snapshot restores both WAL databases, vault and matching checkpoint without signing", t => {
  const f = fixture(t), result = createPaymentBackup(f.dir, f.protection), bytes = readFileSync(result.output);
  assert.equal(result.files, 4); assert.doesNotMatch(bytes.toString(), /private-fixture-row|encryptedKeystore|xpub/);
  const payload = openRecoveryBundle(bytes, password);
  assert.deepEqual(payload.files.map(x => x.name), ["processor.sqlite", "preview.sqlite", "vault.json", "checkpoint.json"]);
  assert.deepEqual(verifyRecoveryBundle(bytes, password, join(f.dir, "drill")), { verified: true, createdAt: result.createdAt, files: 4, signingStarted: false });
  assert.deepEqual(readdirSync(join(f.dir, "drill")), []);
  assert.equal(readdirSync(join(f.dir, "backups")).filter(x => x.startsWith("snapshot-")).length, 0);
  assert.equal(f.dbs[0].prepare("SELECT id FROM financial").get().id, "private-fixture-row");
});
test("wrong password, changed ciphertext and changed manifest are rejected", t => {
  const f = fixture(t), bytes = readFileSync(createPaymentBackup(f.dir, f.protection).output);
  assert.throws(() => openRecoveryBundle(bytes, password + "wrong"));
  const envelope = JSON.parse(bytes.toString()); envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  assert.throws(() => openRecoveryBundle(Buffer.from(JSON.stringify(envelope)), password));
  const payload = openRecoveryBundle(bytes, password); payload.files[0].name = "../../outside";
  assert.throws(() => verifyRecoveryBundle(f.protection.seal(payload), password, join(f.dir, "drill")));
});
test("stale checkpoint cannot produce an apparently good backup; encryption key is retired on close", t => {
  const f = fixture(t); f.dbs[0].exec("INSERT INTO financial VALUES ('uncheckpointed')");
  assert.throws(() => createPaymentBackup(f.dir, f.protection), /integrity/);
  f.protection.close(); assert.throws(() => f.protection.seal({}), /closed/);
});
