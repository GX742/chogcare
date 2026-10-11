import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";

test("own payment API creates non-payable previews and refuses real invoices", async t => {
  const store = openInvoiceStore(":memory:");
  const service = createPaymentService(store);
  service.listen(0, "127.0.0.1"); await once(service, "listening");
  t.after(async () => { await new Promise(resolve => service.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const post = (path, body, origin = "http://127.0.0.1:4173") => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  const config = await (await fetch(base + "/api/payments/config")).json();
  assert.equal(config.paymentsEnabled, false);
  assert.equal(config.verificationDisposition, "non-refundable donation");
  assert.match(config.claimFrequency, /UTC/);
  assert.equal(config.dailyPoolLimitUsdc, "10.00");
  assert.equal(config.maxDailyClaims, 20);
  assert.equal(config.poolFunded, false);
  assert.equal(config.availableClaims, 0);
  const request = { mode: "nft", amount: "1", holderAddress: "0x1111111111111111111111111111111111111111", initiativeId: "burundi" };
  const result = await post("/api/payments/previews", request);
  assert.equal(result.status, 201);
  const preview = await result.json();
  assert.equal(preview.kind, "preview");
  assert.ok(!("depositAddress" in preview));
  assert.equal(store.findPreview(preview.id).holderAddress, undefined);
  assert.equal((await post("/api/payments/invoices", request)).status, 503);
  assert.equal((await post("/api/payments/previews", { ...request, amount: "2" })).status, 400);
  assert.equal((await post("/api/payments/previews", { ...request, initiativeId: "attacker" })).status, 400);
  assert.equal((await post("/api/payments/previews", request, "https://untrusted.example")).status, 403);
  const tooLarge = await post("/api/payments/previews", { extra: "a".repeat(5000) });
  assert.equal(tooLarge.status, 413);
  const malformed = await fetch(base + "/api/payments/previews", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4173" }, body: "{" });
  assert.equal(malformed.status, 400);
});

test("proof ledger prevents tx replay and a second daily claim after NFT transfer", () => {
  const store = openInvoiceStore(":memory:");
  try {
    const proof = { kind: "confirmed-nft-transfer", invoiceId: "a", chainId: 143, txHash: "0x" + "ab".repeat(32), collection: "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763", tokenId: "12", sender: "0x1111111111111111111111111111111111111111", blockNumber: "100", blockHash: "0x" + "ee".repeat(32) };
    const day = Date.parse("2026-10-08T12:00:00Z");
    store.recordNftProof(proof, day);
    assert.throws(() => store.recordNftProof({ ...proof, invoiceId: "b" }, day));
    assert.throws(() => store.recordNftProof({ ...proof, invoiceId: "c", txHash: "0x" + "cd".repeat(32), tokenId: "012", sender: "0x2222222222222222222222222222222222222222" }, day));
    // Old payment cannot be recycled tomorrow, but a fresh proof can be recorded.
    assert.throws(() => store.recordNftProof({ ...proof, invoiceId: "d" }, day + 86_400_000));
    store.recordNftProof({ ...proof, invoiceId: "e", txHash: "0x" + "ef".repeat(32) }, day + 86_400_000);
    assert.throws(() => store.savePreview({ kind: "live", id: "x", depositAddress: "0x123" }));
  } finally { store.close(); }
});
