import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";

const origin = "http://127.0.0.1:4173";
const nft = { mode: "nft", amount: "1", holderAddress: "0x1111111111111111111111111111111111111111", tokenId: "1", initiativeId: "burundi" };
const chog = { mode: "chog", amount: "300", holderAddress: "", initiativeId: "burundi" };
const digest = input => createHash("sha256").update(JSON.stringify([input.mode, input.amount, input.holderAddress, input.initiativeId, input.tokenId ?? null])).digest("hex");

async function fixture(t) {
  const store = openInvoiceStore(":memory:"), invoices = new Map();
  let preflights = 0, issues = 0, checkpoints = 0;
  const processor = {
    publicStatus: () => ({ paymentsEnabled: true, nftPaymentsEnabled: true, integrityLocked: false }),
    get: id => invoices.get(id) ?? null,
    preflightNft: async () => { preflights++; },
    issue: async (input, id) => { issues++; const invoice = { id, mode: input.mode, amount: input.amount }; invoices.set(id, invoice); return invoice; },
    checkpoint: async () => { checkpoints++; },
  };
  const service = createPaymentService(store, origin, true, processor);
  service.listen(0, "127.0.0.1"); await once(service, "listening");
  t.after(async () => { service.closeAllConnections(); await new Promise(done => service.close(done)); store.close(); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const config = await fetch(`${base}/api/payments/config`), cookie = config.headers.get("set-cookie").split(";")[0]; await config.json();
  const post = (key = randomUUID(), input = nft) => fetch(`${base}/api/payments/invoices`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input),
  });
  return { store, processor, invoices, post, counts: () => ({ preflights, issues, checkpoints }) };
}

for (const code of ["NFT_NOT_OWNED", "NFT_DAILY_LIMIT"]) test(`fresh ${code} rejection consumes no immutable request key or custody work`, async t => {
  const f = await fixture(t), key = randomUUID();
  f.processor.preflightNft = async () => { throw Object.assign(new Error("private RPC diagnostic"), { code }); };
  const response = await f.post(key), body = await response.json();
  assert.equal(response.status, 422); assert.equal(body.code, code); assert.equal(body.creationNotStarted, true);
  assert.doesNotMatch(JSON.stringify(body), /private RPC/);
  assert.equal(f.store.requests.find(key), null); assert.equal(f.counts().issues, 0); assert.equal(f.counts().checkpoints, 0);
  f.processor.preflightNft = async () => {};
  assert.equal((await f.post(key)).status, 201, "a rejected unclaimed key can later start its first invoice");
  assert.equal(f.counts().issues, 1); assert.equal(f.store.requests.find(key).state, "complete");
});

test("malformed input, preflight timeout and a missing preflight cannot consume journal capacity", async t => {
  const f = await fixture(t), malformed = randomUUID();
  assert.equal((await f.post(malformed, { ...nft, recipient: "not-allowed" })).status, 400);
  assert.equal(f.store.requests.find(malformed), null); assert.equal(f.counts().preflights, 0);
  const timeout = randomUUID();
  f.processor.preflightNft = async () => { throw Object.assign(new Error("private upstream timeout"), { name: "TimeoutError" }); };
  const response = await f.post(timeout), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.creationNotStarted, true);
  assert.equal(body.code, "NFT_ELIGIBILITY_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(body), /private upstream/);
  assert.equal(f.store.requests.find(timeout), null);
  delete f.processor.preflightNft;
  const missing = randomUUID(), unavailable = await f.post(missing);
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).creationNotStarted, true);
  assert.equal(f.store.requests.find(missing), null); assert.equal(f.counts().issues, 0); assert.equal(f.counts().checkpoints, 0);
});

