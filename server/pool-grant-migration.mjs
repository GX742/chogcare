import { randomUUID } from "node:crypto";

// Startup only, after the operator lease and integrity check. Keep the original
// values and signed transactions: a legacy reservation still pays exactly $0.50.
export function migratePoolGrantPolicy(db) {
  if (db.prepare("PRAGMA table_info(pool_reservations)").all().some(column=>column.name==="holder_address")) return;
  const filename=db.prepare("PRAGMA database_list").all().find(database=>database.name==="main")?.file;
  if (filename) db.prepare("VACUUM main INTO ?").run(`${filename}.before-dollar-grants-${randomUUID()}.sqlite`);
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE pool_reservations_grant_upgrade (
      invoice_id TEXT PRIMARY KEY, collection TEXT NOT NULL, token_id TEXT NOT NULL,
      day TEXT NOT NULL, units INTEGER NOT NULL CHECK(units IN (500000,1000000)),
      state TEXT NOT NULL CHECK(state IN ('reserved','submitted','paid')),
      payout_hash TEXT UNIQUE, claim_scope TEXT NOT NULL DEFAULT 'daily', holder_address TEXT,
      UNIQUE(collection,token_id,day,claim_scope));
      INSERT INTO pool_reservations_grant_upgrade
        SELECT invoice_id,collection,token_id,day,units,state,payout_hash,claim_scope,NULL FROM pool_reservations;
      DROP TABLE pool_reservations;
      ALTER TABLE pool_reservations_grant_upgrade RENAME TO pool_reservations;
      CREATE TABLE pool_payout_days_grant_upgrade (
        invoice_id TEXT PRIMARY KEY REFERENCES pool_reservations(invoice_id),day TEXT NOT NULL,
        units INTEGER NOT NULL CHECK(units IN (500000,1000000)));
      INSERT INTO pool_payout_days_grant_upgrade SELECT invoice_id,day,units FROM pool_payout_days;
      DROP TABLE pool_payout_days;
      ALTER TABLE pool_payout_days_grant_upgrade RENAME TO pool_payout_days;`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nft_invoices'").get()) {
      db.exec(`UPDATE pool_reservations SET holder_address=(
        SELECT lower(json_extract(document,'$.holderAddress')) FROM nft_invoices WHERE id=invoice_id);`);
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Pool grant migration failed foreign-key validation.");
    db.exec("COMMIT");
  } catch(error) { db.exec("ROLLBACK");throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
