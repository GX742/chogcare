import { depositAddress, publicDepositNode } from "./custody-vault.mjs";

export function createAddressAllocator(db, vault) {
  publicDepositNode(vault);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS custody_branch (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      key_id TEXT NOT NULL,
      next_index INTEGER NOT NULL CHECK(next_index >= 0)
    );
    CREATE TABLE IF NOT EXISTS deposit_addresses (
      invoice_id TEXT PRIMARY KEY,
      derivation_index INTEGER NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL
    );`);
  const checkBranch = () => {
    const branch = db.prepare("SELECT * FROM custody_branch WHERE singleton=1").get();
    if (!branch || branch.key_id !== vault.keyId) throw new Error("Custody branch mismatch. Do not issue addresses.");
    return branch;
  };
  db.prepare("INSERT OR IGNORE INTO custody_branch VALUES (1, ?, 0)").run(vault.keyId);
  checkBranch();
  return {
    allocate(invoiceId) {
      if (typeof invoiceId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(invoiceId)) throw new Error("Invalid invoice ID.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const branch = checkBranch();
        const existing = db.prepare("SELECT * FROM deposit_addresses WHERE invoice_id=?").get(invoiceId);
        if (existing) { db.exec("COMMIT"); return existing; }
        const address = depositAddress(vault, branch.next_index);
        db.prepare("INSERT INTO deposit_addresses VALUES (?, ?, ?, ?)").run(invoiceId, branch.next_index, address, vault.keyId);
        db.prepare("UPDATE custody_branch SET next_index=next_index+1 WHERE singleton=1").run();
        const result = db.prepare("SELECT * FROM deposit_addresses WHERE invoice_id=?").get(invoiceId);
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
