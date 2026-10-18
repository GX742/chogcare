import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HDNodeWallet, Transaction } from "ethers";
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, parseAbi, parseUnits, erc20Abi, keccak256 } from "viem";
import { createChogProcessor, fetchProfileMetadata } from "../server/chog-processor.mjs";
import { DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { CHOG, MONAD_USDC, ETHEREUM_USDC, GIVETH_PROJECT_RECIPIENT, NAD_DEX_ROUTER } from "../src/route.ts";
import { RELAY_DEPOSITORY } from "../server/relay-route.mjs";
import { validatePayableInvoice } from "../src/payable-invoice.ts";
import { createPaymentService } from "../server/payment-service.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { deliveryNetwork, SOLANA_CHAIN_ID } from "../src/delivery-network.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";

const h=n=>`0x${BigInt(n).toString(16).padStart(64,"0")}`;
const donor="0x1111111111111111111111111111111111111111";
const fee=100_000n*1_000_000_000n;
const donationUnits=300n*10n**18n,totalUnits=330n*10n**18n;
const solanaSignature="2".repeat(64);
function event(token,to,value,hash,number) {
  return {address:token,transactionHash:hash,blockHash:h(number),blockNumber:number,logIndex:0,removed:false,
    topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:donor,to}}),data:encodeAbiParameters([{type:"uint256"}],[value])};
}
async function harness(t, destinationChainId=1, expensiveBridge=false, initiativeId="burundi", newChain=destinationChainId, extraDependencies={}) {
  const dir=await mkdtemp(join(tmpdir(),"chog-processor-test-"));
  const root=HDNodeWallet.createRandom("",DEPOSIT_BASE_PATH), xpub=root.neuter().extendedKey;
  const vault={version:1,basePath:DEPOSIT_BASE_PATH,xpub,keyId:createHash("sha256").update(xpub).digest("hex")};
  let number=100n, paidLog=null, readyDelivery=false, chainId=143, sourceTimeout=false, destinationFinal=9999n, relayOffline=false, reorg=false, receiptReads=0, holdSource=false, relayGate=null;
  const receipts=new Map(), broadcasts=[], nonces=new Map();
  const solanaRoute=destinationChainId===SOLANA_CHAIN_ID;
  let destLog=solanaRoute?null:event(deliveryNetwork(destinationChainId).usdc,chogBeneficiary(initiativeId,destinationChainId),880_000n,h(9000),900n);
  const block=args=>({number:args.blockNumber??number,hash:h(args.blockNumber??number),timestamp:BigInt(Math.floor(Date.now()/1000))});
  const source={
    getChainId:async()=>chainId,
    getBlock:async args=>args.blockTag==="finalized"&&holdSource?block({blockNumber:number-1n}):block(args),
    getBalance:async args=>args.blockNumber?(broadcasts.find(x=>x.tx.to.toLowerCase()===args.address.toLowerCase()&&x.tx.data==="0x")?.tx.value??5n*10n**18n)+20n*10n**18n-broadcasts.filter(x=>x.tx.from.toLowerCase()===args.address.toLowerCase()).reduce((sum,x)=>sum+x.tx.gasLimit*1_000_000_000n,0n):1000n*10n**18n,
    getContractEvents:async args=>paidLog && paidLog.blockNumber>=args.fromBlock && paidLog.blockNumber<=args.toBlock && paidLog.topics[2].toLowerCase().endsWith(args.args.to.slice(2).toLowerCase())?[paidLog]:[],
    getTransactionCount:async args=>nonces.get(args.address.toLowerCase())??0,
    getGasPrice:async()=>1_000_000_000n,estimateGas:async()=>100_000n,
    readContract:async()=>1_000_000n,
    getTransactionReceipt:async({hash})=>{receiptReads++;if(receipts.has(hash))return receipts.get(hash);const e=new Error("not found");e.name="TransactionReceiptNotFoundError";throw e;},
    sendRawTransaction:async({serializedTransaction})=>{
      const tx=Transaction.from(serializedTransaction), hash=keccak256(serializedTransaction);
      assert.equal(tx.chainId,143n);assert.ok(tx.isSigned());
      broadcasts.push({tx,hash,raw:serializedTransaction});nonces.set(tx.from.toLowerCase(),tx.nonce+1);number++;
      receipts.set(hash,{status:"success",transactionHash:hash,blockNumber:number,blockHash:h(number),gasUsed:100_000n,effectiveGasPrice:1_000_000_000n,logs:[]});
      if(sourceTimeout){sourceTimeout=false;throw new Error("transport timed out AFTER submission");}
      return hash;
    },
  };
  const destination={getChainId:async()=>1,
    getBlock:async args=>args.blockTag?{number:destinationFinal}:reorg?{...block(args),hash:h(999)}:block(args),
    getTransactionReceipt:async()=>({status:"success",transactionHash:h(9000),blockNumber:900n,blockHash:h(900),logs:[destLog]})};
  const dependencies={source,destination,optimismDestination:{...destination,getChainId:async()=>10},
    solanaVerifier:{ready:async()=>true,inspectNativeTransfer:async(_signature,recipient,minimum)=>readyDelivery&&_signature===solanaSignature&&recipient===chogBeneficiary("animal-ethics",SOLANA_CHAIN_ID)?{finalized:true,amount:minimum+50_000n,blockTime:Math.floor(Date.now()/1000),eventId:`solana:${_signature}:1`}:null},
    saleQuote:async()=>({router:NAD_DEX_ROUTER,minMon:String(19n*10n**18n)}),
    usdcQuote:async()=>({fee:500,minUsdc:"980000"}),
    bridgeQuote:async(_payer,_amount,_minimum,chain)=>({requestId:h(8000),orderId:h(8001),minOutput:chain===SOLANA_CHAIN_ID?"8400000":expensiveBridge?"800000":"870000",expectedOutput:chain===SOLANA_CHAIN_ID?"8800000":"880000",minimumOutputUsdMicros:expensiveBridge?"800000":"870000",destinationChainId:chain,estimatedSeconds:2,to:RELAY_DEPOSITORY,data:encodeFunctionData({abi:parseAbi(["function depositErc20(address depositor,address token,uint256 amount,bytes32 id)"]),functionName:"depositErc20",args:[_payer,MONAD_USDC,_amount,h(8001)]}),value:"0",validUntil:Date.now()+60_000}),
    relayJson:async()=>{const bridgeHash=broadcasts.at(-1)?.hash;if(relayGate)await relayGate;if(relayOffline)throw new Error("Relay unavailable");return {status:readyDelivery?"success":"pending",originChainId:143,destinationChainId,inTxHashes:[bridgeHash],txHashes:[solanaRoute?solanaSignature:h(9000)]};},...extraDependencies};
  const settings={filename:join(dir,"processor.sqlite"),vault,root,newDestinationChainId:newChain};
  let processor=createChogProcessor(settings,dependencies);
  t.after(async()=>{await processor.close();await rm(dir,{recursive:true,force:true});});
  return {get processor(){return processor;},get receiptReads(){return receiptReads;},broadcasts,source,
    async issue(){await processor.tick();return processor.issue({mode:"chog",amount:"300",initiativeId});},
    async seedLegacyAnimalInvoice(){
      await processor.tick();const issued=await processor.issue({mode:"chog",amount:"300",initiativeId:"burundi"});
      const db=new DatabaseSync(settings.filename);const row=db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(issued.id);
      const x={...JSON.parse(row.document),initiativeId:"animal-ethics",destinationChainId:1};
      db.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify(x),issued.id);db.close();return processor.get(issued.id);
    },
    deposit(invoice,value=parseUnits(invoice.amount,18)){number++;paidLog=event(CHOG,invoice.depositAddress,value,h(7000),number);receipts.set(h(7000),{status:"success",transactionHash:h(7000),blockNumber:number,blockHash:h(number),logs:[paidLog]});},
    delivery(value=true){readyDelivery=value;},wrongDestination(){destLog=event(ETHEREUM_USDC,donor,880_000n,h(9000),900n);},
    wrongToken(){destLog=event(ETHEREUM_USDC,GIVETH_PROJECT_RECIPIENT,880_000n,h(9000),900n);},
    unfinalized(){destinationFinal=899n;},finalize(){destinationFinal=9999n;},timeout(){sourceTimeout=true;},wrongChain(){chainId=1;},
    relayOffline(){relayOffline=true;},reorg(){reorg=true;},
    delayRelay(){let release;relayGate=new Promise(resolve=>{release=resolve;});return ()=>{release();relayGate=null;};},
    holdSource(){holdSource=true;},finalizeSource(){holdSource=false;},
    async restart(){await processor.close();processor=createChogProcessor(settings,dependencies);},
    async useLegacyGasPlan(id){await processor.close();const db=new DatabaseSync(settings.filename);const x=JSON.parse(db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id).document);delete x.sourceGasPlanVersion;delete x.gasGrantUnits;db.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify(x),id);db.close();processor=createChogProcessor(settings,dependencies);},
    async restartLegacyOnOptimism(id){await processor.close();const db=new DatabaseSync(settings.filename);const x=JSON.parse(db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id).document);delete x.destinationChainId;db.prepare("UPDATE chog_invoices SET document=? WHERE id=?").run(JSON.stringify(x),id);db.close();settings.newDestinationChainId=10;processor=createChogProcessor(settings,dependencies);},
    async advance(times=8){for(let i=0;i<times;i++)await processor.tick();},
  };
}

