import { useState } from "react";
import { pendingCreation, recoveryBundle, rememberInvoice, validInvoiceId } from "./checkout-session";
import { validatePayableInvoice } from "./payable-invoice";
import { validateNftInvoice } from "./nft-invoice";

export default function CheckoutRecovery({ onRestore }: { onRestore: () => void }) {
  const [reference, setReference] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(recoveryBundle()); setMessage("Recovery copied for both payment methods. Store it privately; it includes invoice access IDs and pending requests."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not copy recovery details."); }
  };
  const restore = async () => {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const id = reference.trim();
      if (!validInvoiceId(id)) throw new Error("Enter the 64-character invoice ID, not a wallet address or transaction hash.");
      const response = await fetch(`/api/payments/invoices/${id}`, { signal: AbortSignal.timeout(12000), credentials: "same-origin" });
      if (!response.ok) throw new Error("This invoice could not be verified. Nothing was replaced. Do not pay again.");
      const raw = await response.json();
      const invoice = raw?.mode === "nft" ? validateNftInvoice(raw) : validatePayableInvoice(raw);
      if (invoice.id !== id) throw new Error("Invoice identity mismatch. Nothing was changed.");
      if (pendingCreation(invoice.mode)) throw new Error("A request in this mode is unresolved. Retry its saved request first, or give the operator your recovery details.");
      rememberInvoice(invoice.mode, invoice.id, undefined, invoice.initiativeId);
      setReference(""); setMessage("Verified invoice restored. Its initiative and payment method are pinned."); onRestore();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not restore payment. Nothing was replaced."); }
    finally { setBusy(false); }
  };
  return <details className="checkout-disclosure"><summary>Save or recover a payment</summary><div>
    <p>Save recovery details before closing this tab. Both $CHOG and NFT invoices are included. Keep them private; they are not private keys. Never send a second payment to recover the first.</p>
    <button type="button" className="checkout-reference" onClick={()=>void copy()}>Copy private recovery details</button>
    <label className="checkout-label" htmlFor="restore-invoice">Restore a saved invoice ID</label>
    <input className="checkout-address-input" id="restore-invoice" value={reference} onChange={event=>setReference(event.target.value)} maxLength={64} autoComplete="off" spellCheck={false} disabled={busy}/>
    <button type="button" className="checkout-reference" onClick={()=>void restore()} disabled={busy || !reference.trim()}>{busy ? "Checking invoice…" : "Restore invoice"}</button>
    <p role="status">{message}</p>
  </div></details>;
}
