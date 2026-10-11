// Confirmed by the owner. These are server policy, not browser-editable payment settings.
export const PAYMENT_POLICY = Object.freeze({
  chainId: 143,
  nftCollection: "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763",
  verificationMon: "1",
  verificationDisposition: "non-refundable donation",
  subsidyUsdc: "0.50",
  dailyPoolLimitUsdc: "10.00",
  maxDailyClaims: 20,
  dayReset: "00:00 UTC",
  poolFunded: false,
  paymentsEnabled: false,
  claimFrequency: "once per NFT per UTC calendar day, regardless of owner",
});
export const DAILY_POOL_UNITS = 10_000_000;
export const SUBSIDY_UNITS = 500_000;
export const INITIATIVE_IDS = new Set(["burundi", "school-supplies", "solar-foundation", "animal-ethics", "gainforest", "herd", "vida-verde", "heaven", "kawagumba"]);
