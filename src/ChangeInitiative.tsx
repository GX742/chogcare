import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import type { CheckoutMode } from "./checkout";
import { assertCanChangeUnpaid, closeCheckoutForChange, inspectCheckoutForChange } from "./checkout-navigation";

export default function ChangeInitiative({ mode, onChange }: { mode: CheckoutMode; onChange: () => void }) {
  const [confirmId, setConfirmId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmId) confirmButton.current?.focus({ preventScroll: true }); }, [confirmId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function change(confirmed = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (confirmed) {
        await closeCheckoutForChange(mode, confirmId);
        if (mounted.current) { setConfirmId(""); onChange(); }
      } else {
        const invoice = await inspectCheckoutForChange(mode);
        if (!mounted.current) return;
        if (!invoice) { onChange(); return; }
        if (invoice.state === "delivered") { await closeCheckoutForChange(mode, invoice.id); if (mounted.current) onChange(); return; }
        assertCanChangeUnpaid(invoice);
        setConfirmId(invoice.id);
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not check your payment. Nothing was cancelled."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="checkout-change" aria-busy={busy}>
    <button className="lp-text-button" type="button" disabled={busy} onClick={() => void change()}><ArrowLeft size={17}/>{busy ? "Checking payment…" : "Change initiative"}</button>
    {confirmId && <div className="checkout-change-confirm" role="group" aria-label="Cancel unpaid checkout and change initiative">
      <strong>Haven’t sent the transfer?</strong>
      <p>Changing initiative closes this unpaid checkout. Don’t use its QR again. If you already sent funds, keep this checkout to track them.</p>
      <div><button ref={confirmButton} className="checkout-change-accept" type="button" disabled={busy} onClick={() => void change(true)}>I haven’t paid · change initiative</button><button type="button" disabled={busy} onClick={() => { setConfirmId(""); setError(""); }}>Keep checkout</button></div>
      <small>Your recovery reference is kept. {mode === "nft" ? "The NFT reservation stays until it expires." : "This does not reverse a transfer."}</small>
    </div>}
    {error && <p className="checkout-change-error" role="alert">{error}</p>}
  </div>;
}
