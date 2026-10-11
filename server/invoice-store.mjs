import { DatabaseSync } from "node:sqlite";
import { createPoolLedger } from "./pool-ledger.mjs";
import { createNftProofLedger } from "./nft-proof-ledger.mjs";
import { createRequestJournal } from "./request-journal.mjs";

export function openInvoiceStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS preview_invoices (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);
  const poolLedger = createPoolLedger(db);
  const proofs = createNftProofLedger(db);
  const requests = createRequestJournal(db);
  return {
    requests,
    poolSummary(now) { return poolLedger.summary(now); },
    savePreview(invoice) {
      if (invoice.kind !== "preview" || "depositAddress" in invoice) throw new Error("Only non-payable previews are enabled.");
      // Never persist the entered holder address for a non-payable preview.
      const { holderAddress: _unused, ...document } = invoice;
      db.prepare("DELETE FROM preview_invoices WHERE created_at < ?").run(Date.now() - 86_400_000);
      if (db.prepare("SELECT COUNT(*) AS n FROM preview_invoices").get().n >= 2000) throw new Error("Preview storage limit reached.");
      db.prepare("INSERT INTO preview_invoices VALUES (?, ?, ?)").run(invoice.id, JSON.stringify(document), Date.now());
      return invoice;
    },
    findPreview(id) {
      const row = db.prepare("SELECT document FROM preview_invoices WHERE id = ? AND created_at >= ?").get(id, Date.now() - 86_400_000);
      return row ? JSON.parse(row.document) : null;
    },
    // Internal primitive only, not exposed by HTTP. Recording proof is NOT a payout.
    recordNftProof(proof, now = Date.now()) {
      proofs.recordVerifiedProof(proof, now);
    },
    close() { db.close(); },
  };
}
