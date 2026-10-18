import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStationEvents, stationAmount, stationDonation, stationNickname, STATION_NICKNAME_GRACE_MS } from "../server/station-events.mjs";
import { paymentStateDigest } from "../server/payment-integrity.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chogcare-station-test-"));
  const settings = { processorFilename: join(directory, "processor.sqlite"), profileFilename: join(directory, "preview.sqlite"), stationFilename: join(directory, "station.sqlite"), now: 1000 };
  const processor = new DatabaseSync(settings.processorFilename), profiles = new DatabaseSync(settings.profileFilename);
  processor.exec("PRAGMA journal_mode=WAL; CREATE TABLE chog_invoices(id TEXT PRIMARY KEY,state TEXT,document TEXT); CREATE TABLE delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT UNIQUE);");
  profiles.exec("PRAGMA journal_mode=WAL; CREATE TABLE donor_profiles(invoice_id TEXT PRIMARY KEY,nickname TEXT);");
  let reader = null;
  t.after(async () => { reader?.close(); processor.close(); profiles.close(); await rm(directory, { recursive: true, force: true }); });
  const id = number => number.toString(16).padStart(64, "0");
  return {
    settings, processor, profiles, id,
    start() { reader = openStationEvents(settings); return reader; },
    restart() { reader.close(); reader = openStationEvents(settings); return reader; },
    add(number, state = "delivered", fields = {}) {
      const invoice = { id: id(number), state, amount: "330", donationAmount: "300", depositAddress: "0x1111111111111111111111111111111111111111", destinationHash: `0x${"1".repeat(64)}`, ...fields };
      processor.prepare("INSERT INTO chog_invoices VALUES (?,?,?)").run(invoice.id, state, JSON.stringify(invoice));
      if (state === "delivered") processor.prepare("INSERT INTO delivered_events VALUES (?,?)").run(`10:0x${id(number)}:0`, invoice.id);
      return invoice;
    },
    publish(number, nickname) { profiles.prepare("INSERT INTO donor_profiles VALUES (?,?)").run(id(number), nickname); },
    deliver(number) {
      const record = processor.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id(number));
      const document = { ...JSON.parse(record.document), state: "delivered" };
      processor.prepare("UPDATE chog_invoices SET state='delivered',document=? WHERE id=?").run(JSON.stringify(document), id(number));
      processor.prepare("INSERT INTO delivered_events VALUES (?,?)").run(`10:0x${id(number)}:0`, id(number));
    },
  };
}

test("first station activation skips all historical finalized donations", async t => {
  const f = await fixture(t); f.add(1); f.publish(1, "Old donor");
  const events = f.start(); assert.equal(events.sync(true, 1000), 0); assert.equal(events.next(1000), null);
  assert.deepEqual(events.summary(), { cursor: 1, pending: 0, completed: 0 });
});

test("only durable finalized CHOG delivery becomes a gratitude event", async t => {
  const f = await fixture(t), events = f.start();
  f.add(1, "confirming"); f.publish(1, "GX");
  assert.equal(events.sync(true, 2000), 0); assert.equal(events.next(2000), null);
  f.deliver(1);
  assert.equal(events.sync(true, 3000), 1); assert.equal(events.next(3000).nick, "GX");
  assert.equal(events.sync(true, 4000), 0, "a finalized event is queued exactly once");
});

test("station wire has exact donation amount, public nickname and no financial identity", async t => {
  const f = await fixture(t), events = f.start(); f.add(1); f.publish(1, "Гость GX");
  const before = paymentStateDigest(f.settings.processorFilename), profileBefore = paymentStateDigest(f.settings.profileFilename);
  assert.equal(events.sync(true, 2000), 1);
  const payload = events.next(2000);
  assert.deepEqual(Object.keys(payload), ["v", "type", "id", "nick", "amount"]);
  assert.match(payload.id, /^[a-f0-9]{24}$/); assert.equal(payload.amount, "300"); assert.equal(payload.nick, "Гость GX");
  assert.doesNotMatch(JSON.stringify(payload), /330|0x|wallet|invoice|deposit|network|destination|Ethereum|Optimism|Solana|\\u/);
  events.complete(payload.id, 3000);
  assert.equal(paymentStateDigest(f.settings.processorFilename), before);
  assert.equal(paymentStateDigest(f.settings.profileFilename), profileBefore, "station never writes financial/profile databases");
});

