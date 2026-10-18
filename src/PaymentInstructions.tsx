import CopyPaymentButton from "./CopyPaymentButton";

// Format the display without Number() rounding the exact transfer amount.
export function displayPaymentAmount(value: string) {
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}

export default function PaymentInstructions({ amount, asset, address, qr, expiresAt, onError }: {
  amount: string; asset: "$CHOG" | "MON"; address: string; qr: string; expiresAt: number; onError: (message: string) => void;
}) {
  const addressLabel = asset === "MON" ? "Copy verification address" : "Copy payment address";
  return <>
    <div className="checkout-payment-details">
      <figure className="checkout-qr">{qr ? <img src={qr} width="256" height="256" alt={`Send exactly ${amount} ${asset} on Monad`}/> : <div className="checkout-qr-loading" role="status">Preparing QR…</div>}<figcaption>MONAD · {asset} ONLY</figcaption></figure>
      <dl className="checkout-fields">
        <div className="checkout-exact-amount"><dt>Exact amount</dt><dd><strong>{displayPaymentAmount(amount)} <small>{asset}</small></strong><CopyPaymentButton value={amount} label="Copy amount" onError={onError}/></dd></div>
        <div className="checkout-deposit-address"><dt>{asset === "MON" ? "Single-use verification address" : "Single-use payment address"}</dt><dd><code>{address}</code><CopyPaymentButton value={address} label={addressLabel} onError={onError}/></dd></div>
      </dl>
    </div>
    <p className="checkout-deadline">Pay before <strong>{new Date(expiresAt).toLocaleTimeString("en-GB")}</strong><span>Never reuse this address or send on another network.</span></p>
  </>;
}
