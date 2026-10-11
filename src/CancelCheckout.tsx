import { useState } from "react";
import { validateNftInvoice } from "./nft-invoice";
import { validatePayableInvoice } from "./payable-invoice";
import { assertUnpaidCheckout } from "./checkout-session";

// Close only the UI. The processor retains the invoice and can recover late funds.
export default function CancelCheckout({ id, mode, onClose }: { id: string; mode: "chog" | "nft"; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function close() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/payments/invoices/${id}`, { signal: AbortSignal.timeout(12000), cache: "no-store" });
      if (!response.ok) throw new Error("Could not check this payment. Keep it open and try again.");
      const data = await response.json();
      const invoice = mode === "nft" ? validateNftInvoice(data) : validatePayableInvoice(data);
      assertUnpaidCheckout(id, invoice);
      onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not close checkout."); }
    finally { setBusy(false); }
  }
  return <div className="checkout-cancel">
    {!confirm ? <button type="button" onClick={() => setConfirm(true)}>Cancel payment</button> : <>
      <strong>Haven’t sent funds?</strong>
      <p>Close this checkout only if you haven’t sent the transfer. This does not reverse a transaction. Don’t use this QR again. Your recovery reference is kept; an NFT reservation stays until it expires.</p>
      <div><button type="button" disabled={busy} onClick={() => void close()}>{busy ? "Checking payment…" : "I haven’t paid · cancel"}</button><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Keep checkout</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
