import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, PencilSimple, QrCode } from "@phosphor-icons/react";
import QRCode from "qrcode";
import DonationShare from "./DonationShare";
import DonorProfile from "./DonorProfile";
import DonationThanks from "./DonationThanks";
import CancelCheckout from "./CancelCheckout";
import PaymentInstructions, { displayPaymentAmount } from "./PaymentInstructions";
import CopyPaymentButton from "./CopyPaymentButton";
import { formatUnits, parseUnits } from "viem";
import { validatePayableInvoice, type PayableInvoice } from "./payable-invoice";
import PaymentActivity from "./PaymentActivity";
import { paymentPollDelay } from "./payment-progress";
import { formatDonationAmount } from "./donation-amount";
import { deliveryNetwork } from "./delivery-network";
import { supportsChog } from "./chog-beneficiary";
import { contributionForDonationUnits, NFT_POOL_CONTRIBUTION_PERCENT } from "./pool-contribution";
import { activeInvoiceKeys, beginCreation, BridgeCostLimitError, closeSavedInvoice, createPaymentRequest, initialCheckout, pendingCreation, rememberInvoice, savedInvoice, validInvoiceId } from "./checkout-session";
import "./checkout.css";
import type { SupportContext } from "./support-model";
import { closeHeldCheckout, heldCheckoutKind, sameRefundCase } from "./refunded-checkout";
import RefundStatus from "./RefundStatus";

