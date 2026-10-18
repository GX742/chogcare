import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, lstatSync, rmSync, realpathSync, openSync, fsyncSync, closeSync, statfsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { paymentStateDigest, openPaymentIntegrity } from "./payment-integrity.mjs";
import { publicDepositNode } from "./custody-vault.mjs";

const FILES = ["processor.sqlite", "preview.sqlite", "vault.json", "checkpoint.json"];
const MAX_BYTES = 64 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const aad = Buffer.from("ChogCare recovery bundle v1");
function derive(password, salt) {
  if (typeof password !== "string" || password.length < 16 || password.length > 256) throw Error("A local recovery password is required.");
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function regular(path, maximum = MAX_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw Error("Unsafe recovery file.");
  return readFileSync(path);
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path)) throw Error("Unsafe recovery directory.");
}
function cleanupStage(parent, stage) {
  if (dirname(resolve(stage)) !== resolve(parent) || !/^snapshot-[A-Za-z0-9]+$/.test(basename(stage))) throw Error("Unsafe snapshot cleanup target.");
  rmSync(stage, { recursive: true, force: true });
}
function validatePayload(value) {
  if (value?.version !== 1 || !Array.isArray(value.files) || value.files.length !== 4 || typeof value.createdAt !== "string") throw Error("Invalid recovery manifest.");
  const result = new Map();
  for (const file of value.files) {
    if (!FILES.includes(file.name) || result.has(file.name) || typeof file.data !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("Invalid recovery member.");
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length > MAX_BYTES || bytes.toString("base64") !== file.data || hash(bytes) !== file.sha256) throw Error("Recovery member integrity failure.");
    result.set(file.name, bytes);
  }
  return result;
}

// Password is used once. Retain only a derived encryption key, never the text.
// The same custody password can recover the bundle on another computer.
export function createBackupProtection(password) {
  const salt = randomBytes(32), key = derive(password, salt);
  let closed = false;
  return {
    seal(payload) {
      if (closed) throw Error("Recovery encryption is closed.");
      const plain = Buffer.from(JSON.stringify(payload));
      if (plain.length > MAX_BYTES) { plain.fill(0); throw Error("Recovery bundle exceeds its size limit."); }
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
      try { return Buffer.from(JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64"), authTag: cipher.getAuthTag().toString("base64") })); }
      finally { plain.fill(0); }
    },
    close() { key.fill(0); closed = true; },
  };
}
export function openRecoveryBundle(bytes, password) {
  if (bytes.length > MAX_BYTES * 2) throw Error("Oversized recovery bundle.");
  const value = JSON.parse(bytes.toString("utf8"));
  if (value?.version !== 1 || !["salt", "iv", "authTag", "ciphertext"].every(k => typeof value[k] === "string")) throw Error("Invalid encrypted recovery bundle.");
  const salt = Buffer.from(value.salt, "base64"), iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.authTag, "base64");
  if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw Error("Invalid recovery encryption parameters.");
  const key = derive(password, salt); let plain;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
    const payload = JSON.parse(plain.toString("utf8")); validatePayload(payload); return payload;
  } finally { key.fill(0); plain?.fill(0); }
}

