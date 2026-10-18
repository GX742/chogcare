import { useEffect, useRef, useState } from "react";
import { ArrowRight, Heart } from "@phosphor-icons/react";
import QRCode from "qrcode";
import DonationShare from "./DonationShare";
import DonationThanks from "./DonationThanks";
import { NFT_POOL_GRANT_USDC } from "./nft-pool-policy";
import CancelCheckout from "./CancelCheckout";
import PaymentInstructions from "./PaymentInstructions";
import { supportsNft } from "./chog-beneficiary";
import { initiativeNames } from "./donation-share";
import { validateNftInvoice, type NftInvoice } from "./nft-invoice";
import { beginCreation, closeSavedInvoice, createPaymentRequest, initialCheckout, pendingCreation, rememberInvoice, validInvoiceId } from "./checkout-session";
import type { SupportContext } from "./support-model";
import { nftPollDelay, nftProgressNote } from "./payment-progress";

export default function LiveNftCheckout({initiativeId,ready,healthy,availableClaims,queueFull=false,serviceAllowed=false,onSupport}:{initiativeId:string;ready:boolean;healthy:boolean;availableClaims:number|null;queueFull?:boolean;serviceAllowed?:boolean;onSupport?:(context:SupportContext)=>void}) {
  const [saved]=useState(()=>initialCheckout("nft")),[pending,setPending]=useState(saved.pending);
  const [holder,setHolder]=useState(saved.pending?.input.holderAddress || ""),[agreed,setAgreed]=useState(false);
  const [id,setId]=useState(saved.id),[invoice,setInvoice]=useState<NftInvoice|null>(null);
  const [qr,setQr]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(saved.error),[online,setOnline]=useState(false),[now,setNow]=useState(Date.now);
  const previous=useRef<NftInvoice|null>(null);
  useEffect(()=>{
    if(!id)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;const abort=new AbortController();
    const poll=async()=>{
      let failed=false;
      try {
        if(!validInvoiceId(id))throw new Error("Invalid saved invoice. Contact the operator before paying.");
        const r=await fetch(`/api/payments/invoices/${id}`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(12000)])});
        if(!r.ok)throw new Error("Status unavailable. Keep this invoice and do not pay again.");
        const x=validateNftInvoice(await r.json());
        if(x.id!==id||x.initiativeId!==initiativeId||previous.current&&["initiativeId","amount","subsidyUsdc","tokenId","holderAddress","depositAddress","paymentUri","expiresAt","claimDay","recipient"].some(k=>previous.current![k as keyof NftInvoice]!==x[k as keyof NftInvoice]))throw new Error("Payment instructions changed. Do not send funds.");
        if(!disposed){previous.current=x;setInvoice(x);setOnline(true);setError("");}
      }catch(e){failed=true;if(!disposed){setOnline(false);setError(e instanceof Error?e.message:"Status unavailable.");}}
      finally{if(!disposed)timer=setTimeout(()=>void poll(),nftPollDelay(previous.current?.state,failed));}
    };
    void poll();return()=>{disposed=true;abort.abort();clearTimeout(timer);};
  },[id,initiativeId]);
  useEffect(()=>{if(!id)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[id]);
  // Reservation already holds this invoice's amount. Exhausting new-claim capacity
  // must not hide an otherwise valid QR for the last reserved claim.
  const canPay=serviceAllowed&&!!invoice&&invoice.initiativeId===initiativeId&&invoice.state==="awaiting-payment"&&online&&healthy&&Math.max(now,Date.now())<invoice.expiresAt;
  useEffect(()=>{let disposed=false;setQr("");if(canPay&&invoice)void QRCode.toDataURL(invoice.paymentUri,{width:256,margin:4}).then(q=>{if(!disposed)setQr(q);}).catch(()=>setError("QR unavailable. Do not use a previous QR."));return()=>{disposed=true;};},[canPay,invoice?.paymentUri]);
  const create=async(e:React.FormEvent)=>{
    e.preventDefault();if(!serviceAllowed||(!ready&&!pending)||busy||id||!agreed||saved.error||!supportsNft(initiativeId))return;setBusy(true);setError("");
    try{
      const request=pending ?? beginCreation({mode:"nft",amount:"1",holderAddress:holder.trim(),initiativeId});setPending(request);
      const x=validateNftInvoice(await createPaymentRequest(request,AbortSignal.timeout(30000)));
      if(x.initiativeId!==initiativeId||x.holderAddress.toLowerCase()!==request.input.holderAddress.toLowerCase()||request.input.tokenId!==undefined&&x.tokenId!==String(BigInt(request.input.tokenId)))throw new Error("NFT identity or initiative mismatch.");
      rememberInvoice("nft",x.id,undefined,x.initiativeId);setPending(null);previous.current=x;setInvoice(x);setId(x.id);setOnline(true);
    }catch(e){setError(e instanceof Error?e.message:"Could not resolve checkout. Retry the same request; do not pay again.");try{setPending(pendingCreation("nft"));}catch{/* Keep the previous request locked. */}}finally{setBusy(false);}
  };
  const reset=()=>{try{closeSavedInvoice("nft");previous.current=null;setId("");setInvoice(null);setAgreed(false);setError("");}catch(problem){setError(problem instanceof Error?problem.message:"Keep this invoice for recovery.");}};
  const labels={"awaiting-payment":"Waiting for your 1 MON transfer",verifying:"Transfer detected · verifying NFT ownership",verified:"NFT verified · preparing donation",paying:`Sending $${invoice?.subsidyUsdc??NFT_POOL_GRANT_USDC} to your cause`,confirming:"Received · final confirmation pending",delivered:"Donation delivered",expired:"Invoice expired · do not pay","manual-review":"Operator review required · do not pay again"};
  const received=!!invoice&&["confirming","delivered"].includes(invoice.state);
  return <section className={`checkout holder-preview${!id?" is-entry":""}${invoice?" is-invoice":""}${received?" is-received":""}`} aria-label="NFT holder donation">
    {id&&!received&&<div className="holder-preview-heading"><Heart size={23} weight="duotone"/><span>CHOG holder benefit</span></div>}
    {!id?<form className="nft-giving-form" onSubmit={e=>void create(e)}>
      <div className="nft-giving-intro"><span className="nft-giving-eyebrow">Your daily holder donation</span><div className="nft-giving-headline"><strong>$1</strong><h3>From our pool.<br/>To your cause.</h3></div><p>Three holders a day. You choose the cause.</p></div>
      <div className="nft-giving-availability"><span>{!ready?"Holder donations paused":availableClaims===null?"Checking availability":<><strong>{availableClaims}</strong> of 3 places left today</>}</span><span>$3 daily pool</span></div>
      <div className="nft-wallet-field"><label className="checkout-label" htmlFor="nft-holder">Your CHOG NFT wallet</label>
      <input className="checkout-address-input" id="nft-holder" placeholder="Paste wallet address · 0x…" aria-describedby="nft-wallet-help" value={holder} onChange={e=>setHolder(e.target.value)} maxLength={42} autoComplete="off" spellCheck={false} required disabled={busy||!!pending}/>
      <p className="checkout-help" id="nft-wallet-help">We find your NFT automatically. No wallet connection.</p></div>
      <label className="nft-consent nft-giving-consent"><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} required disabled={busy}/><span><strong>I’ll send 1 MON to verify my wallet</strong><span>On Monad, from the NFT wallet above. The 1 MON stays with ChogCare as a non-refundable donation — not a gas fee. Wallet gas is extra.</span></span></label>
      {!ready&&<p className="checkout-help">{queueFull?"All checkout slots are currently reserved. Wait for a slot; do not send MON without your own active invoice.":"Claims are paused until the pool is funded, gas is available and the worker is online. Do not send MON."}</p>}
      <button className="button primary full checkout-submit" disabled={!serviceAllowed||(!ready&&!pending)||!agreed||busy||!!saved.error||!supportsNft(initiativeId)}>{busy?"Checking your NFT…":pending?"Retry saved request":!supportsNft(initiativeId)?"Initiative not enabled":ready?"Continue · reserve $1":"Pool unavailable"}</button>
    </form>:invoice?<div className="checkout-invoice">
      {received?<DonationThanks amount={invoice.subsidyUsdc} unit="USD" confirmationPending={invoice.state === "confirming"}/>:<>
        <div className="invoice-payment-summary"><h3>Wallet verification</h3><div className="invoice-payment-amount"><strong>1</strong><span>MON</span></div><p><strong>${invoice.subsidyUsdc} reserved</strong> from the pool<br/>For {initiativeNames[invoice.initiativeId]}</p></div>
        {canPay&&<><p className="checkout-help">Send once from your NFT wallet on Monad. Do not use an exchange.</p>
          <PaymentInstructions amount="1" asset="MON" address={invoice.depositAddress} qr={qr} expiresAt={invoice.expiresAt} onError={setError}/>
          <p className="checkout-help">The 1 MON is non-refundable and held by ChogCare; the pool sends a separate ${invoice.subsidyUsdc} donation.</p></>}
      </>}
      {!received && nftProgressNote(invoice.state, online) && <p className="checkout-help" role="status">{nftProgressNote(invoice.state, online)}</p>}
      {received && (!online || invoice.message) && <p className="checkout-help" role="status">{invoice.message || nftProgressNote(invoice.state, online)}</p>}
      {invoice.state==="awaiting-payment"&&online&&<CancelCheckout id={invoice.id} mode="nft" onClose={reset}/>}
      {!received&&<div className={`checkout-status${invoice.state==="expired"?" is-expired":""}`} role="status">{["verifying","verified","paying"].includes(invoice.state)?<span className="checkout-loading-ring" aria-hidden="true"/>:<span className="checkout-status-mark" aria-hidden="true"/>}<div><strong>{invoice.state==="awaiting-payment"&&now>=invoice.expiresAt?"Payment window closed · do not pay":labels[invoice.state]}</strong>{invoice.message&&<p>{invoice.message}</p>}</div></div>}
      {invoice.state==="delivered"&&<><DonationShare state={invoice.state} mode="nft" amount={invoice.subsidyUsdc} initiativeId={invoice.initiativeId}/><button className="checkout-reference" onClick={reset}>Done</button></>}
      {invoice.state==="expired"&&<><p className="checkout-help">If you already paid, keep this invoice and contact the operator. Do not send again.</p><button className="checkout-reference" onClick={reset}>I have not paid · close invoice</button></>}
      <details className="checkout-disclosure"><summary>Receipt & details</summary><div>
      {invoice.depositHash&&<a className="field-link" href={`https://monadscan.com/tx/${invoice.depositHash}`} target="_blank" rel="noreferrer">Verification receipt ↗</a>}
      {invoice.destinationHash&&<a className="field-link" href={`https://optimistic.etherscan.io/tx/${invoice.destinationHash}`} target="_blank" rel="noreferrer">Donation receipt ↗</a>}
      <p>Claim day: {invoice.claimDay} UTC. Reserved donation: ${invoice.subsidyUsdc}. {invoice.state==="confirming"?"The destination transfer is verified; final confirmation continues in the background.":""}</p><code className="checkout-invoice-id">{invoice.id}</code></div></details>
    </div>:<p className="checkout-help">Restoring your NFT invoice. Do not pay again.</p>}
    <p className="checkout-error" role="alert">{error}</p>
    {onSupport && (error || invoice?.state === "manual-review" || invoice?.state === "expired") && <button className="support-checkout-link" type="button" onClick={() => onSupport({ mode: "nft", ...(validInvoiceId(id) ? { invoiceId: id } : {}), issue: invoice?.state === "manual-review" ? "invoice-review" : "checkout-error" })}>Contact support <ArrowRight size={15}/></button>}
    <details className="checkout-disclosure"><summary>How it works & daily limits</summary><div><p>No wallet connection. We verify your 1 MON transfer and NFT ownership on Monad. Smart-wallet transfers require a confirmed execution trace. A public address alone cannot claim a donation. Do not use exchange withdrawals or send twice.</p><p>New pool donations send $1 to your cause on your behalf. One per wallet and NFT per UTC day, with three recipients and $3 total daily. The reset is 00:00 UTC. Existing invoices retain their original reserved amount. ChogCare pays delivery gas separately.</p></div></details>
  </section>;
}
