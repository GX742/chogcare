import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits, parseUnits } from "viem";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { splitSettlementUnits } from "../src/pool-contribution.ts";
import { validatePayableInvoice } from "../src/payable-invoice.ts";
import { donationCard } from "../src/donation-card.ts";

const hash="0x"+"c".repeat(64),address="0x1111111111111111111111111111111111111111";
function invoice(changes={}){
  return {kind:"payment",id:"a".repeat(64),mode:"chog",asset:"CHOG",chainId:143,amount:"330",initiativeId:"school-supplies",recipient:chogBeneficiary("school-supplies",10),depositAddress:address,paymentUri:`ethereum:${CHOG}@143/transfer?address=${address}&uint256=${330n*10n**18n}`,minUsdc:"200000",minimumUsd:"200000",state:"processing",expiresAt:1792400000000,depositHash:hash,bridgeHash:null,destinationHash:null,deliveredUsdc:null,observedUsdc:null,observedDestinationHash:null,message:null,destinationChainId:10,destinationAsset:"USDC",destinationDecimals:6,donationAmount:"300",poolContributionAmount:"30",contributionPercent:10,poolContributionState:"pending",...changes};
}
function settlement(total){const allocation=splitSettlementUnits(parseUnits(total,18));return {receivedAmount:total,receivedDonationAmount:formatUnits(allocation.causeUnits,18),receivedPoolContributionAmount:formatUnits(allocation.poolUnits,18)};}

test("verified excess transfer preserves immutable quote and shares the entire actual cause allocation",()=>{
  const received=settlement("333"),raw=invoice({...received,state:"delivered",bridgeHash:hash,destinationHash:hash,deliveredUsdc:"450000"});
  const parsed=validatePayableInvoice(raw);
  assert.equal(parsed.amount,"330");assert.equal(parsed.donationAmount,"300");assert.equal(parsed.poolContributionAmount,"30");assert.equal(parsed.paymentUri,raw.paymentUri);
  assert.equal(parsed.receivedAmount,"333");assert.equal(parsed.receivedDonationAmount,"302.727272727272727272");assert.equal(parsed.receivedPoolContributionAmount,"30.272727272727272728");
  assert.equal(parseUnits(parsed.receivedDonationAmount,18)+parseUnits(parsed.receivedPoolContributionAmount,18),333n*10n**18n);
  const card=donationCard({state:parsed.state,mode:parsed.mode,initiativeId:parsed.initiativeId,amount:parsed.receivedDonationAmount});
  assert.equal(card.amount,"302.727272727272727272");assert.equal(card.filename,"chogcare-school-supplies-302.727272727272727272-chog.png");
});

test("received allocation is optional for historical invoices and accepted only after a verified deposit",()=>{
  assert.equal(validatePayableInvoice(invoice()).receivedAmount,undefined);
  for(const state of ["processing","bridging","confirming","delivered"]){
    const receipts=state==="confirming"?{bridgeHash:hash,observedDestinationHash:hash,observedUsdc:"450000"}:state==="delivered"?{bridgeHash:hash,destinationHash:hash,deliveredUsdc:"450000"}:{};
    assert.equal(validatePayableInvoice(invoice({...settlement("333"),state,...receipts})).receivedAmount,"333");
  }
  for(const state of ["awaiting-payment","expired"])assert.throws(()=>validatePayableInvoice(invoice({...settlement("333"),state})));
  assert.throws(()=>validatePayableInvoice(invoice({...settlement("333"),depositHash:null})));
  assert.throws(()=>validatePayableInvoice(invoice({...settlement("333"),depositHash:hash+"\n"})));
});

test("a verified transfer held for manual review remains readable without producing a success card",()=>{
  const raw=invoice({...settlement("333"),state:"manual-review",message:"The transfer needs operator review. Do not pay again."});
  const held=validatePayableInvoice(raw);
  assert.equal(held.state,"manual-review");assert.equal(held.receivedAmount,"333");assert.equal(held.receivedDonationAmount,"302.727272727272727272");assert.equal(held.amount,"330");
  assert.equal(donationCard({state:held.state,mode:held.mode,initiativeId:held.initiativeId,amount:held.receivedDonationAmount}),null);
  for(const changed of [{depositHash:null},{receivedDonationAmount:undefined},{receivedPoolContributionAmount:"30"},{state:"awaiting-payment"},{state:"expired"}])assert.throws(()=>validatePayableInvoice({...raw,...changed}));
});

test("received data rejects partial groups, coercion, underpayment, invalid splits and pilot-cap excess",()=>{
  const received=settlement("333");
  for(const field of Object.keys(received)){
    const partial={...received};delete partial[field];assert.throws(()=>validatePayableInvoice(invoice(partial)),field+" missing");
    for(const value of [null,333,{},"333\n","333\u2028","3.33e2","0","-333","333.1234567890123456789"])
      assert.throws(()=>validatePayableInvoice(invoice({...received,[field]:value})),field+" malformed");
  }
  for(const total of ["329.999999999999999999","1100000.000000000000000001"])assert.throws(()=>validatePayableInvoice(invoice(settlement(total))));
  assert.throws(()=>validatePayableInvoice(invoice({...received,receivedDonationAmount:"300",receivedPoolContributionAmount:"33"})));
  assert.throws(()=>validatePayableInvoice(invoice({...received,receivedDonationAmount:"302.727272727272727273",receivedPoolContributionAmount:"30.272727272727272727"})));
  for(const changed of [{amount:"333"},{donationAmount:"302.727272727272727272"},{poolContributionAmount:"30.272727272727272728"},{paymentUri:`ethereum:${address}@143?value=1`}])
    assert.throws(()=>validatePayableInvoice(invoice({...received,...changed})),"received metadata cannot alter the original quote");
  assert.equal(validatePayableInvoice(invoice(settlement("1100000"))).receivedDonationAmount,"1000000");
  assert.deepEqual(Object.fromEntries(Object.keys(received).map(field=>[field,validatePayableInvoice(invoice(settlement("330")))[field]])),settlement("330"));
});

test("legacy zero-contribution receipts allocate the entire received amount to the cause",()=>{
  const raw=invoice({amount:"300",donationAmount:undefined,poolContributionAmount:undefined,contributionPercent:0,poolContributionState:undefined,paymentUri:`ethereum:${CHOG}@143/transfer?address=${address}&uint256=${300n*10n**18n}`,receivedAmount:"333",receivedDonationAmount:"333",receivedPoolContributionAmount:"0"});
  const parsed=validatePayableInvoice(raw);assert.equal(parsed.receivedDonationAmount,"333");assert.equal(parsed.receivedPoolContributionAmount,"0");
  assert.throws(()=>validatePayableInvoice({...raw,...settlement("333")}));
  assert.throws(()=>validatePayableInvoice({...raw,receivedAmount:"1000000.000000000000000001",receivedDonationAmount:"1000000.000000000000000001"}));
});
