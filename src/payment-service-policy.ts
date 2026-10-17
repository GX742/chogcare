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

// Display-only reasons. They never authorize a QR or override the server gates.
export function paymentAvailabilityNotice(config: { paymentsEnabled?: unknown; nftPaymentsEnabled?: unknown; chogReadiness?: unknown; nftReadiness?: unknown }, mode: "chog" | "nft"): string {
  if ((mode === "chog" ? config.paymentsEnabled : config.nftPaymentsEnabled) === true) return "";
  const reason = mode === "chog" ? config.chogReadiness : config.nftReadiness;
  switch (reason) {
    case "network-unavailable": return "Blockchain connection is recovering automatically. Keep your existing invoice; do not send funds or pay again while this notice is shown.";
    case "gas-needed": return "The service needs a network-fee top-up from the operator. You do not need to send extra funds. Availability is checked automatically.";
    case "funding-needed": return "The NFT pool needs verified funding before it can accept another donation. Do not send MON until your own active invoice is available.";
    case "daily-limit": return "Today's NFT pool places are reserved. Availability resets at 00:00 UTC; existing reservations are kept.";
    case "queue-full": return mode === "nft" ? "All NFT checkout slots are reserved. Availability is checked automatically; keep your existing invoice." : "The payment queue is currently full. Finish or cancel your unpaid checkout; existing transfers continue to be tracked.";
    default: return "";
  }
}
