import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomic } from "./sqlite-transaction.mjs";

export const STATION_NICKNAME_GRACE_MS = 30_000;
export const STATION_MAX_LINE_BYTES = 384;
const stationIdPattern = /^[a-f0-9]{24}$/;
const invoiceIdPattern = /^[a-f0-9]{64}$/;
const amountPattern = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,18})?$/;
const digest = value => createHash("sha256").update(value).digest("hex");

// The firmware receives only public gratitude, never payment or wallet identity.
export function stationNickname(value) {
  if (typeof value !== "string") return "CHOG FRIEND";
  // The display fonts contain basic Latin plus Cyrillic, not accented Latin.
  // Transliterate only Latin characters individually; decomposing the entire
  // name would incorrectly change Cyrillic Ё/Й into Е/И.
  const latinMap = { "ß": "ss", "ẞ": "SS", "Ø": "O", "ø": "o", "Æ": "AE", "æ": "ae", "Ł": "L", "ł": "l", "Œ": "OE", "œ": "oe", "Ð": "D", "ð": "d", "Þ": "TH", "þ": "th" };
  let rendered = "";
  for (const character of value.normalize("NFKC")) {
    if (/^[A-Za-z0-9\u0400-\u052f_. -]$/u.test(character)) rendered += character;
    else if (latinMap[character]) rendered += latinMap[character];
    else if (/^\p{Script=Latin}$/u.test(character)) {
      const basic = character.normalize("NFD").replace(/\p{M}/gu, "");
      rendered += /^[A-Za-z]+$/.test(basic) ? basic : " ";
    } else rendered += " ";
  }
  const clean = rendered.trim().replace(/\s+/g, " ");
  let result = "";
  for (const character of clean) {
    if ([...result].length >= 24 || Buffer.byteLength(result + character, "utf8") > 96) break;
    result += character;
  }
  return result.trim() || "CHOG FRIEND";
}

export function stationAmount(value) {
  if (typeof value !== "string" || !amountPattern.test(value)) throw new Error("Invalid station donation amount.");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
  if (units <= 0n || units > 1_000_000n * 10n ** 18n) throw new Error("Station donation amount is outside pilot limits.");
  return value;
}

export function stationDonation({ id, nick, amount }) {
  if (typeof id !== "string" || !stationIdPattern.test(id)) throw new Error("Invalid station event identity.");
  const payload = { v: 1, type: "donation", id, nick: stationNickname(nick), amount: stationAmount(amount) };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > STATION_MAX_LINE_BYTES) throw new Error("Station command is too large.");
  return payload;
}

function regularFile(filename) {
  const path = resolve(filename);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Station source must be an existing regular database file.");
  return path;
}

function sourceRecord(row) {
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !invoiceIdPattern.test(row.invoice_id)) throw new Error("Invalid finalized station source event.");
  const invoice = JSON.parse(row.document);
  if (!invoice || invoice.id !== row.invoice_id || invoice.state !== "delivered" || typeof row.event_id !== "string" || !row.event_id.length) throw new Error("Station source is not a finalized donation.");
  const amount = stationAmount(invoice.donationAmount ?? invoice.amount);
  const fingerprint = digest(JSON.stringify([row.sequence, row.event_id, row.invoice_id, amount]));
  return { sequence: row.sequence, invoiceId: row.invoice_id, amount, fingerprint, id: digest(`chogcare-station-v1:${fingerprint}`).slice(0, 24) };
}

/**
 * Only the sidecar is writable. The financial databases remain read-only and
 * retain their existing integrity checkpoint, signer and HTTP boundaries.
 * A new installation starts at the current tail, not historical payments.
 */
