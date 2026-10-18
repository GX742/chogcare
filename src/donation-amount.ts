export type DonationAmountPresentation = { exactAmount: string; display: string; rounded: boolean };

// Presentation only. Keep the original decimal string for receipts, accounting
// and payment instructions; BigInt prevents binary floating-point rounding.
export function formatDonationAmount(value: string, mode: "chog" | "nft" = "chog"): DonationAmountPresentation {
  if (typeof value !== "string" || value.match(/^\d{1,8}(?:\.\d{1,18})?$/)?.[0] !== value || !["chog", "nft"].includes(mode)) throw new Error("Invalid donation amount.");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (units <= 0n) throw new Error("Donation amount must be positive.");
  const centUnits = 10n ** 16n, cents = (units + centUnits / 2n) / centUnits;
  const rounded = units !== cents * centUnits;
  // A positive dust amount must never look like a zero donation.
  if (cents === 0n) return { exactAmount: value, display: "<0.01", rounded: true };
  const integer = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = (cents % 100n).toString().padStart(2, "0");
  const visibleDecimals = mode === "nft" ? decimals : decimals.replace(/0+$/, "");
  return { exactAmount: value, display: integer + (visibleDecimals ? `.${visibleDecimals}` : ""), rounded };
}
