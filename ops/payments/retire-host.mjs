import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireOperatorLease } from "../../server/operator-lease.mjs";
import { openPaymentIntegrity } from "../../server/payment-integrity.mjs";
import { assertPaymentHostActive, writeHostRetirement } from "../../server/payment-host-retirement.mjs";
import { createBackupProtection, createPaymentBackup, verifyRecoveryBundle } from "../../server/payment-backup.mjs";
import { unlockCustodyVault } from "../../server/custody-vault.mjs";
import { hiddenPassword } from "../../scripts/terminal-password.mjs";

// Planned maintenance only. This tool never transfers files, moves a vault,
// starts a worker or signs/broadcasts. Run only after approved custody migration.
export async function retirePaymentHost({ workspace = process.cwd(), releaseSha, passwordProvider = hiddenPassword } = {}, dependencies = {}) {
  if (typeof releaseSha !== "string" || releaseSha.length !== 40 || !/^[a-f0-9]{40}$/.test(releaseSha)) throw Error("A checked release commit is required.");
  const use = (name, fallback) => dependencies[name] ?? fallback;
  const storage = resolve(workspace, "work/payments");
  let lease, protection, password;
  try {
    lease = await use("acquireOperatorLease", acquireOperatorLease)();
    use("assertPaymentHostActive", assertPaymentHostActive)(workspace);
    const probe = use("createServer", createServer)();
    await new Promise((ok, bad) => { probe.once("error", bad); probe.listen(4174, "127.0.0.1", ok); });
    await new Promise(ok => probe.close(ok));
    // A stopped signer alone is insufficient: verify the CURRENT paired state,
    // then snapshot it under this same lease so an older bundle cannot fence it.
    use("openPaymentIntegrity", openPaymentIntegrity)(resolve(storage, "processor.sqlite"), resolve(storage, "integrity/checkpoint.json"), [resolve(storage, "preview.sqlite")]);
    password = await passwordProvider("Existing custody password (hidden): ");
    const read = use("readFile", readFile);
    const vault = JSON.parse(await read(resolve(storage, "custody/vault.json"), "utf8"));
    // Check the password using the existing offline recovery path. No processor
    // is constructed, and the unlocked return value is neither retained nor used.
    await use("unlockCustodyVault", unlockCustodyVault)(vault, password);
    protection = use("createBackupProtection", createBackupProtection)(password);
    const saved = use("createPaymentBackup", createPaymentBackup)(storage, protection);
    const bytes = await read(saved.output);
    const checked = use("verifyRecoveryBundle", verifyRecoveryBundle)(bytes, password, resolve(storage, "backups"));
    if (checked?.verified !== true || checked.signingStarted !== false || checked.files !== 4 || checked.createdAt !== saved.createdAt) throw Error("A complete verified recovery bundle is required.");
    const evidence = { retiredAt: new Date().toISOString(), releaseSha, backupCreatedAt: checked.createdAt, backupSha256: createHash("sha256").update(bytes).digest("hex") };
    use("writeHostRetirement", writeHostRetirement)(workspace, evidence);
    return { hostRetired: true, recoveryVerified: true, signingStarted: false, liveFilesMoved: false };
  } finally { password = ""; protection?.close(); await lease?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, flag, releaseSha, ...extra] = process.argv.slice(2);
  try {
    if (action !== "--retire-host" || flag !== "--release" || extra.length) throw Error("Use --retire-host --release <checked commit>.");
    console.log(JSON.stringify(await retirePaymentHost({ releaseSha })));
  } catch {
    console.error("Host retirement failed. Preserve the original payment files; custody was not started or transferred. Verify graceful shutdown, the existing password, integrity and backup locally.");
    process.exitCode = 1;
  }
}
