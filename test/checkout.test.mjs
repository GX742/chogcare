import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { createPreviewInvoice, previewQrText } from "../src/checkout.ts";

const holder = "0x1111111111111111111111111111111111111111";
test("preview QR cannot be mistaken for a payable URI or deposit address", async () => {
  const invoice = createPreviewInvoice("chog", "00300.1000", "", "burundi");
  assert.equal(invoice.amount, "300.1");
  assert.equal(invoice.kind, "preview");
  assert.ok(!("depositAddress" in invoice));
  const text = previewQrText(invoice);
  assert.match(text, /NOT A PAYMENT/);
  assert.doesNotMatch(text, /ethereum:|0x[0-9a-f]{40}/i);
  assert.match(await QRCode.toDataURL(text), /^data:image\/png;base64,/);
});
test("amount validation is exact and rejects rounding, negatives, exponents and overflow", () => {
  for (const amount of ["299.999999999999999999", "1e6", "-300", "NaN", "", "300.0000000000000000001", "1,000", "9".repeat(60)]) {
    assert.throws(() => createPreviewInvoice("chog", amount, "", "burundi"));
  }
  assert.equal(createPreviewInvoice("chog", "300.000000000000000001", "", "burundi").amount, "300.000000000000000001");
});
test("NFT preview requires a public holder address and exactly 1 MON; it is not a proof", () => {
  const invoice = createPreviewInvoice("nft", "1", holder, "burundi");
  assert.equal(invoice.asset, "MON");
  assert.equal(invoice.holderAddress, holder);
  assert.equal(invoice.kind, "preview");
  assert.doesNotMatch(previewQrText(invoice), new RegExp(holder));
  for (const invalid of ["", "not an address", "0x" + "0".repeat(40)]) {
    assert.throws(() => createPreviewInvoice("nft", "1", invalid, "burundi"));
  }
  assert.throws(() => createPreviewInvoice("nft", "2", holder, "burundi"));
});
