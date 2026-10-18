import test from "node:test";
import assert from "node:assert/strict";
import { activeInvoiceKeys, closeSavedInvoice, recentSavedInvoices, recoveryBundle, rememberInvoice } from "../src/checkout-session.ts";
import { loadDonationImageReceipt } from "../src/donation-image-receipt.ts";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";

const id = "a".repeat(64), nftId = "b".repeat(64), hash = "0x" + "c".repeat(64), address = "0x1111111111111111111111111111111111111111";
const shared = { kind: "payment", id, state: "delivered", chainId: 143, destinationChainId: 10, initiativeId: "school-supplies", recipient: chogBeneficiary("school-supplies", 10), depositAddress: address, expiresAt: 1792400000000, depositHash: hash, destinationHash: hash, observedDestinationHash: null, message: null };
const chog = { ...shared, mode: "chog", asset: "CHOG", amount: "330", donationAmount: "300", poolContributionAmount: "30", contributionPercent: 10, poolContributionState: "collected", minUsdc: "200000", minimumUsd: "200000", destinationAsset: "USDC", destinationDecimals: 6, bridgeHash: hash, deliveredUsdc: "450000", paymentUri: `ethereum:${CHOG}@143/transfer?address=${address}&uint256=${330n * 10n ** 18n}` };
const nft = { ...shared, id: nftId, mode: "nft", asset: "MON", amount: "1", subsidyUsdc: "1.00", tokenId: "7", holderAddress: "0x2222222222222222222222222222222222222222", claimDay: "2026-10-18", paymentUri: `ethereum:${address}@143?value=1000000000000000000` };
const signal = () => new AbortController().signal;
const response = value => async () => new Response(JSON.stringify(value));
function memory() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }

test("completed profiles remain accessible as image receipts after reload without replacing a different active invoice", () => {
  const store = memory(); rememberInvoice("chog", id, store, "school-supplies"); closeSavedInvoice("chog", store); rememberInvoice("nft", nftId, store, "school-supplies");
  const before = recoveryBundle(store);
  assert.deepEqual(recentSavedInvoices(store), [{ mode: "chog", id }]);
  assert.equal(recoveryBundle(store), before);
  assert.equal(store.getItem(activeInvoiceKeys.nft), nftId);
  assert.equal(store.getItem(activeInvoiceKeys.chog), null);
});

test("legacy v1 receipt history is read newest first, bounded and never rewritten", () => {
  const store = memory(), history = Array.from({ length: 24 }, (_, i) => ({ mode: i % 2 ? "nft" : "chog", id: (i + 1).toString(16).padStart(64, "0") }));
  store.setItem("chogcare:invoice-history:v1", JSON.stringify(history));
  assert.deepEqual(recentSavedInvoices(store), history.slice(-20).reverse());
  assert.equal(store.getItem("chogcare:invoice-history:v1"), JSON.stringify(history));
  store.setItem("chogcare:invoice-history:v1", JSON.stringify([{ mode: "chog", id: "../private" }]));
  assert.throws(() => recentSavedInvoices(store));
});

test("saved image loader performs only a same-origin read and projects the verified donation amount", async () => {
  const calls = [], request = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(chog)); };
  assert.deepEqual(await loadDonationImageReceipt({ mode: "chog", id }, signal(), request), { state: "delivered", mode: "chog", initiativeId: "school-supplies", amount: "300" });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `/api/payments/invoices/${id}`); assert.equal(calls[0].options.credentials, "same-origin"); assert.equal(calls[0].options.method, undefined);
  for (const amount of ["0.50", "1.00"]) assert.equal((await loadDonationImageReceipt({ mode: "nft", id: nftId }, signal(), response({ ...nft, subsidyUsdc: amount }))).amount, amount);
});

test("saved image loader rejects identity substitution, unverifiable receipts and path injection", async () => {
  let calls = 0; const noRequest = async () => { calls++; throw Error("unexpected request"); };
  for (const value of ["../private", `${id}\n`, "https://example.com"]) await assert.rejects(loadDonationImageReceipt({ mode: "chog", id: value }, signal(), noRequest));
  assert.equal(calls, 0);
  await assert.rejects(loadDonationImageReceipt({ mode: "chog", id }, signal(), response({ ...chog, id: nftId })));
  await assert.rejects(loadDonationImageReceipt({ mode: "nft", id }, signal(), response(chog)));
  await assert.rejects(loadDonationImageReceipt({ mode: "chog", id }, signal(), response({ ...chog, destinationHash: null })));
  await assert.rejects(loadDonationImageReceipt({ mode: "chog", id }, signal(), async () => new Response("{}", { status: 503 })));
});
