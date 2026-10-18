import test from "node:test";
import assert from "node:assert/strict";
import { CARD_AMOUNT_BOX, cardAmountLayout, donationCard } from "../src/donation-card.ts";

const input = { state: "delivered", mode: "chog", amount: "300", initiativeId: "solar-foundation" };
test("donation image displays a readable amount while retaining exact receipt identity", () => {
  const card = donationCard({ ...input, amount: "1000000.123456789123456789" });
  assert.equal(card.amount, "1,000,000.12");
  assert.equal(card.exactAmount, "1000000.123456789123456789");
  assert.equal(card.rounded, true);
  assert.equal(card.initiative, "The Solar Foundation");
  assert.match(card.alt, /approximately 1,000,000\.12 \$CHOG/);
  assert.match(card.filename, /^chogcare-solar-foundation-1000000\.12-chog\.png$/);
  assert.doesNotMatch(JSON.stringify(card), /invoice|wallet|0x/);
  for (const initiativeId of ["school-supplies", "vida-verde", "solar-foundation", "animal-ethics", "burundi"]) {
    assert.equal(donationCard({ ...input, initiativeId }).initiativeId, initiativeId);
  }
});

test("NFT image attributes the actual legacy or current grant to the pool in USDC", () => {
  for (const amount of ["0.50", "1.00"]) {
    const card = donationCard({ ...input, mode: "nft", amount });
    assert.equal(card.amount, amount);
    assert.equal(card.exactAmount, amount);
    assert.equal(card.rounded, false);
    assert.match(card.alt, /USDC from the ChogCare NFT pool/);
    assert.doesNotMatch(card.alt, /I donated|MON|\$CHOG/);
    assert.ok(card.filename.endsWith("-usdc.png"));
  }
});

test("unverified, invalid or forged donation inputs cannot produce an image descriptor", () => {
  for (const state of ["awaiting-payment", "processing", "bridging", "paying", "manual-review", "expired", "<script>"]) assert.equal(donationCard({ ...input, state }), null);
  assert.ok(donationCard({ ...input, state: "confirming" }));
  for (const initiativeId of ["unknown", "__proto__", "../solar-foundation", "https://example.com"]) assert.equal(donationCard({ ...input, initiativeId }), null);
  for (const amount of ["0", "-300", "1e6", "300 CHOG", "<img>", "123456789", "300.1234567891234567890"]) assert.equal(donationCard({ ...input, amount }), null);
});

test("readable card amounts stay on one clear line within the original inset", () => {
  // Synthetic metrics stress the layout independently of the renderer. Browser
  // QA separately checks actual Manrope pixels and downloaded PNG dimensions.
  const measure = (text, size) => ({ width: text.length * size * .64, ascent: size * .76, descent: size * .06 });
  const box = CARD_AMOUNT_BOX;
  for (const amount of ["300", "3000", "300000", "1000000", "99999999.999999999999999999", "1234.5678", "302.727272727272727272", "300.000000000000000001", "1000000.123456789123456789", "1.00", "0.50", "0.000000000000000001"]) {
    const card = donationCard({ ...input, amount });
    const rows = cardAmountLayout(card.amount, measure, card.rounded);
    assert.equal(rows.map(row => row.text).join(""), card.amount);
    assert.equal(rows.length, 1);
    let previousBottom = box.y;
    for (const row of rows) {
      const ink = measure(row.text, row.size);
      assert.ok(row.size >= 40 && ink.width <= box.width);
      assert.ok(row.baseline - ink.ascent >= previousBottom - .001);
      assert.ok(row.baseline + ink.descent <= box.y + box.height + .001);
      previousBottom = row.baseline + ink.descent;
    }
  }
  assert.throws(() => cardAmountLayout("1e6", measure));
  assert.throws(() => cardAmountLayout("302.727272727272727272", measure));
  assert.throws(() => cardAmountLayout("300\n", measure));
  assert.throws(() => cardAmountLayout("300", () => ({ width: NaN, ascent: 1, descent: 1 })));
});