const metadataUri=`ipfs://${"a".repeat(46)}/1130.json`;
test("a 3.97-MON operator balance enables fully budgeted new invoices, without re-funding legacy ones",async t=>{
  const f=await harness(t,10,false,"school-supplies");
  const originalBalance=f.source.getBalance;
  let depositAddress;
  f.source.getBalance=async args=>args.blockNumber||args.address===depositAddress?originalBalance(args):3_970_000_000_000_000_000n;
  const invoice=await f.issue();
  depositAddress=invoice.depositAddress;
  assert.equal(f.processor.publicStatus().paymentsEnabled,true);
  assert.equal(invoice.sourceGasPlanVersion,undefined,"private operational budgets stay out of public invoices");
  f.deposit(invoice);await f.advance();
  assert.equal(f.broadcasts[0].tx.value,1_500_000_000_000_000_000n);
  assert.equal(f.processor.get(invoice.id).state,"bridging");
});

test("legacy invoice gas funding and sale proceeds survive a restart unchanged",async t=>{
  const f=await harness(t,10,false,"school-supplies"),invoice=await f.issue();
  await f.useLegacyGasPlan(invoice.id);f.deposit(invoice);await f.advance();
  assert.equal(f.broadcasts[0].tx.value,5_000_000_000_000_000_000n);
  assert.equal(f.broadcasts.find(x=>x.tx.value>0n&&x.tx.data!=="0x").tx.value,20n*10n**18n);
  assert.equal(f.processor.get(invoice.id).state,"bridging");
  const count=f.broadcasts.length;await f.restart();await f.advance();
  assert.equal(f.broadcasts.length,count,"a restart must not re-fund or replace signed transactions");
});