test("fresh NFT preflight holds its preparation slot while CHOG remains independent", async t => {
  const f = await fixture(t), firstKey = randomUUID(), secondKey = randomUUID();
  let entered, release;
  const started = new Promise(done => { entered = done; }), waiting = new Promise(done => { release = done; });
  f.processor.preflightNft = async () => { entered(); await waiting; };
  const first = f.post(firstKey); await started;
  try {
    assert.equal(f.store.requests.find(firstKey), null, "preflight must precede the durable claim");
    const overlapping = await f.post(secondKey); assert.equal(overlapping.status, 429); await overlapping.json();
    assert.equal(f.store.requests.find(secondKey), null);
    const independent = await f.post(randomUUID(), chog); assert.equal(independent.status, 201); await independent.json();
  } finally { release(); }
  assert.equal((await first).status, 201); assert.equal(f.counts().issues, 2);
});

for (const integrityLocked of [false, true]) test(`readiness/integrity is checked again after NFT preflight (integrity=${integrityLocked})`, async t => {
  const f = await fixture(t), key = randomUUID();
  f.processor.preflightNft = async () => { f.processor.publicStatus = () => ({ paymentsEnabled: true, nftPaymentsEnabled: false, integrityLocked }); };
  const response = await f.post(key), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, integrityLocked ? "INTEGRITY_HOLD" : "PAYMENTS_NOT_READY");
  assert.equal(body.creationNotStarted, integrityLocked ? undefined : true);
  assert.equal(f.store.requests.find(key), null); assert.equal(f.counts().issues, 0); assert.equal(f.counts().checkpoints, 0);
});

test("existing proven-unallocated NFT intent keeps its original ID and skips fresh preflight", async t => {
  const f = await fixture(t), key = randomUUID(), entry = f.store.requests.claim(key, digest(nft));
  delete f.processor.preflightNft;
  f.processor.canRetryUnissuedNft = id => id === entry.invoice_id;
  const response = await f.post(key); assert.equal(response.status, 201); assert.equal((await response.json()).id, entry.invoice_id);
  assert.equal(f.store.requests.find(key).invoice_id, entry.invoice_id); assert.equal(f.counts().issues, 1);
  f.processor.publicStatus = () => ({ nftPaymentsEnabled: false, paymentsEnabled: false, integrityLocked: false });
  const recovered = await f.post(key); assert.equal(recovered.status, 201); assert.equal((await recovered.json()).id, entry.invoice_id);
  assert.equal(f.counts().issues, 1, "completed recovery does not call preflight or issue again");
});

test("ownership failure after preflight preserves an ambiguous claimed intent across retries", async t => {
  const f = await fixture(t), key = randomUUID();
  f.processor.issue = async () => { throw Object.assign(new Error("ownership changed after preflight"), { code: "NFT_NOT_OWNED" }); };
  f.processor.canRetryUnissuedNft = () => false;
  const response = await f.post(key), body = await response.json(), entry = f.store.requests.find(key);
  assert.equal(response.status, 409); assert.equal(body.code, "REQUEST_PENDING"); assert.equal(body.creationNotStarted, undefined);
  assert.equal(entry.state, "pending"); assert.equal(f.counts().preflights, 1);
  const retried = await f.post(key); assert.equal(retried.status, 409); await retried.json();
  assert.equal(f.store.requests.find(key).invoice_id, entry.invoice_id); assert.equal(f.counts().preflights, 1);
});

test("a concurrent cross-mode key claim cannot be labelled never-started by NFT preflight rejection", async t => {
  const f = await fixture(t), key = randomUUID();
  let entered, release;
  const started = new Promise(done => { entered = done; }), waiting = new Promise(done => { release = done; });
  f.processor.preflightNft = async () => { entered(); await waiting; throw Object.assign(new Error("not owned"), { code: "NFT_NOT_OWNED" }); };
  const first = f.post(key); await started;
  let allocated;
  try {
    const competing = await f.post(key, chog); assert.equal(competing.status, 201); allocated = await competing.json();
  } finally { release(); }
  const rejected = await first, body = await rejected.json();
  assert.equal(rejected.status, 422); assert.equal(body.creationNotStarted, undefined);
  assert.equal(f.store.requests.find(key).invoice_id, allocated.id); assert.equal(f.store.requests.find(key).state, "complete");
});
