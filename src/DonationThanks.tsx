import type { Ref } from "react";
import { Check, Heart } from "@phosphor-icons/react";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export default function DonationThanks({ amount, unit = "CHOG", headingRef }: { amount: string; unit?: "CHOG" | "USD"; headingRef?: Ref<HTMLHeadingElement> }) {
  const display = number.format(Number(amount));
  return <div className="checkout-thanks" role="status">
    <div className="checkout-thanks-status"><Check size={18} weight="bold" /><span>Donation received</span><Heart size={24} weight="fill" aria-hidden="true" /></div>
    <h3 ref={headingRef} tabIndex={-1}>Thank you for caring.</h3>
    <p className={`checkout-thanks-amount${display.length > 8 ? " is-long" : ""}`}><strong>{unit === "USD" ? "$" : ""}{display}</strong><span>{unit === "CHOG" ? "CHOG donated" : "from the NFT pool"}</span></p>
  </div>;
}