test("a new-invoice phase estimate beyond the funded ceiling stops before that phase is signed",async t=>{
  const f=await harness(t,10,false,"school-supplies"),invoice=await f.issue();
  f.source.estimateGas=async args=>args.data==="0x"?21_000n:200_001n;
  f.deposit(invoice);await f.advance(1);
  assert.equal(f.broadcasts.length,1,"only the already-budgeted gas funding was sent; over-budget approval was not signed");
  assert.equal(f.processor.get(invoice.id).state,"processing");
  await f.advance(1);assert.equal(f.broadcasts.length,1,"retry does not duplicate the funding transfer");
});

test("CHOG readiness recovers after network loss without restarting or replacing a saved invoice",async t=>{
  const f=await harness(t,10,false,"school-supplies");
  const invoice=await f.issue(),getBalance=f.source.getBalance;
  assert.equal(f.processor.publicStatus().chogReadiness,"ready");
  f.source.getBalance=async()=>{throw new Error("temporary network outage");};
  await assert.rejects(f.processor.refreshReadiness());
  assert.equal(f.processor.publicStatus().paymentsEnabled,false);
  assert.equal(f.processor.publicStatus().chogReadiness,"network-unavailable");
  assert.equal(f.processor.get(invoice.id).depositAddress,invoice.depositAddress);
  f.source.getBalance=async()=>0n;
  await f.processor.refreshReadiness();
  assert.equal(f.processor.publicStatus().chogReadiness,"gas-needed");
  assert.equal(f.processor.publicStatus().paymentsEnabled,false);
  f.source.getBalance=getBalance;
  await f.processor.refreshReadiness();
  assert.equal(f.processor.publicStatus().paymentsEnabled,true);
  assert.equal(f.processor.publicStatus().chogReadiness,"ready");
  assert.equal(f.processor.get(invoice.id).depositAddress,invoice.depositAddress);
  assert.equal(f.broadcasts.length,0);
});

test("NFT metadata requests pin the IPFS gateway and prohibit redirects into local services",async()=>{
  let calls=0;
  const metadata=await fetchProfileMetadata(metadataUri,async(url,options)=>{
    calls++;assert.equal(url,`https://gateway.pinata.cloud/ipfs/${"a".repeat(46)}/1130.json`);
    assert.equal(options.redirect,"error");assert.equal(options.headers.Accept,"application/json");assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({name:"CHOG #1130",image:`ipfs://${"b".repeat(46)}/coin.png`}));
  });
  assert.equal(metadata.name,"CHOG #1130");
  for(const uri of ["http://127.0.0.1:4174/api/payments/config","https://evil.example/nft.json",`ipfs://${"a".repeat(46)}/../private`])assert.equal(await fetchProfileMetadata(uri,()=>{calls++;throw new Error("Not allowed");}),null);
  assert.equal(calls,1);
});

test("NFT metadata stops chunked/lying Content-Length responses at the byte limit",async()=>{
  for(const declared of [null,"1"]){
    let reads=0,cancelled=false;
    const stream=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(16_384));},cancel(){cancelled=true;}});
    const headers=declared===null?{}:{"Content-Length":declared};
    await assert.rejects(fetchProfileMetadata(metadataUri,async()=>new Response(stream,{headers})),/display limit/);
    assert.ok(reads<=7,"the full oversized body must never be downloaded");assert.equal(cancelled,true);
  }
});

