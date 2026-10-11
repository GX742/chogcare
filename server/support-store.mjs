import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const STATUSES = new Set(["new", "read", "resolved"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TICKETS = 5000;
const invalid = () => Object.assign(new Error("Invalid support request."), { status: 400 });
const matches = (pattern, value) => typeof value === "string" && value.match(pattern)?.[0] === value;

function text(value, maximum, required, multiline = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== "string") throw invalid();
  const normalized = value.normalize("NFKC").trim();
  if ([...normalized].length > maximum || (required && !normalized.length) ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(normalized) ||
      /[\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(normalized)) throw invalid();
  return normalized || null;
}

export function validateSupportInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["requestId", "subject", "message", "contact", "invoiceId"].includes(key)) ||
      !matches(UUID, input.requestId) ||
      (input.invoiceId !== undefined && !matches(/^[a-f0-9]{64}$/, input.invoiceId))) throw invalid();
  return {
    requestId: input.requestId.toLowerCase(), subject: text(input.subject, 80, true),
    message: text(input.message, 1600, true, true), contact: text(input.contact, 160, false),
    invoiceId: input.invoiceId ?? null,
  };
}

// Deliberately separate from the custody databases and their integrity baseline.
// The renderer must call these private methods through local desktop IPC only.
export function openSupportStore(filename, { clock = Date.now } = {}) {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())) throw new Error("Support storage path is not a regular file.");
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS support_tickets (
        reference TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
        subject TEXT NOT NULL, message TEXT NOT NULL, contact TEXT, invoice_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('new','read','resolved')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS support_created ON support_tickets(created_at DESC,reference);`);
    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const check = () => { if (closed) throw new Error("Support inbox is closed."); };
  const ticket = row => row ? {
    reference: row.reference, subject: row.subject, message: row.message, contact: row.contact,
    invoiceId: row.invoice_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
  return {
    submit(raw) {
      check(); const input = validateSupportInput(raw);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT reference,payload_hash,created_at FROM support_tickets WHERE request_id=?").get(input.requestId);
        if (existing) {
          if (existing.payload_hash !== hash) throw Object.assign(new Error("This support request cannot be changed. Use a new request ID."), { status: 409 });
          db.exec("COMMIT");
          return { created: false, ticket: { reference: existing.reference, createdAt: existing.created_at } };
        }
        if (db.prepare("SELECT COUNT(*) AS n FROM support_tickets").get().n >= MAX_TICKETS) throw Object.assign(new Error("Support inbox is temporarily full. Please try again later."), { status: 503 });
        const createdAt = clock();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("Invalid support clock.");
        let reference;
        for (let attempt = 0; attempt < 5; attempt++) {
          reference = randomBytes(6).toString("hex").toUpperCase();
          if (!db.prepare("SELECT 1 FROM support_tickets WHERE reference=?").get(reference)) break;
          reference = null;
        }
        if (!reference) throw new Error("Support reference is temporarily unavailable.");
        db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?,'new',?,?)").run(reference, input.requestId, hash, input.subject, input.message, input.contact, input.invoiceId, createdAt, createdAt);
        db.exec("COMMIT");
        return { created: true, ticket: { reference, createdAt } };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    list({ status, limit = 50 } = {}) {
      check();
      if (status !== undefined && !STATUSES.has(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid inbox filter.");
      const rows = status === undefined
        ? db.prepare("SELECT * FROM support_tickets ORDER BY created_at DESC,reference DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM support_tickets WHERE status=? ORDER BY created_at DESC,reference DESC LIMIT ?").all(status, limit);
      return rows.map(ticket);
    },
    summary() {
      check(); const result = { total: 0, new: 0, read: 0, resolved: 0 };
      for (const row of db.prepare("SELECT status,COUNT(*) AS n FROM support_tickets GROUP BY status").all()) { result[row.status] = row.n; result.total += row.n; }
      return result;
    },
    setStatus(reference, status) {
      check();
      if (!matches(/^[A-F0-9]{12}$/, reference) || !STATUSES.has(status)) throw new Error("Invalid inbox update.");
      db.prepare("UPDATE support_tickets SET status=?,updated_at=? WHERE reference=?").run(status, clock(), reference);
      return ticket(db.prepare("SELECT * FROM support_tickets WHERE reference=?").get(reference));
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
