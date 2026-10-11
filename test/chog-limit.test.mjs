import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewInvoice } from "../src/checkout.ts";
import { saleQuote } from "../server/source-quotes.mjs";
import { validateSourceCall } from "../server/source-policy.mjs";

test("CHOG accepts exactly one million and rejects one base unit above", async () => {
  assert.equal(createPreviewInvoice("chog", "1000000", "", "burundi").amount, "1000000");
  for (const amount of ["1000001", "1000000.000000000000000001"]) assert.throws(() => createPreviewInvoice("chog", amount, "", "burundi"), /maximum/);
  const units = 1_000_000n * 10n ** 18n;
  const operator = "0x1111111111111111111111111111111111111111", payer = "0x2222222222222222222222222222222222222222";
  const call = { from: operator, to: payer, value: 5n * 10n ** 18n, data: "0x" };
  assert.doesNotThrow(() => validateSourceCall("gas", call, { depositAddress: payer, units: String(units) }, operator));
  assert.throws(() => validateSourceCall("gas", call, { depositAddress: payer, units: String(units + 1n) }, operator));
  const totalUnits=1_100_000n*10n**18n;
  assert.doesNotThrow(()=>validateSourceCall("gas",call,{depositAddress:payer,units:String(totalUnits),contributionPercent:10},operator));
  assert.throws(()=>validateSourceCall("gas",call,{depositAddress:payer,units:String(totalUnits+1n),contributionPercent:10},operator));
  let requested = false;
  await assert.rejects(saleQuote({ readContract: async () => { requested = true; throw new Error("quote reached"); } }, units), /quote reached/);
  assert.equal(requested, true);
  requested = false;
  await assert.rejects(saleQuote({ readContract: async () => { requested = true; throw new Error("quote reached"); } }, totalUnits), /quote reached/);
  requested = false;
  await assert.rejects(saleQuote({ readContract: async () => { requested = true; } }, totalUnits + 1n), /1,100,000/);
  assert.equal(requested, false);
});