test("NFT metadata rejects an oversized declared body before reading it",async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"Content-Length":"65537"}});
  await assert.rejects(fetchProfileMetadata(metadataUri,async()=>response),/response rejected/);
  assert.equal(cancelled,true);
  await assert.rejects(fetchProfileMetadata(metadataUri,async()=>new Response("[]")),/Invalid NFT metadata/);
});

test("overlapping donor profile lookups are coalesced without retaining stale ownership",async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let fetches=0,ownershipReads=0;
  const f=await harness(t,10,false,"school-supplies",10,{metadataFetch:async()=>{fetches++;await gate;return new Response(JSON.stringify({name:"CHOG #1130",image:`ipfs://${"b".repeat(46)}/coin.png`}));}});
  const invoice=await f.issue();f.deposit(invoice);await f.advance();f.delivery();await f.advance();
  f.source.readContract=async({functionName})=>functionName==="tokensOfOwner"?(ownershipReads++,[1130n]):metadataUri;
  const first=f.processor.profileNfts(invoice.id),second=f.processor.profileNfts(invoice.id);
  await new Promise(resolve=>setImmediate(resolve));release();
  const [one,two]=await Promise.all([first,second]);assert.deepEqual(one,two);assert.equal(fetches,1);assert.equal(ownershipReads,1);
  await f.processor.profileNfts(invoice.id);assert.equal(fetches,1);assert.equal(ownershipReads,2,"ownership is not cached across separate profile requests");
  f.source.readContract=async()=>["1130"];
  await assert.rejects(f.processor.profileNfts(invoice.id),/Invalid NFT lookup/);
});

test("donor NFT metadata cache is bounded instead of growing with every public profile",async t=>{
  let fetches=0,current=0n;
  const f=await harness(t,10,false,"school-supplies",10,{metadataFetch:async()=>{fetches++;return new Response(JSON.stringify({name:"CHOG"}));}});
  const invoice=await f.issue();f.deposit(invoice);await f.advance();f.delivery();await f.advance();
  f.source.readContract=async({functionName})=>functionName==="tokensOfOwner"?[current]:metadataUri;
  for(current=0n;current<140n;current++)await f.processor.profileNfts(invoice.id);
  assert.equal(fetches,140);current=0n;await f.processor.profileNfts(invoice.id);
  assert.equal(fetches,141,"the oldest entry is evicted after the bounded cache fills");
});

test("expensive bridge is rejected before issuing a QR or sending funds",async t=>{
  const f=await harness(t,10,true);
  await assert.rejects(f.issue(),/Bridge cost exceeds/);
  assert.equal(f.broadcasts.length,0);
});

test("private leaderboard context reads the verified sender without changing or exposing payment data",async t=>{
  const f=await harness(t,10,false,"school-supplies"),invoice=await f.issue();
  assert.equal(f.processor.leaderboardDonation(invoice.id),null);
  f.deposit(invoice);await f.advance();f.unfinalized();f.delivery();await f.advance(1);
  assert.equal(f.processor.get(invoice.id).state,"confirming");
  const broadcasts=f.broadcasts.length,reads=f.receiptReads;
  assert.deepEqual(f.processor.leaderboardDonation(invoice.id),{sender:donor,state:"confirming",amount:"300",initiativeId:"school-supplies"});
  assert.equal(f.broadcasts.length,broadcasts);
  assert.equal(f.receiptReads,reads,"Private identity lookup must not call the network");
  const publicInvoice=f.processor.get(invoice.id);
  assert.equal(publicInvoice.depositProof,undefined);
  assert.equal(publicInvoice.sender,undefined);
  assert.doesNotMatch(JSON.stringify(publicInvoice),new RegExp(donor,"i"));
  f.finalize();await f.advance(1);
  assert.equal(f.processor.leaderboardDonation(invoice.id).state,"delivered");
  await f.restart();
  assert.equal(f.processor.leaderboardDonation(invoice.id).sender,donor);
  assert.equal(f.processor.leaderboardDonation("invalid"),null);
});

for(const initiativeId of ["school-supplies","solar-foundation","vida-verde"])test(`${initiativeId} pins OP despite ETH default and survives restart`,async t=>{
  const f=await harness(t,10,false,initiativeId,1),invoice=await f.issue();
  assert.equal(invoice.destinationChainId,10);
  assert.equal(invoice.initiativeId,initiativeId);
  assert.equal(invoice.recipient,chogBeneficiary(initiativeId,10));
  assert.equal(validatePayableInvoice(invoice).initiativeId,initiativeId);
  assert.throws(()=>validatePayableInvoice({...invoice,destinationChainId:1}));
  assert.throws(()=>validatePayableInvoice({...invoice,recipient:GIVETH_PROJECT_RECIPIENT}));
  await assert.rejects(f.processor.issue({mode:"chog",amount:"300",initiativeId:"burundi"},invoice.id),/cannot change/);
  assert.equal(f.processor.canRetryUnissuedChog(invoice.id),false);
  f.deposit(invoice);await f.advance();await f.restart();f.delivery();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"delivered");
  assert.equal(f.processor.get(invoice.id).recipient,invoice.recipient);
  assert.equal(f.broadcasts.length,7);
});

