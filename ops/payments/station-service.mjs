import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStationEvents } from "../../server/station-events.mjs";
import { createStationRemoteService, validStationToken } from "../../server/station-remote-service.mjs";

export async function readStationServiceToken({ platform = process.platform, directory = process.env.CREDENTIALS_DIRECTORY, uid = process.getuid?.(), stat = lstat, read = readFile } = {}) {
  if (platform !== "linux" || directory !== "/run/credentials/chogcare-station.service") throw Error("Protected station credentials are required.");
  const path = `${directory}/station-token`, metadata = await stat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || ![64, 65].includes(metadata.size) || (metadata.mode & 0o222) !== 0 || ![0, uid].includes(metadata.uid)) throw Error("Protected station credential is unavailable.");
  const bytes = await read(path);
  try { const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\n$/, ""); if (!validStationToken(token)) throw Error("Invalid station credential."); return token; }
  finally { bytes.fill(0); }
}

export async function stationPaymentWorkerHealthy(fetcher = fetch) {
  let reader;
  try {
    const response = await fetcher("http://127.0.0.1:4174/api/payments/config", { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length") ?? 0) > 16384) return false;
    reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) return false; chunks.push(Buffer.from(value)); }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return value?.custodyConfigured === true && value?.integrityLocked === false && value?.readiness?.processing === "connected";
  } catch { return false; }
  finally { try { void reader?.cancel().catch(() => {}); reader?.releaseLock(); } catch {} }
}

export async function startStationService() {
  const token = await readStationServiceToken();
  const stationFilename = "/var/lib/chogcare-station/station.sqlite";
  const metadata = await lstat(stationFilename);
  // Cloud mode must inherit an explicitly migrated/enrolled outbox. Never
  // initialize at the current tail and silently discard unfinished gratitude.
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw Error("A protected migrated station outbox is required.");
  const events = openStationEvents({ processorFilename: "/var/lib/chogcare/work/payments/processor.sqlite", profileFilename: "/var/lib/chogcare/work/payments/preview.sqlite", stationFilename });
  const server = createStationRemoteService({ events, token, healthy: stationPaymentWorkerHealthy });
  let closing;
  const close = () => closing ??= new Promise(ok => { server.close(() => { events.close(); ok(); }); server.closeIdleConnections(); });
  try { await new Promise((ok, bad) => { server.once("error", bad); server.listen(4176, "127.0.0.1", ok); }); }
  catch (error) { events.close(); throw error; }
  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startStationService().catch(() => { console.error("Station feed startup failed. Check its protected credential, migrated outbox and read-only source access. Payments were not started or changed."); process.exitCode = 1; });
}
