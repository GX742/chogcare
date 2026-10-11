// Confirmed by the owner. These are server policy, not browser-editable payment settings.
import { NFT_POOL_GRANT_USDC, NFT_POOL_DAILY_USDC, NFT_POOL_DAILY_CLAIMS, NFT_POOL_GRANT_UNITS, NFT_POOL_DAILY_UNITS } from "../src/nft-pool-policy.ts";
export const PAYMENT_POLICY = Object.freeze({
  chainId: 143,
  nftCollection: "0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763",
  verificationMon: "1",
  verificationDisposition: "non-refundable donation",
  subsidyUsdc: NFT_POOL_GRANT_USDC,
  dailyPoolLimitUsdc: NFT_POOL_DAILY_USDC,
  maxDailyClaims: NFT_POOL_DAILY_CLAIMS,
  dayReset: "00:00 UTC",
  poolFunded: false,
  paymentsEnabled: false,
  claimFrequency: "once per wallet and once per NFT per UTC calendar day; three recipients maximum",
});
export const DAILY_POOL_UNITS = NFT_POOL_DAILY_UNITS;
export const SUBSIDY_UNITS = NFT_POOL_GRANT_UNITS;
export const INITIATIVE_IDS = new Set(["burundi", "school-supplies", "solar-foundation", "animal-ethics", "gainforest", "herd", "vida-verde", "heaven", "kawagumba"]);
