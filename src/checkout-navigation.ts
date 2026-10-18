import type { CheckoutMode } from "./checkout.ts";
import { assertUnpaidCheckout, checkoutSelection, closeSavedInvoice, currentStore, pendingCreation, savedInvoice, validInvoiceId } from "./checkout-session.ts";
import { validateNftInvoice } from "./nft-invoice.ts";
import { validatePayableInvoice } from "./payable-invoice.ts";
import { cancelUnpaidChog } from "./cancel-unpaid.ts";

type Store = ReturnType<typeof currentStore>;
export async function inspectCheckoutForChange(mode: CheckoutMode, request: typeof fetch = fetch, storage: Store = currentStore()) {
  if (pendingCreation(mode, storage)) throw new Error("Your QR request is still unresolved. Use Retry saved request first. Nothing was cancelled.");
  const id = savedInvoice(mode, storage);
  if (!id) return null;
  if (!validInvoiceId(id)) throw new Error("Your saved checkout needs recovery. Nothing was cancelled.");
  const cause = checkoutSelection("burundi", mode, storage).initiativeId;
  const response = await request(`/api/payments/invoices/${id}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Could not check this payment. Keep your checkout and try again.");
  const data = await response.json();
  const invoice = mode === "chog" ? validatePayableInvoice(data) : validateNftInvoice(data);
  if (invoice.id !== id || invoice.initiativeId !== cause || savedInvoice(mode, storage) !== id || pendingCreation(mode, storage)) throw new Error("The saved checkout changed. Nothing was cancelled.");
  return invoice;
}

export function assertCanChangeUnpaid(invoice: NonNullable<Awaited<ReturnType<typeof inspectCheckoutForChange>>>) {
  assertUnpaidCheckout(invoice.id, invoice, { allowExpired: true });
}

// This closes the donor's checkout, not an on-chain transfer. Keep the recovery
// reference and the processor record intact so an in-flight/late deposit is recoverable.
export async function closeCheckoutForChange(mode: CheckoutMode, expectedId: string, request: typeof fetch = fetch, storage: Store = currentStore()) {
  const invoice = await inspectCheckoutForChange(mode, request, storage);
  if (!invoice || invoice.id !== expectedId) throw new Error("The saved checkout changed. Nothing was cancelled.");
  if (invoice.state !== "delivered") assertCanChangeUnpaid(invoice);
  if (mode === "chog" && invoice.state === "awaiting-payment") await cancelUnpaidChog(invoice.id, request);
  if (savedInvoice(mode, storage) !== expectedId || pendingCreation(mode, storage)) throw Error("The saved checkout changed. Nothing was closed.");
  closeSavedInvoice(mode, storage);
}