test("finalized overpayment station amount uses the proof-backed actual cause allocation", async t => {
  const f=await fixture(t),events=f.start(),txHash=`0x${"a".repeat(64)}`,receivedUnits=String(333n*10n**18n);
  f.add(1,"delivered",{units:String(330n*10n**18n),receivedUnits,contributionPercent:10,depositHash:txHash,
    depositProof:{kind:"confirmed-chog-transfer",invoiceId:f.id(1),chainId:143,txHash,amountUnits:receivedUnits,sender:`0x${"2".repeat(40)}`,logIndex:0,blockNumber:"100",blockHash:`0x${"b".repeat(64)}`}});
  f.publish(1,"GX"); const before=paymentStateDigest(f.settings.processorFilename);
  assert.equal(events.sync(true,2000),1); const payload=events.next(2000);
  assert.equal(payload.amount,"302.727272727272727272");
  assert.doesNotMatch(JSON.stringify(payload),/invoice|0x|deposit|receivedUnits/);
  assert.equal(paymentStateDigest(f.settings.processorFilename),before);
});

test("initiative art comes only from finalized source and preserves durable payloads", async t => {
  const f = await fixture(t); let events = f.start();
  f.add(1, "delivered", {initiativeId:"solar-foundation"}); f.publish(1,"GX");
  const before = paymentStateDigest(f.settings.processorFilename);
  events.sync(true,2000); const wire = events.next(2000);
  assert.equal(wire.cause,"solar-foundation"); assert.equal(wire.test,undefined);
  events = f.restart(); events.sync(true,3000); assert.deepEqual(events.next(3000),wire);
  assert.equal(paymentStateDigest(f.settings.processorFilename),before);
  assert.throws(()=>stationDonation({...wire,cause:"https://evil.example/image"}),/initiative/);
  assert.throws(()=>stationDonation({...wire,test:false}),/test marker/);
});

test("offline or integrity-held worker cannot read new events or forward queued gratitude", async t => {
  const f = await fixture(t), events = f.start(); f.add(1); f.publish(1, "GX");
  assert.equal(events.sync(false, 2000), 0); assert.equal(events.next(5000), null); assert.equal(events.summary().cursor, 0);
  events.sync(true, 6000); const queued = events.next(6000); assert.equal(queued.amount, "300");
  events.sync(false, 7000); assert.equal(events.next(7000), null);
  events.sync(true, 8000); assert.deepEqual(events.next(8000), queued);
});

test("nickname grace accepts a late profile without changing an already queued wire payload", async t => {
  const f = await fixture(t), events = f.start(); f.add(1);
  const midway = 2000 + STATION_NICKNAME_GRACE_MS / 2, justBeforeTimeout = 2000 + STATION_NICKNAME_GRACE_MS - 1000;
  events.sync(true, 2000); assert.equal(events.next(2000), null); assert.equal(events.next(midway), null);
  f.publish(1, "Late donor"); const payload = events.next(justBeforeTimeout); assert.equal(payload.nick, "Late donor");
  f.profiles.prepare("UPDATE donor_profiles SET nickname='Changed donor'").run();
  assert.deepEqual(events.next(2000 + STATION_NICKNAME_GRACE_MS), payload);
});

test("donors who skip the public profile receive an anonymous thank-you after the nickname grace", async t => {
  const f = await fixture(t), events = f.start(); f.add(1); events.sync(true, 2000);
  assert.equal(STATION_NICKNAME_GRACE_MS, 8_000);
  assert.equal(events.next(2000 + STATION_NICKNAME_GRACE_MS - 1), null);
  assert.equal(events.next(2000 + STATION_NICKNAME_GRACE_MS).nick, "CHOG FRIEND");
});

test("pending gratitude survives bridge restart and done gifts do not replay", async t => {
  const f = await fixture(t); let events = f.start(); f.add(1); f.publish(1, "GX");
  events.sync(true, 2000); const pending = events.next(2000);
  events = f.restart(); events.sync(true, 3000); assert.deepEqual(events.next(3000), pending);
  events.complete(pending.id, 4000); events.complete(pending.id, 4001);
  events = f.restart(); events.sync(true, 5000); assert.equal(events.next(5000), null);
  assert.deepEqual(events.summary(), { cursor: 1, pending: 0, completed: 1 });
});

