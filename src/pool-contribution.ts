export const NFT_POOL_CONTRIBUTION_PERCENT = 10 as const;

// The checkout amount is the cause amount. Ten percent is added on top rather
// than deducted from the cause. Integer arithmetic keeps the QR amount exact;
// the one-wei ceiling prevents a fractional contribution from rounding to zero.
export function contributionForDonationUnits(donationUnits: bigint) {
  if (donationUnits <= 0n) throw new Error("Donation must be positive.");
  const contributionUnits = (donationUnits + 9n) / 10n;
  return { donationUnits, contributionUnits, totalUnits: donationUnits + contributionUnits };
}

// Allocate actual post-swap proceeds in the same 10:1 ratio. Any indivisible
// micro-unit goes to the pool, never silently to the operator.
export function splitSettlementUnits(totalUnits: bigint) {
  if (totalUnits <= 1n) throw new Error("Settlement amount is too small.");
  const causeUnits = totalUnits * 10n / 11n;
  return { causeUnits, poolUnits: totalUnits - causeUnits };
}
