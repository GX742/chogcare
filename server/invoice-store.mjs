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
    );
    CREATE TABLE IF NOT EXISTS donor_profiles (
      invoice_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      initiative_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      amount_sort TEXT NOT NULL,
      avatar_token_id TEXT,
      avatar_name TEXT,
      avatar_image TEXT,
      published_at INTEGER NOT NULL
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
    findDonorProfile(invoiceId) {
      const row=db.prepare("SELECT nickname,initiative_id,amount,avatar_token_id,avatar_name,avatar_image,published_at FROM donor_profiles WHERE invoice_id=?").get(invoiceId);
      return row?{nickname:row.nickname,initiativeId:row.initiative_id,amount:row.amount,avatarTokenId:row.avatar_token_id,avatarName:row.avatar_name,avatarImage:row.avatar_image,publishedAt:row.published_at}:null;
    },
    publishDonorProfile(profile) {
      const amountSort=String(BigInt(profile.amountUnits)).padStart(32,"0");
      db.prepare("INSERT INTO donor_profiles VALUES (?,?,?,?,?,?,?,?,?)").run(profile.invoiceId,profile.nickname,profile.initiativeId,profile.amount,amountSort,profile.avatarTokenId??null,profile.avatarName??null,profile.avatarImage??null,profile.publishedAt);
      return this.findDonorProfile(profile.invoiceId);
    },
    leaderboard(limit=20) {
      const rows=db.prepare("SELECT nickname,initiative_id,amount,avatar_token_id,avatar_name,avatar_image,published_at FROM donor_profiles ORDER BY amount_sort DESC,published_at ASC LIMIT ?").all(limit);
      return rows.map((row,index)=>({rank:index+1,nickname:row.nickname,initiativeId:row.initiative_id,amount:row.amount,avatarTokenId:row.avatar_token_id,avatarName:row.avatar_name,avatarImage:row.avatar_image,publishedAt:row.published_at}));
    },
    leaderboardRecords(limit) {
      const query="SELECT invoice_id,nickname,initiative_id,amount,avatar_token_id,avatar_name,avatar_image,published_at FROM donor_profiles ORDER BY amount_sort DESC,published_at ASC";
      const rows=limit===undefined?db.prepare(query).all():db.prepare(query+" LIMIT ?").all(limit);
      return rows.map(row=>({invoiceId:row.invoice_id,nickname:row.nickname,initiativeId:row.initiative_id,amount:row.amount,avatarTokenId:row.avatar_token_id,avatarName:row.avatar_name,avatarImage:row.avatar_image,publishedAt:row.published_at}));
    },
    // Internal primitive only, not exposed by HTTP. Recording proof is NOT a payout.
    recordNftProof(proof, now = Date.now()) {
      proofs.recordVerifiedProof(proof, now);
    },
    close() { db.close(); },
  };
}
