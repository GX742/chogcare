import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { assertUnpaidCheckout, closeSavedInvoice, recoveryBundle, rememberInvoice, savedInvoice } from "../src/checkout-session.ts";
import { closeHeldCheckout, closeRefundedCheckout, closeVerifiedRefund, heldCheckoutKind, isRefundedCheckout } from "../src/refunded-checkout.ts";

const id = "a".repeat(64), otherId = "b".repeat(64), address = "0x1111111111111111111111111111111111111111", hash = "0x" + "c".repeat(64);
const marker = "The underpaid 300 CHOG transfer was refunded to its verified original sender. Do not pay this invoice again.";
const underpaid = "Received 300 CHOG. This invoice requires 330 CHOG. Processing is on hold; do not pay again.";
function invoice(changes = {}) {
  return { kind: "payment", id, mode: "chog", asset: "CHOG", chainId: 143, amount: "330", initiativeId: "school-supplies",
    recipient: chogBeneficiary("school-supplies", 10), depositAddress: address,
    paymentUri: `ethereum:${CHOG}@143/transfer?address=${address}&uint256=${330n * 10n ** 18n}`,
    minUsdc: "200000", minimumUsd: "200000", state: "manual-review", expiresAt: 1792400000000,
    depositHash: null, bridgeHash: null, destinationHash: null, deliveredUsdc: null, observedUsdc: null, observedDestinationHash: null,
    message: marker, destinationChainId: 10, destinationAsset: "USDC", destinationDecimals: 6,
    donationAmount: "300", poolContributionAmount: "30", contributionPercent: 10, poolContributionState: "pending", ...changes };
}
function memory() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }

test("only the exact completed underpayment marker and validated fixed quote permits a refund close", () => {
  assert.equal(isRefundedCheckout(id, invoice()), true);
  assert.equal(isRefundedCheckout(id, {}), false);
  for (const changed of [null, { kind: "preview" }, { id: otherId }, { mode: "nft" }, { amount: "300" },
    { donationAmount: "301" }, { poolContributionAmount: "0" }, { contributionPercent: 0 }, { poolContributionState: "collected" },
    { paymentUri: "ethereum:untrusted" }, { chainId: 1 }, { recipient: address }, { message: null }, { message: marker + " " },
    { message: "Received 300 CHOG. This invoice requires 330 CHOG. Processing is on hold; do not pay again." },
    { message: "The refund is pending." }, { message: "Refund completed" }]) {
    assert.equal(isRefundedCheckout(id, changed === null ? null : invoice(changed)), false);
  }
  assert.equal(isRefundedCheckout(otherId, invoice()), false);
  assert.equal(isRefundedCheckout(id + "\n", invoice()), false);
});

test("processing, held funds, any receipts, timing or received accounting still prevents the separate refund close", () => {
  for (const state of ["awaiting-payment", "expired", "processing", "bridging", "confirming", "delivered", "unknown"]) {
    assert.equal(isRefundedCheckout(id, invoice({ state })), false);
  }
  for (const field of ["depositHash", "bridgeHash", "destinationHash", "observedDestinationHash"]) {
    assert.equal(isRefundedCheckout(id, invoice({ [field]: hash })), false, field);
  }
  for (const field of ["processingStartedAt", "bridgeStartedAt", "destinationIncludedAt"]) {
    assert.equal(isRefundedCheckout(id, invoice({ [field]: 1000 })), false, field);
  }
  for (const field of ["deliveredUsdc", "observedUsdc"]) assert.equal(isRefundedCheckout(id, invoice({ [field]: "200000" })), false, field);
  assert.equal(isRefundedCheckout(id, invoice({ depositHash: hash, receivedAmount: "330", receivedDonationAmount: "300", receivedPoolContributionAmount: "30" })), false);
  for (const field of ["receivedAmount", "receivedDonationAmount", "receivedPoolContributionAmount"]) {
    assert.equal(isRefundedCheckout(id, invoice({ [field]: "300" })), false, field);
  }
  assert.throws(() => assertUnpaidCheckout(id, invoice()), /may be processing/);
});