// Call only inside the financial worker holding its exclusive operator lease,
// or offline under that same lease. No await: both DB snapshots and checkpoint
// are taken in one event-loop turn, so worker writes cannot interleave them.
export function createPaymentBackup(storage, protection, now = Date.now()) {
  storage = resolve(storage);
  const database = join(storage, "processor.sqlite"), companion = join(storage, "preview.sqlite"), checkpoint = join(storage, "integrity", "checkpoint.json");
  openPaymentIntegrity(database, checkpoint, [companion]);
  const checkpointBytes = regular(checkpoint, 4096), vaultBytes = regular(join(storage, "custody", "vault.json"), 65536);
  const vault = JSON.parse(vaultBytes.toString()); publicDepositNode(vault);
  if (typeof vault.encryptedKeystore !== "string") throw Error("Encrypted custody recovery data is missing.");
  const parent = join(storage, "backups"); privateDirectory(parent);
  // Leave headroom for the live SQLite journals. Never fill the payment disk
  // with snapshots, and never silently delete older financial recovery data.
  const disk = statfsSync(parent);
  const sourceBytes = lstatSync(database).size + lstatSync(companion).size;
  if (disk.bavail * disk.bsize < Math.max(512 * 1024 * 1024, sourceBytes * 6)) throw Error("Insufficient recovery disk headroom.");
  const stage = mkdtempSync(join(parent, "snapshot-"));
  try {
    for (const [file, source] of [["processor.sqlite", database], ["preview.sqlite", companion]]) {
      regular(source);
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Financial database failed integrity check.");
        db.exec(`VACUUM INTO '${join(stage, file).replaceAll("'", "''")}'`);
      } finally { db.close(); }
    }
    const cp = JSON.parse(checkpointBytes.toString());
    const snapshotDigest = hash(JSON.stringify([[resolve(database), paymentStateDigest(join(stage, "processor.sqlite"))], [resolve(companion), paymentStateDigest(join(stage, "preview.sqlite"))]]));
    if (snapshotDigest !== cp.digest || !regular(checkpoint, 4096).equals(checkpointBytes)) throw Error("Financial snapshot changed during backup.");
    const payload = { version: 1, createdAt: new Date(now).toISOString(), files: [
      ...["processor.sqlite", "preview.sqlite"].map(name => ({ name, bytes: regular(join(stage, name)) })),
      { name: "vault.json", bytes: vaultBytes }, { name: "checkpoint.json", bytes: checkpointBytes },
    ].map(({ name, bytes }) => ({ name, sha256: hash(bytes), data: bytes.toString("base64") })) };
    const output = join(parent, `recovery-${new Date(now).toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}.chogbackup`);
    const encrypted = protection.seal(payload), fd = openSync(output, "wx", 0o600);
    try { writeFileSync(fd, encrypted); fsyncSync(fd); } finally { closeSync(fd); }
    if (process.platform !== "win32") { const dir = openSync(parent, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
    return { output, createdAt: payload.createdAt, files: FILES.length };
  } finally { cleanupStage(parent, stage); }
}

// Offline drill only: never starts processors, imports a key, signs, or replaces
// live state. Uses a fresh private staging directory and validates DB/checkpoint
// coherence with the ORIGINAL path labels (no silent re-enrolment).
export function verifyRecoveryBundle(bytes, password, privateParent) {
  const payload = openRecoveryBundle(bytes, password), files = validatePayload(payload);
  privateParent = resolve(privateParent); privateDirectory(privateParent);
  const stage = mkdtempSync(join(privateParent, "snapshot-"));
  try {
    for (const [name, contents] of files) writeFileSync(join(stage, name), contents, { flag: "wx", mode: 0o600 });
    const cp = JSON.parse(files.get("checkpoint.json").toString()), vault = JSON.parse(files.get("vault.json").toString());
    publicDepositNode(vault);
    if (typeof vault.encryptedKeystore !== "string" || cp.version !== 1 || typeof cp.database !== "string" || !Array.isArray(cp.companions) || cp.companions.length !== 1) throw Error("Recovery descriptors are inconsistent.");
    const digests = ["processor.sqlite", "preview.sqlite"].map(name => {
      const db = new DatabaseSync(join(stage, name), { readOnly: true });
      try { if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Restored database is invalid."); } finally { db.close(); }
      return paymentStateDigest(join(stage, name));
    });
    if (hash(JSON.stringify([[cp.database, digests[0]], [cp.companions[0], digests[1]]])) !== cp.digest) throw Error("Restored checkpoint does not match databases.");
    return { verified: true, createdAt: payload.createdAt, files: files.size, signingStarted: false };
  } finally { for (const data of files.values()) data.fill(0); cleanupStage(privateParent, stage); }
}