test("Animal Ethics pins native SOL, verifies the finalized recipient balance and survives restart",async t=>{
  const f=await harness(t,SOLANA_CHAIN_ID,false,"animal-ethics",10),invoice=await f.issue();
  assert.equal(invoice.destinationChainId,SOLANA_CHAIN_ID);assert.equal(invoice.destinationAsset,"SOL");
  assert.equal(invoice.recipient,chogBeneficiary("animal-ethics",SOLANA_CHAIN_ID));
  f.deposit(invoice);await f.advance();await f.restart();f.delivery();await f.advance();
  const delivered=validatePayableInvoice(f.processor.get(invoice.id));
  assert.equal(delivered.state,"delivered");assert.equal(delivered.destinationHash,solanaSignature);
  assert.ok(BigInt(delivered.deliveredUsdc)>=BigInt(delivered.minUsdc));assert.equal(f.broadcasts.length,7);
});

test("legacy Animal Ethics deposits are preserved for review, never silently redirected or spent",async t=>{
  const f=await harness(t,1,false,"animal-ethics",10),invoice=await f.seedLegacyAnimalInvoice();
  assert.equal(validatePayableInvoice(invoice).recipient,chogBeneficiary("animal-ethics",1));
  f.deposit(invoice);await f.advance();await f.restart();await f.advance();
  const restored=f.processor.get(invoice.id);assert.equal(restored.state,"manual-review");
  assert.equal(restored.recipient,invoice.recipient);assert.ok(restored.depositHash);assert.equal(f.broadcasts.length,0);
});

test("end-to-end orchestration: unique QR address -> CHOG -> swaps -> bridge -> finalized delivery",async t=>{
  const f=await harness(t), invoice=await f.issue();
  assert.equal(validatePayableInvoice(invoice).state,"awaiting-payment");
  assert.equal(f.broadcasts.length,0,"invoice creation never sends a transaction");
  const second=await f.issue();assert.notEqual(second.depositAddress,invoice.depositAddress);
  f.deposit(invoice);await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"bridging");
  assert.equal(f.broadcasts.length,7,"gas, exact approval, sale, swap, pool contribution, exact approval, bridge");
  assert.equal(f.broadcasts[3].tx.value,20n*10n**18n,"operator gas money is not donated as sale proceeds");
  f.delivery();f.unfinalized();await f.advance(1);
  const observed=validatePayableInvoice(f.processor.get(invoice.id));
  assert.equal(observed.state,"confirming","inclusion is not final delivery");
  assert.equal(observed.observedUsdc,"880000");assert.equal(observed.observedDestinationHash,h(9000));
  assert.equal(observed.destinationHash,null);assert.equal(observed.deliveredUsdc,null);
  assert.doesNotMatch(observed.message??"",/paused/);
  assert.ok(observed.processingStartedAt>0);assert.ok(observed.bridgeStartedAt>=observed.processingStartedAt);
  assert.ok(observed.destinationIncludedAt>0);
  f.finalize();await f.advance(1);
  const result=validatePayableInvoice(f.processor.get(invoice.id));
  assert.equal(result.state,"delivered");assert.equal(result.deliveredUsdc,"880000");assert.equal(result.destinationHash,h(9000));
  await f.restart();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"delivered");assert.equal(f.broadcasts.length,7,"restart never repeats a donation");
});

test("Optimism invoices bind native USDC, receipt observation and finality to chain 10",async t=>{
  const f=await harness(t,10),invoice=await f.issue();
  assert.equal(invoice.destinationChainId,10);assert.equal(invoice.bridgeEstimatedSeconds,2);
  f.deposit(invoice);f.delivery();f.unfinalized();await f.advance();
  const observed=validatePayableInvoice(f.processor.get(invoice.id));
  assert.equal(observed.state,"confirming");assert.equal(observed.destinationChainId,10);
  assert.equal(observed.deliveredUsdc,null);
  await f.restart();f.finalize();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"delivered");assert.equal(f.broadcasts.length,7);
});

test("legacy Ethereum invoice resumes on Ethereum after default changes to Optimism",async t=>{
  const f=await harness(t),invoice=await f.issue();f.deposit(invoice);await f.advance();
  await f.restartLegacyOnOptimism(invoice.id);f.delivery();await f.advance();
  const result=f.processor.get(invoice.id);
  assert.equal(result.destinationChainId,1);assert.equal(result.state,"delivered");
  assert.equal(f.processor.publicStatus().destinationChainId,10);
  assert.equal(f.broadcasts.length,7,"migration must not resend a paid order");
});