test("only the known untouched 300-of-330 underpayment can be explicitly archived while remaining on hold", () => {
  const held = invoice({ message: underpaid });
  assert.equal(heldCheckoutKind(id, held), "underpaid");
  assert.equal(isRefundedCheckout(id, held), false);
  assert.throws(() => assertUnpaidCheckout(id, held), /may be processing/);
  let closed = 0;
  assert.equal(closeVerifiedRefund(id, held, () => closed++), false);
  assert.equal(closed, 0, "the stale unpaid-cancel action must not archive an underpayment");
  for (const changed of [{ id: otherId }, { state: "processing" }, { state: "bridging" }, { state: "awaiting-payment" },
    { message: underpaid + " " }, { message: "Processing is on hold; do not pay again." }, { amount: "331" },
    { donationAmount: "301" }, { poolContributionAmount: "31" }, { contributionPercent: 0 }, { poolContributionState: "collected" },
    { depositHash: hash }, { bridgeHash: hash }, { destinationHash: hash }, { observedDestinationHash: hash },
    { processingStartedAt: 1000 }, { bridgeStartedAt: 1000 }, { destinationIncludedAt: 1000 },
    { receivedAmount: "300" }, { receivedDonationAmount: "300" }, { receivedPoolContributionAmount: "0" },
    { deliveredUsdc: "200000" }, { observedUsdc: "200000" }]) {
    assert.equal(heldCheckoutKind(id, { ...held, ...changed }), null);
  }
});

test("explicit held-payment archive rechecks the same case, keeps history and never posts a cancellation", async () => {
  const held = invoice({ message: underpaid }), store = memory(), calls = [];
  rememberInvoice("chog", id, store, "school-supplies");
  await closeHeldCheckout(id, "underpaid", () => closeSavedInvoice("chog", store), { request: async (url, options) => {
    calls.push({ url, options }); assert.equal(options.method, "GET"); return Response.json(held);
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.cache, "no-store");
  assert.equal(savedInvoice("chog", store), "");
  assert.deepEqual(JSON.parse(recoveryBundle(store)).history, [{ mode: "chog", id }]);
  assert.equal(held.state, "manual-review"); assert.equal(held.message, underpaid);
  for (const reply of [invoice(), invoice({ message: "Unknown hold" }), invoice({ message: underpaid, id: otherId }), invoice({ message: underpaid, depositHash: hash })]) {
    rememberInvoice("chog", id, store, "school-supplies");
    await assert.rejects(closeHeldCheckout(id, "underpaid", () => closeSavedInvoice("chog", store), { request: async () => Response.json(reply) }));
    assert.equal(savedInvoice("chog", store), id);
  }
  const freshStore = memory(); rememberInvoice("chog", id, freshStore, "school-supplies");
  const broken = { ...freshStore, setItem() { throw new Error("storage full"); } };
  await assert.rejects(closeHeldCheckout(id, "underpaid", () => closeSavedInvoice("chog", broken), { request: async () => Response.json(held) }));
  assert.equal(savedInvoice("chog", freshStore), id);
});

test("fresh refund confirmation uses only one bounded no-store GET and archives recovery history without a cancel POST", async t => {
  const store = memory(), calls = [], deadline = new AbortController().signal;
  rememberInvoice("chog", id, store, "school-supplies");
  t.mock.method(AbortSignal, "timeout", ms => { assert.equal(ms, 12_000); return deadline; });
  await closeRefundedCheckout(id, () => closeSavedInvoice("chog", store), { request: async (url, options) => {
    calls.push({ url, options }); assert.equal(options.method, "GET");
    assert.equal(savedInvoice("chog", store), id);
    return Response.json(invoice());
  } });
  assert.deepEqual(calls, [{ url: `/api/payments/invoices/${id}`, options: { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: deadline } }]);
  assert.equal(savedInvoice("chog", store), "");
  assert.deepEqual(JSON.parse(recoveryBundle(store)).history, [{ mode: "chog", id }]);
});

test("failed refetch, changed identity, unknown hold or altered instructions never closes or clears the saved invoice", async () => {
  for (const reply of [() => Response.json(invoice({ id: otherId })), () => Response.json(invoice({ state: "processing" })),
    () => Response.json(invoice({ message: "Refund is pending" })), () => Response.json(invoice({ depositHash: hash })),
    () => Response.json(invoice({ paymentUri: "wrong" })), () => Response.json(invoice(), { status: 503 }),
    () => new Response("not json"), () => { throw new Error("private diagnostic must not escape"); }]) {
    const store = memory(); rememberInvoice("chog", id, store, "school-supplies");
    await assert.rejects(closeRefundedCheckout(id, () => closeSavedInvoice("chog", store), { request: async () => reply() }),
      error => error.message === "The completed refund could not be verified. Keep this invoice open; do not pay again.");
    assert.equal(savedInvoice("chog", store), id);
    assert.deepEqual(JSON.parse(recoveryBundle(store)).history, []);
  }
});

test("abort before or during the fresh response prevents close even if a late response claims success", async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); let closed = 0, requests = 0;
    if (before) controller.abort();
    await assert.rejects(closeRefundedCheckout(id, () => closed++, { signal: controller.signal, request: async () => {
      requests++; controller.abort(); return Response.json(invoice());
    } }));
    assert.equal(closed, 0); assert.equal(requests, before ? 0 : 1);
  }
});

