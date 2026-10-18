import test from "node:test";
import assert from "node:assert/strict";
import { getAddress, parseUnits } from "viem";
import { CHOG } from "../src/route.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { activeInvoiceKeys, beginCreation, checkoutSelection, pendingCreation, recoveryBundle, rememberInvoice, savedInvoice } from "../src/checkout-session.ts";
import { inspectCheckoutForChange, closeCheckoutForChange } from "../src/checkout-navigation.ts";

const chogId="a".repeat(64),nftId="b".repeat(64),address="0x1111111111111111111111111111111111111111",hash="0x"+"c".repeat(64);
function memory(){const map=new Map();return{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function invoice(mode){
  const shared={kind:"payment",id:mode==="chog"?chogId:nftId,mode,state:"awaiting-payment",chainId:143,destinationChainId:10,initiativeId:"school-supplies",recipient:chogBeneficiary("school-supplies",10),depositAddress:address,expiresAt:Date.now()+600000,depositHash:null,destinationHash:null,observedDestinationHash:null,message:null};
  return mode==="chog"?{...shared,asset:"CHOG",amount:"330",donationAmount:"300",poolContributionAmount:"30",contributionPercent:10,poolContributionState:"pending",minUsdc:"200000",minimumUsd:"200000",destinationAsset:"USDC",destinationDecimals:6,bridgeHash:null,paymentUri:`ethereum:${CHOG}@143/transfer?address=${getAddress(address)}&uint256=${parseUnits("330",18)}`}:{...shared,asset:"MON",amount:"1",subsidyUsdc:"1.00",tokenId:"7",holderAddress:"0x2222222222222222222222222222222222222222",claimDay:"2026-10-16",paymentUri:`ethereum:${address}@143?value=1000000000000000000`};
}
const response=data=>async(url,init)=>{assert.equal(init.cache,"no-store");if(url.endsWith("/config"))return Response.json({});if(init?.method==="POST"){assert.equal(data.mode,"chog");assert.equal(url,`/api/payments/invoices/${data.id}/cancel`);assert.deepEqual(JSON.parse(init.body),{mode:"chog"});return Response.json({...data,state:"expired"});}return Response.json(data);};
for(const mode of ["chog","nft"])test(`${mode}: confirmed unpaid initiative change archives the old invoice and preserves the other mode`,async()=>{
  const store=memory(),x=invoice(mode),other=mode==="chog"?"nft":"chog";
  rememberInvoice(mode,x.id,store,"school-supplies");rememberInvoice(other,invoice(other).id,store,"solar-foundation");
  const before=recoveryBundle(store);
  await inspectCheckoutForChange(mode,response(x),store);assert.equal(recoveryBundle(store),before,"inspection is read-only");
  await closeCheckoutForChange(mode,x.id,response(x),store);
  assert.equal(savedInvoice(mode,store),"");assert.equal(savedInvoice(other,store),invoice(other).id);
  assert.equal(checkoutSelection("vida-verde",mode,store).initiativeId,"vida-verde");
  assert.deepEqual(JSON.parse(recoveryBundle(store)).history,[{mode,id:x.id}]);
});
test("unresolved QR creation cannot be cancelled or replaced by navigation",async()=>{
  const store=memory(),pending=beginCreation({mode:"chog",amount:"300",holderAddress:"",initiativeId:"school-supplies"},store);
  await assert.rejects(inspectCheckoutForChange("chog",()=>{throw Error("must not request");},store),/unresolved/);
  assert.deepEqual(pendingCreation("chog",store),pending);
});

test("failed or ambiguous server cancellation keeps the original recovery reference",async()=>{
  const x=invoice("chog"),store=memory();rememberInvoice("chog",x.id,store,x.initiativeId);
  for(const failure of [async()=>new Response("",{status:409}),async()=>{throw Error("timeout");},async()=>Response.json(x)]){
    const request=async(url,init)=>init.method==="POST"?failure():response(x)(url,init);
    await assert.rejects(closeCheckoutForChange("chog",x.id,request,store));
    assert.equal(savedInvoice("chog",store),x.id);
  }
});
test("no invoice permits immediate navigation without any request",async()=>{
  assert.equal(await inspectCheckoutForChange("chog",()=>{throw Error("must not request");},memory()),null);
});
test("processing, funded, wrong-identity and offline responses never close an invoice",async()=>{
  for(const mode of ["chog","nft"]){
    const x=invoice(mode),store=memory();rememberInvoice(mode,x.id,store,x.initiativeId);const before=recoveryBundle(store);
    const states=mode==="chog"?["processing","bridging","manual-review"]:["verifying","verified","paying","manual-review"];
    const variants=[...states.map(state=>({...x,state})),...['depositHash','destinationHash','observedDestinationHash',...(mode==="chog"?['bridgeHash']:[])].map(key=>({...x,[key]:hash})),{...x,id:"d".repeat(64)},{...x,initiativeId:"solar-foundation",recipient:chogBeneficiary("solar-foundation",10)},{...x,paymentUri:"ethereum:wrong"}];
    for(const value of variants){await assert.rejects(closeCheckoutForChange(mode,x.id,response(value),store));assert.equal(recoveryBundle(store),before);}
    for(const request of [async()=>new Response("",{status:503}),async()=>{throw Error("timeout");}]){await assert.rejects(closeCheckoutForChange(mode,x.id,request,store));assert.equal(recoveryBundle(store),before);}
  }
});
test("expired unpaid checkout is archived only after explicit confirmation; no funds are discarded",async()=>{
  const store=memory(),x={...invoice("chog"),state:"expired"};rememberInvoice("chog",x.id,store,x.initiativeId);
  await assert.rejects(closeCheckoutForChange("chog",x.id,response({...x,depositHash:hash}),store));
  assert.equal(savedInvoice("chog",store),x.id);
  await closeCheckoutForChange("chog",x.id,response(x),store);assert.equal(savedInvoice("chog",store),"");
});
test("an invoice changing during the read or recovery-storage failure prevents navigation",async()=>{
  const store=memory(),x=invoice("chog");rememberInvoice("chog",x.id,store,x.initiativeId);
  await assert.rejects(closeCheckoutForChange("chog",x.id,async()=>{store.setItem(activeInvoiceKeys.chog,"e".repeat(64));return Response.json(x);},store),/changed/);
  assert.equal(savedInvoice("chog",store),"e".repeat(64));
  store.setItem(activeInvoiceKeys.chog,x.id);
  await assert.rejects(closeCheckoutForChange("chog",x.id,response(x),{...store,setItem(){throw Error("storage full");}}),/storage full/);
  assert.equal(savedInvoice("chog",store),x.id);
});
