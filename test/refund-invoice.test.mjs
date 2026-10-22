import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatUnits } from "viem";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { validatePayableInvoice } from "../src/payable-invoice.ts";
import { closeHeldCheckout, heldCheckoutKind, sameRefundCase } from "../src/refunded-checkout.ts";
import { closeSavedInvoice, recoveryBundle, rememberInvoice, savedInvoice } from "../src/checkout-session.ts";
import { paymentPollDelay, paymentProgress } from "../src/payment-progress.ts";

const id="a".repeat(64), otherId="b".repeat(64), address="0x1111111111111111111111111111111111111111", hash="0x"+"c".repeat(64), otherHash="0x"+"d".repeat(64);
const refund=(changes={})=>({kind:"chog-amount-mismatch",status:"processing",amount:"1",txHash:null,...changes});
function invoice(changes={}) {
  return {kind:"payment",id,mode:"chog",asset:"CHOG",chainId:143,amount:"330",initiativeId:"school-supplies",recipient:chogBeneficiary("school-supplies",10),depositAddress:address,
    paymentUri:`ethereum:${CHOG}@143/transfer?address=${address}&uint256=${330n*10n**18n}`,minUsdc:"200000",minimumUsd:"200000",state:"manual-review",expiresAt:1792400000000,
    depositHash:null,bridgeHash:null,destinationHash:null,deliveredUsdc:null,observedUsdc:null,observedDestinationHash:null,message:null,
    destinationChainId:10,destinationAsset:"USDC",destinationDecimals:6,donationAmount:"300",poolContributionAmount:"30",contributionPercent:10,poolContributionState:"pending",refund:refund(),...changes};
}
function memory(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}

test("structured refund accepts canonical full received amounts under and over the immutable quote without donation credit",()=>{
  const max=formatUnits(2n**256n-1n,18);
  for(const amount of ["0.000000000000000001","1","300","333","1100001",max])for(const status of ["processing","confirming","completed","blocked"]){
    const raw=invoice({refund:refund({amount,status,txHash:status==="confirming"||status==="completed"?hash:null})});
    const before=JSON.stringify(raw),parsed=validatePayableInvoice(raw);
    assert.deepEqual(parsed.refund,raw.refund);assert.equal(parsed.amount,"330");assert.equal(parsed.donationAmount,"300");assert.equal(parsed.poolContributionAmount,"30");
    assert.equal(parsed.receivedAmount,undefined);assert.equal(parsed.depositHash,null);assert.equal(parsed.state,"manual-review");assert.equal(JSON.stringify(raw),before);
    assert.equal(heldCheckoutKind(id,parsed),"automatic-refund");assert.equal(paymentProgress(parsed,Date.now(),true),null);
  }
});

test("refund amount/status/hash schema rejects ambiguous values and unverified completion",()=>{
  for(const amount of ["0","0.0","-1","+1","01","1.0","1.",".1","1e0","1,0","NaN",1,null,{},"330","330.0","0.0000000000000000001",formatUnits(2n**256n,18),"1\n"])
    assert.throws(()=>validatePayableInvoice(invoice({refund:refund({amount})})));
  for(const value of [[],{},"processing",false,{...refund(),privateRaw:"must not be public"},refund({kind:"other"}),refund({status:"queued"}),refund({status:"unknown"}),refund({txHash:undefined}),refund({txHash:"javascript:alert(1)"}),refund({txHash:hash+"\n"}),refund({status:"completed"}),refund({status:"confirming"})])
    assert.throws(()=>validatePayableInvoice(invoice({refund:value})));
  for(const field of ["kind","status","amount","txHash"]){const value=refund();delete value[field];assert.throws(()=>validatePayableInvoice(invoice({refund:value})));}
});

test("refund cannot coexist with donation processing, received accounting, destination outcomes or collected pool funds",()=>{
  for(const state of ["awaiting-payment","processing","bridging","confirming","delivered","expired"])assert.throws(()=>validatePayableInvoice(invoice({state})));
  for(const field of ["depositHash","bridgeHash","destinationHash","observedDestinationHash"])assert.throws(()=>validatePayableInvoice(invoice({[field]:hash})));
  for(const field of ["processingStartedAt","bridgeStartedAt","destinationIncludedAt"])assert.throws(()=>validatePayableInvoice(invoice({[field]:1})));
  for(const field of ["deliveredUsdc","observedUsdc"])assert.throws(()=>validatePayableInvoice(invoice({[field]:"200000"})));
  assert.throws(()=>validatePayableInvoice(invoice({poolContributionState:"collected"})));
  assert.throws(()=>validatePayableInvoice(invoice({depositHash:hash,receivedAmount:"333",receivedDonationAmount:"302.727272727272727272",receivedPoolContributionAmount:"30.272727272727272728"})));
  for(const field of ["receivedAmount","receivedDonationAmount","receivedPoolContributionAmount"])assert.throws(()=>validatePayableInvoice(invoice({[field]:"1"})));
});

