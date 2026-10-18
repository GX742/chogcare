import { ArrowsLeftRight, PaperPlaneTilt, Clock, Info, WifiSlash, CheckCircle } from "@phosphor-icons/react";
import type { PayableInvoice } from "./payable-invoice";
import { paymentProgress } from "./payment-progress";

export default function PaymentActivity({ invoice, now, online }: { invoice: PayableInvoice; now: number; online: boolean }) {
  const activity = paymentProgress(invoice, now, online);
  if (!activity) return null;
  if(invoice.state === "confirming")return <div className="checkout-arrival" role="status">
    <CheckCircle size={42} weight="light" aria-hidden="true"/>
    <h4>Received by the initiative</h4>
    <strong>{invoice.receivedAmount??invoice.amount} <small>$CHOG sent</small></strong>
    <p>{activity.note} No further payment needed.</p>
    <span>Final confirmation continues in the background.</span>
    {(!online || invoice.message) && <p>{invoice.message || "Connection lost. Rechecking the original transfer."}</p>}
  </div>;
  const StageIcon = !online ? WifiSlash : invoice.state === "bridging" ? PaperPlaneTilt : ArrowsLeftRight;
  return <div className={`payment-activity payment-activity-refined${activity.paused ? " is-paused" : ""}`}>
    <div className="payment-activity-heading">
      <span className="payment-activity-symbol" aria-hidden="true"><StageIcon size={25} weight="duotone" /></span>
      <div className="payment-activity-copy" role="status" aria-live="polite">
        <h4>{online ? activity.title : "Reconnecting to your donation"}</h4>
        <p className="payment-activity-note">{activity.note}</p>
      </div>
    </div>
    <div className="payment-activity-meta">
      {activity.elapsed && <span className="payment-activity-clock"><Clock size={15} aria-hidden="true"/><span><strong>{activity.elapsed}</strong> elapsed</span></span>}
      <p className="payment-activity-estimate">{activity.estimate}</p>
    </div>
    {invoice.message && <p className="payment-activity-message"><Info size={18} aria-hidden="true"/><span>{invoice.message}</span></p>}
    {!online && !invoice.message && <p className="payment-activity-message"><Info size={18} aria-hidden="true"/><span>Your invoice is saved. We’ll check the original transfer when the connection returns. Do not pay again.</span></p>}
  </div>;
}