test("station detects source rollback and refuses silent replay", async t => {
  const f = await fixture(t), events = f.start(); f.add(1); f.add(2); events.sync(true, 2000);
  f.processor.prepare("DELETE FROM delivered_events WHERE invoice_id=?").run(f.id(2));
  assert.throws(() => events.sync(true, 3000), /rollback/);
});

test("station detects source replacement with the same event sequence", async t => {
  const f = await fixture(t), events = f.start(); f.add(1); events.sync(true, 2000);
  f.processor.prepare("UPDATE delivered_events SET event_id='replacement-event'").run();
  assert.throws(() => events.next(6000), /identity changed/);
});

test("malformed finalized invoice fails closed before updating source cursor", async t => {
  const f = await fixture(t), events = f.start(); f.add(1, "delivered", { donationAmount: "NaN" });
  assert.throws(() => events.sync(true, 2000), /amount/); assert.equal(events.summary().cursor, 0);
});

test("exact CHOG amounts never use floating point or silently round", () => {
  assert.equal(stationAmount("300.000000000000000001"), "300.000000000000000001");
  assert.equal(stationAmount("1000000"), "1000000");
  for (const amount of ["1000000.000000000000000001", "1000001", "0", "-1", "1e3", "NaN", "300\n", "300.1234567890123456789", "000300", "0300", "00.1"]) assert.throws(() => stationAmount(amount));
});

const arrival = { observedDestinationHash: `0x${"a".repeat(64)}`, observedUsdc: "450000", destinationIncludedAt: 2000, initiativeId: "solar-foundation" };

test("verified arrival triggers gratitude before finality without writing payment state", async t => {
  const f = await fixture(t), events = f.start();
  f.add(1, "confirming", arrival); f.publish(1, "GX");
  const before = paymentStateDigest(f.settings.processorFilename);
  assert.equal(events.sync(true, 2500), 1);
  const payload = events.next(2500);
  assert.equal(payload.nick, "GX"); assert.equal(payload.cause, "solar-foundation");
  assert.equal(payload.amount, "300"); assert.equal(payload.test, undefined);
  assert.equal(paymentStateDigest(f.settings.processorFilename), before);
  assert.equal(f.processor.prepare("SELECT COUNT(*) AS n FROM delivered_events").get().n, 0);
  events.complete(payload.id, 3000);
  f.deliver(1); assert.equal(events.sync(true, 4000), 0);
  assert.equal(events.next(4000), null, "finality must not trigger a second show");
  assert.deepEqual(events.summary(), { cursor: 1, pending: 0, completed: 1 });
});

test("overpaid receipt arrival credits actual kindness once and refuses forged excess before queuing", async t => {
  const f=await fixture(t),events=f.start(),txHash=`0x${"c".repeat(64)}`,receivedUnits=String(333n*10n**18n);
  const fields={...arrival,units:String(330n*10n**18n),contributionPercent:10,receivedUnits,depositHash:txHash,
    depositProof:{kind:"confirmed-chog-transfer",invoiceId:f.id(1),chainId:143,txHash,amountUnits:receivedUnits,sender:`0x${"2".repeat(40)}`,logIndex:0,blockNumber:"100",blockHash:`0x${"b".repeat(64)}`}};
  const invoice=f.add(1,"confirming",{...fields,depositProof:{...fields.depositProof,amountUnits:String(334n*10n**18n)}});
  f.publish(1,"GX");
  assert.throws(()=>events.sync(true,2500),/verified deposit proof/);
  assert.equal(events.summary().pending,0);
  f.processor.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify({...invoice,depositProof:fields.depositProof}),invoice.id);
  const before=paymentStateDigest(f.settings.processorFilename);
  assert.equal(events.sync(true,3000),1); const payload=events.next(3000);
  assert.equal(payload.amount,"302.727272727272727272");
  assert.equal(payload.cause,"solar-foundation");
  assert.equal(paymentStateDigest(f.settings.processorFilename),before);
  events.complete(payload.id,3100); f.deliver(1);
  assert.equal(events.sync(true,4000),0); assert.equal(events.next(4000),null);
});

