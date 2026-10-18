import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { processingChogUnits, receivedChogAmounts, creditedChogDonationAmount } from "../server/chog-received.mjs";

const units = value => parseUnits(value, 18).toString();
const txHash = `0x${"a".repeat(64)}`;
const invoice = (received = "333", contributionPercent = 10) => ({
  id: "a".repeat(64), units: units(contributionPercent === 10 ? "330" : "300"),
  amount: contributionPercent === 10 ? "330" : "300", donationAmount: "300",
  poolContributionAmount: contributionPercent === 10 ? "30" : "0", contributionPercent,
  receivedUnits: units(received), depositHash: txHash,
  depositProof: { kind: "confirmed-chog-transfer", invoiceId: "a".repeat(64), chainId: 143,
    txHash, amountUnits: units(received), sender: `0x${"1".repeat(40)}`,
    logIndex: 3, blockNumber: "100", blockHash: `0x${"b".repeat(64)}` },
});

test("330 quoted / 333 received processes all 333 and credits the 10:1 actual allocation without mutating the quote", () => {
  const payment = invoice(), original = structuredClone(payment);
  assert.equal(processingChogUnits(payment), parseUnits("333", 18));
  assert.deepEqual(receivedChogAmounts(payment), {
    receivedAmount: "333", receivedDonationAmount: "302.727272727272727272", receivedPoolContributionAmount: "30.272727272727272728",
  });
  assert.equal(creditedChogDonationAmount(payment), "302.727272727272727272");
  assert.deepEqual(payment, original);
});

test("one wei excess is conserved with rounding assigned to the pool", () => {
  const payment = invoice("330.000000000000000001"), amounts = receivedChogAmounts(payment);
  assert.deepEqual(amounts, { receivedAmount: "330.000000000000000001", receivedDonationAmount: "300", receivedPoolContributionAmount: "30.000000000000000001" });
  assert.equal(parseUnits(amounts.receivedDonationAmount, 18) + parseUnits(amounts.receivedPoolContributionAmount, 18), processingChogUnits(payment));
});

test("legacy zero-contribution overpayment credits the full received amount to the cause", () => {
  const payment = invoice("333", 0);
  assert.equal(creditedChogDonationAmount(payment), "333");
  assert.deepEqual(receivedChogAmounts(payment), { receivedAmount: "333", receivedDonationAmount: "333", receivedPoolContributionAmount: "0" });
});

test("exact historical invoices retain their original accounting and do not require a new proof", () => {
  for (const contributionPercent of [0, 10]) {
    const payment = invoice("333", contributionPercent);
    delete payment.receivedUnits; delete payment.depositProof;
    assert.equal(processingChogUnits(payment), BigInt(payment.units));
    assert.deepEqual(receivedChogAmounts(payment), {});
    assert.equal(creditedChogDonationAmount(payment), "300");
    delete payment.donationAmount;
    assert.equal(creditedChogDonationAmount(payment), payment.amount);
  }
});

test("received amount cannot be forged independently of its invoice-bound canonical deposit proof", () => {
  const valid = invoice();
  for (const patch of [
    { kind: "unverified" }, { invoiceId: "c".repeat(64) }, { chainId: 10 }, { amountUnits: units("330") },
    { txHash: `0x${"c".repeat(64)}` }, { sender: `0x${"0".repeat(40)}` }, { sender: "donor" },
    { logIndex: -1 }, { logIndex: 1.5 }, { logIndex: undefined }, { blockNumber: undefined },
    { blockNumber: "100\n" }, { blockNumber: "-1" }, { blockHash: "0x123" },
  ]) {
    const payment = { ...valid, depositProof: { ...valid.depositProof, ...patch } };
    assert.throws(() => processingChogUnits(payment), /verified deposit proof/);
    assert.throws(() => receivedChogAmounts(payment), /verified deposit proof/);
    assert.throws(() => creditedChogDonationAmount(payment), /verified deposit proof/);
  }
  for (const patch of [{ depositProof: null }, { depositHash: `0x${"c".repeat(64)}` }, { receivedUnits: undefined }, { receivedUnits: "333\n" }]) {
    assert.throws(() => processingChogUnits({ ...valid, ...patch }), /verified deposit proof/);
  }
});

test("underpayments and received amounts above the existing pilot cap cannot authorize processing", () => {
  assert.throws(() => processingChogUnits(invoice("329.999999999999999999")), /pilot limits/);
  assert.equal(processingChogUnits(invoice("1100000")), parseUnits("1100000", 18));
  assert.throws(() => processingChogUnits(invoice("1100000.000000000000000001")), /pilot limits/);
  assert.equal(processingChogUnits(invoice("1000000", 0)), parseUnits("1000000", 18));
  assert.throws(() => processingChogUnits(invoice("1000000.000000000000000001", 0)), /pilot limits/);
  for (const value of ["0", "-1", "3e20", String(2n ** 256n)]) assert.throws(() => processingChogUnits({ ...invoice(), units: value }), /pilot limits/);
});
