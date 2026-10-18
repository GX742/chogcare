import { formatUnits } from "viem";
import { splitSettlementUnits } from "../src/pool-contribution.ts";

const unitsPattern = /^\d{1,78}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const matches = (pattern, value) => typeof value === "string" && value.match(pattern)?.[0] === value;
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const hasReceived = invoice => Object.hasOwn(invoice ?? {}, "receivedUnits");
const fail = () => { throw new Error("Received CHOG amount is not bound to a verified deposit proof or exceeds pilot limits."); };

// Immutable quote fields remain the instructions the donor originally saw.
// A separate received amount may authorize processing only when the processor's
// canonical source receipt binds that exact full amount to this same invoice.
export function processingChogUnits(invoice) {
  const cap = (invoice?.contributionPercent === 10 ? 1_100_000n : 1_000_000n) * 10n ** 18n;
  if (!matches(unitsPattern, invoice?.units)) fail();
  const quoted = BigInt(invoice.units);
  if (quoted <= 0n || quoted > cap) fail();
  if (!hasReceived(invoice)) return quoted;
  if (!matches(unitsPattern, invoice.receivedUnits)) fail();
  const received = BigInt(invoice.receivedUnits), proof = invoice.depositProof;
  if (received < quoted || received > cap ||
      !matches(/^[a-f0-9]{64}$/, invoice.id) || proof?.kind !== "confirmed-chog-transfer" ||
      proof.invoiceId !== invoice.id || proof.chainId !== 143 || proof.amountUnits !== invoice.receivedUnits ||
      !matches(hashPattern, proof.txHash) || !same(proof.txHash, invoice.depositHash) ||
      !matches(addressPattern, proof.sender) || /^0x0{40}$/i.test(proof.sender) ||
      !Number.isSafeInteger(proof.logIndex) || proof.logIndex < 0 ||
      !matches(unitsPattern, proof.blockNumber) || !matches(hashPattern, proof.blockHash)) fail();
  return received;
}

export function receivedChogAmounts(invoice) {
  if (!hasReceived(invoice)) return {};
  const received = processingChogUnits(invoice);
  const split = invoice.contributionPercent === 10 ? splitSettlementUnits(received) : { causeUnits: received, poolUnits: 0n };
  return {
    receivedAmount: formatUnits(received, 18),
    receivedDonationAmount: formatUnits(split.causeUnits, 18),
    receivedPoolContributionAmount: formatUnits(split.poolUnits, 18),
  };
}

export function creditedChogDonationAmount(invoice) {
  return hasReceived(invoice) ? receivedChogAmounts(invoice).receivedDonationAmount : invoice.donationAmount ?? invoice.amount;
}