export const activeInvoiceKey=activeInvoiceKeys.chog;
const presetAmounts=["500","3000","30000","300000","1000000"] as const;
const integerFormatter=new Intl.NumberFormat("en-US",{maximumFractionDigits:0});
const usdFormatter=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2});
export default function LiveChogCheckout({initiativeId,initiativeName,ready,destinationChainId=1,serviceAllowed=false,onViewLeaderboard,onSupport}:{initiativeId:string;initiativeName:string;ready:boolean;destinationChainId?:1|10|792703809;serviceAllowed?:boolean;onViewLeaderboard?:()=>void;onSupport?:(context:SupportContext)=>void}) {
  const [saved] = useState(()=>initialCheckout("chog"));
  const [pending,setPending]=useState(saved.pending);
  const [amount,setAmount]=useState(saved.pending?.input.amount || "500"), [invoice,setInvoice]=useState<PayableInvoice|null>(null), [id,setId]=useState(saved.id);
  const [qr,setQr]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(saved.error),[online,setOnline]=useState(false);
  const [rateUsdMicros,setRateUsdMicros]=useState<bigint|null>(null);
  const [bridgeCostRejected,setBridgeCostRejected]=useState(false);
  const [now,setNow]=useState(Date.now);
  const heading=useRef<HTMLHeadingElement>(null);
  const amountInput=useRef<HTMLInputElement>(null);
  const currentInvoice=useRef<PayableInvoice|null>(null);
  const observation=useRef(0),returnFocus=useRef(false);
  useEffect(()=>{if(!id&&returnFocus.current){returnFocus.current=false;amountInput.current?.focus({preventScroll:true});amountInput.current?.scrollIntoView({block:"center"});}},[id]);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController();
    const load=async()=>{try{const response=await fetch("/api/payments/chog-rate",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});if(!response.ok)return;const value=await response.json();if(value.referenceChog!=="300"||typeof value.estimatedUsdMicros!=="string"||!/^\d{1,12}$/.test(value.estimatedUsdMicros))return;const micros=BigInt(value.estimatedUsdMicros);if(!disposed&&micros>0n)setRateUsdMicros(micros);}catch{/* The checkout remains usable without an indicative display quote. */}};
    void load();const timer=setInterval(()=>void load(),30_000);return()=>{disposed=true;controller.abort();clearInterval(timer);};
  },[]);
  const estimatedUsd=(value:string)=>{if(rateUsdMicros===null||!/^\d{1,7}(\.\d{0,18})?$/.test(value))return null;try{const units=parseUnits(value,18),micros=units*rateUsdMicros/(300n*10n**18n);return usdFormatter.format(Number(micros)/1_000_000);}catch{return null;}};
  const allocation=(value:string)=>{try{const result=contributionForDonationUnits(parseUnits(value,18));return {donation:value,contribution:formatUnits(result.contributionUnits,18),total:formatUnits(result.totalUnits,18)};}catch{return null;}};
  const network=deliveryNetwork(invoice ? invoice.destinationChainId : destinationChainId);
  useEffect(()=>{if(invoice)heading.current?.focus({preventScroll:true});},[invoice?.id]);
  useEffect(()=>{
    if(!id)return;
    const version=++observation.current;
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
        if(previous?.refund&&!sameRefundCase(previous.refund,next.refund))throw new Error("Refund details changed unexpectedly. Keep this invoice and contact support.");
        if(!disposed&&version===observation.current){currentInvoice.current=next;setInvoice(next);setOnline(true);setError("");}
      } catch(problem){failed=true;if(!disposed&&version===observation.current){setOnline(false);setError(problem instanceof Error?problem.message:"Status unavailable. Do not pay again.");}}
      finally{if(!disposed&&version===observation.current)timer=setTimeout(()=>void poll(),paymentPollDelay(currentInvoice.current?.state,failed,currentInvoice.current?.refund?.status));}
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
    setBusy(true);setError("");setBridgeCostRejected(false);
    try {
      if(!/^\d{1,7}(\.\d{1,18})?$/.test(amount)||parseUnits(amount,18)<300n*10n**18n||parseUnits(amount,18)>1_000_000n*10n**18n)throw new Error("Enter an amount between 300 and 1,000,000 $CHOG, with up to 18 decimal places.");
      const normalizedAmount=formatUnits(parseUnits(amount,18),18);
      const request=beginCreation({mode:"chog",amount:normalizedAmount,holderAddress:"",initiativeId});setPending(request);
      const next=validatePayableInvoice(await createPaymentRequest(request,AbortSignal.timeout(30_000)));
      if(next.donationAmount!==normalizedAmount || next.contributionPercent!==NFT_POOL_CONTRIBUTION_PERCENT || next.initiativeId!==initiativeId)throw new Error("Payment amount, contribution or initiative changed unexpectedly.");
      rememberInvoice("chog",next.id,undefined,next.initiativeId);setPending(null);currentInvoice.current=next;setInvoice(next);setOnline(true);setId(next.id);
    } catch(problem){setBridgeCostRejected(problem instanceof BridgeCostLimitError);setError(problem instanceof Error?problem.message:"Could not resolve payment. Retry the same request; do not pay again.");try{setPending(pendingCreation("chog"));}catch{/* Keep existing request locked if storage is unavailable. */}}finally{setBusy(false);}
  };
  const labels={"awaiting-payment":"Waiting for your $CHOG transfer",processing:"$CHOG received · exchanging",bridging:"Sending your donation to the charity",confirming:"Donation received · confirmation in progress",delivered:"Donation delivered",expired:"Invoice expired · do not pay", "manual-review":"Operator review required · do not pay again"};
  const progress=invoice?.state==="delivered"?4:invoice?.state==="confirming"?3:invoice?.state==="bridging"?2:invoice?.state==="processing"?1:0;
  const reset=()=>{try{closeSavedInvoice("chog");observation.current++;returnFocus.current=true;currentInvoice.current=null;setId("");setInvoice(null);setQr("");setOnline(false);setError("");}catch(problem){setError(problem instanceof Error?problem.message:"Keep this invoice for recovery.");}};
  const archiveKind=invoice?heldCheckoutKind(id,invoice):null;
  const startAfterHeldPayment=async()=>{if(busy||!archiveKind)return;setBusy(true);setError("");try{await closeHeldCheckout(id,archiveKind,reset,{expectedRefund:invoice?.refund,isCurrent:()=>savedInvoice("chog")===id&&currentInvoice.current?.id===id&&heldCheckoutKind(id,currentInvoice.current)===archiveKind&&sameRefundCase(invoice?.refund,currentInvoice.current?.refund)});}catch{setError("This payment could not be checked safely. Keep its recovery reference; do not pay this invoice again.");}finally{setBusy(false);}};
  const refund=invoice?.refund;
  const paymentAllocation=allocation(amount);
  const suggestedAmount=bridgeCostRejected?presetAmounts.find(value=>parseUnits(value,18)>parseUnits(amount,18)):undefined;
  const changeAmount=(value:string)=>{setAmount(value);setBridgeCostRejected(false);};
  const received=!!invoice&&["confirming","delivered"].includes(invoice.state);
  const inProgress=invoice?.state==="processing"||invoice?.state==="bridging";
  const receivedTotal=invoice?.receivedAmount??invoice?.amount??"";
  const donationAmount=invoice?.receivedDonationAmount??invoice?.donationAmount??invoice?.amount??"";
  const selectedDonationAmount=invoice?.donationAmount??invoice?.amount??"";
  const poolAmount=invoice?.receivedPoolContributionAmount??invoice?.poolContributionAmount??"0";
  const overpaid=!!invoice?.receivedAmount&&parseUnits(invoice.receivedAmount,18)>parseUnits(invoice.amount,18);
  const transferOnHold=invoice?.state==="manual-review"&&!!invoice.receivedAmount;
  const totalDisplay=invoice?.depositHash?formatDonationAmount(receivedTotal):null;
  const causeDisplay=invoice?.depositHash?formatDonationAmount(donationAmount):null;
  const poolDisplay=invoice?.depositHash&&parseUnits(poolAmount,18)>0n?formatDonationAmount(poolAmount):null;
  const roundedAllocation=totalDisplay?.rounded||causeDisplay?.rounded||poolDisplay?.rounded;
  return <section className={`checkout${!id?" is-entry":""}${busy?" is-opening":""}${invoice?" is-invoice":""}${inProgress?" is-processing":""}${received?" is-received":""}${invoice?.state==="delivered"?" is-delivered":""}`} aria-busy={busy} aria-label="$CHOG payment checkout">
    {id&&!received&&<div className="checkout-topline"><span>{refund?"CHOG refund":inProgress?<><span className={`invoice-processing-mark${!online?" is-paused":""}`} aria-hidden="true"/>Donation in progress</>:transferOnHold?"Transfer on hold · do not pay again":<><QrCode size={17}/> Pay by QR</>}</span></div>}
    {!id ? <form className="chog-giving-form" onSubmit={create}>
      <div className="checkout-entry-heading"><label className="checkout-label" htmlFor="live-amount">Amount for the cause</label><span><QrCode size={16} aria-hidden="true"/>Monad</span></div>
      <div className={`checkout-amount-input${amount.length>11?" is-precise":amount.length>6?" is-long":""}`}>
        <span className="checkout-amount-value">
          <span className="checkout-amount-measure" aria-hidden="true">{amount||"0"}</span>
          <input ref={amountInput} id="live-amount" inputMode="decimal" autoComplete="off" spellCheck={false} size={1} aria-describedby="checkout-amount-hint" value={amount} maxLength={26} onChange={e=>changeAmount(e.target.value)} disabled={busy||!!pending}/>
        </span>
        <span className="checkout-amount-unit"><strong>$CHOG</strong>{estimatedUsd(amount)&&<small>≈ {estimatedUsd(amount)}</small>}</span>
      </div>
      <div className="checkout-amount-toolbar">
        <p className="checkout-amount-hint" id="checkout-amount-hint">Suggested minimum 500 $CHOG · bridge fees vary</p>
        <button className="checkout-edit-amount" type="button" aria-label="Edit donation amount" disabled={busy||!!pending} onClick={()=>{amountInput.current?.focus();amountInput.current?.select();}}><PencilSimple size={15} aria-hidden="true"/>Edit amount</button>
      </div>
      <div className="checkout-presets" role="group" aria-label="Suggested $CHOG amounts">{presetAmounts.map(v=><button type="button" key={v} aria-pressed={amount===v} onClick={()=>changeAmount(v)} disabled={busy||!!pending}><strong>{integerFormatter.format(Number(v))}</strong></button>)}</div>
      {paymentAllocation&&<div className="checkout-contribution" aria-label="Payment split"><div><span>Your initiative</span><strong>{paymentAllocation.donation} <span className="checkout-token">$CHOG</span></strong></div><div><span>NFT community pool <small>+{NFT_POOL_CONTRIBUTION_PERCENT}%</small></span><strong>{paymentAllocation.contribution} <span className="checkout-token">$CHOG</span></strong></div><div className="checkout-contribution-total"><span>Total to send</span><strong>{paymentAllocation.total} <span>$CHOG</span>{estimatedUsd(paymentAllocation.total)&&<small>≈ {estimatedUsd(paymentAllocation.total)}</small>}</strong></div></div>}
      <div className="checkout-payment-notes">
        <p className="checkout-help"><strong>Fees.</strong> Exchange and delivery fees reduce what the charity receives. Keep MON for wallet gas.</p>
        <p className="checkout-safety-line"><strong>Wallet.</strong> ChogCare holds funds during processing. Use your own wallet, not an exchange.</p>
      </div>
      <button type="submit" className="button primary full checkout-submit" disabled={!serviceAllowed||busy||(!ready&&!pending)||!!saved.error||!supportsChog(initiativeId)}>{busy?"Checking route…":pending?"Retry saved request":!supportsChog(initiativeId)?"Payments coming soon":!ready?"Payments unavailable":"Get payment QR"}{busy?<span className="checkout-loading-ring" aria-hidden="true"/>:<ArrowRight size={18}/>}</button>
    </form> : invoice ? <div className="checkout-invoice">
      {refund?<RefundStatus refund={refund} quotedAmount={invoice.amount} online={online} headingRef={heading}/>:received?<><DonationThanks amount={selectedDonationAmount} headingRef={heading} confirmationPending={invoice.state === "confirming"} onDonateAgain={reset}/><DonorProfile invoiceId={invoice.id} onViewLeaderboard={onViewLeaderboard}/><DonationShare state={invoice.state} mode="chog" amount={selectedDonationAmount} initiativeId={invoice.initiativeId}/></>:<div className="invoice-payment-summary">
        <div className={`invoice-payment-main${inProgress&&(totalDisplay?.display??receivedTotal).length>6?" is-long":""}`}><div><h3 ref={heading} tabIndex={-1}>{invoice.state==="expired"?"Payment expired":transferOnHold?"Transfer amount on hold":inProgress?"Total received":"Total to send"}</h3><div className={`invoice-payment-amount${(totalDisplay?.display??receivedTotal).length>(inProgress?6:9)?" is-long":""}`}><strong title={`${receivedTotal} $CHOG`}>{totalDisplay?.display??displayPaymentAmount(receivedTotal)}</strong><span>$CHOG</span></div>{inProgress&&<p className="invoice-processing-note">A little care, on its way.</p>}</div>
          {inProgress&&<img className="invoice-processing-art" src="/chogcare-care-logo.png" width="1254" height="1254" alt="ChogCare" decoding="async"/>}
        </div>
        <p className="invoice-payment-allocation"><span><strong title={`${donationAmount} $CHOG`}>{causeDisplay?.display??displayPaymentAmount(donationAmount)} $CHOG</strong> to {initiativeName}</span><span><strong title={`${poolAmount} $CHOG`}>+{poolDisplay?.display??displayPaymentAmount(poolAmount)} $CHOG</strong> to the NFT community pool</span></p>
        {roundedAllocation&&<p className="checkout-rounded-note">Rounded for display. Exact amounts in Payment details.</p>}
      </div>}
      {!refund&&overpaid&&<p className="checkout-help invoice-received-adjustment">Received {totalDisplay?.rounded?"approximately ":""}{totalDisplay?.display??displayPaymentAmount(receivedTotal)} $CHOG; requested {displayPaymentAmount(invoice.amount)} $CHOG. {transferOnHold?"This transfer is on hold for review. Do not pay again.":"Your entire transfer is included in the donation and pool split."}</p>}
      {canPay && <><p className="checkout-scan-caption"><strong>Send exactly {invoice.amount} $CHOG.</strong> {invoice.contributionPercent===10&&<>{invoice.donationAmount} for the cause + {invoice.poolContributionAmount} for the NFT pool. </>}Scan the QR or copy the details below. Send once, from your own wallet. This address is not the token contract.</p><PaymentInstructions amount={invoice.amount} asset="$CHOG" address={invoice.depositAddress} qr={qr} expiresAt={invoice.expiresAt} onError={setError}/></>}
      {!refund&&!["expired","delivered","confirming"].includes(invoice.state) && <ol className="checkout-progress" aria-label="Donation progress">{["Transfer","Exchange","Bridge","Receipt"].map((label,index)=><li key={label} className={index<progress?"complete":index===progress?"current":""} aria-current={index===progress?"step":undefined}><span>{index<progress?<Check size={13}/>:index+1}</span>{label}</li>)}</ol>}
      {!refund&&!received&&<PaymentActivity invoice={invoice} now={now} online={online}/>}
      {received&&(!online||invoice.message)&&<p className="checkout-help" role="status">{invoice.message||"Connection lost. Rechecking your donation."}</p>}
      {invoice.state==="awaiting-payment"&&online&&<CancelCheckout id={invoice.id} mode="chog" onClose={reset}/>}
      {archiveKind&&<>{archiveKind==="underpaid"&&<p className="checkout-help">Your previous CHOG payment is still on hold. It has not been refunded or donated. Keep its recovery reference. A new donation uses a new address.</p>}{refund&&refund.status!=="completed"&&<p className="checkout-help">{refund.status==="blocked"?"Your refund is paused for review. Keep its recovery reference for support.":"The refund will continue automatically if you start a new donation."} This payment stays in your history. A new donation uses a new address.</p>}<button type="button" className="button primary full checkout-submit" disabled={busy} onClick={()=>void startAfterHeldPayment()}>{busy?"Checking payment…":archiveKind==="refunded"||refund?.status==="completed"?"Refund completed · start a new donation":"Start a new donation · keep this payment"}<ArrowRight size={16}/></button></>}
      {!refund&&["awaiting-payment","expired","manual-review"].includes(invoice.state) && <div className={`checkout-status${invoice.state==="expired"?" is-expired":""}`} role="status"><span className="checkout-status-mark" aria-hidden="true"/><div><strong>{invoice.state==="awaiting-payment"&&now>=invoice.expiresAt?"Payment window closed · do not pay":labels[invoice.state]}</strong>{(invoice.message||(!canPay&&invoice.state==="awaiting-payment"))&&<p>{invoice.message||"Payment instructions are paused. Do not send funds now."}</p>}</div></div>}
      {!received&&(invoice.depositHash||invoice.bridgeHash||invoice.destinationHash||invoice.observedDestinationHash)&&<details className="checkout-disclosure"><summary>Transfer receipts</summary><div className="checkout-receipts">
      {invoice.depositHash&&<a className="field-link" href={`https://monadscan.com/tx/${invoice.depositHash}`} target="_blank" rel="noreferrer">View $CHOG deposit ↗</a>}
      {invoice.bridgeHash&&<a className="field-link" href={`https://monadscan.com/tx/${invoice.bridgeHash}`} target="_blank" rel="noreferrer">View bridge submission ↗</a>}
      {invoice.destinationHash&&<a className="field-link" href={`${network.explorer}/tx/${invoice.destinationHash}`} target="_blank" rel="noreferrer">Donation receipt ↗</a>}
      {!invoice.destinationHash&&invoice.observedDestinationHash&&<a className="field-link" href={`${network.explorer}/tx/${invoice.observedDestinationHash}`} target="_blank" rel="noreferrer">Receipt · awaiting finality ↗</a>}
      </div></details>}
      {invoice.state==="expired"&&!invoice.depositHash&&<><p className="checkout-help">Already sent $CHOG? Keep this invoice open. Do not pay again.</p><button className="button primary full checkout-submit" onClick={reset}>I haven't paid · start again <ArrowRight size={16}/></button></>}
    </div>:<p className="checkout-help">Restoring your payment status. Do not pay again.</p>}
    <p className="checkout-error" role="alert">{error}</p>
    {!id&&!pending&&!busy&&suggestedAmount&&<button className="button primary full" type="button" onClick={()=>{changeAmount(suggestedAmount);setError("");amountInput.current?.focus({preventScroll:true});amountInput.current?.scrollIntoView({block:"center"});}}>Review {integerFormatter.format(Number(suggestedAmount))} $CHOG donation <ArrowRight size={16}/></button>}
    {onSupport && (error || invoice?.state === "manual-review" || invoice?.state === "expired") && <button className="support-checkout-link" type="button" onClick={() => onSupport({ mode: "chog", ...(validInvoiceId(id) ? { invoiceId: id } : {}), issue: invoice?.state === "manual-review" ? "invoice-review" : "checkout-error" })}>Contact support <ArrowRight size={15}/></button>}
    <details className="checkout-disclosure"><summary>{invoice?"Payment details":"Fees & payment details"}</summary><div>
      {invoice?.depositHash&&<><p>{overpaid?<>Selected donation: {selectedDonationAmount} $CHOG. Actual initiative allocation: {donationAmount} $CHOG. Actual NFT pool allocation: {poolAmount} $CHOG. Total received: {receivedTotal} $CHOG.</>:<>Donation: {donationAmount} $CHOG. NFT pool contribution: {poolAmount} $CHOG. Total sent: {receivedTotal} $CHOG.</>}</p>{received&&<p>{invoice.state==="confirming"?"The destination transfer is verified. Final confirmation continues in the background.":"The destination transfer is finalized."}</p>}<div className="checkout-receipts">{invoice.depositHash&&<a href={`https://monadscan.com/tx/${invoice.depositHash}`} target="_blank" rel="noreferrer">$CHOG transfer ↗</a>}{invoice.bridgeHash&&<a href={`https://monadscan.com/tx/${invoice.bridgeHash}`} target="_blank" rel="noreferrer">Bridge transfer ↗</a>}{(invoice.destinationHash||invoice.observedDestinationHash)&&<a href={`${network.explorer}/tx/${invoice.destinationHash||invoice.observedDestinationHash}`} target="_blank" rel="noreferrer">Donation receipt ↗</a>}</div></>}
      {!refund&&<><p>Your selected $CHOG amount is allocated to the cause. A mandatory 10% contribution is added on top for the NFT community pool. Small pool contributions are combined before delivery.</p>
      <p>Send $CHOG only on Monad (chain 143). ChogCare exchanges it into the charity's accepted currency. Exchange and delivery fees reduce the amount the charity receives. Your wallet also needs MON for the initial transfer.</p>
      <p>ChogCare controls the deposit address during processing. This is a local mainnet pilot, not independently audited production software. Transfers can pause and need operator recovery. Do not use exchange withdrawals.</p>
      <p>Receipt is shown after the on-chain {network.asset} transfer is verified. Finality is checked independently. Keep this invoice to check its status.</p></>}
      {(invoice?.state==="delivered"||invoice?.state==="confirming")&&<p>The charity {invoice.state==="delivered"?"received":"has an unfinalized receipt for"} {formatUnits(BigInt(invoice.deliveredUsdc??invoice.observedUsdc!),network.decimals)} {network.asset} after exchange and delivery fees.</p>}
      {invoice&&<><p>{refund?"Keep this invoice ID to check your refund or contact support. Never send another payment to this address.":<>Quoted minimum: {formatUnits(BigInt(invoice.minUsdc),network.decimals)} {network.asset}. Save your invoice ID for support. Never create another payment to recover funds already sent.</>}</p><code className="checkout-invoice-id">{invoice.id}</code><CopyPaymentButton value={invoice.id} label="Copy invoice ID" onError={setError}/></>}
    </div></details>
  </section>;
}
