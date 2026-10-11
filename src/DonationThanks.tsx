import type { Ref } from "react";
import { ArrowRight, Check } from "@phosphor-icons/react";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export default function DonationThanks({ amount, unit = "CHOG", headingRef }: { amount: string; unit?: "CHOG" | "USD"; headingRef?: Ref<HTMLHeadingElement> }) {
  const display = number.format(Number(amount));
  return <div className="checkout-thanks" role="status">
    <div className="checkout-thanks-status"><span><Check size={16} weight="bold" /></span>Donation received</div>
    <div className="checkout-thanks-main">
      <div><p className={`checkout-thanks-amount${display.length > 8 ? " is-long" : ""}`}><strong>{unit === "USD" ? "$" : ""}{display}</strong><span>{unit === "CHOG" ? "CHOG" : "from the NFT pool"}</span></p><p className="checkout-thanks-note">Thank you for caring.</p></div>
      <img className="checkout-thanks-art" src="/chog-heart-hero.png" width="1280" height="1280" alt="" decoding="async" />
    </div>
    <h3 className="checkout-thanks-route" ref={headingRef} tabIndex={-1}><span>{unit === "CHOG" ? "CHOG" : "CHOG NFT"}</span><ArrowRight size={22} weight="bold" aria-hidden="true" /><span lang="ru">Благотворительность</span></h3>
  </div>;
}
