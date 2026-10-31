import { lstatSync, mkdirSync, openSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedStationEvent, validStationToken, validStationEventId } from "../server/station-remote-service.mjs";
import { readRegularFileSync } from "../server/regular-file.mjs";

export const STATION_REMOTE_ORIGIN = "https://45.38.60.159";
const DEADLINE_MS = 5000, MAX_RESPONSE_BYTES = 2048;
const privateFailure = () => Error("Station remote configuration is unavailable or not private.");

// Merely adding a valid protected file explicitly selects cloud mode. Invalid
// files fail closed; a broken remote config must never fall back to old custody.
export function readStationRemoteConfig(workspace, { platform = process.platform, uid = process.getuid?.(), checkWindowsAcl } = {}) {
  let parent = resolve(workspace);
  for (const component of ["work", "station"]) {
    parent = join(parent, component);
    let stat; try { stat = lstatSync(parent); } catch (error) { if (error.code === "ENOENT") return null; throw privateFailure(); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw privateFailure();
  }
  const path = join(parent, "remote.json");
  const validate = metadata => {
    if (metadata.size < 2n || (platform !== "win32" && ((metadata.mode & 0o077n) !== 0n || ![0n, BigInt(uid)].includes(metadata.uid)))) throw privateFailure();
    if (platform !== "win32") return;
    if (checkWindowsAcl) { if (checkWindowsAcl(path) !== true) throw privateFailure(); }
    else {
      const script = fileURLToPath(new URL("./check-station-remote-acl.ps1", import.meta.url));
      try { execFileSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-WorkspacePath", resolve(workspace)], { timeout: 5000, maxBuffer: 1024, stdio: "ignore", shell: false, windowsHide: true }); } catch { throw privateFailure(); }
    }
  };
  let value, bytes, opened = false;
  try { bytes = readRegularFileSync(path, 1024, { validate, open(filename, flags) { const fd = openSync(filename, flags); opened = true; return fd; } }); value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { if (!opened && error.code === "ENOENT") return null; throw privateFailure(); }
  finally { bytes?.fill(0); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "origin,token,version" || value.version !== 1 || value.origin !== STATION_REMOTE_ORIGIN || !validStationToken(value.token)) throw privateFailure();
  return { version: 1, origin: STATION_REMOTE_ORIGIN, token: value.token };
}

export function createRemoteStationEvents({ filename, token, origin = STATION_REMOTE_ORIGIN, fetcher = fetch, now = Date.now }, { schedule = callback => setTimeout(callback, DEADLINE_MS), cancel = clearTimeout } = {}) {
  if (origin !== STATION_REMOTE_ORIGIN || !validStationToken(token)) throw Error("Invalid remote station configuration.");
  const path = resolve(filename), parent = dirname(path); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw privateFailure();
  try { const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw privateFailure(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS remote_acks(id TEXT PRIMARY KEY,state TEXT NOT NULL,completed_at INTEGER NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0)");
    if (!db.prepare("PRAGMA table_info(remote_acks)").all().some(column => column.name === "attempted_at")) db.exec("ALTER TABLE remote_acks ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0");
  } catch (error) { db.close(); throw error; }
  let closed = false, connected = false, event = null, activeController = null, refreshing = null;
  let offeredId = null;
  async function request(route, body, pendingId) {
    const controller = new AbortController(); activeController = controller;
    const url = route === "next" ? "https://45.38.60.159/api/station/v1/next" : route === "ack" ? "https://45.38.60.159/api/station/v1/ack" : null;
    if (!url) throw Error("Invalid station route.");
    let timer, reader;
    const operation = async () => {
      const response = await fetcher(url, { method: body ? "POST" : "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(pendingId ? { "X-Chogcare-Station-Pending": pendingId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), credentials: "omit", redirect: "error", signal: controller.signal });
      if ((!response.ok && !(route === "ack" && response.status === 409)) || response.redirected || (response.url && response.url !== url) || !response.body) throw Error("Station feed unavailable.");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || length.length > 10 || Number(length) > MAX_RESPONSE_BYTES)) throw Error("Station response too large.");
      reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) { const value = await reader.read(); if (controller.signal.aborted || closed) throw Error("Station request stopped."); if (value.done) break; size += value.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw Error("Station response too large."); chunks.push(Buffer.from(value.value)); }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!response.ok) {
        if (value?.code === "STATION_EVENT_NOT_ELIGIBLE" && Object.keys(value).sort().join(",") === "code,error" && typeof value.error === "string") return { version: 1, notEligible: true };
        throw Error("Station acknowledgement outcome is unknown.");
      }
      return value;
    };
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = schedule(() => { controller.abort(); reject(Error("Station deadline expired.")); }); })]); }
    finally { cancel(timer); controller.abort(); try { void reader?.cancel().catch(() => {}); reader?.releaseLock(); } catch {} if (activeController === controller) activeController = null; }
  }
  return {
    async refresh(pendingId = null) {
      if (closed) return false;
      if (pendingId !== null && !validStationEventId(pendingId)) return false;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        connected = false; event = null;
        try {
          const ack = db.prepare("SELECT id FROM remote_acks WHERE state='pending' OR (state='held' AND attempted_at<=?) ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,attempted_at,completed_at,id LIMIT 1").get(now() - 30_000);
          if (ack) {
            const response = await request("ack", { id: ack.id, status: "done" });
            if (closed || response?.version !== 1) return false;
            if (response.notEligible === true) {
              // A reorg can make an already physically displayed arrival
              // ineligible. Keep its USB dedup tombstone and retry separately,
              // while allowing later verified gratitude to continue.
              db.prepare("UPDATE remote_acks SET state='held',attempted_at=? WHERE id=?").run(now(), ack.id);
            } else {
              if (response.acknowledged !== true || Object.keys(response).sort().join(",") !== "acknowledged,version") return false;
              db.prepare("UPDATE remote_acks SET state='done',attempted_at=? WHERE id=?").run(now(), ack.id);
            }
          }
          const response = await request("next", null, pendingId);
          if (closed || !response || Object.keys(response).sort().join(",") !== "event,healthy,version" || response.version !== 1 || response.healthy !== true) return false;
          event = response.event === null ? null : sanitizedStationEvent(response.event);
          if (event && db.prepare("SELECT 1 FROM remote_acks WHERE id=?").get(event.id)) event = null;
          connected = true; return true;
        } catch { return false; }
      })().finally(() => { refreshing = null; });
      return refreshing;
    },
    next() { if (closed || !connected || !event) return null; offeredId ??= event.id; return { ...event }; },
    complete(id) {
      if (closed || offeredId !== id) throw Error("Unknown station acknowledgement.");
      db.prepare("INSERT INTO remote_acks VALUES (?,'pending',?,0) ON CONFLICT(id) DO NOTHING").run(id, now()); offeredId = null; if (event?.id === id) event = null;
    },
    async close() { if (closed) return; closed = true; connected = false; event = null; activeController?.abort(); await refreshing; db.close(); },
  };
}
