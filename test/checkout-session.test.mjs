import test from "node:test";
import assert from "node:assert/strict";
import { assertUnpaidCheckout } from "../src/checkout-session.ts";
import { activeInvoiceKeys, beginCreation, checkoutSelection, closeSavedInvoice, createPaymentRequest, pendingCreation, recoveryBundle, rememberInvoice, rememberMode, savedInvoice, validInvoiceId } from "../src/checkout-session.ts";

const chogId = "a".repeat(64), nftId = "b".repeat(64);
test("cancel guard refuses processing, wrong identity and any detected funds", () => {
  const invoice = { id: chogId, state: "awaiting-payment", depositHash: null };
  assert.doesNotThrow(() => assertUnpaidCheckout(chogId, invoice));
  for (const state of ["processing", "bridging", "verifying", "verified", "paying", "confirming", "delivered", "manual-review", "expired"]) assert.throws(() => assertUnpaidCheckout(chogId, { ...invoice, state }));
  assert.throws(() => assertUnpaidCheckout(nftId, invoice));
  for (const key of ["depositHash", "destinationHash", "observedDestinationHash"]) assert.throws(() => assertUnpaidCheckout(chogId, { ...invoice, [key]: "0x" + "1".repeat(64) }));
});
function memory() { const map = new Map(); return { getItem:key=>map.get(key)??null, setItem:(key,value)=>map.set(key,value), removeItem:key=>map.delete(key) }; }
const chog = { mode:"chog", amount:"300", holderAddress:"", initiativeId:"burundi" };
const nft = { mode:"nft", amount:"1", holderAddress:"0x"+"1".repeat(40), tokenId:"12", initiativeId:"burundi" };

for(const initiativeId of ["school-supplies","solar-foundation","vida-verde"])test(`NFT ${initiativeId} recovery never relabels an outstanding grant`,()=>{
  const store=memory();beginCreation({...nft,initiativeId},store);
  assert.equal(pendingCreation("nft",store).input.initiativeId,initiativeId);
  rememberInvoice("nft",nftId,store,initiativeId);
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,initiativeId);
  assert.throws(()=>rememberInvoice("nft",nftId,store,"burundi"));
});

test("Animal Ethics recovery retains its cause instead of falling back to Burundi",()=>{
  const store=memory();
  beginCreation({...chog,initiativeId:"animal-ethics"},store);
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"animal-ethics");
  rememberInvoice("chog",chogId,store,"animal-ethics");
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"animal-ethics");
  assert.throws(()=>rememberInvoice("chog",chogId,store,"burundi"));
  closeSavedInvoice("chog",store);
  assert.equal(checkoutSelection("burundi","chog",store).initiativeId,"burundi");
});

test("archived completed or explicitly closed invoices unlock methods without losing recovery", () => {
  for (const mode of ["chog", "nft"]) {
    const store = memory(), id = mode === "chog" ? chogId : nftId;
    rememberInvoice(mode, id, store);
    closeSavedInvoice(mode, store);
    closeSavedInvoice(mode, store);
    for (const wanted of ["chog", "nft"]) assert.deepEqual(checkoutSelection("herd", wanted, store), { mode: wanted, initiativeId: "herd", outstanding: false });
    assert.deepEqual(JSON.parse(recoveryBundle(store)).history, [{ mode, id }]);
  }
});

test("NFT-only restore opens NFT mode and pins the original cause, including legacy v1 IDs", () => {
  const store = memory(); store.setItem(activeInvoiceKeys.nft,nftId);
  assert.deepEqual(checkoutSelection("herd","chog",store),{mode:"nft",initiativeId:"burundi",outstanding:true});
  assert.equal(savedInvoice("nft",store),nftId);
});
test("both invoice IDs survive mode switching, pinning, reset and recovery export", () => {
  const store=memory(); rememberInvoice("chog",chogId,store); rememberInvoice("nft",nftId,store);
  rememberMode("nft",store);
  assert.equal(checkoutSelection("herd",undefined,store).mode,"nft");
  assert.equal(checkoutSelection("herd","chog",store).mode,"chog");
  assert.throws(()=>rememberInvoice("nft","c".repeat(64),store),/already saved/);
  assert.equal(savedInvoice("nft",store),nftId);
  closeSavedInvoice("chog",store);
  assert.equal(savedInvoice("nft",store),nftId);
  const recovery=JSON.parse(recoveryBundle(store));
  assert.equal(recovery.nft,nftId); assert.deepEqual(recovery.history,[{mode:"chog",id:chogId}]);
  assert.equal(checkoutSelection("herd","chog",store).mode,"nft");
});
test("ambiguous creation retries keep exactly the same key and payload across reloads", async () => {
  const store=memory(), first=beginCreation(chog,store);
  await assert.rejects(()=>createPaymentRequest(first,new AbortController().signal,async()=>{throw new Error("response lost");}),/request is saved/);
  const restored=pendingCreation("chog",store);
  assert.deepEqual(restored,first);
  assert.deepEqual(beginCreation(chog,store),first);
  assert.throws(()=>beginCreation({...chog,amount:"500"},store),/not been resolved/);
  assert.equal(checkoutSelection("heaven","nft",store).mode,"chog");
  let sent;
  await createPaymentRequest(restored,new AbortController().signal,async(url,init)=>{sent={url,...init}; return new Response(JSON.stringify({id:chogId}),{status:201});});
  assert.equal(sent.headers["Idempotency-Key"],first.key);
  assert.deepEqual(JSON.parse(sent.body),chog);
  rememberInvoice("chog",chogId,store);
  assert.equal(pendingCreation("chog",store),null);
  assert.equal(savedInvoice("chog",store),chogId);
});
test("storage write failure prevents new creation; failed completion does not lose pending key", () => {
  const store=memory(); const broken={...store,setItem(){throw new Error("full");}};
  assert.throws(()=>beginCreation(chog,broken),/full/);
  assert.equal(pendingCreation("chog",store),null);
  const pending=beginCreation(nft,store);
  assert.throws(()=>rememberInvoice("nft",nftId,broken),/full/);
  assert.deepEqual(pendingCreation("nft",store),pending);
});
test("only an explicit safe pre-creation rejection unlocks request editing", async () => {
  const store=memory(), pending=beginCreation(chog,store);
  const fail=(body,status)=>async()=>new Response(JSON.stringify(body),{status});
  for(const [body,status] of [[{code:"REQUEST_PENDING"},409],[{code:"SESSION_REQUIRED"},403],[{error:"offline"},503]]) {
    await assert.rejects(()=>createPaymentRequest(pending,new AbortController().signal,fail(body,status),store),/not resolved/);
    assert.deepEqual(pendingCreation("chog",store),pending);
  }
  await assert.rejects(()=>createPaymentRequest(pending,new AbortController().signal,fail({creationNotStarted:true},400),store),/No payment was created/);
  assert.equal(pendingCreation("chog",store),null);
  assert.notEqual(beginCreation({...chog,amount:"500"},store).key,pending.key);
});
test("invalid saved references are not silently erased or substituted", () => {
  const store=memory(); store.setItem(activeInvoiceKeys.nft,"../../config");
  assert.equal(checkoutSelection("herd","chog",store).initiativeId,"burundi");
  assert.throws(()=>closeSavedInvoice("nft",store),/Invalid saved invoice/);
  assert.equal(store.getItem(activeInvoiceKeys.nft),"../../config");
  for(const value of ["../config",nftId+"?query",null,123])assert.equal(validInvoiceId(value),false);
});
