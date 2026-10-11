import { useEffect, useState } from "react";
import { Info } from "@phosphor-icons/react";
import type { CheckoutMode } from "./checkout";
import "./checkout.css";
import LiveChogCheckout from "./LiveChogCheckout";
import LiveNftCheckout from "./LiveNftCheckout";
import { holderAvailability, paymentServicePolicy } from "./payment-service-policy";
import { initiativeChain, supportsNft, acceptsNewChog } from "./chog-beneficiary";
import type { DonationDestinationChainId } from "./delivery-network";

type Props = { mode: CheckoutMode; initiativeId: string; initiativeName: string };

export default function PaymentCheckout(props: Props) {
  const [ready, setReady] = useState(false);
  const [destinationChainId, setDestinationChainId] = useState<DonationDestinationChainId>(1);
  const [nftReady, setNftReady] = useState(false);
  const [poolHealthy, setPoolHealthy] = useState(false);
  const [availableClaims, setAvailableClaims] = useState<number | null>(null);
  const [nftQueueFull, setNftQueueFull] = useState(false);
  const [serviceAllowed, setServiceAllowed] = useState(false);
  const [securityNotice, setSecurityNotice] = useState("");
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch("/api/payments/config", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error();
        const config = await response.json();
        if (!disposed) {
          const policy = paymentServicePolicy(config);
          setServiceAllowed(policy.allowed);
          setSecurityNotice(policy.notice);
          setDestinationChainId(initiativeChain(props.initiativeId,config.destinationChainId === 10 ? 10 : 1));
          setReady(policy.allowed && config.paymentMode === "local-pilot" && config.paymentsEnabled === true && config.supportedModes?.includes("chog") && config.supportedInitiatives?.includes(props.initiativeId));
          setNftReady(policy.allowed && config.nftPaymentsEnabled === true && config.supportedModes?.includes("nft") && config.poolChainId === 10 && supportsNft(props.initiativeId) && (config.nftSupportedInitiatives?.includes(props.initiativeId) || props.initiativeId === "burundi"));
          setPoolHealthy(policy.allowed && config.poolHealthy === true && config.poolGasReady === true && config.poolChainId === 10);
          setAvailableClaims(holderAvailability(config));
          setNftQueueFull(config.nftQueueFull === true);
        }
      } catch {
        if (!disposed) { setReady(false); setNftReady(false); setPoolHealthy(false); setAvailableClaims(null); setNftQueueFull(false); setServiceAllowed(false); setSecurityNotice("Payment service unavailable. Keep your invoice; do not send funds or pay again."); }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [props.initiativeId]);

  return <>
    {securityNotice && <div className="payment-service-notice" role="status"><Info size={22} aria-hidden="true"/><div><strong>Payments temporarily paused</strong><p>{securityNotice}</p></div></div>}
    {props.initiativeId === "animal-ethics" && props.mode === "nft" && <div className="payment-service-notice" role="status"><Info size={22} aria-hidden="true"/><div><strong>Holder benefit unavailable for this route</strong><p>Animal Ethics accepts native SOL. A $0.50 cross-chain payout currently exceeds the bridge-loss limit, so no holder QR is issued.</p></div></div>}
    {props.mode === "chog" ? <LiveChogCheckout initiativeId={props.initiativeId} initiativeName={props.initiativeName} ready={ready && acceptsNewChog(props.initiativeId)} destinationChainId={initiativeChain(props.initiativeId,destinationChainId===10?10:1)} serviceAllowed={serviceAllowed}/> : !supportsNft(props.initiativeId) ? <section className="checkout"><h3>Holder donations are paused.</h3><p>We will not issue a verification QR while a $0.50 payout cannot meet the bridge-loss limit.</p></section> : <LiveNftCheckout initiativeId={props.initiativeId} ready={nftReady} healthy={poolHealthy} availableClaims={availableClaims} queueFull={nftQueueFull} serviceAllowed={serviceAllowed}/>}
  </>;
}
