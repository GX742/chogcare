import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSupportRequest, parseSupportTicket, sendSupportRequest, supportDraft, SupportSendError } from "../src/support-model.ts";

const invoiceId = "a".repeat(64), requestId = "12345678-1234-4123-8123-123456789abc";
const newId = "87654321-1234-4321-8321-abcdef123456", ticket = { reference: "ABCDEF123456", createdAt: 1_791_700_000_000 };
const randomUuid = () => requestId;
const context = { mode: "chog", invoiceId, issue: "invoice-review", walletAddress: "private", recoveryKey: "private", error: "raw RPC secret" };

test("support defaults to no invoice and never copies raw diagnostics or private context", () => {
  const draft = supportDraft(context), request = createSupportRequest(draft, context, null, randomUuid);
  assert.equal(draft.includeInvoice, false); assert.equal(request.invoiceId, undefined);
  assert.deepEqual(Object.keys(request).sort(), ["message", "requestId", "subject"]);
  assert.ok(!JSON.stringify(request).includes("private")); assert.ok(!JSON.stringify(request).includes("raw RPC"));
});
test("a private invoice reference is attached only after explicit valid consent", () => {
  const draft = { ...supportDraft(context), includeInvoice: true };
  assert.equal(createSupportRequest(draft, context, null, randomUuid).invoiceId, invoiceId);
  assert.throws(() => createSupportRequest(draft, { invoiceId: `${invoiceId}\n` }, null, randomUuid));
  assert.throws(() => createSupportRequest({ ...draft, includeInvoice: "yes" }, context, null, randomUuid));
});
test("identical retries keep the same UUID; a changed request gets a new UUID", () => {
  const draft = supportDraft(context), first = createSupportRequest(draft, context, null, randomUuid);
  const repeated = createSupportRequest(draft, context, first, () => { throw new Error("must not generate another UUID"); });
  assert.equal(repeated, first);
  assert.equal(createSupportRequest({ ...draft, message: "A different support message." }, context, first, () => newId).requestId, newId);
  assert.equal(createSupportRequest({ ...draft, contact: "  reply@example.com  " }, context, null, randomUuid).contact, "reply@example.com");
});
test("support validates lengths, controls and required text before a request", () => {
  const draft = supportDraft(context);
  for (const changed of [{ subject: " " }, { message: "" }, { subject: "a".repeat(81) }, { message: "a".repeat(1601) }, { contact: "a".repeat(161) }, { message: "hidden\u0000value" }, { subject: "a\nb" }, { contact: "a\tb" }, { message: "unsafe\u202etext" }, { message: "bad\ud800surrogate" }]) assert.throws(() => createSupportRequest({ ...draft, ...changed }, context, null, randomUuid));
  assert.equal(createSupportRequest({ ...draft, message: "Hello 💜\nPlease help." }, context, null, randomUuid).message, "Hello 💜\nPlease help.");
  assert.throws(() => createSupportRequest(draft, context, null, () => "not-secure"));
});
test("ticket confirmation exposes only a bounded public reference and creation time", () => {
  assert.deepEqual(parseSupportTicket({ ticket: { ...ticket, invoiceId, contact: "private", adminNote: "private" } }), ticket);
  for (const change of [{ reference: "abcdef123456" }, { reference: "ABCDEF123456\n" }, { createdAt: "now" }, { createdAt: -1 }]) assert.equal(parseSupportTicket({ ticket: { ...ticket, ...change } }), null);
});
test("explicit support submission bootstraps session then posts only the chosen fields", async () => {
  const calls = [], request = createSupportRequest(supportDraft(context), context, null, randomUuid);
  const http = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(url.endsWith("/support") ? { ticket } : {}), { status: url.endsWith("/support") ? 201 : 200, headers: { "content-type": "application/json" } }); };
  assert.deepEqual(await sendSupportRequest(request, new AbortController().signal, http), ticket);
  assert.deepEqual(calls.map(call => call.url), ["/api/payments/config", "/api/payments/support"]);
  assert.equal(calls[0].init.method, undefined); assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin"); assert.equal(calls[1].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[1].init.body), request); assert.ok(!calls.some(call => call.url.includes(invoiceId)));
});
test("bootstrap failure never sends a support POST and can safely be edited", async () => {
  const calls = [], request = createSupportRequest(supportDraft(context), context, null, randomUuid);
  await assert.rejects(sendSupportRequest(request, new AbortController().signal, async (url) => { calls.push(url); throw new Error("private transport diagnostics"); }), error => error instanceof SupportSendError && !error.requestMayBeReceived && !error.message.includes("private"));
  assert.deepEqual(calls, ["/api/payments/config"]);
});
test("ambiguous transport errors retry the same body without diagnostic leakage", async () => {
  const request = createSupportRequest(supportDraft(context), context, null, randomUuid), bodies = [];
  const http = async (url, init) => { if (url.endsWith("/config")) return new Response("{}"); bodies.push(init.body); throw new Error("private RPC key / password"); };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(sendSupportRequest(request, new AbortController().signal, http), error => error instanceof SupportSendError && error.requestMayBeReceived && !error.message.includes("private"));
  assert.equal(bodies[0], bodies[1]); assert.equal(JSON.parse(bodies[1]).requestId, requestId);
});
test("rejected and malformed confirmations show only safe errors", async () => {
  const request = createSupportRequest(supportDraft(context), context, null, randomUuid);
  for (const status of [403, 429, 503, 201]) {
    const http = async url => url.endsWith("/config") ? new Response("{}") : new Response(JSON.stringify({ error: "secret detailed RPC", ticket: { reference: "bad", createdAt: 1 } }), { status });
    await assert.rejects(sendSupportRequest(request, new AbortController().signal, http), error => error instanceof SupportSendError && !error.message.includes("secret") && error.requestMayBeReceived === ![403, 429].includes(status));
  }
});
test("support UI is an accessible explicit form, not automatic error reporting or storage", () => {
  const source = readFileSync(new URL("../src/SupportDialog.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("<dialog")); assert.ok(source.includes("showModal()")); assert.ok(source.includes("onCancel={onClose}"));
  assert.ok(source.includes("Include my private invoice reference")); assert.ok(source.includes("Never share a password, private key or seed phrase"));
  assert.ok(!source.includes("localStorage")); assert.ok(!source.includes("sessionStorage")); assert.ok(!source.includes("location.href"));
  const css = readFileSync(new URL("../src/support-dialog.css", import.meta.url), "utf8"); assert.ok(css.includes("prefers-reduced-motion"));
  for (const file of ["LiveChogCheckout", "LiveNftCheckout"]) { const checkout = readFileSync(new URL(`../src/${file}.tsx`, import.meta.url), "utf8"); assert.ok(checkout.includes("Contact support")); assert.ok(checkout.includes("onSupport")); }
});
