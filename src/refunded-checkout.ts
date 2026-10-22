import { validInvoiceId } from "./checkout-session.ts";
import { validatePayableInvoice } from "./payable-invoice.ts";

const completedRefundMessage = "The underpaid 300 CHOG transfer was refunded to its verified original sender. Do not pay this invoice again.";
const underpaidMessage = "Received 300 CHOG. This invoice requires 330 CHOG. Processing is on hold; do not pay again.";
const cannotClose = "The completed refund could not be verified. Keep this invoice open; do not pay again.";
const cannotArchive = "This held payment could not be verified. Keep its recovery reference; do not pay this invoice again.";
export type HeldCheckoutKind = "refunded" | "underpaid";

// These exact cases permit archiving this tab's recovery reference only.
// A held underpayment remains on hold; archiving never cancels or refunds it.
export function heldCheckoutKind(id: string, raw: unknown): HeldCheckoutKind | null {
  try {
    const invoice = validatePayableInvoice(raw);
    const kind = invoice.message === completedRefundMessage ? "refunded" : invoice.message === underpaidMessage ? "underpaid" : null;
    const canArchive = validInvoiceId(id) && invoice.id === id && invoice.state === "manual-review" &&
      kind !== null && invoice.amount === "330" &&
      invoice.donationAmount === "300" && invoice.poolContributionAmount === "30" &&
      invoice.contributionPercent === 10 && invoice.poolContributionState === "pending" &&
      [invoice.depositHash, invoice.bridgeHash, invoice.destinationHash, invoice.observedDestinationHash,
        invoice.processingStartedAt, invoice.bridgeStartedAt, invoice.destinationIncludedAt,
        invoice.deliveredUsdc, invoice.observedUsdc].every(value => value == null) &&
      [invoice.receivedAmount, invoice.receivedDonationAmount, invoice.receivedPoolContributionAmount].every(value => value === undefined);
    return canArchive ? kind : null;
  } catch { return null; }
}

export const isRefundedCheckout = (id: string, raw: unknown): boolean => heldCheckoutKind(id, raw) === "refunded";

export function closeVerifiedRefund(id: string, raw: unknown, onClose: () => void): boolean {
  if (!isRefundedCheckout(id, raw)) return false;
  onClose();
  return true;
}

export async function closeHeldCheckout(id: string, expectedKind: HeldCheckoutKind, onClose: () => void, { request = fetch, signal, isCurrent }: { request?: typeof fetch; signal?: AbortSignal; isCurrent?: () => boolean } = {}) {
  const message = expectedKind === "refunded" ? cannotClose : cannotArchive;
  if (!validInvoiceId(id) || !["refunded", "underpaid"].includes(expectedKind)) throw new Error(message);
  const deadline = AbortSignal.timeout(12_000);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let data: unknown;
  try {
    activeSignal.throwIfAborted();
    const response = await request(`/api/payments/invoices/${id}`, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: activeSignal });
    if (!response.ok) throw new Error(message);
    data = await response.json();
    activeSignal.throwIfAborted();
  } catch { throw new Error(message); }
  if (heldCheckoutKind(id, data) !== expectedKind || isCurrent && !isCurrent()) throw new Error(message);
  onClose();
}

export async function closeRefundedCheckout(id: string, onClose: () => void, options?: { request?: typeof fetch; signal?: AbortSignal; isCurrent?: () => boolean }) {
  return closeHeldCheckout(id, "refunded", onClose, options);
}
