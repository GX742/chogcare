import { assertUnpaidCheckout, validInvoiceId } from "./checkout-session.ts";
import { validatePayableInvoice } from "./payable-invoice.ts";

export async function cancelUnpaidChog(id: string, request: typeof fetch = fetch) {
  if (!validInvoiceId(id)) throw Error("Invalid saved payment reference.");
  // Refresh the signed browser session without allocating any new payment.
  const config = await request("/api/payments/config", { cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!config.ok) throw Error("Could not check the payment service. Keep your invoice.");
  const response = await request(`/api/payments/invoices/${id}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "chog" }),
    cache: "no-store", signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error("Could not cancel this payment safely. Keep your invoice and retry; do not pay again.");
  const invoice = validatePayableInvoice(await response.json());
  assertUnpaidCheckout(id, invoice, { allowExpired: true });
  if (invoice.state !== "expired") throw Error("Cancellation was not confirmed. Keep your invoice.");
  return invoice;
}
