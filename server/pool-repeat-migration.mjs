import { randomUUID } from "node:crypto";

// Preserve every reservation and referencing payout. Runs only during startup,
// after the operator lease and existing integrity checkpoint have been checked.
export function migratePoolRepeatScope(db) {
  if(db.prepare("PRAGMA table_info(pool_reservations)").all().some(c=>c.name==="claim_scope"))return;
  const filename=db.prepare("PRAGMA database_list").all().find(d=>d.name==="main")?.file;
  if(filename)db.prepare("VACUUM main INTO ?").run(`${filename}.before-repeat-${randomUUID()}.sqlite`);
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    if(!db.prepare("PRAGMA table_info(pool_reservations)").all().some(c=>c.name==="claim_scope")) {
      db.exec(`CREATE TABLE pool_reservations_repeat_upgrade (
        invoice_id TEXT PRIMARY KEY, collection TEXT NOT NULL, token_id TEXT NOT NULL,
        day TEXT NOT NULL, units INTEGER NOT NULL CHECK(units=500000),
        state TEXT NOT NULL CHECK(state IN ('reserved','submitted','paid')),
        payout_hash TEXT UNIQUE, claim_scope TEXT NOT NULL DEFAULT 'daily',
        UNIQUE(collection,token_id,day,claim_scope));
        INSERT INTO pool_reservations_repeat_upgrade
          SELECT invoice_id,collection,token_id,day,units,state,payout_hash,'daily' FROM pool_reservations;
        DROP TABLE pool_reservations;
        ALTER TABLE pool_reservations_repeat_upgrade RENAME TO pool_reservations;`);
      if(db.prepare("PRAGMA foreign_key_check").all().length)throw new Error("Pool migration failed foreign-key validation.");
    }
    db.exec("COMMIT");
  } catch(error) {db.exec("ROLLBACK");throw error;}
  finally {db.exec("PRAGMA foreign_keys=ON");}
}
