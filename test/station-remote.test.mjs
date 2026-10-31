import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { openStationEvents } from "../server/station-events.mjs";
import { createStationRemoteService, sanitizedStationEvent, validStationToken, validStationEventId } from "../server/station-remote-service.mjs";
import { createRemoteStationEvents, readStationRemoteConfig, STATION_REMOTE_ORIGIN } from "../scripts/station-remote-client.mjs";
import { enrollPaymentIntegrity, paymentStateDigest } from "../server/payment-integrity.mjs";
import { relocatePaymentCheckpoint } from "../server/payment-relocation.mjs";
import { relocateStationOutbox } from "../server/station-outbox-relocation.mjs";
import { readStationServiceToken, stationPaymentWorkerHealthy } from "../ops/payments/station-service.mjs";

const token = "a".repeat(64), headers = { Authorization: `Bearer ${token}` };
const payload = { v: 1, type: "donation", id: "b".repeat(24), nick: "CHOG FRIEND", amount: "300", cause: "solar-foundation" };
const cleanupTasks = new Map();
const cleanup = (path, task) => cleanupTasks.get(path).push(task);
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "chog-remote-station-test-")), tasks = []; cleanupTasks.set(path, tasks);
  t.after(async () => { let failed; for (const task of tasks.reverse()) { try { await task(); } catch (error) { failed ??= error; } } try { rmSync(path, { recursive: true, force: true }); } catch (error) { failed ??= error; } cleanupTasks.delete(path); if (failed) throw failed; });
  return path;
}
function fixture(t) {
  const path = directory(t), processorFilename = join(path, "processor.sqlite"), profileFilename = join(path, "preview.sqlite"), stationFilename = join(path, "station.sqlite");
  const processor = new DatabaseSync(processorFilename), profiles = new DatabaseSync(profileFilename);
  processor.exec("PRAGMA journal_mode=WAL; CREATE TABLE chog_invoices(id TEXT PRIMARY KEY,state TEXT,document TEXT); CREATE TABLE delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT UNIQUE)");
  profiles.exec("PRAGMA journal_mode=WAL; CREATE TABLE donor_profiles(invoice_id TEXT PRIMARY KEY,nickname TEXT)");
  let events = openStationEvents({ processorFilename, profileFilename, stationFilename, now: 1000 });
  cleanup(path, () => { events?.close(); processor.close(); profiles.close(); });
  return { path, processorFilename, profileFilename, stationFilename, processor, profiles,
    get events() { return events; }, closeEvents() { events.close(); events = null; },
    add(number, state = "delivered", extra = {}) { const id = number.toString(16).padStart(64, "0"), document = { id, state, amount: "330", donationAmount: "300", initiativeId: "solar-foundation", ...extra }; processor.prepare("INSERT INTO chog_invoices VALUES (?,?,?)").run(id, state, JSON.stringify(document)); if (state === "delivered") processor.prepare("INSERT INTO delivered_events VALUES (?,?)").run(`fixture:${number}`, id); profiles.prepare("INSERT INTO donor_profiles VALUES (?,?)").run(id, "CHOG FRIEND"); return id; },
  };
}
async function service(t, f, healthy = () => true) {
  const server = createStationRemoteService({ events: f.events, token, healthy, clock: () => 2000 });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  cleanup(f.path, () => new Promise(ok => { server.close(ok); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/api/station/v1`;
}

test("authenticated station HTTP exposes only sanitized gratitude, ACKs idempotently and leaves money untouched", async t => {
  const f = fixture(t); f.add(1); const before = [f.processorFilename, f.profileFilename].map(paymentStateDigest), base = await service(t, f);
  const response = await fetch(`${base}/next`, { headers }); assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.healthy, true); assert.equal(value.event.amount, "300");
  assert.deepEqual(Object.keys(value.event), ["v", "type", "id", "nick", "amount", "cause"]);
  assert.doesNotMatch(JSON.stringify(value), /invoice|wallet|0x|destination|330|fixture:/);
  const ack = () => fetch(`${base}/ack`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id: value.event.id, status: "done" }) });
  assert.equal((await ack()).status, 200); assert.equal((await ack()).status, 200);
  assert.equal((await (await fetch(`${base}/next`, { headers })).json()).event, null);
  assert.deepEqual([f.processorFilename, f.profileFilename].map(paymentStateDigest), before);
});

test("station API denies unauthenticated, cross-origin, wrong-host, extra-path and oversized requests before reading events", async t => {
  let reads = 0;
  const f = fixture(t), base = await service(t, f, () => { reads++; return true; });
  for (const [url, options, status] of [
    [`${base}/next`, {}, 401], [`${base}/next`, { headers: { Authorization: `Bearer ${"f".repeat(64)}` } }, 401],
    [`${base}/next`, { headers: { ...headers, Origin: "https://example.invalid" } }, 403],
    [`${base}/next?invoice=x`, { headers }, 404], [`${base}/other`, { headers }, 404],
    [`${base}/next`, { method: "POST", headers }, 405],
    [`${base}/ack`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "x".repeat(257) }, 400],
    [`${base}/ack`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id: payload.id, status: "done", invoiceId: "private-fixture" }) }, 400],
  ]) assert.equal((await fetch(url, options)).status, status);
  const wrongHost = await new Promise((ok, bad) => { const request = httpRequest(`${base}/next`, { headers: { ...headers, Host: "example.invalid" } }, response => { response.resume(); response.once("end", () => ok(response.statusCode)); }); request.once("error", bad); request.end(); });
  assert.equal(wrongHost, 403);
  assert.equal(reads, 0);
});

test("integrity/offline hold and a removed arrival prevent remote display and acknowledgement", async t => {
  const f = fixture(t); let healthy = true;
  const id = f.add(1, "confirming", { observedDestinationHash: `0x${"1".repeat(64)}`, observedUsdc: "1", destinationIncludedAt: 1500 });
  const base = await service(t, f, () => healthy), initial = await (await fetch(`${base}/next`, { headers })).json(); assert.ok(initial.event);
  healthy = false;
  const held = await fetch(`${base}/next`, { headers }); assert.equal(held.status, 503); assert.deepEqual(await held.json(), { version: 1, healthy: false, event: null });
  const ack = () => fetch(`${base}/ack`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id: initial.event.id, status: "done" }) });
  assert.equal((await ack()).status, 503);
  healthy = true; const original = JSON.parse(f.processor.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id).document); delete original.observedDestinationHash;
  f.processor.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify(original), id);
  assert.equal((await ack()).status, 409); assert.equal(f.events.summary().completed, 0);
});

test("remote next preserves an in-flight arrival while another donation finalizes", async t => {
  const f = fixture(t), base = await service(t, f);
  f.add(1, "confirming", { observedDestinationHash: `0x${"1".repeat(64)}`, observedUsdc: "1", destinationIncludedAt: 1500 });
  const arrival = (await (await fetch(`${base}/next`, { headers })).json()).event;
  f.add(2);
  const waiting = (await (await fetch(`${base}/next`, { headers: { ...headers, "X-Chogcare-Station-Pending": arrival.id } })).json()).event;
  assert.deepEqual(waiting, arrival);
});

test("remote USB ACK survives an outage and restart without replaying the physical event", async t => {
  const path = directory(t), filename = join(path, "acks.sqlite"); let ackFails = true, acknowledged = false, requests = 0;
  const fetcher = async (url, options) => {
    requests++; assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    if (url.endsWith("/ack")) { assert.deepEqual(JSON.parse(options.body), { id: payload.id, status: "done" }); if (ackFails) throw Error("fixture outage"); acknowledged = true; return Response.json({ version: 1, acknowledged: true }); }
    return Response.json({ version: 1, healthy: true, event: acknowledged ? null : payload });
  };
  let client = createRemoteStationEvents({ filename, token, fetcher });
  assert.equal(await client.refresh(), true); assert.deepEqual(client.next(), payload);
  client.complete(payload.id); assert.equal(await client.refresh(), false); assert.equal(client.next(), null); await client.close();
  client = createRemoteStationEvents({ filename, token, fetcher }); cleanup(path, () => client.close());
  ackFails = false; assert.equal(await client.refresh(), true); assert.equal(acknowledged, true); assert.equal(client.next(), null); assert.equal(requests, 4);
});

test("a late USB ACK is retained during a network outage after the payload was offered", async t => {
  const path = directory(t); let fail = false;
  const client = createRemoteStationEvents({ filename: join(path, "acks.sqlite"), token, fetcher: async () => { if (fail) throw Error("offline"); return Response.json({ version: 1, healthy: true, event: payload }); } }); cleanup(path, () => client.close());
  await client.refresh(); client.next(); fail = true; await client.refresh();
  assert.doesNotThrow(() => client.complete(payload.id)); assert.equal(client.next(), null);
});

test("a physically completed arrival held by reorg does not block later gratitude or replay USB after restart", async t => {
  const path = directory(t), filename = join(path, "acks.sqlite"), later = { ...payload, id: "c".repeat(24) };
  let phase = "initial", clock = 1000, oldAcks = 0;
  const fetcher = async (url, options) => {
    if (phase === "outage") throw Error("fixture network outage");
    if (url.endsWith("/ack")) {
      const id = JSON.parse(options.body).id;
      if (id === payload.id) { oldAcks++; if (phase !== "restored") return Response.json({ code: "STATION_EVENT_NOT_ELIGIBLE", error: "Station event is not eligible." }, { status: 409 }); }
      return Response.json({ version: 1, acknowledged: true });
    }
    return Response.json({ version: 1, healthy: true, event: phase === "reorg" ? later : phase === "restored" ? null : payload });
  };
  let client = createRemoteStationEvents({ filename, token, fetcher, now: () => clock });
  await client.refresh(); client.next(); client.complete(payload.id); phase = "outage";
  assert.equal(await client.refresh(), false); await client.close();
  client = createRemoteStationEvents({ filename, token, fetcher, now: () => clock }); cleanup(path, () => client.close());
  phase = "reorg"; assert.equal(await client.refresh(), true); assert.deepEqual(client.next(), later); assert.equal(oldAcks, 1);
  client.complete(later.id); assert.equal(await client.refresh(), true); assert.equal(client.next(), null);
  phase = "initial"; assert.equal(await client.refresh(), true); assert.equal(client.next(), null, "physical completion tombstone suppresses a returning old arrival");
  phase = "restored"; clock += 30_000; assert.equal(await client.refresh(), true); assert.equal(oldAcks, 2); assert.equal(client.next(), null);
});

test("tokens and event identities reject a final newline instead of accepting a noncanonical bearer", () => {
  assert.equal(validStationToken(token), true); assert.equal(validStationToken(`${token}\n`), false);
  assert.equal(validStationEventId(payload.id), true); assert.equal(validStationEventId(`${payload.id}\n`), false);
  assert.throws(() => sanitizedStationEvent({ ...payload, id: `${payload.id}\n` }));
});

test("remote client rejects extra identity fields, redirects, oversized bodies and arbitrary origins", async t => {
  const path = directory(t); let number = 0;
  for (const fetcher of [
    async () => Response.json({ version: 1, healthy: true, event: { ...payload, invoiceId: "private-fixture" } }),
    async () => { const response = Response.json({ version: 1, healthy: true, event: payload }); Object.defineProperty(response, "redirected", { value: true }); return response; },
    async () => new Response("x".repeat(2049)),
    async () => Response.json({ version: 1, healthy: false, event: payload }),
  ]) { const client = createRemoteStationEvents({ filename: join(path, `acks-${number++}.sqlite`), token, fetcher }); assert.equal(await client.refresh(), false); assert.equal(client.next(), null); await client.close(); }
  assert.throws(() => createRemoteStationEvents({ filename: join(path, "bad.sqlite"), token, origin: "https://example.invalid" }));
});

test("remote deadline and shutdown release a fetch that never returns without fabricating health", async t => {
  const path = directory(t); let signal;
  const client = createRemoteStationEvents({ filename: join(path, "acks.sqlite"), token, fetcher: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } }, { schedule: callback => setTimeout(callback, 20) });
  const pending = client.refresh(); await client.close(); assert.equal(await pending, false); assert.equal(signal.aborted, true); assert.equal(client.next(), null);
});

test("cloud selection requires an explicit private exact-origin config; malformed config never falls back", t => {
  const path = directory(t); assert.equal(readStationRemoteConfig(path), null); mkdirSync(join(path, "work/station"), { recursive: true });
  const filename = join(path, "work/station/remote.json"), options = { platform: "win32", checkWindowsAcl: () => true };
  writeFileSync(filename, JSON.stringify({ version: 1, origin: STATION_REMOTE_ORIGIN, token }), { mode: 0o600 });
  assert.equal(readStationRemoteConfig(path, options).origin, STATION_REMOTE_ORIGIN);
  assert.throws(() => readStationRemoteConfig(path, { ...options, checkWindowsAcl: () => false }));
  for (const contents of ["{", JSON.stringify({ version: 1, origin: "https://example.invalid", token }), JSON.stringify({ version: 1, origin: STATION_REMOTE_ORIGIN, token, invoiceId: "x" })]) { writeFileSync(filename, contents); assert.throws(() => readStationRemoteConfig(path, options)); }
});

test("remote config replacement during its ACL check fails closed rather than selecting local custody", t => {
  const path = directory(t); mkdirSync(join(path, "work/station"), { recursive: true });
  const filename = join(path, "work/station/remote.json");
  writeFileSync(filename, JSON.stringify({ version: 1, origin: STATION_REMOTE_ORIGIN, token }), { mode: 0o600 });
  assert.throws(() => readStationRemoteConfig(path, { platform: "win32", checkWindowsAcl() { renameSync(filename, `${filename}.original`); return true; } }), /unavailable|private/);
});

test("station token reader accepts only a protected service credential and clears raw bytes", async () => {
  const metadata = { isFile: () => true, nlink: 1n, size: 64n, mode: 0o100400n, uid: 1000n, mtimeNs: 1n, ctimeNs: 1n };
  let bytes, closed = 0, reads = 0;
  const openFile = async (path, flags) => {
    assert.equal(path, "/run/credentials/chogcare-station.service/station-token"); assert.ok(Number.isInteger(flags));
    let offset = 0;
    return { stat: async () => metadata, read: async (buffer, at) => { bytes = buffer; reads++; if (offset) return { bytesRead: 0 }; buffer.write(token, at); offset = 64; return { bytesRead: 64 }; }, close: async () => { closed++; } };
  };
  const options = { platform: "linux", directory: "/run/credentials/chogcare-station.service", uid: 1000, openFile };
  assert.equal(await readStationServiceToken(options), token); assert.ok(bytes.every(x => x === 0)); assert.equal(closed, 1); assert.equal(reads, 2);
  await assert.rejects(readStationServiceToken({ ...options, directory: "/tmp" }));
  for (const invalid of [{ mode: 0o100600n }, { nlink: 2n }, { size: 66n }, { isFile: () => false }]) {
    await assert.rejects(readStationServiceToken({ ...options, openFile: async () => ({ stat: async () => ({ ...metadata, ...invalid }), close: async () => { closed++; } }) }));
  }
  assert.equal(closed, 5, "rejected metadata closes the same opened descriptor before reading");
  await assert.rejects(readStationServiceToken({ ...options, openFile: async (...args) => {
    const handle = await openFile(...args); let checks = 0;
    handle.stat = async () => ({ ...metadata, ctimeNs: checks++ ? 2n : 1n }); return handle;
  } }));
  assert.ok(bytes.every(x => x === 0), "changed credentials clear buffers on rejection");
});

test("station health uses only actual custody, processing and integrity state, independent of new-invoice capacity", async () => {
  const good = { custodyConfigured: true, integrityLocked: false, paymentsEnabled: false, readiness: { processing: "connected" } };
  assert.equal(await stationPaymentWorkerHealthy(async () => Response.json(good)), true);
  for (const value of [{ ...good, integrityLocked: true }, { ...good, custodyConfigured: false }, { ...good, readiness: { processing: "offline" } }]) assert.equal(await stationPaymentWorkerHealthy(async () => Response.json(value)), false);
});

function migratedState(t) {
  const f = fixture(t); f.add(1); f.events.sync(true, 2000); const done = f.events.next(2000); f.events.complete(done.id, 2100); f.add(2); f.events.sync(true, 3000); const pending = f.events.next(3000); f.closeEvents();
  const sourceCheckpoint = join(f.path, "source-checkpoint.json"); enrollPaymentIntegrity(f.processorFilename, sourceCheckpoint, [f.profileFilename]);
  const target = join(f.path, "cloud"); mkdirSync(target);
  const processorFilename = join(target, "processor.sqlite"), profileFilename = join(target, "preview.sqlite"), checkpointFilename = join(target, "checkpoint.json"), stationFilename = join(target, "station.sqlite");
  f.processor.exec(`VACUUM INTO '${processorFilename.replaceAll("'", "''")}'`); f.profiles.exec(`VACUUM INTO '${profileFilename.replaceAll("'", "''")}'`);
  relocatePaymentCheckpoint({ database: processorFilename, requestJournal: profileFilename, sourceCheckpoint, targetCheckpoint: checkpointFilename });
  return { f, pending, settings: { stationSnapshot: f.stationFilename, stationFilename, sourceCheckpoint, processorFilename, profileFilename, checkpointFilename } };
}

test("verified sidecar relocation preserves pending/completed identities and financial state without tail reset", t => {
  const { f, pending, settings } = migratedState(t), before = [settings.processorFilename, settings.profileFilename].map(paymentStateDigest);
  const oldBytes = createHash("sha256").update(readFileSync(f.stationFilename)).digest("hex");
  assert.deepEqual(relocateStationOutbox(settings), { relocated: true, pending: 1, completed: 1, financialFilesChanged: false });
  const events = openStationEvents(settings); try { events.sync(true, 4000); assert.deepEqual(events.next(4000), pending); assert.equal(events.summary().cursor, 2); } finally { events.close(); }
  assert.deepEqual([settings.processorFilename, settings.profileFilename].map(paymentStateDigest), before);
  assert.equal(createHash("sha256").update(readFileSync(f.stationFilename)).digest("hex"), oldBytes);
  assert.throws(() => relocateStationOutbox(settings), /new destination/);
});

test("sidecar relocation rejects source substitution and rollback before publishing a target", t => {
  const { settings } = migratedState(t);
  const wrong = new DatabaseSync(settings.stationSnapshot); wrong.prepare("UPDATE station_meta SET value=? WHERE name='source'").run("f".repeat(64)); wrong.close();
  assert.throws(() => relocateStationOutbox(settings), /another source/);
  assert.throws(() => readFileSync(settings.stationFilename), { code: "ENOENT" });
});

test("sidecar relocation refuses an existing destination without overwriting it or financial state", t => {
  const { settings } = migratedState(t), before = [settings.processorFilename, settings.profileFilename].map(paymentStateDigest);
  writeFileSync(settings.stationFilename, "synthetic existing sidecar");
  assert.throws(() => relocateStationOutbox(settings), { code: "EEXIST" });
  assert.equal(readFileSync(settings.stationFilename, "utf8"), "synthetic existing sidecar");
  assert.deepEqual([settings.processorFilename, settings.profileFilename].map(paymentStateDigest), before);
});

test("sidecar relocation refuses a linked destination parent before creating a target", t => {
  const { f, settings } = migratedState(t), actual = join(f.path, "actual"), linked = join(f.path, "linked");
  mkdirSync(actual);
  symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => relocateStationOutbox({ ...settings, stationFilename: join(linked, "station.sqlite") }));
  assert.throws(() => readFileSync(join(actual, "station.sqlite")), { code: "ENOENT" });
});
