import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";

const invoiceId = "d".repeat(64), origin = "http://127.0.0.1:4173";
async function fixture(t, processor = {}) {
  const store = openInvoiceStore(":memory:");
  const server = createPaymentService(store, origin, true, processor);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.close(); await once(server, "close"); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, get: () => fetch(`${base}/api/payments/leaderboard`), publish: nickname => fetch(`${base}/api/payments/leaderboard`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ invoiceId, nickname, avatarTokenId: null }),
  }) };
}

test("direct profile requests cannot bypass new-name moderation or trigger ownership lookups", async t => {
  let lookups = 0;
  const f = await fixture(t, { profileNfts: async () => { lookups++; return { initiativeId: "school-supplies", amount: "300", nfts: [] }; } });
  for (const nickname of ["fuck", "сука", "NFT Pool", "Admin", "free-usdt.com"]) {
    const response = await f.publish(nickname), body = await response.json();
    assert.equal(response.status, 400, nickname);
    assert.match(body.code, /^NICKNAME_/);
    assert.equal(f.store.findDonorProfile(invoiceId), null);
    assert.equal(Object.hasOwn(body, "nickname"), false);
  }
  assert.equal(lookups, 0);
  const published = await f.publish("GX");
  assert.equal(published.status, 201); assert.equal((await published.json()).profile.nickname, "GX");
  assert.equal(lookups, 1);
});

test("existing profiles remain readable and idempotent when a later moderation rule would reject their name", async t => {
  let lookups = 0, checkpoints = 0;
  const f = await fixture(t, { profileNfts: async () => { lookups++; throw new Error("Must not reverify published profiles"); }, checkpoint: async () => { checkpoints++; } });
  f.store.publishDonorProfile({ invoiceId, nickname: "Admin", initiativeId: "school-supplies", amount: "300", amountUnits: String(300n * 10n ** 18n), avatarTokenId: null, publishedAt: 1 });
  const response = await f.publish("fuck");
  assert.equal(response.status, 200); assert.equal((await response.json()).profile.nickname, "Admin");
  assert.equal(f.store.findDonorProfile(invoiceId).nickname, "Admin");
  assert.equal(lookups, 0); assert.equal(checkpoints, 1);
});

test("pool summary stays outside donor entries and exposes only public exact-USDC totals", async t => {
  const f = await fixture(t, { nftPoolImpact: () => ({ donatedUsdc: "2500000", donations: 4, wallet: "PRIVATE", invoiceId, txHash: "PRIVATE", rank: 1 }) });
  const response = await f.get(), body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { entries: [], pool: { donatedUsdc: "2500000", donations: 4 } });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|invoice|wallet|txHash|rank/);
});

test("missing, failing and malformed pool sources preserve the donor endpoint with unavailable statistics", async t => {
  let source = null;
  const f = await fixture(t, { nftPoolImpact: () => { if (source === "throw") throw new Error("PRIVATE failure"); return source; } });
  for (source of [null, "throw", { donatedUsdc: "0", donations: 1 }, { donatedUsdc: "1e6", donations: 1 }]) {
    const response = await f.get(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { entries: [], pool: null });
  }
  source = { donatedUsdc: "0", donations: 0 };
  assert.deepEqual((await (await f.get()).json()).pool, source);
});

test("an integrity hold blocks moderation writes and pool totals before invoking their sources", async t => {
  let sourceCalls = 0;
  const f = await fixture(t, { publicStatus: () => ({ integrityLocked: true }), profileNfts: () => { sourceCalls++; }, nftPoolImpact: () => { sourceCalls++; } });
  for (const response of [await f.get(), await f.publish("GX")]) { assert.equal(response.status, 503); assert.equal((await response.json()).code, "INTEGRITY_HOLD"); }
  assert.equal(sourceCalls, 0); assert.equal(f.store.findDonorProfile(invoiceId), null);
});
