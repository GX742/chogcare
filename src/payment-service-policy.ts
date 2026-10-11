import { NFT_POOL_DAILY_CLAIMS } from "./nft-pool-policy.ts";

export const requiredPaymentSecurityVersion = "2026-10-09-hardened-v1";
export function paymentServicePolicy(config: { securityVersion?: unknown; integrityLocked?: unknown }) {
  if (config.securityVersion !== requiredPaymentSecurityVersion) return { allowed: false, notice: "Payment service update pending. Please wait for the operator." };
  if (config.integrityLocked !== false) return { allowed: false, notice: "Payment recovery check pending. Please wait for the operator; do not send funds." };
  return { allowed: true, notice: "" };
}
export function holderAvailability(config: { securityVersion?: unknown; integrityLocked?: unknown; availableClaims?: unknown }): number | null {
  if (!paymentServicePolicy(config).allowed || typeof config.availableClaims !== "number" || !Number.isInteger(config.availableClaims) || config.availableClaims < 0 || config.availableClaims > NFT_POOL_DAILY_CLAIMS) return null;
  return config.availableClaims;
}
