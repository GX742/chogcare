import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createPaymentService } from "../server/payment-service.mjs";

const invoiceId = "e".repeat(64);
const origin = "http://127.0.0.1:4173";
const profileInput = { invoiceId, nickname: "Safe Donor", avatarTokenId: null };
const context = { state: "delivered", initiativeId: "school-supplies", amount: "300", nfts: [] };

async function serviceFixture(t, processor) {
  // Test-owned in-memory SQLite only. No real worker, custody key or chain call.
  const store = openInvoiceStore(":memory:");
  const service = createPaymentService(store, origin, true, processor);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(async () => {
    await new Promise(resolve => service.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const publish = () => fetch(`${base}/api/payments/leaderboard`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(profileInput),
  });
  return { store, base, publish };
}

function seedProfile(store) {
  return store.publishDonorProfile({
    ...profileInput, initiativeId: context.initiativeId, amount: "300",
    amountUnits: "300000000000000000000", publishedAt: 1,
  });
}

async function assertHeld(response) {
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "INTEGRITY_HOLD");
  assert.equal("profile" in body, false);
  assert.equal("nfts" in body, false);
  assert.match(body.error, /do not pay again/i);
  return body;
}

test("integrity hold blocks existing donor profiles, public board and publication before reads or writes", async t => {
  let lookups = 0, donationReads = 0, checkpoints = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: true }),
    profileNfts: async () => { lookups++; return context; },
    leaderboardDonation: () => { donationReads++; return null; },
    checkpoint: async () => { checkpoints++; },
  };
  const { store, base, publish } = await serviceFixture(t, processor);
  const existing = seedProfile(store);
  await assertHeld(await fetch(`${base}/api/payments/invoices/${invoiceId}/profile`));
  await assertHeld(await fetch(`${base}/api/payments/leaderboard`));
  await assertHeld(await publish());
  assert.deepEqual(store.findDonorProfile(invoiceId), existing);
  assert.deepEqual({ lookups, donationReads, checkpoints }, { lookups: 0, donationReads: 0, checkpoints: 0 });
});

test("integrity becoming locked during NFT lookup prevents profile publication and disclosure", async t => {
  let locked = false, checkpoints = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: locked }),
    profileNfts: async () => { locked = true; return context; },
    checkpoint: async () => { checkpoints++; },
  };
  const { store, base, publish } = await serviceFixture(t, processor);
  await assertHeld(await publish());
  assert.equal(store.findDonorProfile(invoiceId), null);
  locked = false;
  await assertHeld(await fetch(`${base}/api/payments/invoices/${invoiceId}/profile`));
  assert.equal(checkpoints, 0);
});

test("integrity hold prohibits preview writes to the protected companion store", async t => {
  let checkpoints = 0, previewWrites = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: true }),
    checkpoint: async () => { checkpoints++; },
  };
  const { store, base } = await serviceFixture(t, processor);
  const originalSave = store.savePreview;
  store.savePreview = (...args) => { previewWrites++; return originalSave(...args); };
  const response = await fetch(`${base}/api/payments/previews`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "chog", amount: "300", holderAddress: "", initiativeId: "school-supplies" }),
  });
  await assertHeld(response);
  assert.equal(previewWrites, 0);
  assert.equal(checkpoints, 0);
});

test("preview issuance rechecks integrity after asynchronous request-body admission", async t => {
  let statusReads = 0, previewWrites = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: ++statusReads > 1 }),
    checkpoint: async () => assert.fail("Locked preview must not checkpoint"),
  };
  const { store, base } = await serviceFixture(t, processor);
  store.savePreview = () => { previewWrites++; assert.fail("Locked preview must not be saved"); };
  await assertHeld(await fetch(`${base}/api/payments/previews`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "chog", amount: "300", holderAddress: "", initiativeId: "school-supplies" }),
  }));
  assert.equal(previewWrites, 0);
  assert.equal(statusReads, 2);
});

test("failed publication checkpoint returns an integrity hold, never successful recovered profile", async t => {
  let locked = false, checkpoints = 0, lookups = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: locked }),
    profileNfts: async () => { lookups++; return context; },
    checkpoint: async () => {
      checkpoints++;
      locked = true;
      throw new Error("Private database path and RPC secret must not be exposed");
    },
  };
  const { store, base, publish } = await serviceFixture(t, processor);
  const body = await assertHeld(await publish());
  assert.doesNotMatch(JSON.stringify(body), /Private database|RPC secret/);
  // Do not roll back a committed row or reset its integrity checkpoint. Preserve
  // it for owner reconciliation, but gate all public reads and retries.
  assert.equal(store.findDonorProfile(invoiceId).nickname, "Safe Donor");
  await assertHeld(await publish());
  await assertHeld(await fetch(`${base}/api/payments/invoices/${invoiceId}/profile`));
  assert.equal(checkpoints, 1);
  assert.equal(lookups, 1);
});

test("a checkpoint failure is fail closed even if a custom worker has not yet reported its hold", async t => {
  const processor = {
    publicStatus: () => ({ integrityLocked: false }),
    profileNfts: async () => context,
    checkpoint: async () => { throw new Error("Sensitive exception details"); },
  };
  const { publish } = await serviceFixture(t, processor);
  await assertHeld(await publish());
  // The previous implementation recovered the inserted profile from this catch
  // and returned HTTP200. Repeating must also require a successful checkpoint.
  await assertHeld(await publish());
});

test("a profile is successful only after its checkpoint and post-checkpoint integrity check", async t => {
  let locked = false, checkpoints = 0;
  const processor = {
    publicStatus: () => ({ integrityLocked: locked, paymentsEnabled: false }),
    profileNfts: async () => context,
    checkpoint: async () => { checkpoints++; },
  };
  const { store, publish } = await serviceFixture(t, processor);
  let response = await publish();
  assert.equal(response.status, 201);
  assert.equal((await response.json()).profile.nickname, "Safe Donor");
  assert.equal(checkpoints, 1);
  processor.checkpoint = async () => { checkpoints++; locked = true; };
  await assertHeld(await publish());
  assert.equal(checkpoints, 2);
  assert.equal(store.leaderboardRecords().length, 1);
});
