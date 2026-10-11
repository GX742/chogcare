import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";
import { createHttpAdmission } from "../server/http-admission.mjs";

const origin = "http://127.0.0.1:4173";
const input = { mode: "chog", amount: "300", holderAddress: "", initiativeId: "burundi" };
const digest = value => createHash("sha256").update(JSON.stringify([value.mode, value.amount, value.holderAddress, value.initiativeId, value.tokenId ?? null])).digest("hex");

async function harness(t, issue, store = openInvoiceStore(":memory:")) {
  const invoices = new Map(); let calls = 0;
  const processor = {
    publicStatus: () => ({ paymentsEnabled: true, nftPaymentsEnabled: true }),
    get: id => invoices.get(id) ?? null,
    async issue(payload, id) {
      calls++;
      if (issue) return issue(payload, id, invoices);
      const invoice = { kind: "live", id, mode: payload.mode, amount: payload.amount, state: "awaiting-payment" };
      invoices.set(id, invoice); return invoice;
    },
  };
  const service = createPaymentService(store, origin, true, processor);
  service.listen(0, "127.0.0.1"); await once(service, "listening");
  t.after(async () => { await new Promise(resolve => service.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const config = await fetch(`${base}/api/payments/config`);
  const cookie = config.headers.get("set-cookie").split(";")[0]; await config.json();
  return { base, store, invoices, service, cookie, processor, calls: () => calls,
    post: (key = randomUUID(), body = input, headers = {}) => fetch(`${base}/api/payments/invoices`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": key, ...headers }, body: JSON.stringify(body) }),
  };
}

test("live issuance requires signed session and UUID; identical retries allocate once", async t => {
  const f = await harness(t);
  assert.equal((await f.post(randomUUID(), input, { Cookie: "chogcare_session=forged" })).status, 403);
  assert.equal((await f.post("not-random")).status, 400);
  assert.equal(f.calls(), 0);
  const key = randomUUID(), first = await f.post(key), invoice = await first.json();
  assert.equal(first.status, 201);
  const replay = await f.post(key); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), invoice);
  assert.equal(f.calls(), 1);
  const mismatch = await f.post(key, { ...input, amount: "301" });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(f.calls(), 1);
});

test("overlapping retries return pending and recover the same invoice, not a second address", async t => {
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const f = await harness(t, async (payload, id, invoices) => { started(); await waiting; const invoice = { id, mode: payload.mode }; invoices.set(id, invoice); return invoice; });
  const key = randomUUID(), first = f.post(key); await entered;
  const overlap = await f.post(key); assert.equal(overlap.status, 409);
  assert.equal((await overlap.json()).code, "REQUEST_PENDING");
  const nextKey = randomUUID(), other = await f.post(nextKey); assert.equal(other.status, 429);
  assert.equal(f.store.requests.find(nextKey), null); assert.equal(f.calls(), 1);
  release(); const invoice = await (await first).json();
  assert.deepEqual(await (await f.post(key)).json(), invoice); assert.equal(f.calls(), 1);
});

test("a worker exception after commit recovers its invoice and never exposes exception data", async t => {
  const f = await harness(t, async (payload, id, invoices) => { invoices.set(id, { id, amount: payload.amount }); throw new Error("SECRET_RPC_CREDENTIAL /private/vault.json"); });
  const result = await f.post(); assert.equal(result.status, 201);
  assert.doesNotMatch(await result.text(), /SECRET|vault/); assert.equal(f.calls(), 1);
});

test("unallocated NFT request retries only with worker proof and the original ID", async t => {
  let fail=true; const ids=[];
  const f=await harness(t,async(payload,id,invoices)=>{ids.push(id);if(fail)throw new Error("temporary RPC failure");const x={id,mode:"nft",tokenId:"1638"};invoices.set(id,x);return x;});
  f.processor.canRetryUnissuedNft=id=>!f.invoices.has(id);
  const key=randomUUID(),body={mode:"nft",amount:"1",holderAddress:"0x19a863aeC37C83C7Cb34548c29f1F7e41BCB51Ca",initiativeId:"burundi"};
  assert.equal((await f.post(key,body)).status,409);
  fail=false;
  assert.equal((await f.post(key,body)).status,201);
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
});

test("wrong legacy NFT can unlock only after no-allocation proof",async t=>{
  const f=await harness(t,async()=>{throw Object.assign(new Error("private diagnostic"),{code:"NFT_NOT_OWNED"});});
  const key=randomUUID(),body={mode:"nft",amount:"1",holderAddress:"0x19a863aeC37C83C7Cb34548c29f1F7e41BCB51Ca",tokenId:"1130",initiativeId:"burundi"};
  assert.equal((await f.post(key,body)).status,409);
  f.processor.canRetryUnissuedNft=()=>true;
  const response=await f.post(key,body),data=await response.json();
  assert.equal(response.status,422);assert.equal(data.creationNotStarted,true);assert.equal(data.code,"NFT_NOT_OWNED");
  assert.doesNotMatch(JSON.stringify(data),/private diagnostic/);
});

test("ambiguous worker failure remains durable pending without a second issuance", async t => {
  const f = await harness(t, async () => { throw new Error("secret provider URL"); });
  const key = randomUUID(), first = await f.post(key), error = await first.json();
  assert.equal(first.status, 409); assert.equal(error.code, "REQUEST_PENDING");
  assert.equal(error.creationNotStarted, undefined); assert.doesNotMatch(JSON.stringify(error), /secret provider/);
  assert.equal((await f.post(key)).status, 409); assert.equal(f.calls(), 1);
  assert.equal(f.store.requests.find(key).state, "pending");
});

test("rejected retries cannot release a recorded intent and recovery bypasses readiness", async t => {
  const f = await harness(t), key = randomUUID();
  const issued = await (await f.post(key)).json();
  f.processor.publicStatus = () => ({ paymentsEnabled: false });
  const retry = await f.post(key); assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), issued);
  const invalid = await f.post(key, { ...input, amount: "1" }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).creationNotStarted, undefined);
  const lostSession = await f.post(key, input, { Cookie: "" }); assert.equal(lostSession.status, 403); assert.equal((await lostSession.json()).creationNotStarted, undefined);
  assert.equal(f.calls(), 1);
  const unavailable = await f.post(randomUUID()); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).creationNotStarted, true);
});

