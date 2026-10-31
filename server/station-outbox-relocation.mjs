import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, constants, writeFileSync, openSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { readRegularFileSync } from "./regular-file.mjs";
import { openPaymentIntegrity, paymentStateDigest } from "./payment-integrity.mjs";
import { openStationEvents } from "./station-events.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Offline migration of presentation state only. Original financial checkpoint
// labels prove which old source owns the outbox; both new financial databases
// must be exact copies before only the sidecar's path binding can change.
export function relocateStationOutbox({ stationSnapshot, stationFilename, sourceCheckpoint, processorFilename, profileFilename, checkpointFilename }) {
  const paths = [stationSnapshot, stationFilename, sourceCheckpoint, processorFilename, profileFilename, checkpointFilename].map(path => resolve(path));
  if (new Set(paths).size !== paths.length || existsSync(paths[1])) throw Error("Station relocation requires a new destination.");
  const metadata = lstatSync(paths[0]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) throw Error("Invalid station snapshot.");
  const old = JSON.parse(readRegularFileSync(paths[2], 4096));
  if (old.version !== 1 || typeof old.database !== "string" || !old.database || !Array.isArray(old.companions) || old.companions.length !== 1 || typeof old.companions[0] !== "string" || !old.companions[0] || old.companions[0] === old.database || !/^[a-f0-9]{64}$/.test(old.digest ?? "")) throw Error("Invalid station source checkpoint.");
  openPaymentIntegrity(paths[3], paths[5], [paths[4]]);
  if (hash([[old.database, paymentStateDigest(paths[3])], [old.companions[0], paymentStateDigest(paths[4])]]) !== old.digest) throw Error("Station financial source changed during migration.");
  const parent = dirname(paths[1]); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw Error("Invalid station destination.");
  const stage = mkdtempSync(join(parent, "station-relocation-")), snapshot = join(stage, "station.sqlite");
  let source, target, events;
  try {
    source = new DatabaseSync(paths[0], { readOnly: true });
    if (source.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Invalid station snapshot.");
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`); source.close(); source = null;
    target = new DatabaseSync(snapshot);
    const binding = target.prepare("SELECT value FROM station_meta WHERE name='source'").get()?.value;
    if (binding !== hash([old.database, old.companions[0]])) throw Error("Station outbox belongs to another source.");
    target.prepare("UPDATE station_meta SET value=? WHERE name='source'").run(hash([paths[3], paths[4]]));
    target.close(); target = null;
    events = openStationEvents({ processorFilename: paths[3], profileFilename: paths[4], stationFilename: snapshot });
    const summary = events.summary(); events.close(); events = null;
    const bytes = readRegularFileSync(snapshot, 64 * 1024 * 1024);
    const fd = openSync(paths[1], constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); bytes.fill(0); }
    if (process.platform !== "win32") { const directory = openSync(parent, "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
    return { relocated: true, pending: summary.pending, completed: summary.completed, financialFilesChanged: false };
  } finally { events?.close(); target?.close(); source?.close(); rmSync(stage, { recursive: true, force: true }); }
}
