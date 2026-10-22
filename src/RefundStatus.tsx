import type { Ref } from "react";
import type { ChogRefund } from "./payable-invoice";
import { displayPaymentAmount } from "./PaymentInstructions";
import "./refund-status.css";

export default function RefundStatus({ refund, quotedAmount, online, headingRef }: { refund: ChogRefund; quotedAmount: string; online: boolean; headingRef: Ref<HTMLHeadingElement> }) {
  const completed = refund.status === "completed", blocked = refund.status === "blocked";
  return <section className={`checkout-refund${completed ? " is-completed" : blocked ? " is-blocked" : ""}`} lang="en" role="status" aria-live="polite">
    <h3 ref={headingRef} tabIndex={-1}>{completed ? "REFUND COMPLETED." : blocked ? "INCORRECT AMOUNT SENT. YOUR REFUND IS PAUSED." : "INCORRECT AMOUNT SENT. YOUR REFUND IS IN PROGRESS."}</h3>
    <p>{completed ? "The full received amount has been returned to its original sender. This payment was not donated." : blocked ? "Automatic refund needs a review. Keep this payment and contact support. Refund completion has not been confirmed." : "We are returning the full received amount to its original sender. Do not top up or reuse this address."}</p>
    <dl><div><dt>{completed ? "Returned" : "Refund amount"}</dt><dd>{displayPaymentAmount(refund.amount)} <span>CHOG</span></dd></div><div><dt>Original invoice amount</dt><dd>{displayPaymentAmount(quotedAmount)} <span>CHOG</span></dd></div></dl>
    {refund.status === "confirming" && <p>Transaction sent. Waiting for final network confirmation.</p>}
    {!online && <p className="checkout-refund-connection">Connection lost. Checking the last known refund status. Do not send another payment to this address.</p>}
    {refund.txHash && <a href={`https://monadscan.com/tx/${refund.txHash}`} target="_blank" rel="noreferrer">{completed ? "Confirmed refund" : "Refund transaction"} ↗</a>}
  </section>;
}