test("worker offline cannot label a durable pending request as never started", async t => {
  const store = openInvoiceStore(":memory:"), key = randomUUID(); store.requests.claim(key, digest(input));
  const service = createPaymentService(store); service.listen(0, "127.0.0.1"); await once(service, "listening");
  t.after(async () => { await new Promise(resolve => service.close(resolve)); store.close(); });
  const result = await fetch(`http://127.0.0.1:${service.address().port}/api/payments/invoices`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input) });
  assert.equal(result.status, 503); assert.equal((await result.json()).creationNotStarted, undefined);
});

test("integrity checkpoint failure never reveals a payable invoice even after worker commit", async t => {
  const f = await harness(t); let checkpoints = 0, locked = false;
  f.processor.publicStatus = () => ({ paymentsEnabled: !locked, integrityLocked: locked });
  f.processor.checkpoint = () => { if (++checkpoints >= 2) { locked = true; throw new Error("checkpoint secret path"); } };
  const key = randomUUID(), result = await f.post(key), body = await result.json();
  assert.equal(result.status, 503); assert.equal(body.code, "INTEGRITY_HOLD"); assert.equal(body.creationNotStarted, undefined); assert.equal(body.id, undefined);
  assert.equal(f.calls(), 1); assert.equal(f.invoices.size, 1);
  const retry = await f.post(key); assert.equal(retry.status, 503); assert.equal((await retry.json()).id, undefined); assert.equal(f.calls(), 1);
  const id = f.store.requests.find(key).invoice_id;
  assert.equal((await fetch(`${f.base}/api/payments/invoices/${id}`)).status, 503);
});

test("failed intent checkpoint prevents the worker from creating any deposit address", async t => {
  const f = await harness(t);
  f.processor.checkpoint = () => { throw new Error("checkpoint unavailable"); };
  const key = randomUUID(), result = await f.post(key); assert.equal(result.status, 503); assert.equal((await result.json()).code, "INTEGRITY_HOLD");
  assert.equal(f.calls(), 0); assert.equal(f.store.requests.find(key).state, "pending");
});

test("restart recovers committed invoice through durable server-selected request ID", async t => {
  const dir = mkdtempSync(join(tmpdir(), "chogcare-http-test-")), filename = join(dir, "test.sqlite");
  let store = openInvoiceStore(filename); const key = randomUUID(), entry = store.requests.claim(key, digest(input)); store.close();
  store = openInvoiceStore(filename);
  const f = await harness(t, undefined, store);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invoice = { id: entry.invoice_id, mode: "chog", state: "delivered", amount: "300" }; f.invoices.set(invoice.id, invoice);
  const recovered = await f.post(key); assert.equal(recovered.status, 201); assert.deepEqual(await recovered.json(), invoice);
  assert.equal(f.calls(), 0); assert.equal(store.requests.find(key).state, "complete");
});

test("status polling is separate by signed session and cannot exhaust invoice-create budget", async t => {
  const f = await harness(t);
  for (let i = 0; i < 241; i++) await fetch(`${f.base}/api/payments/config`, { headers: { Cookie: f.cookie } });
  assert.equal((await fetch(`${f.base}/api/payments/config`, { headers: { Cookie: f.cookie } })).status, 429);
  const other = await fetch(`${f.base}/api/payments/config`); assert.equal(other.status, 200);
  const otherCookie = other.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${f.base}/api/payments/config`, { headers: { Cookie: otherCookie } })).status, 200);
  assert.equal((await f.post()).status, 201);
});

test("signed session cannot be forged and X-Forwarded-For cannot bypass create limits", () => {
  let now = 1_790_000_000_000; const admission = createHttpAdmission(origin, () => now), headers = {};
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res = { setHeader: (name, value) => { headers[name] = value; } };
  const session = admission.session(req, res, true);
  assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Strict/);
  req.headers.cookie = headers["Set-Cookie"].split(";")[0]; assert.equal(admission.session(req, res), session);
  req.headers.cookie += "x"; assert.equal(admission.session(req, res), null);
  for (let i = 0; i < 8; i++) { req.headers["x-forwarded-for"] = `192.0.2.${i}`; assert.equal(admission.admit(req, "create", session), 0); }
  assert.equal(admission.admit(req, "create", session), 60);
  assert.equal(admission.admit(req, "read", session), 0);
  now += 60_001; assert.equal(admission.admit(req, "create", session), 0);
});

test("slow body has a wall-clock deadline before any worker action", async t => {
  const f = await harness(t); const start = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    const req = request(`${f.base}/api/payments/invoices`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: f.cookie, "Idempotency-Key": randomUUID(), "Transfer-Encoding": "chunked" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", error => { if (error.code === "ECONNRESET") resolve("closed"); else reject(error); });
    req.write("{");
    const drip = setInterval(() => { if (!req.destroyed) req.write(" "); }, 200);
    req.once("close", () => clearInterval(drip));
  });
  assert.ok(outcome === 408 || outcome === "closed"); assert.ok(Date.now() - start < 8000); assert.equal(f.calls(), 0);
});