test("Ethereum token address on Optimism can never authorize a donation receipt",async t=>{
  const f=await harness(t,10),invoice=await f.issue();f.deposit(invoice);f.delivery();f.wrongToken();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"bridging");assert.equal(f.processor.get(invoice.id).observedUsdc,null);
});

test("observed Ethereum transfer survives restart and can finalize while Relay is offline",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);f.delivery();f.unfinalized();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"confirming");
  await f.restart();f.relayOffline();await f.advance(1);
  assert.equal(f.processor.get(invoice.id).state,"confirming");
  f.finalize();await f.advance(1);assert.equal(f.processor.get(invoice.id).state,"delivered");
  assert.equal(f.broadcasts.length,7);
});

test("reorganized observed transfer clears pending evidence and never marks delivery",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);f.delivery();f.unfinalized();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"confirming");f.reorg();f.finalize();await f.advance(1);
  const result=f.processor.get(invoice.id);assert.equal(result.state,"bridging");
  assert.equal(result.observedDestinationHash,null);assert.equal(result.observedUsdc,null);assert.equal(result.deliveredUsdc,null);
  assert.equal(result.destinationIncludedAt,null);
});

test("slow bridge tracking does not block the next invoice's source transaction",async t=>{
  const f=await harness(t), first=await f.issue();f.deposit(first);await f.advance();
  assert.equal(f.processor.get(first.id).state,"bridging");
  const second=await f.issue();f.deposit(second);
  const release=f.delayRelay();
  const tick=f.processor.tick();
  try {
    // Allow the deterministic async RPC mocks to progress without releasing Relay.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.broadcasts.length,14,"the second invoice can finish its source pipeline during bridge wait");
    assert.equal(f.processor.get(second.id).state,"bridging");
    await f.processor.tick();
    assert.equal(f.broadcasts.length,14,"overlapping ticks cannot double send");
  } finally {release();await tick;}
});

test("destination receipts continue tracking while a different invoice owns the source lane",async t=>{
  const f=await harness(t),first=await f.issue();f.deposit(first);await f.advance();
  const second=await f.issue();f.deposit(second);
  const getLogs=f.source.getContractEvents;let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.source.getContractEvents=async args=>{if(args.args.to===second.depositAddress)await gate;return getLogs(args);};
  const tick=f.processor.tick();
  try{
    await new Promise(resolve=>setImmediate(resolve));
    f.delivery();await f.processor.track();
    assert.equal(f.processor.get(first.id).state,"delivered");
    assert.equal(f.broadcasts.length,7,"the tracking lane cannot sign transactions");
    await f.processor.track();assert.equal(f.processor.get(first.id).state,"delivered");
  }finally{release();await tick;}
});

test("read-only CHOG readiness remains fresh through a bridge wait longer than its TTL",async t=>{
  let clock=Date.now();
  const f=await harness(t,1,false,"burundi",1,{now:()=>clock}),invoice=await f.issue();
  f.deposit(invoice);await f.advance();assert.equal(f.processor.get(invoice.id).state,"bridging");
  const release=f.delayRelay(),tick=f.processor.tick();
  try{
    await new Promise(resolve=>setImmediate(resolve));clock+=61_000;
    assert.equal(f.processor.publicStatus().paymentsEnabled,false,"the original health TTL must still expire");
    const before=f.broadcasts.length;
    await f.processor.refreshReadiness();
    assert.equal(f.processor.publicStatus().paymentsEnabled,true);
    assert.equal(f.broadcasts.length,before,"a readiness heartbeat cannot sign or resend a transaction");
    f.wrongChain();await assert.rejects(f.processor.refreshReadiness(),/chain mismatch/);
    assert.equal(f.processor.publicStatus().paymentsEnabled,false,"wrong-chain RPC remains fail closed");
  }finally{release();await tick;}
});

test("CHOG readiness probes coalesce, preserve gas gating and never create invoices",async t=>{
  const f=await harness(t);let release,reads=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.source.getBalance=async()=>{reads++;await gate;return 0n;};
  const one=f.processor.refreshReadiness(),two=f.processor.refreshReadiness();
  assert.equal(one,two);release();await Promise.all([one,two]);
  assert.equal(reads,1);assert.equal(f.processor.publicStatus().paymentsEnabled,false);
  assert.equal(f.broadcasts.length,0);
});

test("finalized source receipts are not repeatedly fetched for every subsequent phase",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);await f.advance();
  assert.equal(f.broadcasts.length,7);
  assert.ok(f.receiptReads<=22,`expected <=22 source receipt reads with the contribution transfer, got ${f.receiptReads}`);
});

