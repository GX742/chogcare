import type { PayableInvoice } from "./payable-invoice";
import type { NftInvoice } from "./nft-invoice";

export function nftPollDelay(state?: NftInvoice["state"], failed = false) {
  if (failed) return 10_000;
  if (state === "confirming") return 10_000;
  if (state === "delivered" || state === "expired" || state === "manual-review") return 30_000;
  return 1_500;
}

export function nftProgressNote(state: NftInvoice["state"], online: boolean) {
  if (!online) return "Reconnecting to your saved invoice. Do not send MON again.";
  if (state === "awaiting-payment") return "Already sent? Detection and NFT verification can take time. Keep this invoice; send only once.";
  if (state === "verifying") return "Checking the transfer and NFT ownership. Your original invoice is saved; no further MON is needed.";
  if (state === "verified" || state === "paying") return "The pool is preparing your donation. No further MON is needed.";
  if (state === "confirming") return "The donation has arrived. Final network confirmation continues in the background; you can switch to $CHOG.";
  return "";
}

// Planning ranges, not a provider SLA or a countdown to success. Only a verified
// destination receipt changes the payment state; clocks never do.
export function paymentProgress(invoice: PayableInvoice, now: number, online: boolean) {
  const state = invoice.state;
  if (!["processing", "bridging", "confirming"].includes(state)) return null;
  const startedAt = state === "confirming" ? invoice.destinationIncludedAt
    : state === "bridging" ? invoice.bridgeStartedAt : invoice.processingStartedAt;
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const delayed = seconds !== null && seconds > (state === "confirming" ? 1200 : 180);
  const title = state === "confirming" ? "Your donation has arrived"
    : state === "bridging" ? "On its way to the charity" : "Exchanging your $CHOG";
  const estimate = !online ? "Reconnecting · estimate unavailable"
    : invoice.message || delayed ? "Taking longer · still tracking"
    : state === "confirming" ? "Final confirmation continues in the background"
    : state === "bridging" ? (invoice.bridgeEstimatedSeconds ? `Relay estimate · ~${invoice.bridgeEstimatedSeconds} sec` : "Waiting for the bridge · time varies") : "Exchanging on Monad · time varies";
  const note = state === "confirming" ? "Received by the charity. Confirmation is still in progress."
    : state === "bridging" ? "$CHOG exchanged. Following the original transfer." : "Deposit received. No further payment needed.";
  const elapsed = seconds === null ? null : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { title, estimate, note, elapsed, paused: !online };
}

export function paymentPollDelay(state?: PayableInvoice["state"], failed = false, refundStatus?: NonNullable<PayableInvoice["refund"]>["status"]) {
  if (failed) return 10_000;
  if (state === "manual-review" && (refundStatus === "processing" || refundStatus === "confirming")) return 1_500;
  if (state === "processing" || state === "bridging" || state === "awaiting-payment") return 1_500;
  if (state === "confirming") return 10_000;
  if (state === "delivered" || state === "manual-review") return 30_000;
  return 1_500;
}
