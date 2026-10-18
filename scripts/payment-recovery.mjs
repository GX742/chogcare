import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { acquireOperatorLease } from "../server/operator-lease.mjs";
import { createBackupProtection, createPaymentBackup, verifyRecoveryBundle } from "../server/payment-backup.mjs";
import { unlockCustodyVault } from "../server/custody-vault.mjs";
import { hiddenPassword } from "./terminal-password.mjs";

// Offline only. Does not replace production files, reset integrity or broadcast.
const [mode, name, ...extra] = process.argv.slice(2);
let lease, protection, password;
try {
  if (extra.length || !["--create", "--verify"].includes(mode) || (mode === "--create" && name) || (mode === "--verify" && !name)) throw Error("Use --create or --verify <bundle filename>.");
  const storage = resolve("work/payments"), parent = resolve(storage, "backups");
  lease = await acquireOperatorLease();
  password = await hiddenPassword("Existing custody password (hidden): ");
  let path;
  if (mode === "--create") {
    await unlockCustodyVault(JSON.parse(readFileSync(resolve(storage, "custody/vault.json"), "utf8")), password);
    protection = createBackupProtection(password);
    path = createPaymentBackup(storage, protection).output;
  } else {
    path = resolve(parent, name);
    if (dirname(path) !== parent || !path.endsWith(".chogbackup") || realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).size > 128 * 1024 * 1024) throw Error("Choose a regular encrypted bundle directly inside the protected backups folder.");
  }
  const checked = verifyRecoveryBundle(readFileSync(path), password, parent);
  console.log(JSON.stringify({ ...checked, bundle: path, liveFilesReplaced: false }));
  console.log("Keep a separate encrypted off-device copy. This drill does not reconcile newer blockchain transactions or authorize restarting restored custody.");
} catch (error) {
  console.error(error.code === "EADDRINUSE" ? "Payments are running. Use the next planned maintenance window; do not interrupt a transfer for this check." : "Recovery check failed. Preserve the original databases, checkpoint and vault. No live files were replaced.");
  process.exitCode = 1;
} finally { password = ""; protection?.close(); await lease?.close(); }
