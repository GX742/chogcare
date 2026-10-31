import { lstatSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";

export const HOST_RETIRED_MESSAGE = "Payments were retired on this computer for migration. Keep the recovery files; use the designated payment server. Do not remove the retirement marker to restart custody.";
export class PaymentHostRetiredError extends Error {
  constructor() { super(HOST_RETIRED_MESSAGE); this.code = "HOST_RETIRED"; }
}
const fail = () => { throw new PaymentHostRetiredError(); };
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hex = (value, length) => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);

export function hostRetirementPath(workspace) { return resolve(workspace, "work/payments/integrity/host-retired.json"); }

// A persistent safety fence for this installation, not a cross-host lock. Even
// malformed metadata holds custody; an unreadable marker must never mean active.
export function readHostRetirement(workspace, { platform = process.platform, uid = process.getuid?.() } = {}) {
  let parent = resolve(workspace);
  for (const component of ["work", "payments", "integrity"]) {
    parent = join(parent, component);
    let stat;
    try { stat = lstatSync(parent); } catch (error) { if (error.code === "ENOENT") return null; fail(); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  let stat;
  try { stat = lstatSync(hostRetirementPath(workspace)); } catch (error) { if (error.code === "ENOENT") return null; fail(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 2048) fail();
  if (platform !== "win32" && ((stat.mode & 0o077) !== 0 || ![0, uid].includes(stat.uid))) fail();
  let value;
  try { value = JSON.parse(readFileSync(hostRetirementPath(workspace), "utf8")); } catch { fail(); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "backupCreatedAt,backupSha256,kind,releaseSha,retiredAt,version" ||
      value.version !== 1 || value.kind !== "chogcare-payment-host-retired" || !iso(value.retiredAt) || !iso(value.backupCreatedAt) ||
      !hex(value.releaseSha, 40) || !hex(value.backupSha256, 64)) fail();
  return value;
}

export function assertPaymentHostActive(workspace = process.cwd()) {
  if (readHostRetirement(workspace)) fail();
}

// Only the offline retirement tool calls this after a fresh complete backup was
// verified while it owned the worker lease. There is deliberately no unretire API.
export function writeHostRetirement(workspace, evidence) {
  assertPaymentHostActive(workspace);
  if (!evidence || Object.keys(evidence).sort().join(",") !== "backupCreatedAt,backupSha256,releaseSha,retiredAt") fail();
  const value = { version: 1, kind: "chogcare-payment-host-retired", retiredAt: evidence.retiredAt, backupCreatedAt: evidence.backupCreatedAt, releaseSha: evidence.releaseSha, backupSha256: evidence.backupSha256 };
  if (!iso(value.retiredAt) || !iso(value.backupCreatedAt) || !hex(value.releaseSha, 40) || !hex(value.backupSha256, 64)) fail();
  const parent = resolve(workspace, "work/payments/integrity");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPaymentHostActive(workspace);
  const fd = openSync(hostRetirementPath(workspace), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") { const directory = openSync(parent, "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
  return value;
}
