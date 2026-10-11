import type { PayableInvoice } from "./payable-invoice";
import { deliveryNetwork } from "./delivery-network.ts";

// Planning ranges, not a provider SLA or a countdown to success. Only a verified
// destination receipt changes the payment state; clocks never do.
export function paymentProgress(invoice: PayableInvoice, now: number, online: boolean) {
  const state = invoice.state;
  const network = deliveryNetwork(invoice.destinationChainId);
  if (!["processing", "bridging", "confirming"].includes(state)) return null;
  const startedAt = state === "confirming" ? invoice.destinationIncludedAt
    : state === "bridging" ? invoice.bridgeStartedAt : invoice.processingStartedAt;
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  const delayed = seconds !== null && seconds > (state === "confirming" ? 1200 : 180);
  const title = state === "confirming" ? `${network.asset} has arrived`
    : state === "bridging" ? `On its way to ${network.name}` : "Exchanging your CHOG";
  const estimate = !online ? "Reconnecting · estimate unavailable"
    : invoice.message || delayed ? "Taking longer · still tracking"
    : state === "confirming" ? "Final confirmation continues in the background"
    : state === "bridging" ? (invoice.bridgeEstimatedSeconds ? `Relay estimate · ~${invoice.bridgeEstimatedSeconds} sec` : "Waiting for the bridge · time varies") : "Exchanging on Monad · time varies";
  const note = state === "confirming" ? `Received on ${network.name}. Not yet finalized.`
    : state === "bridging" ? "CHOG exchanged. Following the original transfer." : "Deposit received. No further payment needed.";
  const elapsed = seconds === null ? null : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { title, estimate, note, elapsed, paused: !online };
}

export function paymentPollDelay(state?: PayableInvoice["state"], failed = false) {
  if (failed) return 10_000;
  if (state === "processing" || state === "bridging") return 3_000;
  if (state === "confirming") return 10_000;
  if (state === "delivered" || state === "manual-review") return 30_000;
  return 5_000;
}