test("pending source receipts are not cached and do not authorize the next phase",async t=>{
  const f=await harness(t),invoice=await f.issue();f.deposit(invoice);
  const broadcast=f.source.sendRawTransaction;
  f.source.sendRawTransaction=async args=>{const hash=await broadcast(args);if(f.broadcasts.length===1)f.holdSource();return hash;};
  await f.advance(1);
  assert.equal(f.broadcasts.length,1);await f.advance(2);
  assert.equal(f.broadcasts.length,1);assert.match(f.processor.get(invoice.id).message,/source finality/);
  f.finalizeSource();await f.advance();assert.equal(f.broadcasts.length,7);
});

test("confirming payments still consume an active invoice slot",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);f.delivery();f.unfinalized();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"confirming");await f.issue();await f.issue();
  await assert.rejects(f.issue(),/already active/);
});

test("unpaid cancellation releases checkout capacity without deleting its address or deadline",async t=>{
  const f=await harness(t),first=await f.issue();await f.issue();await f.issue();
  assert.equal(f.processor.publicStatus().chogQueueFull,true);
  assert.equal(f.processor.publicStatus().paymentsEnabled,false);
  const cancelled=f.processor.cancelUnpaidChog(first.id);
  assert.equal(cancelled.state,"expired");assert.equal(cancelled.depositAddress,first.depositAddress);assert.equal(cancelled.expiresAt,first.expiresAt);
  assert.deepEqual(f.processor.cancelUnpaidChog(first.id),cancelled,"lost-response retry is idempotent");
  assert.equal(f.processor.publicStatus().paymentsEnabled,true);
  const next=await f.issue();assert.notEqual(next.depositAddress,first.depositAddress);
  assert.equal(f.broadcasts.length,0);
});

test("a transfer already sent to a cancelled checkout is still recovered exactly once",async t=>{
  const f=await harness(t),invoice=await f.issue();f.processor.cancelUnpaidChog(invoice.id);
  f.deposit(invoice);f.delivery();await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"delivered");
  const sent=f.broadcasts.length;
  assert.throws(()=>f.processor.cancelUnpaidChog(invoice.id),/cannot be cancelled/);
  await f.advance();assert.equal(f.broadcasts.length,sent);
});

test("cancellation cannot race an in-flight deposit observation",async t=>{
  const f=await harness(t),invoice=await f.issue(),original=f.source.getContractEvents;
  let release,entered;const watching=new Promise(ok=>{entered=ok;});
  f.source.getContractEvents=async input=>{entered();await new Promise(ok=>{release=ok;});return original(input);};
  f.deposit(invoice);const tick=f.processor.tick();await watching;
  try{assert.throws(()=>f.processor.cancelUnpaidChog(invoice.id),/observation is in progress/);}
  finally{f.source.getContractEvents=original;release();await tick;}
  assert.notEqual(f.processor.get(invoice.id).state,"expired");
});

test("accepted transaction + transport timeout + restart does not double send",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);f.timeout();
  await f.advance(1);assert.equal(f.broadcasts.length,7,"the original receipt resolves an ambiguous broadcast in the same tick");
  await f.restart();await f.advance();assert.equal(f.broadcasts.length,7);
  assert.equal(new Set(f.broadcasts.map(x=>x.hash)).size,7);
});

test("partial or excessive CHOG never triggers automatic spending",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice,totalUnits-1n);await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"manual-review");assert.equal(f.broadcasts.length,0);
});

test("wrong Ethereum recipient never produces donation success",async t=>{
  const f=await harness(t), invoice=await f.issue();f.deposit(invoice);f.delivery();f.wrongDestination();await f.advance(10);
  assert.equal(f.processor.get(invoice.id).state,"bridging");assert.equal(f.processor.get(invoice.id).destinationHash,null);
});

test("RPC chain change immediately disables new invoices",async t=>{
  const f=await harness(t);await f.issue();f.wrongChain();await assert.rejects(f.processor.tick());
  assert.equal(f.processor.publicStatus().paymentsEnabled,false);
  await assert.rejects(f.processor.issue({mode:"chog",amount:"300",initiativeId:"burundi"}));
});

test("source confirmations reuse the current receipt and diagnostics contain no invoice identifiers",async t=>{
  const f=await harness(t),invoice=await f.issue();f.deposit(invoice);await f.advance();
  assert.equal(f.processor.get(invoice.id).state,"bridging");
  // Seven source transactions: one missing read before each submission and one
  // included read afterwards, plus the original donor proof. No duplicate read
  // is needed inside the canonical/finalized validation of each source receipt.
  assert.equal(f.receiptReads,15);
  const snapshot=f.processor.diagnostics();assert.equal(snapshot["source-preflight"].count,7);
  assert.equal(snapshot["source-confirmation"].count,7);
  assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(`${invoice.id}|${invoice.depositAddress}|${donor}|raw|xpub`,"i"));
  assert.equal(f.processor.publicStatus().diagnostics,undefined);
});

