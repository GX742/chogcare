import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseUnits } from "viem";
import { openSupportStore, validateSupportInput } from "../server/support-store.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";
import { createReadOnlyDashboard, openReadOnlyImpactSource } from "../server/ops-dashboard.mjs";
import { createReadOnlyQuoteService } from "../server/ops-quotes.mjs";
import { createOperationsRuntime, createOfflineOperationsService } from "../server/operations-runtime.mjs";
import { readFileSync } from "node:fs";

const supportInput = () => ({ requestId: randomUUID(), subject: "Donation question", message: "Please help with this donation.", contact: "@donor" });
const testOperations = { initDirectory(workspace, kind) { const directory = join(workspace, "work", kind); mkdirSync(directory, { recursive: true }); return directory; } };

test("support persists independently, retries once, private IPC lists and controlled status updates", t => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-support-test-")), filename = join(directory, "support.sqlite");
  let store = openSupportStore(filename, { clock: () => 1000 });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = { ...supportInput(), invoiceId: "a".repeat(64) }, first = store.submit(input);
  assert.equal(first.created, true); assert.match(first.ticket.reference, /^[A-F0-9]{12}$/);
  assert.deepEqual(Object.keys(first.ticket).sort(), ["createdAt", "reference"]);
  assert.deepEqual(store.submit(input), { ...first, created: false });
  assert.throws(() => store.submit({ ...input, message: "Changed" }), error => error.status === 409);
  assert.deepEqual(store.summary(), { total: 1, new: 1, read: 0, resolved: 0 });
  assert.equal(store.list()[0].invoiceId, input.invoiceId);
  assert.equal(store.setStatus(first.ticket.reference, "read").status, "read");
  assert.throws(() => store.setStatus(first.ticket.reference, "deleted"));
  assert.throws(() => store.list({ limit: 101 }));
  store.close(); store = openSupportStore(filename);
  assert.equal(store.list({ status: "read" }).length, 1);
  assert.equal(store.setStatus("0".repeat(12), "resolved"), null);
});

test("support validates exact fields, bounded Unicode and controls, optional consent-only invoice", () => {
  for (const changed of [
    { requestId: "not-a-uuid" }, { subject: "" }, { subject: "a".repeat(81) },
    { message: "a".repeat(1601) }, { contact: "a".repeat(161) },
    { invoiceId: "a".repeat(63) }, { invoiceId: "A".repeat(64) },
    { invoiceId: "a".repeat(64) + "\n" }, { requestId: randomUUID() + "\n" },
    { message: "secret\0payload" }, { subject: "Header\nspoof" }, { message: "Hide\u202eaddress" }, { message: "Broken\ud800" }, { extra: "unexpected" },
  ]) assert.throws(() => validateSupportInput({ ...supportInput(), ...changed }));
  const input = supportInput();
  assert.equal(validateSupportInput({ ...input, message: "Привет\nありがとう 🧡" }).message, "Привет\nありがとう 🧡");
  assert.equal(validateSupportInput(input).invoiceId, null);
});

