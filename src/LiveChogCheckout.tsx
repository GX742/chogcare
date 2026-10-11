import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle, Copy, QrCode } from "@phosphor-icons/react";
import QRCode from "qrcode";
import DonationShare from "./DonationShare";
import DonorProfile from "./DonorProfile";
import CancelCheckout from "./CancelCheckout";
import { formatUnits, parseUnits } from "viem";
import { validatePayableInvoice, type PayableInvoice } from "./payable-invoice";
import PaymentActivity from "./PaymentActivity";
import { paymentPollDelay } from "./payment-progress";
import { deliveryNetwork } from "./delivery-network";
import { supportsChog } from "./chog-beneficiary";
import { contributionForDonationUnits, NFT_POOL_CONTRIBUTION_PERCENT } from "./pool-contribution";
import { activeInvoiceKeys, beginCreation, closeSavedInvoice, createPaymentRequest, initialCheckout, pendingCreation, rememberInvoice, validInvoiceId } from "./checkout-session";
import "./checkout.css";

export const activeInvoiceKey=activeInvoiceKeys.chog;
const presetAmounts=["300","3000","30000"] as const;
const integerFormatter=new Intl.NumberFormat("en-US",{maximumFractionDigits:0});
const usdFormatter=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2});
export default function LiveChogCheckout({initiativeId,initiativeName,ready,destinationChainId=1,serviceAllowed=false}:{initiativeId:string;initiativeName:string;ready:boolean;destinationChainId?:1|10|792703809;serviceAllowed?:boolean}) {
  const [saved] = useState(()=>initialCheckout("chog"));
  const [pending,setPending]=useState(saved.pending);
  const [amount,setAmount]=useState(saved.pending?.input.amount || "300"), [invoice,setInvoice]=useState<PayableInvoice|null>(null), [id,setId]=useState(saved.id);
  const [qr,setQr]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(saved.error),[online,setOnline]=useState(false),[copied,setCopied]=useState("");
  const [rateUsdMicros,setRateUsdMicros]=useState<bigint|null>(null);
  const [now,setNow]=useState(Date.now);
  const heading=useRef<HTMLHeadingElement>(null);
  const currentInvoice=useRef<PayableInvoice|null>(null);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController();
    const load=async()=>{try{const response=await fetch("/api/payments/chog-rate",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});if(!response.ok)return;const value=await response.json();if(value.referenceChog!=="300"||typeof value.estimatedUsdMicros!=="string"||!/^\d{1,12}$/.test(value.estimatedUsdMicros))return;const micros=BigInt(value.estimatedUsdMicros);if(!disposed&&micros>0n)setRateUsdMicros(micros);}catch{/* The checkout remains usable without an indicative display quote. */}};
    void load();const timer=setInterval(()=>void load(),30_000);return()=>{disposed=true;controller.abort();clearInterval(timer);};
  },[]);
  const estimatedUsd=(value:string)=>{if(rateUsdMicros===null||!/^\d{1,7}(\.\d{0,18})?$/.test(value))return null;try{const units=parseUnits(value,18),micros=units*rateUsdMicros/(300n*10n**18n);return usdFormatter.format(Number(micros)/1_000_000);}catch{return null;}};
  const allocation=(value:string)=>{try{const result=contributionForDonationUnits(parseUnits(value,18));return {donation:value,contribution:formatUnits(result.contributionUnits,18),total:formatUnits(result.totalUnits,18)};}catch{return null;}};
  useEffect(()=>{if(invoice?.state==="delivered"){try{closeSavedInvoice("chog");}catch{setError("Could not save your receipt. Keep this checkout open.");}}},[invoice?.state,invoice?.id]);
  const network=deliveryNetwork(invoice ? invoice.destinationChainId : destinationChainId);
  useEffect(()=>{if(invoice)heading.current?.focus({preventScroll:true});},[invoice?.id]);
  useEffect(()=>{
    if(!id)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    const poll=async()=>{
      let failed=false;
      try {
        if(!validInvoiceId(id))throw new Error("Invalid saved invoice. Contact the operator before paying.");
        const response=await fetch(`/api/payments/invoices/${id}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        if(!response.ok)throw new Error("Payment worker is offline or the invoice needs recovery. Do not send another payment.");
        const next=validatePayableInvoice(await response.json());
        if(next.id!==id || next.initiativeId!==initiativeId)throw new Error("Invoice identity or initiative mismatch. Do not pay.");
        const previous=currentInvoice.current;
        if(previous && ["id","initiativeId","recipient","amount","donationAmount","poolContributionAmount","contributionPercent","depositAddress","paymentUri","expiresAt","minUsdc","destinationChainId"].some(key=>previous[key as keyof PayableInvoice]!==next[key as keyof PayableInvoice]))throw new Error("Payment instructions changed unexpectedly. Do not send funds; contact the operator.");
        if(!disposed){currentInvoice.current=next;setInvoice(next);setOnline(true);setError("");}
      } catch(problem){failed=true;if(!disposed){setOnline(false);setError(problem instanceof Error?problem.message:"Status unavailable. Do not pay again.");}}
      finally{if(!disposed)timer=setTimeout(()=>void poll(),paymentPollDelay(currentInvoice.current?.state,failed));}
    };
    void poll();
    return()=>{disposed=true;controller.abort();clearTimeout(timer);};
  },[id,initiativeId]);
  useEffect(()=>{
    if(!id || ["delivered","expired","manual-review"].includes(invoice?.state??""))return;
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>clearInterval(timer);
  },[id,invoice?.state]);
  const canPay=serviceAllowed && !!invoice && invoice.initiativeId===initiativeId && invoice.state==="awaiting-payment" && ready && online && Math.max(now,Date.now())<invoice.expiresAt;
  useEffect(()=>{
    let disposed=false;setQr("");
    if(canPay && invoice)void QRCode.toDataURL(invoice.paymentUri,{width:256,margin:4,errorCorrectionLevel:"M"}).then(image=>{if(!disposed)setQr(image);}).catch(()=>setError("QR unavailable. Do not use an old QR code."));
    return()=>{disposed=true;};
  },[invoice?.paymentUri,canPay]);
  const create=async(event:React.FormEvent)=>{
    event.preventDefault();if(!serviceAllowed||busy||id||(!ready&&!pending)||saved.error||!supportsChog(initiativeId))return;
    setBusy(true);setError("");
    try {
      if(!/^\d{1,7}(\.\d{1,18})?$/.test(amount)||parseUnits(amount,18)<300n*10n**18n||parseUnits(amount,18)>1_000_000n*10n**18n)throw new Error("Enter an amount between 300 and 1,000,000 CHOG, with up to 18 decimal places.");
      const normalizedAmount=formatUnits(parseUnits(amount,18),18);
      const request=beginCreation({mode:"chog",amount:normalizedAmount,holderAddress:"",initiativeId});setPending(request);
      const next=validatePayableInvoice(await createPaymentRequest(request,AbortSignal.timeout(30_000)));
      if(next.donationAmount!==normalizedAmount || next.contributionPercent!==NFT_POOL_CONTRIBUTION_PERCENT || next.initiativeId!==initiativeId)throw new Error("Payment amount, contribution or initiative changed unexpectedly.");
      rememberInvoice("chog",next.id,undefined,next.initiativeId);setPending(null);currentInvoice.current=next;setInvoice(next);setOnline(true);setId(next.id);
    } catch(problem){setError(problem instanceof Error?problem.message:"Could not resolve payment. Retry the same request; do not pay again.");try{setPending(pendingCreation("chog"));}catch{/* Keep existing request locked if storage is unavailable. */}}finally{setBusy(false);}
  };
  const copy=async(text:string,label:string)=>{try{await navigator.clipboard.writeText(text);setCopied(label);}catch{setError("Copy is unavailable. Select the displayed text manually.");}};
  const labels={"awaiting-payment":"Waiting for your CHOG transfer",processing:"CHOG received · exchanging",bridging:`Bridge submitted · tracking ${network.name} delivery`,confirming:`${network.asset} received · waiting for ${network.name} finality`,delivered:"Donation delivered",expired:"Invoice expired · do not pay", "manual-review":"Operator review required · do not pay again"};
  const progress=invoice?.state==="delivered"?4:invoice?.state==="confirming"?3:invoice?.state==="bridging"?2:invoice?.state==="processing"?1:0;
  const reset=()=>{try{closeSavedInvoice("chog");currentInvoice.current=null;setId("");setInvoice(null);setError("");}catch(problem){setError(problem instanceof Error?problem.message:"Keep this invoice for recovery.");}};
  const paymentAllocation=allocation(amount);
  return <section className={`checkout${busy?" is-opening":""}${invoice?" is-invoice":""}${invoice?.state==="delivered"?" is-delivered":""}`} aria-busy={busy} aria-label="CHOG payment checkout">
    <div className="checkout-topline"><span><QrCode size={17}/> Pay by QR</span></div>
    {!id ? <form onSubmit={create}>
      <h3>Give with CHOG.</h3><p className="checkout-intro">Send CHOG on Monad. The processor delivers USDC to your initiative on {network.name}.</p>
      <div className="checkout-purpose"><span>Your initiative</span><strong>{initiativeName}</strong></div>
      <label className="checkout-label" htmlFor="live-amount">Donation amount</label>
      <div className="checkout-amount-input"><input id="live-amount" inputMode="decimal" value={amount} maxLength={26} onChange={e=>setAmount(e.target.value)} disabled={busy||!!pending}/><span className="checkout-amount-unit"><strong>CHOG</strong>{estimatedUsd(amount)&&<small>≈ {estimatedUsd(amount)}</small>}</span></div>
      <div className="checkout-presets">{presetAmounts.map(v=><button type="button" key={v} aria-pressed={amount===v} onClick={()=>setAmount(v)} disabled={busy||!!pending}><strong>{integerFormatter.format(Number(v))}</strong>{estimatedUsd(v)&&<small>≈ {estimatedUsd(v)}</small>}</button>)}</div>
      {paymentAllocation&&<div className="checkout-contribution" aria-label="Payment split"><div><span>To {initiativeName}</span><strong>{paymentAllocation.donation} CHOG {estimatedUsd(paymentAllocation.donation)&&<small>≈ {estimatedUsd(paymentAllocation.donation)}</small>}</strong></div><div><span>NFT community pool <small>+{NFT_POOL_CONTRIBUTION_PERCENT}%</small></span><strong>{paymentAllocation.contribution} CHOG {estimatedUsd(paymentAllocation.contribution)&&<small>≈ {estimatedUsd(paymentAllocation.contribution)}</small>}</strong></div><div className="checkout-contribution-total"><span>Total to send</span><strong>{paymentAllocation.total} CHOG {estimatedUsd(paymentAllocation.total)&&<small>≈ {estimatedUsd(paymentAllocation.total)}</small>}</strong></div></div>}
      <p className="checkout-help">Your donation stays intact. The 10% pool contribution is added on top and batched to Optimism from $5. Keep MON for wallet gas.</p>
      <button type="submit" className="button primary full checkout-submit" disabled={!serviceAllowed||busy||(!ready&&!pending)||!!saved.error||!supportsChog(initiativeId)}>{busy?"Checking route…":pending?"Retry saved request":!supportsChog(initiativeId)?"Payments coming soon":!ready?"Payments unavailable":"Get payment QR"}{busy?<span className="checkout-loading-ring" aria-hidden="true"/>:<ArrowRight size={18}/>}</button>
      <p className="checkout-safety-line">ChogCare holds funds during processing. Use your own wallet, not an exchange.</p>
    </form> : invoice ? <div className="checkout-invoice">
      {invoice.state==="delivered"&&<div className="checkout-success" role="status"><div className="checkout-success-mark"><CheckCircle size={54} weight="fill"/></div><span>DELIVERED ONCHAIN</span><h3>You moved care forward.</h3><strong>{invoice.donationAmount??invoice.amount} <small>CHOG</small></strong><div className="checkout-success-route"><span>Monad</span><i/><span>{network.name}</span></div><p>{initiativeName} received the donation. The 10% community-pool contribution is tracked separately.</p></div>}
      <div className="checkout-total"><div><h3 ref={heading} tabIndex={-1}>{invoice.state==="expired"?"Payment expired":"Total payment"}</h3><span>{invoice.donationAmount??invoice.amount} CHOG to {initiativeName} · {invoice.poolContributionAmount??"0"} CHOG to the NFT pool</span></div><strong>{invoice.amount}<small> CHOG</small></strong></div>
      {canPay && <><p className="checkout-scan-caption">Send the exact CHOG amount once. This is a single-use address, not the token contract.</p><div className="checkout-payment-details">
        <figure className="checkout-qr">{qr&&<img src={qr} width="256" height="256" alt="CHOG transfer request on Monad"/>}<figcaption>MONAD · CHOG ONLY</figcaption></figure>
        <dl className="checkout-fields"><div><dt>Payment address</dt><dd><code>{invoice.depositAddress}</code><button onClick={()=>void copy(invoice.depositAddress,"address")} aria-label="Copy payment address">{copied==="address"?<Check size={18}/>:<Copy size={18}/>}</button></dd></div><div><dt>Exact amount</dt><dd>{invoice.amount} CHOG <button onClick={()=>void copy(invoice.amount,"amount")} aria-label="Copy amount">{copied==="amount"?<Check size={18}/>:<Copy size={18}/>}</button></dd></div></dl>
      </div><p className="checkout-help">Pay before {new Date(invoice.expiresAt).toLocaleTimeString("en-GB")}. Never reuse this address or send on another network.</p></>}
      {!["expired","delivered","confirming"].includes(invoice.state) && <ol className="checkout-progress" aria-label="Donation progress">{["Transfer","Exchange","Bridge","Receipt"].map((label,index)=><li key={label} className={index<progress?"complete":index===progress?"current":""} aria-current={index===progress?"step":undefined}><span>{index<progress?<Check size={13}/>:index+1}</span>{label}</li>)}</ol>}
      <PaymentActivity invoice={invoice} now={now} online={online}/>
      {invoice.state==="awaiting-payment"&&online&&<CancelCheckout id={invoice.id} mode="chog" onClose={reset}/>}
      {["awaiting-payment","expired","manual-review"].includes(invoice.state) && <div className={`checkout-status${invoice.state==="expired"?" is-expired":""}`} role="status"><span className="checkout-status-mark"/><div><strong>{labels[invoice.state]}</strong>{(invoice.message||(!canPay&&invoice.state==="awaiting-payment"))&&<p>{invoice.message||"Payment instructions are paused. Do not send funds now."}</p>}</div></div>}
      {(invoice.depositHash||invoice.bridgeHash||invoice.destinationHash||invoice.observedDestinationHash)&&<details className="checkout-disclosure"><summary>Transfer receipts</summary><div className="checkout-receipts">
      {invoice.depositHash&&<a className="field-link" href={`https://monadscan.com/tx/${invoice.depositHash}`} target="_blank" rel="noreferrer">View CHOG deposit ↗</a>}
      {invoice.bridgeHash&&<a className="field-link" href={`https://monadscan.com/tx/${invoice.bridgeHash}`} target="_blank" rel="noreferrer">View bridge submission ↗</a>}
      {invoice.destinationHash&&<a className="field-link" href={`${network.explorer}/tx/${invoice.destinationHash}`} target="_blank" rel="noreferrer">Donation receipt ↗</a>}
      {!invoice.destinationHash&&invoice.observedDestinationHash&&<a className="field-link" href={`${network.explorer}/tx/${invoice.observedDestinationHash}`} target="_blank" rel="noreferrer">Receipt · awaiting finality ↗</a>}
      </div></details>}
      {["confirming","delivered"].includes(invoice.state)&&<DonationShare state={invoice.state} mode="chog" amount={invoice.donationAmount??invoice.amount} initiativeId={invoice.initiativeId}/>}
      {invoice.state==="delivered"&&<><DonorProfile invoiceId={invoice.id}/><button className="checkout-reference" onClick={reset}>Make another donation <ArrowRight size={16}/></button></>}
      {invoice.state==="expired"&&!invoice.depositHash&&<><p className="checkout-help">Already sent CHOG? Keep this invoice open. Do not pay again.</p><button className="button primary full checkout-submit" onClick={reset}>I haven't paid · start again <ArrowRight size={16}/></button></>}
    </div>:<p className="checkout-help">Restoring your payment status. Do not pay again.</p>}
    <p className="checkout-error" role="alert">{error}</p>
    <details className="checkout-disclosure"><summary>{invoice?"Payment details & help":"Fees & payment details"}</summary><div>
      <p>Your selected cause amount stays intact. A mandatory 10% CHOG contribution is added on top, exchanged separately in the settlement split and consolidated for the NFT community pool. Small contributions are batched before bridging to Optimism.</p>
      <p>CHOG on Monad (chain 143) is exchanged and bridged to {network.asset} on {network.name}. Exchange and bridge fees reduce the amount received. Your wallet also needs MON for the initial transfer.</p>
      <p>ChogCare controls the deposit address during processing. This is a local mainnet pilot, not independently audited production software. Transfers can pause and need operator recovery. Do not use exchange withdrawals.</p>
      <p>Receipt is shown after the on-chain {network.asset} transfer is verified. Finality is checked independently. Keep this invoice to check its status.</p>
      {(invoice?.state==="delivered"||invoice?.state==="confirming")&&<p>The initiative {invoice.state==="delivered"?"received":"has an unfinalized receipt for"} {formatUnits(BigInt(invoice.deliveredUsdc??invoice.observedUsdc!),network.decimals)} {network.asset} on {network.name} after exchange and bridge fees.</p>}
      {invoice&&<><p>Quoted minimum: {formatUnits(BigInt(invoice.minUsdc),network.decimals)} {network.asset}. Save your invoice ID for support. Never create another payment to recover funds already sent.</p><code className="checkout-invoice-id">{invoice.id}</code><button className="checkout-reference" onClick={()=>void copy(invoice.id,"invoice")}>{copied==="invoice"?"Invoice ID copied":"Copy invoice ID"}<Copy size={14}/></button></>}
    </div></details>
  </section>;
}