test("arrival persists through restart and finality with the same USB identity", async t => {
  const f = await fixture(t); let events = f.start();
  f.add(1, "confirming", arrival); events.sync(true, 2500);
  assert.equal(events.next(10499), null);
  const payload = events.next(10500); assert.equal(payload.nick, "CHOG FRIEND");
  events = f.restart(); f.deliver(1); assert.equal(events.sync(true, 12000), 0);
  assert.deepEqual(events.next(12000), payload);
  events.complete(payload.id); events = f.restart(); events.sync(true, 13000);
  assert.equal(events.next(13000), null);
});

test("arrival requires a verified receipt, positive amount and post-install inclusion", async t => {
  const f = await fixture(t), events = f.start();
  f.add(1, "confirming", { ...arrival, observedDestinationHash: null });
  f.add(2, "confirming", { ...arrival, observedUsdc: "0" });
  f.add(3, "confirming", { ...arrival, destinationIncludedAt: 999 });
  f.add(4, "confirming", { ...arrival, message: "Network verification unavailable" });
  f.add(5, "bridging", arrival);
  assert.equal(events.sync(true, 3000), 0); assert.equal(events.next(3000), null);
});

test("reorganized and offline arrivals are held, then resume without changing their payload", async t => {
  const f = await fixture(t), events = f.start();
  const invoice = f.add(1, "confirming", arrival); f.publish(1, "GX");
  events.sync(true, 2500); const payload = events.next(2500);
  f.processor.prepare("UPDATE chog_invoices SET state='bridging',document=? WHERE id=?")
    .run(JSON.stringify({ ...invoice, state: "bridging", observedDestinationHash: null }), invoice.id);
  events.sync(true, 3000); assert.equal(events.next(3000, payload.id), null);
  f.processor.prepare("UPDATE chog_invoices SET state='confirming',document=? WHERE id=?").run(JSON.stringify(invoice), invoice.id);
  events.sync(false, 4000); assert.equal(events.next(4000, payload.id), null);
  events.sync(true, 5000); assert.deepEqual(events.next(5000, payload.id), payload);
});

test("pending arrival keeps its turn when another invoice finalizes", async t => {
  const f = await fixture(t), events = f.start();
  f.add(1, "confirming", arrival); f.publish(1, "GX");
  events.sync(true, 2500); const payload = events.next(2500);
  f.add(2); f.publish(2, "Next donor"); events.sync(true, 3000);
  assert.deepEqual(events.next(3000, payload.id), payload);
  events.complete(payload.id); assert.equal(events.next(4000).nick, "Next donor");
});

test("existing v1 station queue is preserved while adding arrival support", async t => {
  const f = await fixture(t); let events = f.start();
  f.add(1); f.publish(1, "Existing donor"); events.sync(true, 2000);
  const payload = events.next(2000);
  // Represents the old installation: no arrival table and existing v1 outbox.
  const sidecar = new DatabaseSync(f.settings.stationFilename);
  sidecar.exec("DROP TABLE station_arrivals"); sidecar.close();
  events = f.restart(); events.sync(true, 3000);
  assert.deepEqual(events.next(3000), payload);
  events.complete(payload.id); f.add(2, "confirming", arrival); f.publish(2, "New donor");
  assert.equal(events.sync(true, 4000), 1); assert.equal(events.next(4000).nick, "New donor");
});

test("screen nickname sanitization is UTF-8 bounded and transliterates unsupported Latin glyphs", () => {
  assert.equal(stationNickname("ＧＸ\tИван\n_.-"), "GX Иван _.-");
  assert.equal(stationNickname("你好😀"), "CHOG FRIEND");
  const nickname = stationNickname("Я".repeat(80)); assert.equal([...nickname].length, 24); assert.equal(Buffer.byteLength(nickname), 48);
  const payload = stationDonation({ id: "a".repeat(24), nick: "Élodie Иван", amount: "300.000000000000000001" });
  assert.equal(payload.nick, "Elodie Иван"); assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 384);
  assert.equal(stationNickname("Ёж Йона"), "Ёж Йона");
  assert.equal(stationNickname("ßØøÆæŁłŒœÐðÞþ"), "ssOoAEaeLlOEoeDdTHth");
  assert.equal(stationNickname("François Zoë Renée"), "Francois Zoe Renee");
  assert.doesNotMatch(JSON.stringify(payload), /\\u|\\n|\\r/);
});