export function openStationEvents({ processorFilename, profileFilename, stationFilename, now = Date.now() }) {
  const processorPath = regularFile(processorFilename), profilePath = regularFile(profileFilename), stationPath = resolve(stationFilename);
  if (stationPath === processorPath || stationPath === profilePath) throw new Error("Station sidecar cannot be a payment database.");
  mkdirSync(dirname(stationPath), { recursive: true });
  if (existsSync(stationPath) && (!lstatSync(stationPath).isFile() || lstatSync(stationPath).isSymbolicLink())) throw new Error("Station sidecar must be a regular database file.");
  let source, profiles, sidecar;
  try {
    source = new DatabaseSync(processorPath, { readOnly: true });
    profiles = new DatabaseSync(profilePath, { readOnly: true });
    source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    profiles.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    // Prepare required schemas before creating sidecar state; missing tables are
    // an offline/error condition, not a reason to invent a source event.
    const tail = source.prepare("SELECT COALESCE(MAX(rowid),0) AS sequence FROM delivered_events");
    const at = source.prepare("SELECT e.rowid AS sequence,e.event_id,e.invoice_id,i.document FROM delivered_events e JOIN chog_invoices i ON i.id=e.invoice_id WHERE e.rowid=? AND i.state='delivered'");
    const after = source.prepare("SELECT e.rowid AS sequence,e.event_id,e.invoice_id,i.document FROM delivered_events e JOIN chog_invoices i ON i.id=e.invoice_id WHERE e.rowid>? AND i.state='delivered' ORDER BY e.rowid LIMIT 100");
    const profile = profiles.prepare("SELECT nickname FROM donor_profiles WHERE invoice_id=?");
    sidecar = new DatabaseSync(stationPath);
    sidecar.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS station_meta (name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS station_events (
        id TEXT PRIMARY KEY,source_sequence INTEGER NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
        amount TEXT NOT NULL,nickname TEXT,payload TEXT,first_seen INTEGER NOT NULL,
        ready_at INTEGER NOT NULL,state TEXT NOT NULL,completed_at INTEGER
      );`);
    const getMeta = name => sidecar.prepare("SELECT value FROM station_meta WHERE name=?").get(name)?.value;
    const setMeta = (name, value) => sidecar.prepare("INSERT INTO station_meta VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name, String(value));
    const binding = digest(JSON.stringify([processorPath, profilePath]));
    if (getMeta("version") === undefined) {
      if (sidecar.prepare("SELECT COUNT(*) AS n FROM station_meta").get().n || sidecar.prepare("SELECT COUNT(*) AS n FROM station_events").get().n) throw new Error("Station ledger metadata is incomplete; automatic replay is disabled.");
      const sequence = tail.get().sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid station source cursor.");
      const anchor = sequence ? sourceRecord(at.get(sequence)).fingerprint : "";
      atomic(sidecar, () => { setMeta("version", 1); setMeta("source", binding); setMeta("cursor", sequence); setMeta("anchor", anchor); setMeta("started", now); });
    } else if (getMeta("version") !== "1" || getMeta("source") !== binding) throw new Error("Station ledger belongs to a different source.");
    const assertCursor = () => {
      const text = getMeta("cursor"), cursor = Number(text), maximum = tail.get().sequence;
      if (!/^\d+$/.test(text ?? "") || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maximum) || maximum < cursor) throw new Error("Station source rollback detected; preserve the ledger and payment databases.");
      const anchor = cursor ? sourceRecord(at.get(cursor)).fingerprint : "";
      if (getMeta("anchor") !== anchor) throw new Error("Station source identity changed; automatic replay is disabled.");
      return cursor;
    };
    assertCursor();
    let healthy = false, closed = false;
    return {
      sync(isHealthy, timestamp = Date.now()) {
        healthy = isHealthy === true;
        if (closed || !healthy) return 0;
        const cursor = assertCursor(), rows = after.all(cursor), events = rows.map(sourceRecord);
        atomic(sidecar, () => {
          for (const event of events) {
            const nickname = profile.get(event.invoiceId)?.nickname;
            sidecar.prepare("INSERT INTO station_events VALUES (?,?,?,?,?,?,?,?,'pending',NULL)").run(event.id, event.sequence, event.fingerprint, event.amount, typeof nickname === "string" ? stationNickname(nickname) : null, null, timestamp, typeof nickname === "string" ? timestamp : timestamp + STATION_NICKNAME_GRACE_MS);
            setMeta("cursor", event.sequence); setMeta("anchor", event.fingerprint);
          }
        });
        return events.length;
      },
      next(timestamp = Date.now()) {
        if (closed || !healthy) return null;
        assertCursor();
        const row = sidecar.prepare("SELECT * FROM station_events WHERE state='pending' ORDER BY source_sequence LIMIT 1").get();
        if (!row) return null;
        const sourceEvent = sourceRecord(at.get(row.source_sequence));
        if (sourceEvent.fingerprint !== row.fingerprint || sourceEvent.id !== row.id || sourceEvent.amount !== row.amount) throw new Error("Station pending event identity changed.");
        if (row.payload) {
          const result = stationDonation(JSON.parse(row.payload));
          if (JSON.stringify(result) !== row.payload || result.id !== row.id || result.amount !== row.amount) throw new Error("Station outbox integrity mismatch.");
          return result;
        }
        const nickname = profile.get(sourceEvent.invoiceId)?.nickname ?? row.nickname;
        if (!nickname && timestamp < row.ready_at) return null;
        const payload = stationDonation({ id: row.id, nick: nickname, amount: row.amount });
        sidecar.prepare("UPDATE station_events SET payload=? WHERE id=? AND payload IS NULL").run(JSON.stringify(payload), row.id);
        return payload;
      },
      complete(id, timestamp = Date.now()) {
        if (closed || !stationIdPattern.test(id ?? "")) throw new Error("Invalid station completion.");
        const row = sidecar.prepare("SELECT payload,state FROM station_events WHERE id=?").get(id);
        if (!row?.payload) throw new Error("Station completion has no queued payload.");
        sidecar.prepare("UPDATE station_events SET state='done',completed_at=? WHERE id=? AND state='pending'").run(timestamp, id);
      },
      summary() { return { pending: sidecar.prepare("SELECT COUNT(*) AS n FROM station_events WHERE state='pending'").get().n, completed: sidecar.prepare("SELECT COUNT(*) AS n FROM station_events WHERE state='done'").get().n, cursor: Number(getMeta("cursor")) }; },
      close() { if (closed) return; closed = true; healthy = false; sidecar.close(); profiles.close(); source.close(); },
    };
  } catch (error) { sidecar?.close(); profiles?.close(); source?.close(); throw error; }
}
