import type { Ref } from "react";
import { ArrowRight, Check, Play } from "@phosphor-icons/react";
import { formatDonationAmount } from "./donation-amount";

export default function DonationThanks({ amount, unit = "CHOG", headingRef, confirmationPending = false, onDonateAgain }: { amount: string; unit?: "CHOG" | "USD"; headingRef?: Ref<HTMLHeadingElement>; confirmationPending?: boolean; onDonateAgain?:()=>void }) {
  const {display,rounded} = formatDonationAmount(amount, unit === "CHOG" ? "chog" : "nft");
  return <div className="checkout-thanks" role="status">
    <div className="checkout-thanks-status"><span><Check size={16} weight="bold" /></span>{confirmationPending ? "Donation received · finalizing" : "Donation delivered"}</div>
    <div className="checkout-thanks-main">
      <div><p className={`checkout-thanks-amount${display.length > 7 ? " is-long" : ""}`} title={`${amount} ${unit === "CHOG" ? "$CHOG" : "USD"}`}><strong>{unit === "USD" ? "$" : ""}{display}</strong><span>{unit === "CHOG" ? "$CHOG" : "from the NFT pool"}</span></p><p className="checkout-thanks-note">Thank you, CHOG friend.</p>{rounded&&<p className="checkout-rounded-note">Rounded for display. Exact amount in Payment details.</p>}</div>
      <img className="checkout-thanks-art" src="/chogcare-care-logo.png" width="1254" height="1254" alt="ChogCare" decoding="async" />
    </div>
    {onDonateAgain&&<div className="checkout-thanks-actions"><button type="button" className="checkout-donate-again" onClick={onDonateAgain}>Donate again<ArrowRight size={17} aria-hidden="true"/></button></div>}
    <h3 className="checkout-thanks-route" ref={headingRef} tabIndex={-1}><span>{unit === "CHOG" ? "$CHOG" : "CHOG NFT"}</span><ArrowRight size={22} weight="bold" aria-hidden="true" /><span>Charity</span></h3>
    {unit === "CHOG" && <div className="checkout-thanks-broadcast"><a href="#care-livestream"><Play size={18} weight="fill" aria-hidden="true"/>Watch yourself on the livestream<ArrowRight size={18} aria-hidden="true"/></a><p>The broadcast has a short delay. Your thank-you appears when the station is connected.</p></div>}
    {confirmationPending && <p className="checkout-help">The donation has arrived. Final network confirmation can take longer and continues in the background. Your invoice is saved; no further payment is needed.</p>}
  </div>;
}
