import { useEffect, useState } from "react";
import { Info } from "@phosphor-icons/react";
import type { CheckoutMode } from "./checkout";
import "./checkout.css";
import LiveChogCheckout from "./LiveChogCheckout";
import LiveNftCheckout from "./LiveNftCheckout";
import { holderAvailability, paymentServicePolicy } from "./payment-service-policy";
import { initiativeChain, supportsNft, acceptsNewChog } from "./chog-beneficiary";
import type { DonationDestinationChainId } from "./delivery-network";
import { NFT_POOL_GRANT_USDC, NFT_POOL_DAILY_CLAIMS } from "./nft-pool-policy";
import SupportDialog from "./SupportDialog";
import type { SupportContext } from "./support-model";

type Props = { mode: CheckoutMode; initiativeId: string; initiativeName: string; onViewLeaderboard?:()=>void };

export default function PaymentCheckout(props: Props) {
  const [support, setSupport] = useState<SupportContext | null>(null);
  const [ready, setReady] = useState(false);
  const [destinationChainId, setDestinationChainId] = useState<DonationDestinationChainId>(1);
  const [nftReady, setNftReady] = useState(false);
  const [poolHealthy, setPoolHealthy] = useState(false);
  const [availableClaims, setAvailableClaims] = useState<number | null>(null);
  const [nftQueueFull, setNftQueueFull] = useState(false);
  const [serviceAllowed, setServiceAllowed] = useState(false);
  const [securityNotice, setSecurityNotice] = useState("");
  const [configInitiative, setConfigInitiative] = useState("");
  const currentConfig = configInitiative === props.initiativeId;
  const chogReady = currentConfig && ready;
  const holderReady = currentConfig && nftReady;
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    // A newly selected cause must not inherit the previous cause's readiness.
    setReady(false); setNftReady(false); setPoolHealthy(false);
    setAvailableClaims(null); setNftQueueFull(false); setServiceAllowed(false); setSecurityNotice("");
    setConfigInitiative("");
    const poll = async () => {
      try {
        const response = await fetch("/api/payments/config", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error();
        const config = await response.json();
        if (!disposed) {
          setConfigInitiative(props.initiativeId);
          const policy = paymentServicePolicy(config);
          setServiceAllowed(policy.allowed);
          setSecurityNotice(policy.notice);
          setDestinationChainId(initiativeChain(props.initiativeId,config.destinationChainId === 10 ? 10 : 1));
          setReady(policy.allowed && config.paymentMode === "local-pilot" && config.paymentsEnabled === true && config.supportedModes?.includes("chog") && config.supportedInitiatives?.includes(props.initiativeId));
          setNftReady(policy.allowed && config.subsidyUsdc === NFT_POOL_GRANT_USDC && config.maxDailyClaims === NFT_POOL_DAILY_CLAIMS && config.nftPaymentsEnabled === true && config.supportedModes?.includes("nft") && config.poolChainId === 10 && supportsNft(props.initiativeId) && (config.nftSupportedInitiatives?.includes(props.initiativeId) || props.initiativeId === "burundi"));
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
    {securityNotice && <div className="payment-service-notice" role="status"><Info size={22} aria-hidden="true"/><div><strong>Payments temporarily paused</strong><p>{securityNotice}</p><button className="support-checkout-link" type="button" onClick={() => setSupport({ mode: props.mode, issue: "payment-unavailable" })}>Contact support</button></div></div>}
    {props.initiativeId === "animal-ethics" && props.mode === "nft" && <div className="payment-service-notice" role="status"><Info size={22} aria-hidden="true"/><div><strong>Holder benefit unavailable for this cause</strong><p>Animal Ethics supports CHOG donations, but not donations from this NFT pool. No verification QR is issued here.</p></div></div>}
    {props.mode === "chog" ? <LiveChogCheckout initiativeId={props.initiativeId} initiativeName={props.initiativeName} ready={chogReady && acceptsNewChog(props.initiativeId)} destinationChainId={initiativeChain(props.initiativeId,destinationChainId===10?10:1)} serviceAllowed={currentConfig && serviceAllowed} onViewLeaderboard={props.onViewLeaderboard} onSupport={setSupport}/> : !supportsNft(props.initiativeId) ? <section className="checkout"><h3>Holder donations are paused.</h3><p>The selected cause is not supported by the NFT pool.</p></section> : <LiveNftCheckout initiativeId={props.initiativeId} ready={holderReady} healthy={currentConfig && poolHealthy} availableClaims={currentConfig ? availableClaims : null} queueFull={currentConfig && nftQueueFull} serviceAllowed={currentConfig && serviceAllowed} onSupport={setSupport}/>}
    {!securityNotice && !(props.mode === "chog" ? chogReady : holderReady) && <div className="checkout-service-help"><button className="support-checkout-link" type="button" onClick={() => setSupport({ mode: props.mode, issue: "payment-unavailable" })}>Contact support</button></div>}
    <SupportDialog context={support} onClose={() => setSupport(null)}/>
  </>;
}
