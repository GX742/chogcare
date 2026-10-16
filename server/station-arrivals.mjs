import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const receiptHash = /^0x[a-fA-F0-9]{64}$/;

// Presentation only: a canonical destination receipt can receive a thank-you
// before finality. Never writes invoices, delivered_events or financial state.
export function openStationArrivals({ source, sidecar, profile, started, amount, donation, causes, grace }) {
  if (!Number.isSafeInteger(started) || started < 0) throw new Error("Invalid station start boundary.");
  sidecar.exec(`CREATE TABLE IF NOT EXISTS station_arrivals (
    invoice_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
    payload TEXT,first_seen INTEGER NOT NULL,ready_at INTEGER NOT NULL,
    state TEXT NOT NULL,completed_at INTEGER
  )`);
  const candidates = source.prepare("SELECT id,document FROM chog_invoices WHERE state='confirming'");
  const invoiceAt = source.prepare("SELECT id,state,document FROM chog_invoices WHERE id=?");
  const finalized = source.prepare("SELECT 1 FROM delivered_events WHERE invoice_id=?");
  const record = row => {
    if (!row) return null;
    const invoice = JSON.parse(row.document);
    if (!/^[a-f0-9]{64}$/.test(row.id) || invoice.id !== row.id) throw new Error("Invalid station arrival identity.");
    if (invoice.state !== "confirming" && invoice.state !== "delivered") return null;
    if (row.state && row.state !== invoice.state) throw new Error("Station arrival state mismatch.");
    if (invoice.state === "confirming") {
      if (!receiptHash.test(invoice.observedDestinationHash ?? "") ||
          !/^[1-9]\d*$/.test(invoice.observedUsdc ?? "") ||
          !Number.isSafeInteger(invoice.destinationIncludedAt) || invoice.destinationIncludedAt <= 0 ||
          invoice.message) return null;
    } else if (!finalized.get(row.id)) return null;
    const value = amount(invoice.donationAmount ?? invoice.amount);
    const cause = causes.includes(invoice.initiativeId) ? invoice.initiativeId : undefined;
    const fingerprint = hash(JSON.stringify([row.id, value, cause ?? null]));
    return { invoiceId: row.id, amount: value, cause, fingerprint,
      id: hash(`chogcare-station-arrival-v1:${fingerprint}`).slice(0, 24), includedAt: invoice.destinationIncludedAt };
  };
  return {
    has(invoiceId) { return !!sidecar.prepare("SELECT 1 FROM station_arrivals WHERE invoice_id=?").get(invoiceId); },
    owns(id) { return !!sidecar.prepare("SELECT 1 FROM station_arrivals WHERE id=? AND state='pending'").get(id); },
    sync(timestamp) {
      let count = 0;
      for (const row of candidates.all()) {
        const event = record(row);
        if (!event || event.includedAt < started || this.has(event.invoiceId)) continue;
        sidecar.prepare("INSERT INTO station_arrivals VALUES (?,?,?,NULL,?,?,'pending',NULL)")
          .run(event.invoiceId, event.id, event.fingerprint, timestamp, timestamp + grace);
        count++;
      }
      return count;
    },
    next(timestamp, id = null) {
      const row = id ? sidecar.prepare("SELECT * FROM station_arrivals WHERE state='pending' AND id=?").get(id) : sidecar.prepare("SELECT * FROM station_arrivals WHERE state='pending' ORDER BY first_seen,invoice_id LIMIT 1").get();
      if (!row) return null;
      const event = record(invoiceAt.get(row.invoice_id));
      // A removed/unverifiable receipt is held, never promoted to finality.
      if (!event) return null;
      if (event.id !== row.id || event.fingerprint !== row.fingerprint) throw new Error("Station arrival identity changed.");
      if (row.payload) {
        const payload = donation(JSON.parse(row.payload));
        if (JSON.stringify(payload) !== row.payload || payload.id !== event.id || payload.amount !== event.amount || payload.cause !== event.cause || payload.test !== undefined) throw new Error("Station arrival outbox integrity mismatch.");
        return payload;
      }
      const nickname = profile.get(row.invoice_id)?.nickname;
      if (!nickname && timestamp < row.ready_at) return null;
      const payload = donation({ id: event.id, amount: event.amount, cause: event.cause, nick: nickname });
      sidecar.prepare("UPDATE station_arrivals SET payload=? WHERE invoice_id=? AND payload IS NULL").run(JSON.stringify(payload), row.invoice_id);
      return payload;
    },
    complete(id, timestamp) {
      const row = sidecar.prepare("SELECT payload FROM station_arrivals WHERE id=?").get(id);
      if (!row) return false;
      if (!row.payload) throw new Error("Station completion has no queued payload.");
      sidecar.prepare("UPDATE station_arrivals SET state='done',completed_at=? WHERE id=? AND state='pending'").run(timestamp, id);
      return true;
    },
    count(state) { return sidecar.prepare("SELECT COUNT(*) AS n FROM station_arrivals WHERE state=?").get(state).n; },
  };
}