test("consistent legacy quotes are refundable while old holds never acquire a synthetic refund job",()=>{
  const legacy=invoice({amount:"300",donationAmount:"300",poolContributionAmount:null,contributionPercent:0,poolContributionState:null,paymentUri:`ethereum:${CHOG}@143/transfer?address=${address}&uint256=${300n*10n**18n}`});
  assert.equal(validatePayableInvoice(legacy).refund.amount,"1");
  for(const changes of [{donationAmount:"301"},{poolContributionAmount:"1"},{poolContributionState:"pending"}])assert.throws(()=>validatePayableInvoice({...legacy,...changes}));
  for(const omitted of [null,undefined]){
    const held=invoice({refund:omitted,message:"Received 1 CHOG. This invoice requires 330 CHOG. Processing is on hold; do not pay again."});
    assert.equal(validatePayableInvoice(held).refund,omitted);assert.equal(heldCheckoutKind(id,held),"underpaid");
  }
});

test("the public refund projection retains only the validated four-field job and drops unrelated invoice properties",()=>{
  const parsed=validatePayableInvoice(invoice({privateOriginalSender:"not-public",signedTransaction:"not-public"}));
  assert.deepEqual(Object.keys(parsed.refund).sort(),["amount","kind","status","txHash"]);
  assert.equal(Object.hasOwn(parsed,"privateOriginalSender"),false);assert.equal(Object.hasOwn(parsed,"signedTransaction"),false);
});

test("active refunds poll promptly; blocked/completed and offline status never imply fast progress",()=>{
  for(const status of ["processing","confirming"]){assert.equal(paymentPollDelay("manual-review",false,status),1500);assert.equal(paymentPollDelay("manual-review",true,status),10000);}
  for(const status of ["completed","blocked",undefined])assert.equal(paymentPollDelay("manual-review",false,status),30000);
});

test("explicit archive preserves history with only a fresh GET while the same refund progresses to completion",async()=>{
  for(const status of ["processing","confirming","completed","blocked"]){
    const store=memory(),expected=refund({status,txHash:status==="confirming"||status==="completed"?hash:null});
    rememberInvoice("chog",id,store,"school-supplies");let requests=0;
    await closeHeldCheckout(id,"automatic-refund",()=>closeSavedInvoice("chog",store),{expectedRefund:expected,request:async(url,options)=>{
      requests++;assert.equal(url,`/api/payments/invoices/${id}`);assert.equal(options.method,"GET");assert.equal(options.cache,"no-store");
      return Response.json(invoice({refund:refund({status:"completed",txHash:hash})}));
    }});
    assert.equal(requests,1);assert.equal(savedInvoice("chog",store),"");assert.deepEqual(JSON.parse(recoveryBundle(store)).history,[{mode:"chog",id}]);
  }
});

test("a changed refund binding, active invoice, malformed outcome or missing snapshot cannot archive",async()=>{
  const expected=refund({status:"confirming",txHash:hash});
  for(const raw of [invoice({id:otherId}),invoice({refund:refund({amount:"2",status:"completed",txHash:hash})}),invoice({refund:refund({status:"completed",txHash:otherHash})}),invoice({refund:undefined}),invoice({refund:refund({status:"completed"})})]){
    let closed=0;
    await assert.rejects(closeHeldCheckout(id,"automatic-refund",()=>closed++,{expectedRefund:expected,request:async()=>Response.json(raw)}));assert.equal(closed,0);
  }
  for(const options of [{},{expectedRefund:refund(),isCurrent:()=>false}]){
    let closed=0;await assert.rejects(closeHeldCheckout(id,"automatic-refund",()=>closed++,{...options,request:async()=>Response.json(invoice())}));assert.equal(closed,0);
  }
  assert.equal(sameRefundCase(refund(),refund({status:"completed",txHash:hash})),true);
  assert.equal(sameRefundCase(expected,refund({status:"completed",txHash:hash})),true);
  assert.equal(sameRefundCase(expected,refund({status:"completed",txHash:otherHash})),false);
});

test("refund view uses dedicated uppercase states and never presents a donation success or payment QR",()=>{
  const view=readFileSync(new URL("../src/RefundStatus.tsx",import.meta.url),"utf8"),checkout=readFileSync(new URL("../src/LiveChogCheckout.tsx",import.meta.url),"utf8");
  assert.match(view,/INCORRECT AMOUNT SENT\. YOUR REFUND IS IN PROGRESS\./);assert.match(view,/REFUND COMPLETED\./);assert.match(view,/YOUR REFUND IS PAUSED\./);
  assert.doesNotMatch(view,/[\u0400-\u04ff]/);
  assert.doesNotMatch(view,/<(?:DonationThanks|DonationShare|DonorProfile|PaymentInstructions|QRCode)\b/);
  assert.match(checkout,/refund\?<RefundStatus[^:]+:received\?/);assert.match(checkout,/!refund&&\["awaiting-payment","expired","manual-review"\]/);
});