test("a late held-payment response cannot archive a different active invoice or touch a pending request", async () => {
  const store = memory(), pendingKey = "chogcare:pending-chog:v1", pendingValue = "preserved pending recovery";
  rememberInvoice("chog", id, store, "school-supplies"); store.setItem(pendingKey, pendingValue);
  let closed = 0;
  await assert.rejects(closeHeldCheckout(id, "underpaid", () => { closed++; closeSavedInvoice("chog", store); }, {
    isCurrent: () => savedInvoice("chog", store) === id,
    request: async () => {
      store.setItem("chogcare:active-invoice:v1", otherId);
      return Response.json(invoice({ message: underpaid }));
    },
  }));
  assert.equal(closed, 0); assert.equal(savedInvoice("chog", store), otherId); assert.equal(store.getItem(pendingKey), pendingValue);
  assert.equal(store.getItem("chogcare:invoice-history:v1"), null);
});

test("a newer same-id observation of processing blocks an older successful archive response", async () => {
  let current = invoice({ message: underpaid }), closed = 0;
  await assert.rejects(closeHeldCheckout(id, "underpaid", () => closed++, {
    isCurrent: () => heldCheckoutKind(id, current) === "underpaid",
    request: async () => {
      current = invoice({ state: "processing", depositHash: hash });
      return Response.json(invoice({ message: underpaid }));
    },
  }));
  assert.equal(closed, 0);
});

test("a fresh result from the stale cancel dialog takes the separate completed-refund branch while other holds stay blocked", () => {
  let closed = 0;
  assert.equal(closeVerifiedRefund(id, invoice(), () => closed++), true);
  assert.equal(closed, 1);
  for (const raw of [invoice({ id: otherId }), invoice({ message: "Refund pending" }), invoice({ state: "processing" }), invoice({ depositHash: hash })]) {
    assert.equal(closeVerifiedRefund(id, raw, () => closed++), false);
    assert.throws(() => assertUnpaidCheckout(id, raw, { allowExpired: true }));
  }
  assert.equal(closed, 1);
  const cancel = readFileSync(new URL("../src/CancelCheckout.tsx", import.meta.url), "utf8");
  assert.ok(cancel.indexOf('mode === "chog" && closeVerifiedRefund(id, invoice, closeCurrentRefund)') < cancel.indexOf("assertUnpaidCheckout(id, invoice"));
  assert.match(cancel, /closeVerifiedRefund\(id, invoice, closeCurrentRefund\)\) return;/);
  assert.match(cancel, /savedInvoice\("chog"\) !== id\) throw new Error/);
  assert.match(cancel, /heldCheckoutKind\(id, invoice\) === "underpaid"\) throw new Error/);
});

test("archiving failure preserves the original active reference and the refund remains retryable", async () => {
  const store = memory(); rememberInvoice("chog", id, store, "school-supplies");
  const broken = { ...store, setItem() { throw new Error("storage full"); } };
  await assert.rejects(closeRefundedCheckout(id, () => closeSavedInvoice("chog", broken), { request: async () => Response.json(invoice()) }));
  assert.equal(savedInvoice("chog", store), id);
  assert.equal(isRefundedCheckout(id, invoice()), true);
});

test("the explicit button uses revalidation and the send caption repeats the immutable invoice total", () => {
  const source = readFileSync(new URL("../src/LiveChogCheckout.tsx", import.meta.url), "utf8");
  assert.match(source, /archiveKind&&<>/);
  assert.match(source, /await closeHeldCheckout\(id,archiveKind,reset,\{isCurrent:\(\)=>savedInvoice\("chog"\)===id&&currentInvoice\.current\?\.id===id&&heldCheckoutKind\(id,currentInvoice\.current\)===archiveKind\}\)/);
  assert.match(source, /Refund completed · start a new donation/);
  assert.match(source, /Start a new donation · keep this payment/);
  assert.match(source, /Your 300 CHOG payment is still on hold\. It has not been refunded or donated\./);
  assert.match(source, /A new donation uses a new address\./);
  assert.match(source, /Amount for the cause/);
  assert.match(source, /Send exactly \{invoice\.amount\} \$CHOG/);
});
