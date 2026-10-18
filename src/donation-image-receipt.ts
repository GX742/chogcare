import { validInvoiceId } from "./checkout-session.ts";
import type { CheckoutMode } from "./checkout.ts";
import { validatePayableInvoice } from "./payable-invoice.ts";
import { validateNftInvoice } from "./nft-invoice.ts";
import type { DonationCardInput } from "./donation-card.ts";

export async function loadDonationImageReceipt(reference: { mode: CheckoutMode; id: string }, signal: AbortSignal, request: typeof fetch = fetch): Promise<DonationCardInput> {
  if (!validInvoiceId(reference.id) || !["chog", "nft"].includes(reference.mode)) throw new Error("Invalid saved donation.");
  const response = await request(`/api/payments/invoices/${reference.id}`, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Saved donation unavailable.");
  const raw: unknown = await response.json();
  const invoice = reference.mode === "nft" ? validateNftInvoice(raw) : validatePayableInvoice(raw);
  if (invoice.id !== reference.id || invoice.mode !== reference.mode) throw new Error("Saved donation identity mismatch.");
  return { state: invoice.state, mode: invoice.mode, initiativeId: invoice.initiativeId, amount: invoice.mode === "nft" ? invoice.subsidyUsdc : invoice.donationAmount ?? invoice.amount };
}

export async function loadLatestDonationImage(references: { mode: CheckoutMode; id: string }[], signal: AbortSignal, request: typeof fetch = fetch): Promise<DonationCardInput | null> {
  for (const reference of references) {
    const receipt = await loadDonationImageReceipt(reference, signal, request);
    if (["confirming", "delivered"].includes(receipt.state)) return receipt;
  }
  return null;
}