async function apiFixture(t, options = {}, processor = null) {
  const invoices = openInvoiceStore(":memory:"), support = openSupportStore(":memory:");
  const server = createPaymentService(invoices, "http://127.0.0.1:4173", false, processor, { supportStore: support, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); invoices.close(); support.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + "/api/payments/dashboard"), cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  const post = (input, headers = {}) => fetch(base + "/api/payments/support", { method: "POST", headers: { Origin: "http://127.0.0.1:4173", Cookie: cookie, "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) });
  return { base, post, support, cookie, invoices };
}

test("public support has no listing or bearer lookup and never exposes submitted identifiers", async t => {
  const { base, post, support, cookie } = await apiFixture(t);
  const input = { ...supportInput(), invoiceId: "a".repeat(64) }, response = await post(input), body = await response.json();
  assert.equal(response.status, 201); assert.match(body.ticket.reference, /^[A-F0-9]{12}$/);
  const wire = JSON.stringify(body);
  for (const privateValue of [input.invoiceId, input.message, input.contact, input.requestId]) assert.ok(!wire.includes(privateValue));
  assert.equal((await post(input)).status, 200); assert.equal(support.summary().total, 1);
  assert.equal((await fetch(base + "/api/payments/support", { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(base + `/api/payments/support/${body.ticket.reference}`)).status, 404);
  assert.equal((await post({ ...input, message: "Change" })).status, 409);
});

test("support enforces Origin, signed session, content type and body cap without payment writes", async t => {
  const { base, post, support } = await apiFixture(t);
  const input = supportInput();
  assert.equal((await post(input, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await post(input, { Cookie: "" })).status, 403);
  assert.equal((await fetch(base + "/api/payments/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await post(input, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ ...input, message: "x".repeat(9000) })).status, 413);
  assert.equal(support.summary().total, 0);
});

test("support is available during integrity hold and does not consume invoice creation admission", async t => {
  let checkpointCalls = 0;
  const processor = { publicStatus: () => ({ integrityLocked: true, paymentsEnabled: false }), checkpoint: () => { checkpointCalls++; throw new Error("private path"); } };
  const { base, post, cookie, support } = await apiFixture(t, {}, processor);
  for (let i = 0; i < 3; i++) assert.equal((await post(supportInput())).status, 201);
  assert.equal((await post(supportInput())).status, 429);
  assert.equal(support.summary().total, 3); assert.equal(checkpointCalls, 0);
  const preview = await fetch(base + "/api/payments/previews", { method: "POST", headers: { Origin: "http://127.0.0.1:4173", Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(preview.status, 503); assert.equal((await preview.json()).code, "INTEGRITY_HOLD");
});

test("support accepts full Unicode length but rejects invalid UTF-8, compression and oversized bytes", async t => {
  let now = Date.now();
  const { base, post, cookie, support } = await apiFixture(t, { clock: () => now });
  assert.equal((await post({ ...supportInput(), message: "🧡".repeat(800) })).status, 201);
  const send = (body, headers = {}) => fetch(base + "/api/payments/support", { method: "POST", headers: { Origin: "http://127.0.0.1:4173", Cookie: cookie, "Content-Type": "application/json", ...headers }, body });
  for (const [body, headers, expected] of [
    [new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), {}, 400],
    [JSON.stringify(supportInput()), { "Content-Encoding": "gzip" }, 415],
    [JSON.stringify({ ...supportInput(), message: "x".repeat(9000) }), {}, 413],
    [JSON.stringify({ ...supportInput(), message: "🧡".repeat(1600) }), {}, 413],
    [JSON.stringify({ ...supportInput(), extra: "not supported" }), {}, 400],
  ]) { now += 600000; assert.equal((await send(body, headers)).status, expected); }
  assert.equal(support.summary().total, 1);
});

test("omitting service options opens no support database or payment-independent writes", async t => {
  const store = openInvoiceStore(":memory:"), server = createPaymentService(store);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(base + "/api/payments/support", { method: "POST", headers: { Origin: "http://127.0.0.1:4173", "Content-Type": "application/json" }, body: JSON.stringify(supportInput()) });
  assert.equal(result.status, 503);
  assert.equal((await fetch(base + "/api/payments/bridge-estimate?amount=300&initiativeId=burundi")).status, 503);
  assert.equal((await (await fetch(base + "/api/payments/dashboard")).json()).impact, null);
});

test("dashboard projects only safe fields and unknown totals fail closed", () => {
  let held = false;
  const dashboard = createReadOnlyDashboard({ clock: () => 1000, status: () => ({ integrityLocked: held, paymentsEnabled: true, nftPaymentsEnabled: false, availableClaims: 2, poolTreasury: "PRIVATE_ADDRESS", sourceHash: "PRIVATE_HASH", invoiceId: "PRIVATE_ID" }), impact: () => ({ chogDonated: "600.000000000000000001", donations: 2, wallet: "PRIVATE_WALLET" }) });
  const snapshot = dashboard.snapshot();
  assert.equal(snapshot.payments.state, "ready"); assert.equal(snapshot.payments.nftState, "paused");
  assert.deepEqual(snapshot.impact, { chogDonated: "600.000000000000000001", donations: 2 });
  assert.equal(snapshot.payments.maxDailyClaims, 3); assert.equal(snapshot.payments.subsidyUsdc, "1.00");
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
  held = true; assert.equal(dashboard.snapshot().impact, null); assert.equal(dashboard.snapshot().payments.availableClaims, null); assert.equal(dashboard.snapshot().payments.state, "paused");
  assert.equal(createReadOnlyDashboard().snapshot().payments.state, "offline");
  assert.equal(createReadOnlyDashboard({ status: () => ({ paymentsEnabled: true }), impact: () => ({ chogDonated: "100", donations: 1 }) }).snapshot().impact, null);
});

test("dashboard caches bounded aggregate work but a new integrity hold clears it immediately", () => {
  let now = 1000, calls = 0, locked = false;
  const dashboard = createReadOnlyDashboard({ clock: () => now, status: () => ({ integrityLocked: locked, paymentsEnabled: true }), impact: () => { calls++; return { chogDonated: "300", donations: 1 }; } });
  for (let i = 0; i < 100; i++) { const value = dashboard.snapshot(); value.impact.chogDonated = "changed"; }
  assert.equal(calls, 1); assert.equal(dashboard.snapshot().impact.chogDonated, "300");
  now += 5000; dashboard.snapshot(); assert.equal(calls, 2);
  locked = true; assert.equal(dashboard.snapshot().impact, null); assert.equal(calls, 2);
  locked = false; dashboard.snapshot(); assert.equal(calls, 3);
});

test("impact uses a read-only finalized-event snapshot, exact cause amount and excludes confirming", t => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-impact-test-")), filename = join(directory, "processor.sqlite");
  const db = new DatabaseSync(filename);
  let source;
  t.after(() => { source?.close(); try { db.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  db.exec("CREATE TABLE chog_invoices(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL); CREATE TABLE delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT UNIQUE);");
  const add = (id, state, amount, event = true) => {
    const units = parseUnits("330", 18).toString(), hash = "0x" + "ab".repeat(32);
    const document = { id, state, donationAmount: amount, amount: "330", units, depositHash: hash, depositProof: { kind: "confirmed-chog-transfer", invoiceId: id, chainId: 143, sender: "0x" + "11".repeat(20), txHash: hash, amountUnits: units } };
    db.prepare("INSERT INTO chog_invoices VALUES (?,?,?)").run(id, state, JSON.stringify(document));
    if (event) db.prepare("INSERT INTO delivered_events VALUES (?,?)").run(id, id);
  };
  add("a".repeat(64), "delivered", "300.000000000000000001"); add("b".repeat(64), "delivered", "300"); add("c".repeat(64), "confirming", "300"); add("d".repeat(64), "delivered", "300", false);
  const before = db.prepare("SELECT COUNT(*) AS n FROM chog_invoices").get().n;
  source = openReadOnlyImpactSource(filename);
  assert.deepEqual(source.summary(), { chogDonated: "600.000000000000000001", donations: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chog_invoices").get().n, before); db.close();
});

test("public impact adds selected 300 to 4200 when the verified transfer is 333, preserving all financial terms", t => {
  const directory=mkdtempSync(join(tmpdir(),"chogcare-impact-overpayment-test-")),filename=join(directory,"processor.sqlite");
  const db=new DatabaseSync(filename);let source;
  t.after(()=>{source?.close();db.close();rmSync(directory,{recursive:true,force:true});});
  db.exec("CREATE TABLE chog_invoices(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL); CREATE TABLE delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT UNIQUE);");
  const hash="0x"+"ab".repeat(32),overpaidId="c".repeat(64);
  const add=(id,donationAmount,amount,receivedAmount)=>{
    const units=parseUnits(amount,18).toString(),actualUnits=parseUnits(receivedAmount??amount,18).toString();
    const document={id,state:"delivered",donationAmount,amount,units,contributionPercent:10,depositHash:hash,
      depositProof:{kind:"confirmed-chog-transfer",invoiceId:id,chainId:143,sender:"0x"+"11".repeat(20),txHash:hash,amountUnits:actualUnits,
        logIndex:0,blockNumber:"100",blockHash:"0x"+"bc".repeat(32)},...(receivedAmount?{receivedUnits:actualUnits}:{})};
    db.prepare("INSERT INTO chog_invoices VALUES (?,?,?)").run(id,document.state,JSON.stringify(document));
    db.prepare("INSERT INTO delivered_events VALUES (?,?)").run(id,id);
    return document;
  };
  add("a".repeat(64),"1500","1650");add("b".repeat(64),"2700","2970");
  source=openReadOnlyImpactSource(filename);
  assert.deepEqual(source.summary(),{chogDonated:"4200",donations:2});
  const overpaid=add(overpaidId,"300","330","333"),snapshot=db.prepare("SELECT document FROM chog_invoices ORDER BY id").all();
  assert.deepEqual(source.summary(),{chogDonated:"4500",donations:3});
  assert.deepEqual(db.prepare("SELECT document FROM chog_invoices ORDER BY id").all(),snapshot,"the aggregate reader never writes original or actual accounting");
  assert.throws(()=>db.prepare("INSERT INTO delivered_events VALUES (?,?)").run("duplicate",overpaidId),/UNIQUE/);
  assert.deepEqual(source.summary(),{chogDonated:"4500",donations:3});
  db.prepare("UPDATE chog_invoices SET state='bridging',document=? WHERE id=?").run(JSON.stringify({...overpaid,state:"bridging"}),overpaidId);
  assert.deepEqual(source.summary(),{chogDonated:"4200",donations:2});
  db.prepare("UPDATE chog_invoices SET state='delivered',document=? WHERE id=?").run(JSON.stringify(overpaid),overpaidId);
  assert.deepEqual(source.summary(),{chogDonated:"4500",donations:3});
  db.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify({...overpaid,depositProof:{...overpaid.depositProof,amountUnits:overpaid.units}}),overpaidId);
  assert.throws(()=>source.summary(),/failed verification/,"using the original total as fake proof must not authorize a received333 record");
});

function quoteFixture(overrides = {}) {
  let calls = 0, now = 1000, sent;
  const dependencies = {
    source: { getChainId: async () => 143 }, clock: () => now,
    saleQuote: async (_source, amount) => { calls++; assert.equal(amount, parseUnits("330", 18)); return { minMon: "100" }; },
    usdcQuote: async () => ({ minUsdc: "11000000" }),
    fetch: async (url, options) => { assert.equal(url, "https://api.relay.link/quote/v2"); assert.equal(options.redirect, "error"); sent = JSON.parse(options.body); return new Response("{}", { status: 200 }); },
    validateRelayOrder: async (_quote, payer, amount, minimum, checkedAt) => { assert.equal(payer, "0x" + "11".repeat(20)); assert.equal(amount, 10000000n); assert.equal(minimum,1n); return { inputUsdMicros: "10000000", expectedOutputUsdMicros: "9500000", minimumOutputUsdMicros: "9400000", estimatedSeconds: 2, validUntil: checkedAt + 60000, data: "PRIVATE_CALLDATA", requestId: "PRIVATE_ORDER" }; },
    ...overrides,
  };
  return { service: createReadOnlyQuoteService({}, dependencies), calls: () => calls, sent: () => sent, advance: value => { now += value; } };
}

test("read-only estimates quote total then split charity, include exact fee and cache cloned safe DTO", async () => {
  const fixture = quoteFixture(), input = { amount: "300", initiativeId: "school-supplies" };
  const first = await fixture.service.quote(input);
  assert.equal(fixture.sent().slippageTolerance, "25", "display estimates must request the same tight tolerance as checkout");
  assert.equal(fixture.sent().originChainId, 143); assert.equal(fixture.sent().destinationChainId, 10);
  assert.equal(fixture.sent().refundTo, fixture.sent().user);
  assert.equal(fixture.sent().amount, "10000000"); assert.equal(first.totalChog, "330"); assert.equal(first.poolContributionChog, "30");
  assert.equal(first.conversionMinimumUsdc, "11"); assert.equal(first.expectedCharityUsd, "9.5"); assert.equal(first.minimumCharityUsd, "9.4"); assert.equal(first.bridgeFeeUsd, "0.5"); assert.equal(first.bridgeFeePercent, "5");
  assert.equal(first.expiresAt, 31000); assert.ok(!JSON.stringify(first).includes("PRIVATE"));
  first.totalChog = "tampered";
  assert.equal((await fixture.service.quote(input)).totalChog, "330"); assert.equal(fixture.calls(), 1);
  fixture.advance(30000); await fixture.service.quote(input); assert.equal(fixture.calls(), 2);
  fixture.service.close(); await assert.rejects(fixture.service.quote(input), /temporarily unavailable/);
});

test("300 CHOG estimates accept positive signed delivery below $0.20 on USDC and native SOL routes", async () => {
  for (const initiativeId of ["school-supplies", "animal-ethics"]) {
    const fixture = quoteFixture({ validateRelayOrder: async (_quote, _payer, _amount, minimum, checkedAt, chain) => {
      assert.equal(minimum,1n,"read-only estimates must match the positive-only invoice quote policy");
      assert.equal(chain,initiativeId==="animal-ethics"?792703809:10);
      return { inputUsdMicros:"10000000",expectedOutputUsdMicros:"199999",minimumOutputUsdMicros:"1",estimatedSeconds:2,validUntil:checkedAt+60000 };
    } });
    const result=await fixture.service.quote({amount:"300",initiativeId});
    assert.equal(result.totalChog,"330");assert.equal(result.minimumCharityUsd,"0.000001");
    assert.equal(result.expectedCharityUsd,"0.199999");
    fixture.service.close();
  }
});

test("estimate input is allowlisted, one in-flight request is shared, other combos are bounded", async () => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const fixture = quoteFixture({ saleQuote: async () => { await gate; return { minMon: "100" }; } });
  for (const input of [{ amount: "301", initiativeId: "burundi" }, { amount: "300", initiativeId: "attacker" }, { amount: "300", initiativeId: "burundi", url: "http://127.0.0.1" }]) await assert.rejects(fixture.service.quote(input), error => error.status === 400);
  const input = { amount: "300", initiativeId: "burundi" }, first = fixture.service.quote(input), second = fixture.service.quote(input);
  input.amount = "1"; // The pending request must keep its already-validated copy.
  await assert.rejects(fixture.service.quote({ amount: "3000", initiativeId: "burundi" }), /temporarily unavailable/);
  unblock(); assert.deepEqual(await first, await second);
});

test("estimate validates real signed fixture and rejects provider mutation before safe projection", async () => {
  const signed = JSON.parse(readFileSync(new URL("./fixtures/relay-optimism-order.json", import.meta.url), "utf8"));
  const now = signed.protocol.v2.orderData.output.deadline * 1000 - 60000;
  const options = { source: { getChainId: async () => 143 }, clock: () => now, saleQuote: async () => ({ minMon: "100" }), usdcQuote: async () => ({ minUsdc: "1100000" }), fetch: async () => new Response(JSON.stringify(signed)) };
  const good = createReadOnlyQuoteService({}, options);
  const result = await good.quote({ amount: "300", initiativeId: "burundi" });
  assert.ok(Number(result.expectedCharityUsd) > 0); assert.ok(!JSON.stringify(result).includes(signed.requestId));
  const changed = structuredClone(signed); changed.protocol.v2.orderData.output.payments[0].recipient = "0x" + "11".repeat(20);
  const bad = createReadOnlyQuoteService({}, { ...options, fetch: async () => new Response(JSON.stringify(changed)) });
  await assert.rejects(bad.quote({ amount: "300", initiativeId: "burundi" }), /temporarily unavailable/);
});

test("estimate fails closed on wrong chain, oversized external body and raw provider failures", async () => {
  for (const changes of [
    { source: { getChainId: async () => 1 } },
    { saleQuote: async () => { throw new Error("SECRET_RPC_TOKEN"); } },
    { fetch: async () => new Response("x".repeat(262145)) },
    { fetch: async () => new Response("{}", { headers: { "Content-Length": "300000" } }) },
    { validateRelayOrder: async () => { throw new Error("SECRET_ORDER"); } },
  ]) await assert.rejects(quoteFixture(changes).service.quote({ amount: "300", initiativeId: "burundi" }), error => error.status === 503 && !error.message.includes("SECRET"));
});

test("public estimate rejects query duplicates/unknown combinations and redacts RPC errors", async t => {
  let calls = 0;
  const { base } = await apiFixture(t, { quoteService: { quote: async () => { calls++; throw new Error("PRIVATE_RPC_PASSWORD"); } } });
  for (const query of ["amount=300&amount=3000&initiativeId=burundi", "amount=300&initiativeId=burundi&url=private", "amount=1&initiativeId=burundi"]) assert.equal((await fetch(base + "/api/payments/bridge-estimate?" + query)).status, 400);
  const response = await fetch(base + "/api/payments/bridge-estimate?amount=300&initiativeId=burundi");
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("PRIVATE")); assert.equal(calls, 1);
});

test("operations runtime protects storage before opening any support database and fails closed", t => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-runtime-acl-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const dependencies = { initDirectory(workspace, kind) {
    calls++; assert.equal(workspace, directory); assert.equal(kind, "support");
    assert.equal(existsSync(join(directory, "work/support/support.sqlite")), false);
    throw new Error("Permissions could not be protected.");
  } };
  assert.throws(() => createOperationsRuntime({ workspacePath: directory }, dependencies), /Permissions/);
  assert.throws(() => createOfflineOperationsService({ workspacePath: directory }, dependencies), /Permissions/);
  assert.equal(calls, 2); assert.equal(existsSync(join(directory, "work")), false);
});

test("operations runtime only creates support storage, and close releases its local inbox", t => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-runtime-test-"));
  const runtime = createOperationsRuntime({ workspacePath: directory }, testOperations);
  t.after(() => { runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(runtime.options.supportStore.summary(), { total: 0, new: 0, read: 0, resolved: 0 });
  assert.equal(runtime.options.dashboard.snapshot().payments.state, "offline");
  assert.equal(runtime.options.dashboard.snapshot().payments.availableClaims, null);
  assert.equal(runtime.options.dashboard.snapshot().impact, null);
  runtime.close(); runtime.close(); assert.throws(() => runtime.options.supportStore.summary(), /closed/);
});

test("offline operations remain public/read-only for money and retain support across fallback restarts", async t => {
  const directory = mkdtempSync(join(tmpdir(), "chogcare-offline-test-"));
  const server = createOfflineOperationsService({ workspacePath: directory, allowedOrigin: "http://127.0.0.1:4173" }, testOperations);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(base + "/api/payments/config"), config = await bootstrap.json(), cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  assert.equal(config.paymentMode, "offline"); assert.equal(config.paymentsEnabled, false); assert.equal(config.nftPaymentsEnabled, false); assert.equal(config.custodyConfigured, false); assert.equal(config.integrityLocked, false); assert.equal(config.availableClaims, 0);
  const response = await fetch(base + "/api/payments/support", { method: "POST", headers: { Origin: "http://127.0.0.1:4173", Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(supportInput()) });
  assert.equal(response.status, 201);
  for (const [method, path] of [["POST", "/api/payments/previews"], ["POST", "/api/payments/invoices"], ["POST", "/api/payments/leaderboard"], ["GET", "/api/payments/invoices/" + "a".repeat(64)], ["GET", "/api/payments/invoices/" + "a".repeat(64) + "/profile"], ["GET", "/api/payments/leaderboard"]]) {
    const result = await fetch(base + path, { method, headers: { Cookie: cookie, ...(method === "POST" ? { Origin: "http://127.0.0.1:4173", "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(result.status, 503); assert.equal((await result.json()).code, "PAYMENTS_OFFLINE");
  }
  const reader = openSupportStore(join(directory, "work/support/support.sqlite"));
  assert.equal(reader.summary().total, 1); reader.close();
});

test("production operations default to chogcare.xyz and reject lookalike and stale origins", async t=>{
  const directory=mkdtempSync(join(tmpdir(),"chogcare-domain-test-"));
  const server=createOfflineOperationsService({workspacePath:directory},testOperations);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const bootstrap=await fetch(base+"/api/payments/config",{headers:{Origin:"https://chogcare.xyz"}});
  assert.equal(bootstrap.status,200);assert.match(bootstrap.headers.get("set-cookie"),/; Secure/);
  assert.equal((await bootstrap.json()).paymentMode,"offline");
  const cookie=bootstrap.headers.get("set-cookie").split(";")[0];
  for(const origin of ["https://chogcare.xyz.evil.test","http://chogcare.xyz","https://chogcare.vercel.app","null"]){
    const denied=await fetch(base+"/api/payments/support",{method:"POST",headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(supportInput())});
    assert.equal(denied.status,403);
  }
  const accepted=await fetch(base+"/api/payments/support",{method:"POST",headers:{Origin:"https://chogcare.xyz",Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(supportInput())});
  assert.equal(accepted.status,201);
});
