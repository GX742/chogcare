import { randomBytes } from "node:crypto";

// The API records intent BEFORE calling a money-handling worker. A restart must
// never turn a lost HTTP response into a second deposit address.
export function createRequestJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS payment_requests (
    request_key TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    invoice_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending','complete')),
    created_at INTEGER NOT NULL
  );`);
  const find = key => db.prepare("SELECT * FROM payment_requests WHERE request_key = ?").get(key) ?? null;
  return {
    find,
    claim(key, digest) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = find(key);
        if (existing) { db.exec("COMMIT"); return { ...existing, fresh: false }; }
        // Never prune ambiguous or completed keys automatically: expiry must not
        // allow a historical request to allocate another address after a retry.
        if (db.prepare("SELECT COUNT(*) AS n FROM payment_requests").get().n >= 20_000) throw new Error("Request journal capacity reached.");
        const id = randomBytes(32).toString("hex");
        db.prepare("INSERT INTO payment_requests VALUES (?, ?, ?, 'pending', ?)").run(key, digest, id, Date.now());
        db.exec("COMMIT");
        return { ...find(key), fresh: true };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    complete(key, id) {
      if (db.prepare("UPDATE payment_requests SET state = 'complete' WHERE request_key = ? AND invoice_id = ?").run(key, id).changes !== 1) throw new Error("Request binding mismatch.");
    },
  };
}