test("source orchestration uses the exact simulated native gas limit without reducing contract safety margins",async t=>{
  const f=await harness(t),invoice=await f.issue();
  f.source.estimateGas=async args=>args.data==="0x"?21_000n:100_000n;
  f.deposit(invoice);await f.advance();
  assert.equal(f.broadcasts.length,7);assert.equal(f.broadcasts[0].tx.gasLimit,21_000n);
  for(const {tx} of f.broadcasts.slice(1))assert.equal(tx.gasLimit,125_000n);
  assert.equal(f.processor.get(invoice.id).state,"bridging");
});

test("a persisted pool contribution must finalize before the charity bridge proceeds",async t=>{
  const f=await harness(t),invoice=await f.issue();f.deposit(invoice);
  const broadcast=f.source.sendRawTransaction;
  f.source.sendRawTransaction=async args=>{const hash=await broadcast(args);if(f.broadcasts.length===5)f.holdSource();return hash;};
  await f.advance(1);
  assert.equal(f.broadcasts.length,5); // Gas, approval, sale, swap, contribution.
  assert.equal(f.processor.get(invoice.id).poolContributionState,"pending","signed bytes alone are not a collected contribution");
  await f.advance(1);
  assert.equal(f.processor.get(invoice.id).state,"processing");assert.equal(f.broadcasts.length,5);
  f.finalizeSource();await f.advance(3);
  assert.equal(f.broadcasts.length,7);assert.equal(f.processor.get(invoice.id).state,"bridging");
  assert.equal(f.processor.get(invoice.id).poolContributionState,"collected");
  assert.equal(f.processor.diagnostics()["source-confirmation"].failed,2);
});

test("a reverted pool contribution never authorizes a bridge or a replacement contribution",async t=>{
  const f=await harness(t),invoice=await f.issue();f.deposit(invoice);
  const original=f.source.getTransactionReceipt;
  f.source.getTransactionReceipt=async args=>({...await original(args),...(f.broadcasts.length>=5&&args.hash===f.broadcasts[4].hash?{status:"reverted"}:{})});
  await f.advance(2);assert.equal(f.processor.get(invoice.id).state,"manual-review");
  assert.equal(f.broadcasts.length,5);await f.restart();await f.advance();assert.equal(f.broadcasts.length,5);
});

test("concurrent invoice cap and donation bounds are enforced before exposing addresses",async t=>{
  const f=await harness(t);await f.processor.tick();
  for(const amount of ["299","1000001","1000000.000000000000000001","NaN","1e24"])await assert.rejects(f.processor.issue({mode:"chog",amount,initiativeId:"burundi"}));
  const results=await Promise.allSettled(Array.from({length:8},()=>f.processor.issue({mode:"chog",amount:"300",initiativeId:"burundi"})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,3);
});

for(const initiativeId of ["burundi","school-supplies","solar-foundation","vida-verde","animal-ethics"])test(`live HTTP ${initiativeId} binds the issued address and exposes no signing material`,async t=>{
  const chain=initiativeId==="animal-ethics"?SOLANA_CHAIN_ID:10;
  const f=await harness(t,chain,false,initiativeId,10);await f.processor.tick();
  const store=openInvoiceStore(":memory:"),service=createPaymentService(store,"http://127.0.0.1:4173",true,f.processor);
  service.listen(0,"127.0.0.1");await once(service,"listening");
  t.after(async()=>{await new Promise(r=>service.close(r));store.close();});
  const base=`http://127.0.0.1:${service.address().port}`;
  const configResponse=await fetch(`${base}/api/payments/config`),cookie=configResponse.headers.get("set-cookie").split(";")[0];
  const config=await configResponse.json();assert.equal(config.paymentsEnabled,true);
  const response=await fetch(`${base}/api/payments/invoices`,{method:"POST",headers:{Origin:"http://127.0.0.1:4173","Content-Type":"application/json",Cookie:cookie,"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({mode:"chog",amount:"300",holderAddress:"",initiativeId})});
  assert.equal(response.status,201);const invoice=validatePayableInvoice(await response.json());
  const read=await(await fetch(`${base}/api/payments/invoices/${invoice.id}`)).json();assert.deepEqual(read,invoice);
  assert.ok(!/privateKey|xpub|raw|orderSignature|encryptedKeystore/.test(JSON.stringify(read)));
  assert.equal(f.broadcasts.length,0);
  for(const changed of [
    {paymentUri:"ethereum:"+donor},{depositAddress:donor},{amount:"301"},{state:"delivered",destinationHash:h(1234)},{minUsdc:"0"},
    {donationAmount:"301"},{poolContributionAmount:"29"},{poolContributionState:null},{contributionPercent:7},
  ])assert.throws(()=>validatePayableInvoice({...invoice,...changed}));
});
