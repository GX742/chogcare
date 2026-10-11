import { Heart, CheckCircle } from "@phosphor-icons/react";
import type { PayableInvoice } from "./payable-invoice";
import { paymentProgress } from "./payment-progress";

export default function PaymentActivity({ invoice, now, online }: { invoice: PayableInvoice; now: number; online: boolean }) {
  const activity = paymentProgress(invoice, now, online);
  if (!activity) return null;
  if(invoice.state === "confirming")return <div className="checkout-arrival" role="status">
    <CheckCircle size={42} weight="light" aria-hidden="true"/>
    <h4>Received by the initiative</h4>
    <strong>{invoice.amount} <small>CHOG sent</small></strong>
    <p>{activity.note} No further payment needed.</p>
    <span>Final confirmation continues in the background.</span>
    {(!online || invoice.message) && <p>{invoice.message || "Connection lost. Rechecking the original transfer."}</p>}
  </div>;
  return <div className={`payment-activity${activity.paused ? " is-paused" : ""}`}>
    <div className="payment-orbit" aria-hidden="true"><span /><span /><Heart size={28} weight="fill" /></div>
    <div className="payment-activity-copy" role="status" aria-live="polite">
      <h4>{activity.title}</h4>
      <p className="payment-activity-estimate">{activity.estimate}</p>
    </div>
    <p className="payment-activity-note">{activity.note}</p>
    <small className="payment-activity-clock">{activity.elapsed ? `${activity.elapsed} elapsed · ` : ""}Estimates may vary</small>
    {invoice.message && <p className="payment-activity-message">{invoice.message}</p>}
  </div>;
}
