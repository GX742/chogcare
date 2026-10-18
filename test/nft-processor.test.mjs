import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDNodeWallet, Transaction, Interface } from "ethers";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { DatabaseSync } from "node:sqlite";
import { createNftProcessor } from "../server/nft-processor.mjs";
import { createPoolLedger } from "../server/pool-ledger.mjs";
import { NFT_POOL_FUNDER, NFT_POOL_FUNDERS } from "../server/nft-pool-config.mjs";
import { verifyApprovedNftFunding } from "../server/nft-pool-funding.mjs";
import { DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { GIVETH_PROJECT_RECIPIENT, ETHEREUM_USDC } from "../src/route.ts";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { validateNftInvoice } from "../src/nft-invoice.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { NFT_REPEAT_HOLDER } from "../server/nft-repeat-policy.mjs";

const h=n=>`0x${BigInt(n).toString(16).padStart(64,"0")}`;
const holder="0x1111111111111111111111111111111111111111";
const other="0x2222222222222222222222222222222222222222";
const usdc=deliveryNetwork(10).usdc;
const iface=new Interface(["function transfer(address,uint256) returns(bool)"]);
function transfer(token,from,to,value,txHash,number) {
  return {address:token,transactionHash:txHash,blockNumber:number,blockHash:h(number),logIndex:0,removed:false,
    topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from,to}}),data:encodeAbiParameters([{type:"uint256"}],[value])};
}
function financialSnapshot(filename) {
  const db=new DatabaseSync(filename,{readOnly:true});
  try {
    return Object.fromEntries(["custody_branch","deposit_addresses","nft_invoices","nft_pool_meta","pool_funding","pool_reservations","pool_payout_days","nft_proofs","pool_outbox"].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally {db.close();}
}
async function fixture(t, { checkpoint = () => {}, holderAddress = holder, initialTick = true } = {}) {
  const holder=holderAddress;
  const dir=mkdtempSync(join(tmpdir(),"chogcare-nft-test-")),filename=join(dir,"processor.sqlite");
  const root=HDNodeWallet.createRandom("",DEPOSIT_BASE_PATH),xpub=root.neuter().extendedKey;
  const vault={version:1,basePath:DEPOSIT_BASE_PATH,xpub,keyId:createHash("sha256").update(xpub).digest("hex")};
  let clock=Date.parse("2026-10-08T12:00:00Z"),sourceTip=100n,destTip=100n,gas=10n**16n,tokenBalance=0n,owner=holder;
  let fundingToken=usdc,fundingFrom=NFT_POOL_FUNDER,nonce=0,timeout=false,accepted=false,fee=10000n;
  const deposits=[],broadcasts=[],receipts=new Map();let worker;
  const source={getChainId:async()=>143,
    getBlock:async({blockTag,blockNumber})=>blockTag?{number:sourceTip,timestamp:BigInt(Math.floor(clock/1000))}:{number:blockNumber,hash:h(blockNumber),timestamp:BigInt(Math.floor(clock/1000)),transactions:deposits.filter(d=>d.blockNumber===blockNumber)},
    getBalance:async({address})=>deposits.filter(d=>d.to===address).reduce((a,d)=>a+d.value,0n),
    readContract:async()=>owner,
    getTransaction:async({hash})=>deposits.find(d=>d.hash===hash),
    getTransactionReceipt:async({hash})=>{const tx=deposits.find(d=>d.hash===hash);return {status:"success",transactionHash:hash,blockNumber:tx.blockNumber,blockHash:tx.blockHash,from:tx.from,to:tx.to};},
  };
  const fundingReceipt=()=>({status:"success",transactionHash:h(900),blockNumber:101n,blockHash:h(101),logs:[transfer(fundingToken,fundingFrom,worker.treasuryAddress,10000000n,h(900),101n)]});
  const destination={getChainId:async()=>10,
    getBlock:async({blockTag,blockNumber})=>({number:blockTag?destTip:blockNumber,hash:h(blockTag?destTip:blockNumber),timestamp:BigInt(Math.floor(clock/1000))}),
    getContractEvents:async({fromBlock,toBlock})=>fromBlock<=101n&&toBlock>=101n?[fundingReceipt().logs[0]]:[],
    getBalance:async()=>gas,readContract:async()=>tokenBalance,
    getTransactionCount:async()=>nonce,estimateGas:async()=>60000n,getGasPrice:async()=>1000000n,
    getTransactionReceipt:async({hash})=>{if(hash===h(900))return fundingReceipt();if(receipts.has(hash))return receipts.get(hash);const e=new Error("not found");e.name="TransactionReceiptNotFoundError";throw e;},
    sendRawTransaction:async({serializedTransaction})=>{const tx=Transaction.from(serializedTransaction);broadcasts.push(serializedTransaction);accepted=true;if(timeout)throw new Error("timeout after accept");return tx.hash;},
  };
  const settings={filename,vault,root,checkpoint},deps={source,destination,now:()=>clock,feeEstimate:async()=>fee};
  worker=createNftProcessor(settings,deps);
  t.after(async()=>{await worker.close();rmSync(dir,{recursive:true,force:true});});
  if(initialTick)await worker.tick();
  return {get worker(){return worker;},filename,broadcasts,deposits,source,destination,
    input:(tokenId="1")=>({mode:"nft",amount:"1",holderAddress:holder,tokenId,initiativeId:"burundi"}),
    async fund(){destTip=110n;tokenBalance=10000000n;await worker.tick();},
    corruptFunding(token,from=NFT_POOL_FUNDER){fundingToken=token;fundingFrom=from;},
    setOwner(value){owner=value;},setGas(value){gas=value;},setFee(value){fee=value;},setTimeout(value){timeout=value;},
    async advance(ms){clock+=ms;await worker.tick();},
    elapse(ms){clock+=ms;},
    deposit(x,changes={}){sourceTip+=1n;const tx={hash:h(1000+deposits.length),blockNumber:sourceTip,blockHash:h(sourceTip),from:x.holderAddress,to:x.depositAddress,value:10n**18n,input:"0x",...changes};deposits.push(tx);return tx.hash;},
    async settle(finalized=false,token=usdc){assert.ok(accepted);const tx=Transaction.from(broadcasts.at(-1));const [recipient,units]=iface.decodeFunctionData("transfer",tx.data);const b=destTip+1n;receipts.set(tx.hash,{status:"success",transactionHash:tx.hash,blockNumber:b,blockHash:h(b),logs:[transfer(token,tx.from,recipient,units,tx.hash,b)]});nonce=tx.nonce+1;tokenBalance-=units;if(finalized)destTip=b;await worker.tick();return tx;},
    async finalize(){destTip+=100n;await worker.tick();},
    async restart(){await worker.close();worker=createNftProcessor(settings,deps);await worker.tick();},
  };
}

test("NFT funding/network recovery preserves the reservation without restart or another transfer",async t=>{
  const f=await fixture(t);await f.fund();
  const invoice=await f.worker.issue(f.input()),getBlock=f.destination.getBlock;
  assert.equal(f.worker.publicStatus().nftReadiness,"ready");
  f.destination.getBlock=async()=>{throw new Error("temporary network outage");};
  await assert.rejects(f.worker.tick());
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,false);
  assert.equal(f.worker.publicStatus().nftReadiness,"network-unavailable");
  // A balance heartbeat cannot bypass the failed funding verification.
  await f.worker.refreshReadiness();
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,false);
  f.destination.getBlock=getBlock;
  await f.worker.tick();
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,true);
  assert.equal(f.worker.publicStatus().nftReadiness,"ready");
  assert.equal(f.worker.get(invoice.id).depositAddress,invoice.depositAddress);
  assert.equal(f.worker.get(invoice.id).subsidyUsdc,invoice.subsidyUsdc);
  assert.equal(f.worker.publicStatus().availableClaims,2);
  assert.equal(f.broadcasts.length,0);
});

test("NFT funding catches up in durable provider-sized pages across an outage and restart",async t=>{
  const f=await fixture(t);await f.fund();
  const invoice=await f.worker.issue(f.input()),getBlock=f.destination.getBlock,getReceipt=f.destination.getTransactionReceipt;
  const pages=[];let unavailable=false;
  const funding=transfer(usdc,NFT_POOL_FUNDER,f.worker.treasuryAddress,2_000_000n,h(901),200n);
  f.destination.getBlock=async args=>args.blockTag?{number:10_000n,hash:h(10_000),timestamp:1n}:getBlock(args);
  f.destination.getTransactionReceipt=async args=>args.hash===h(901)?{status:"success",transactionHash:h(901),blockNumber:200n,blockHash:h(200),logs:[funding]}:getReceipt(args);
  f.destination.getContractEvents=async args=>{
    assert.ok(args.toBlock-args.fromBlock<50n,"one tick must fit one free-provider page");
    pages.push([args.fromBlock,args.toBlock]);
    if(unavailable)throw new Error("temporary historical RPC outage");
    return args.fromBlock<=200n&&args.toBlock>=200n?[funding]:[];
  };
  const state=()=>{const db=new DatabaseSync(f.filename,{readOnly:true});try{return {
    cursor:db.prepare("SELECT funding_cursor FROM nft_pool_meta").get().funding_cursor,
    credits:db.prepare("SELECT COUNT(*) AS n FROM pool_funding").get().n,
  };}finally{db.close();}};
  await f.worker.tick();assert.deepEqual(state(),{cursor:"160",credits:1});
  unavailable=true;await assert.rejects(f.worker.tick());
  assert.deepEqual(state(),{cursor:"160",credits:1});
  await f.worker.refreshReadiness();assert.equal(f.worker.publicStatus().poolHealthy,false);
  unavailable=false;await f.worker.tick();
  assert.deepEqual(state(),{cursor:"210",credits:2});
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,true);
  assert.equal(f.worker.get(invoice.id).depositAddress,invoice.depositAddress);
  await f.restart();assert.deepEqual(state(),{cursor:"260",credits:2});
  assert.deepEqual(pages,[[111n,160n],[161n,210n],[161n,210n],[211n,260n]]);
  assert.equal(f.broadcasts.length,0);
});

test("an invalid funding receipt cannot advance the NFT scan cursor or enable checkout",async t=>{
  const f=await fixture(t);
  const db=new DatabaseSync(f.filename,{readOnly:true});
  try{
    f.corruptFunding(ETHEREUM_USDC);
    await assert.rejects(f.fund());
    assert.equal(db.prepare("SELECT funding_cursor FROM nft_pool_meta").get().funding_cursor,"100");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_funding").get().n,0);
    assert.equal(f.worker.publicStatus().poolHealthy,false);
    f.corruptFunding(usdc);await f.worker.tick();
    assert.equal(db.prepare("SELECT funding_cursor FROM nft_pool_meta").get().funding_cursor,"110");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_funding").get().n,1);
  }finally{db.close();}
  assert.equal(f.broadcasts.length,0);
});

for(const initiativeId of ["school-supplies","solar-foundation","vida-verde"])test(`NFT ${initiativeId}: exact recipient, restart, finality and no duplicate payout`,async t=>{
  const f=await fixture(t);await f.fund();
  const invoice=await f.worker.issue({...f.input(),initiativeId});
  assert.equal(validateNftInvoice(invoice).recipient,chogBeneficiary(initiativeId,10));
  assert.throws(()=>validateNftInvoice({...invoice,recipient:GIVETH_PROJECT_RECIPIENT}));
  assert.throws(()=>validateNftInvoice({...invoice,destinationChainId:1}));
  await f.restart();assert.equal(f.worker.get(invoice.id).initiativeId,initiativeId);
  f.deposit(invoice);await f.worker.tick();
  const tx=await f.settle(false);assert.equal(iface.decodeFunctionData("transfer",tx.data)[0].toLowerCase(),invoice.recipient.toLowerCase());
  assert.equal(f.worker.get(invoice.id).state,"confirming");
  await f.restart();await f.finalize();
  assert.equal(f.worker.get(invoice.id).state,"delivered");
  assert.equal(f.broadcasts.length,1);assert.equal(f.worker.publicStatus().availableClaims,2);
});

test("authorized holder repeats the same NFT three times with unique proofs and payouts across restart, then the global pool cap blocks a fourth",async t=>{
  const f=await fixture(t,{holderAddress:NFT_REPEAT_HOLDER});await f.fund();
  const invoices=[],proofHashes=[];
  for(let index=0;index<3;index++){
    const invoice=await f.worker.issue(f.input("1638"));invoices.push(invoice);
    proofHashes.push(f.deposit(invoice));await f.worker.tick();await f.settle(true);
    assert.equal(f.worker.get(invoice.id).state,"delivered");
    assert.equal(f.worker.publicStatus().availableClaims,2-index);
    await f.restart();assert.equal(f.broadcasts.length,index+1);
    if(index===0){
      f.setOwner(other);
      await assert.rejects(f.worker.issue({...f.input("1638"),holderAddress:other}),error=>error.code==="NFT_DAILY_LIMIT");
      await assert.rejects(f.worker.issue({...f.input("0001638"),holderAddress:other}),error=>error.code==="NFT_DAILY_LIMIT");
      f.setOwner(NFT_REPEAT_HOLDER);
    }
  }
  assert.equal(new Set(invoices.map(invoice=>invoice.id)).size,3);
  assert.equal(new Set(invoices.map(invoice=>invoice.depositAddress)).size,3);
  assert.equal(new Set(proofHashes).size,3);assert.equal(new Set(f.broadcasts).size,3);
  const db=new DatabaseSync(f.filename,{readOnly:true});try{
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nft_proofs").get().n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_reservations WHERE state='paid'").get().n,3);
    const scopes=db.prepare("SELECT invoice_id,claim_scope FROM pool_reservations").all();
    for(const row of scopes)assert.equal(row.claim_scope,`repeat:${row.invoice_id}`);
  }finally{db.close();}
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"3.00");
  await assert.rejects(f.worker.issue(f.input("1638")),/not ready/);
  await assert.rejects(f.worker.issue(f.input("1639")),/not ready/);
  await f.restart();assert.equal(f.broadcasts.length,3);
  await f.advance(86400000);
  const tomorrow=await f.worker.issue(f.input("1638"));
  assert.equal(tomorrow.subsidyUsdc,"1.00");
});

test("repeat permission cannot open concurrent invoices for the same wallet or an active NFT",async t=>{
  const f=await fixture(t,{holderAddress:NFT_REPEAT_HOLDER});await f.fund();
  const attempts=await Promise.allSettled([f.worker.issue(f.input("1638")),f.worker.issue(f.input("1639"))]);
  assert.equal(attempts.filter(result=>result.status==="fulfilled").length,1);
  const invoice=attempts.find(result=>result.status==="fulfilled").value;
  await assert.rejects(f.worker.issue(f.input("1638")),/already active/);
  await assert.rejects(f.worker.issue(f.input("1639")),/already active/);
  f.setOwner(other);
  await assert.rejects(f.worker.issue({...f.input("1638"),holderAddress:other}),/already active/);
  await f.restart();assert.equal(f.worker.get(invoice.id).state,"awaiting-payment");
  await assert.rejects(f.worker.issue(f.input("1638")),/already active/);
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");assert.equal(f.broadcasts.length,0);
});

test("authorized holder auto-discovers the already-used owned NFT without a client token ID",async t=>{
  const f=await fixture(t,{holderAddress:NFT_REPEAT_HOLDER});await f.fund();
  const first=await f.worker.issue(f.input("1638"));f.deposit(first);await f.worker.tick();await f.settle(true);await f.restart();
  const read=f.source.readContract;
  f.source.readContract=async args=>args.functionName==="tokensOfOwner"?[1638n]:read(args);
  const input=f.input();delete input.tokenId;
  const second=await f.worker.issue(input);assert.equal(second.tokenId,"1638");
  assert.notEqual(second.id,first.id);assert.notEqual(second.depositAddress,first.depositAddress);
  f.deposit(second);await f.worker.tick();await f.settle(true);await f.restart();
  assert.equal(f.worker.get(second.id).state,"delivered");assert.equal(f.broadcasts.length,2);
});

test("authorized holder can request a fresh invoice after two unpaid expiries while old addresses remain inactive",async t=>{
  const f=await fixture(t,{holderAddress:NFT_REPEAT_HOLDER});await f.fund();const expired=[];
  for(let index=0;index<2;index++){
    const invoice=await f.worker.issue(f.input("1638"));expired.push(invoice);
    await f.advance(361000);assert.equal(f.worker.get(invoice.id).state,"expired");
  }
  await f.restart();const fresh=await f.worker.issue(f.input("1638"));
  assert.equal(f.worker.get(fresh.id).state,"awaiting-payment");
  assert.equal(new Set([...expired,fresh].map(invoice=>invoice.depositAddress)).size,3);
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");assert.equal(f.broadcasts.length,0);
});

test("smart-wallet deposits are discovered after a legacy cursor skipped them; double payment produces one grant",async t=>{
  const f=await fixture(t);await f.fund();
  const invoice=await f.worker.issue(f.input());
  const first=f.deposit(invoice,{from:other,to:holder,value:0n,input:"0x1234"});
  f.deposit(invoice,{from:other,to:holder,value:0n,input:"0x1234"});
  f.source.getBalance=async({blockNumber})=>blockNumber<=100n?0n:2n*10n**18n;
  const trace=()=>({type:"CALL",from:other,to:holder,value:"0x0",input:"0x1234",calls:[{type:"CALL",from:holder,to:invoice.depositAddress,value:"0xde0b6b3a7640000",input:"0x"}]});
  f.source.request=async({method,params})=>method==="debug_traceTransaction"?trace():f.deposits.filter(tx=>tx.blockNumber===BigInt(params[0])).map(tx=>({txHash:tx.hash,result:trace()}));
  const db=new DatabaseSync(f.filename);
  const x=JSON.parse(db.prepare("SELECT document FROM nft_invoices WHERE id=?").get(invoice.id).document);
  x.cursor="102";db.prepare("UPDATE nft_invoices SET document=? WHERE id=?").run(JSON.stringify(x),invoice.id);db.close();
  await f.worker.tick();
  assert.equal(f.worker.get(invoice.id).depositHash,first);
  assert.equal(f.worker.get(invoice.id).state,"paying");
  assert.equal(f.broadcasts.length,1);
  await f.settle(true);
  assert.equal(f.worker.get(invoice.id).state,"delivered");
  assert.equal(f.worker.publicStatus().availableClaims,2);
});

test("NFT discovery selects owned token without client token ID and keeps owner verification",async t=>{
  const f=await fixture(t);await f.fund();
  const read=f.source.readContract;
  f.source.readContract=async args=>args.functionName==="tokensOfOwner"?[1638n]:read(args);
  const input=f.input();delete input.tokenId;
  const id="a".repeat(64);
  assert.equal(f.worker.canRetryUnissuedNft(id),true);
  const invoice=await f.worker.issue(input,id);
  assert.equal(invoice.tokenId,"1638");assert.equal(invoice.id,id);
  assert.equal(f.worker.canRetryUnissuedNft(id),false);
  assert.equal(f.broadcasts.length,0);
});

test("NFT discovery rejects no holdings without allocating an address",async t=>{
  const f=await fixture(t);await f.fund();
  f.source.readContract=async()=>[];
  const input=f.input();delete input.tokenId;
  const id="b".repeat(64);
  await assert.rejects(f.worker.issue(input,id),{code:"NFT_NOT_OWNED"});
  assert.equal(f.worker.canRetryUnissuedNft(id),true);
  assert.equal(f.worker.publicStatus().availableClaims,3);
});

test("NFT preflight verifies current eligibility without allocating or writing financial state",async t=>{
  const f=await fixture(t);await f.fund();
  const before=financialSnapshot(f.filename),input=f.input(),read=f.source.readContract;
  for(let index=0;index<3;index++)assert.equal(await f.worker.preflight(input),undefined);
  f.source.readContract=async args=>args.functionName==="tokensOfOwner"?[1n]:read(args);
  const automatic={...input};delete automatic.tokenId;
  assert.equal(await f.worker.preflight(automatic),undefined);
  assert.equal(automatic.tokenId,undefined,"read-only lookup must not mutate the caller's request");
  assert.deepEqual(financialSnapshot(f.filename),before);
  assert.equal(f.worker.publicStatus().availableClaims,3);
  assert.equal(f.broadcasts.length,0);
  f.setOwner(other);
  await assert.rejects(f.worker.preflight(input),{code:"NFT_NOT_OWNED"});
  assert.deepEqual(financialSnapshot(f.filename),before);
});

test("successful NFT preflight is never cached authorization for a later issuance",async t=>{
  const f=await fixture(t);await f.fund();
  const input=f.input(),before=financialSnapshot(f.filename);
  await f.worker.preflight(input);f.setOwner(other);
  await assert.rejects(f.worker.issue(input),{code:"NFT_NOT_OWNED"});
  assert.deepEqual(financialSnapshot(f.filename),before);
  assert.equal(f.broadcasts.length,0);
  f.setOwner(holder);
  const first=await f.worker.issue(input);f.deposit(first);await f.worker.tick();await f.settle(true);await f.restart();
  const paid=financialSnapshot(f.filename);
  await assert.rejects(f.worker.preflight(f.input("2")),{code:"NFT_DAILY_LIMIT"});
  assert.deepEqual(financialSnapshot(f.filename),paid);
  assert.equal(f.broadcasts.length,1);
});

test("NFT checkout stays closed until verified Optimism funding AND gas; wrong token/sender cannot fund",async t=>{
  const f=await fixture(t);await assert.rejects(f.worker.issue(f.input()));
  f.corruptFunding(ETHEREUM_USDC);await assert.rejects(f.fund());assert.equal(f.worker.publicStatus().poolFunded,false);
  f.corruptFunding(usdc,other);await assert.rejects(f.fund());assert.equal(f.worker.publicStatus().poolFunded,false);
  f.corruptFunding(usdc);await f.fund();f.setGas(0n);await f.worker.tick();await assert.rejects(f.worker.issue(f.input()));
  f.setGas(10n**16n);await f.worker.tick();assert.equal(f.worker.publicStatus().nftPaymentsEnabled,true);
});
test("additional approved funder is scanned; reconciliation and restart cannot double credit",async t=>{
  const f=await fixture(t);
  const second=NFT_POOL_FUNDERS[1];
  f.corruptFunding(usdc,second);
  // Receipt exists but is ahead of finalized tip: no early accounting credit.
  await assert.rejects(verifyApprovedNftFunding(f.destination,f.worker.treasuryAddress,second,h(900),0),/finality/);
  await f.fund();
  assert.equal(f.worker.publicStatus().poolFunded,true);
  assert.deepEqual(f.worker.publicStatus().poolFunders,[...NFT_POOL_FUNDERS]);
  await assert.rejects(verifyApprovedNftFunding(f.destination,f.worker.treasuryAddress,other,h(900),0),/not approved/);
  await assert.rejects(verifyApprovedNftFunding(f.destination,f.worker.treasuryAddress,NFT_POOL_FUNDER,h(900),0),/does not match/);
  await assert.rejects(verifyApprovedNftFunding(f.destination,other,second,h(900),0),/does not match/);
  const verified=await verifyApprovedNftFunding(f.destination,f.worker.treasuryAddress,second,h(900),0);
  const db=new DatabaseSync(f.filename);
  try {
    const ledger=createPoolLedger(db,10);
    ledger.creditVerifiedFunding(verified);ledger.creditVerifiedFunding(verified);
    assert.equal(ledger.summary().fundedAvailableUnits,10000000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_funding").get().n,1);
  } finally {db.close();}
  await f.restart();assert.equal(f.worker.publicStatus().availableClaims,3);
});
test("NFT flow: reserve -> exact MON proof -> signed 1.00 Optimism USDC -> receipt -> finalized",async t=>{
  const f=await fixture(t);await f.fund();
  const x=await f.worker.issue(f.input());assert.equal(validateNftInvoice(x).state,"awaiting-payment");
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");assert.equal(f.worker.publicStatus().availableClaims,2);
  await assert.rejects(f.worker.issue(f.input()));await assert.rejects(f.worker.issue({...f.input("2"),initiativeId:"gainforest"}));
  f.deposit(x);await f.worker.tick();assert.equal(f.worker.get(x.id).state,"paying");
  const tx=await f.settle(false);assert.equal(tx.chainId,10n);assert.equal(tx.to.toLowerCase(),usdc.toLowerCase());
  assert.equal(tx.data,iface.encodeFunctionData("transfer",[GIVETH_PROJECT_RECIPIENT,1000000n]));
  assert.equal(f.worker.get(x.id).state,"confirming");
  await f.finalize();assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(f.broadcasts.length,1);
  await f.restart();assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(f.broadcasts.length,1);
  await assert.rejects(f.worker.issue(f.input()));
});

test("a legacy $0.50 reservation keeps its exact payout and public invoice through restart",async t=>{
  const f=await fixture(t);await f.fund();const invoice=await f.worker.issue(f.input());
  const db=new DatabaseSync(f.filename);
  const record=JSON.parse(db.prepare("SELECT document FROM nft_invoices WHERE id=?").get(invoice.id).document);
  delete record.subsidyUnits;
  db.prepare("UPDATE pool_reservations SET units=500000 WHERE invoice_id=?").run(invoice.id);
  db.prepare("UPDATE nft_invoices SET document=? WHERE id=?").run(JSON.stringify(record),invoice.id);
  db.close();
  await f.restart();
  assert.equal(validateNftInvoice(f.worker.get(invoice.id)).subsidyUsdc,"0.50");
  f.deposit(invoice);await f.worker.tick();const tx=await f.settle(true);
  assert.equal(iface.decodeFunctionData("transfer",tx.data)[1],500000n);
  assert.equal(f.worker.get(invoice.id).state,"delivered");
  await f.restart();assert.equal(f.broadcasts.length,1);
  assert.equal(f.worker.get(invoice.id).subsidyUsdc,"0.50");
});
test("wrong MON amount or lost NFT ownership never authorizes a payout",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());
  f.deposit(x,{value:9n*10n**17n});await f.worker.tick();assert.equal(f.worker.get(x.id).state,"manual-review");assert.equal(f.broadcasts.length,0);
  await assert.rejects(f.worker.issue(f.input("2")),/already active/);
  f.setOwner(other);const y=await f.worker.issue({...f.input("2"),holderAddress:other});
  f.deposit(y,{from:other});f.setOwner(holder);await f.worker.tick();assert.equal(f.worker.get(y.id).state,"manual-review");assert.equal(f.broadcasts.length,0);
});
test("RPC timeout/restart rebroadcasts exact persisted NFT payout bytes, never another nonce",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);f.setTimeout(true);
  await f.worker.tick();const first=f.broadcasts[0];assert.ok(first);await f.restart();assert.equal(f.broadcasts[1],first);
  f.setTimeout(false);await f.settle(true);assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(new Set(f.broadcasts).size,1);
});
test("unpaid expired reservations release only after finalized source window; bad receipt token cannot mark paid",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());await f.advance(11*60000+1000);
  assert.equal(f.worker.get(x.id).state,"expired");assert.equal(f.worker.publicStatus().availableClaims,3);
  const y=await f.worker.issue(f.input());f.deposit(y);await f.worker.tick();await f.settle(true,ETHEREUM_USDC);
  assert.notEqual(f.worker.get(y.id).state,"delivered");assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");
});
test("parallel issuance is bounded; chain is pinned across restarts; gas spikes pause without payout",async t=>{
  const f=await fixture(t);await f.fund();const results=await Promise.allSettled([f.worker.issue(f.input()),f.worker.issue(f.input("2"))]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const x=results.find(r=>r.status==="fulfilled").value;f.setFee(10n**16n);f.deposit(x);await f.worker.tick();assert.equal(f.broadcasts.length,0);
  const db=new DatabaseSync(f.filename);assert.throws(()=>createPoolLedger(db,1),/network/);db.close();
  f.setFee(10000n);await f.worker.tick();assert.equal(f.broadcasts.length,1);
});
test("NFT invoice validator rejects wrong chain, QR, recipient and changed subsidy",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());
  for(const change of [{chainId:10},{destinationChainId:1},{paymentUri:"ethereum:"+other},{recipient:other},{subsidyUsdc:"0.49"},{state:"delivered"}])assert.throws(()=>validateNftInvoice({...x,...change}));
});
test("three distinct holders receive $1 each; a fourth invoice cannot take MON",async t=>{
  const f=await fixture(t);await f.fund();
  for(let i=1;i<=3;i++){
    const owner=`0x${String(i).repeat(40)}`;f.setOwner(owner);
    const x=await f.worker.issue({...f.input(String(i)),holderAddress:owner});f.deposit(x);await f.worker.tick();await f.settle(true);
    assert.equal(f.worker.get(x.id).state,"delivered");
  }
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"3.00");
  assert.equal(f.worker.publicStatus().availableClaims,0);
  await assert.rejects(f.worker.issue({...f.input("4"),holderAddress:`0x${"4".repeat(40)}`}));
  assert.equal(f.broadcasts.length,3);
});
test("a new owner cannot reuse a token's daily grant; expired old payment cannot satisfy a fresh invoice",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);await f.worker.tick();await f.settle(true);
  f.setOwner(other);await f.restart();
  await assert.rejects(f.worker.issue({...f.input(),holderAddress:other}),error=>error.code==="NFT_DAILY_LIMIT");
  await assert.rejects(f.worker.issue({...f.input("0001"),holderAddress:other}),error=>error.code==="NFT_DAILY_LIMIT");
  const old=await f.worker.issue({...f.input("2"),holderAddress:other});await f.advance(661000);
  const fresh=await f.worker.issue({...f.input("2"),holderAddress:other});assert.notEqual(old.depositAddress,fresh.depositAddress);
  f.deposit(old);await f.worker.tick();assert.equal(f.worker.get(fresh.id).state,"awaiting-payment");assert.equal(f.broadcasts.length,1);
});

test("proof timeout retries the same pinned deposit after backoff and restart, without replacing the grant",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());
  const pinned=f.deposit(x),getTransaction=f.source.getTransaction,reads=[];
  let outage=true;
  f.source.getTransaction=async args=>{
    reads.push(args.hash);
    if(outage)throw Object.assign(new Error("temporary RPC outage"),{name:"TimeoutError"});
    return getTransaction(args);
  };
  await f.worker.tick();assert.equal(f.worker.get(x.id).state,"verifying");
  assert.equal(f.worker.get(x.id).depositHash,pinned);assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");
  // Another transfer must not replace the pinned proof or create another grant.
  f.deposit(x);await f.worker.tick();assert.equal(reads.length,1);
  await f.restart();assert.equal(reads.length,1);
  outage=false;await f.advance(4999);assert.equal(reads.length,1);
  await f.advance(1);assert.equal(f.worker.get(x.id).state,"paying");
  assert.ok(reads.length>1);assert.deepEqual([...new Set(reads)],[pinned]);
  await f.settle(true);await f.restart();assert.equal(f.worker.get(x.id).state,"delivered");
  assert.equal(new Set(f.broadcasts).size,1);
  const db=new DatabaseSync(f.filename);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nft_proofs").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_reservations").get().n,1);
  } finally {db.close();}
});

test("proof retry exhaustion retains the paid reservation even after invoice expiry",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());const pinned=f.deposit(x);let reads=0;
  f.source.getTransaction=async()=>{reads++;throw Object.assign(new Error("network timeout"),{code:"ETIMEDOUT"});};
  await f.worker.tick();
  for (const delay of [5000,10000,20000,40000,80000,160000,300000]) await f.advance(delay);
  assert.equal(reads,8);assert.equal(f.worker.get(x.id).state,"manual-review");
  assert.equal(f.worker.get(x.id).depositHash,pinned);assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");
  await f.advance(600000);await f.restart();assert.equal(reads,8);assert.equal(f.broadcasts.length,0);
  assert.equal(f.worker.get(x.id).state,"manual-review");
  await assert.rejects(f.worker.issue(f.input("2")),/already active/);
});

test("transient pre-sign recheck failure is resumable and does not insert the same proof twice",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);
  const original=f.source.getTransaction;let reads=0;
  f.source.getTransaction=async args=>{
    if(++reads===2)throw Object.assign(new Error("timeout before signing"),{name:"TimeoutError"});
    return original(args);
  };
  await f.worker.tick();assert.equal(f.worker.get(x.id).state,"verifying");assert.equal(f.broadcasts.length,0);
  await f.advance(5000);assert.equal(f.worker.get(x.id).state,"paying");
  await f.settle(true);assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(f.broadcasts.length,1);
});

test("public NFT admission bounds identities and reports a full queue separately from the remaining budget",async t=>{
  const f=await fixture(t);await f.fund();
  const one=await f.worker.issue(f.input("1"));
  assert.equal(one.expiresAt-Date.parse("2026-10-08T12:00:00Z"),300000);
  await assert.rejects(f.worker.issue(f.input("2")),/already active/);
  f.setOwner(other);
  await assert.rejects(f.worker.issue({...f.input("1"),holderAddress:other}),/already active/);
  await f.worker.issue({...f.input("2"),holderAddress:other});
  const third="0x3333333333333333333333333333333333333333";
  f.setOwner(third);await f.worker.issue({...f.input("3"),holderAddress:third});
  const full=f.worker.publicStatus();assert.equal(full.availableClaims,0);assert.equal(full.availableCheckoutSlots,0);
  assert.equal(full.nftQueueFull,true);assert.equal(full.nftPaymentsEnabled,false);
  await assert.rejects(f.worker.issue({...f.input("4"),holderAddress:third}),/not ready/);
  await f.restart();assert.equal(f.worker.publicStatus().nftQueueFull,true);
  await f.advance(361000);assert.equal(f.worker.publicStatus().availableCheckoutSlots,3);
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,true);assert.equal(f.worker.publicStatus().availableClaims,3);
});

test("unverified unpaid expiries cannot ban a holder for the UTC day, including after restart",async t=>{
  const f=await fixture(t);await f.fund();
  const one=await f.worker.issue(f.input());await f.advance(361000);assert.equal(f.worker.get(one.id).state,"expired");
  const two=await f.worker.issue(f.input());await f.advance(361000);assert.equal(f.worker.get(two.id).state,"expired");
  await f.restart();
  const next=await f.worker.issue(f.input());
  assert.equal(next.state,"awaiting-payment");
  assert.equal(new Set([one,two,next].map(invoice=>invoice.depositAddress)).size,3);
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");
  assert.equal(f.worker.publicStatus().availableClaims,2);
  assert.equal(f.broadcasts.length,0,"unpaid attempts must never create a payout");
  await assert.rejects(f.worker.issue(f.input("2")),/already active/);
  f.deposit(next);await f.worker.tick();await f.settle(true);await f.restart();
  assert.equal(f.worker.get(next.id).state,"delivered");
  assert.equal(f.broadcasts.length,1);
  await assert.rejects(f.worker.issue(f.input("2")),{code:"NFT_DAILY_LIMIT"});
  f.setOwner(other);
  await assert.rejects(f.worker.issue({...f.input(),holderAddress:other}),{code:"NFT_DAILY_LIMIT"});
  assert.equal(f.worker.get(one.id).state,"expired");assert.equal(f.worker.get(two.id).state,"expired");
});

test("unpaid expiries for a public NFT cannot ban its new rightful owner",async t=>{
  const f=await fixture(t);await f.fund();const expired=[];
  for(let index=0;index<2;index++){
    const invoice=await f.worker.issue(f.input());expired.push(invoice);
    await f.advance(361000);assert.equal(f.worker.get(invoice.id).state,"expired");
  }
  f.setOwner(other);await f.restart();
  const next=await f.worker.issue({...f.input(),holderAddress:other});
  assert.equal(next.holderAddress,other);assert.equal(next.tokenId,"1");
  assert.equal(new Set([...expired,next].map(invoice=>invoice.depositAddress)).size,3);
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"1.00");
  assert.equal(f.broadcasts.length,0);
  for(const invoice of expired)assert.equal(f.worker.get(invoice.id).state,"expired");
});

test("persisted NFT payout is never broadcast when durability checkpoint fails, including restart",async t=>{
  let checks=0;const f=await fixture(t,{checkpoint:()=>{if(++checks>=2)throw new Error("checkpoint unavailable after persistence");}});
  await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);await f.worker.tick();
  assert.equal(f.broadcasts.length,0);await f.worker.tick();await f.restart();assert.equal(f.broadcasts.length,0);assert.ok(checks>=3);
  const db=new DatabaseSync(f.filename);
  try {assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,1);} finally {db.close();}
});

test("integrity failure before NFT signing creates no signed payout",async t=>{
  const f=await fixture(t,{checkpoint:()=>{throw new Error("checkpoint unavailable before signing");}});
  await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);await f.worker.tick();
  assert.equal(f.broadcasts.length,0);
  const db=new DatabaseSync(f.filename);
  try {assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pool_outbox").get().n,0);} finally {db.close();}
});

test("NFT issuance accepts only a trusted valid internal request ID and never allocates a duplicate",async t=>{
  const f=await fixture(t);await f.fund();
  await assert.rejects(f.worker.issue(f.input(),"invalid"),/request ID/);
  const id="a".repeat(64),x=await f.worker.issue(f.input(),id);assert.equal(x.id,id);
  await assert.rejects(f.worker.issue(f.input("2"),id),/already active/);
  assert.equal(f.worker.get(id).tokenId,"1");
});

test("a slow unpaid NFT discovery does not block another holder's verified payout",async t=>{
  const f=await fixture(t);await f.fund();
  const slow=await f.worker.issue(f.input());
  f.setOwner(other);const ready=await f.worker.issue({...f.input("2"),holderAddress:other});f.deposit(ready);
  const original=f.source.getBalance;let release,entered=false;
  const gate=new Promise(resolve=>{release=resolve;});
  f.source.getBalance=async args=>{
    if(args.address===slow.depositAddress){entered=true;await gate;}
    return original(args);
  };
  const tick=f.worker.tick();
  try{
    for(let i=0;i<50&&!f.broadcasts.length;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(entered,true);assert.equal(f.broadcasts.length,1,"ready payout must progress before slow discovery resolves");
    assert.equal(f.worker.get(ready.id).state,"paying");
    assert.equal(f.worker.get(slow.id).state,"awaiting-payment");
    assert.equal(f.worker.diagnostics()["nft-discovery"].inFlight,1);
  }finally{release();await tick;}
  assert.equal(f.worker.diagnostics()["nft-discovery"].inFlight,0);
  await f.settle(true);assert.equal(f.worker.get(ready.id).state,"delivered");
  await f.restart();assert.equal(f.broadcasts.length,1);
});

test("concurrent NFT proofs keep treasury estimation, nonce allocation and signing serialized",async t=>{
  const f=await fixture(t);await f.fund();
  const first=await f.worker.issue(f.input());f.setOwner(other);
  const second=await f.worker.issue({...f.input("2"),holderAddress:other});
  f.source.readContract=async args=>args.args[0]===1n?holder:other;
  f.deposit(first);f.deposit(second);
  let release,estimates=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.destination.estimateGas=async()=>{estimates++;await gate;return 60_000n;};
  const tick=f.worker.tick();
  try{
    for(let i=0;i<50&&estimates===0;i++)await new Promise(resolve=>setImmediate(resolve));
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(estimates,1,"a second signing path must not enter while the first is preparing");
    await f.worker.tick(); // Reentrant tick must not open a second queue.
    assert.equal(estimates,1);
  }finally{release();await tick;}
  assert.equal(f.broadcasts.length,1);assert.equal(new Set(f.broadcasts).size,1);
  const txOne=await f.settle(true);assert.equal(txOne.nonce,0);assert.equal(f.broadcasts.length,2);
  const txTwo=await f.settle(true);assert.equal(txTwo.nonce,1);
  assert.equal(f.worker.get(first.id).state,"delivered");assert.equal(f.worker.get(second.id).state,"delivered");
  await f.restart();assert.equal(f.broadcasts.length,2);
});

test("performance snapshot is numeric only and never changes public invoice or pool terms",async t=>{
  const f=await fixture(t);await f.fund();const invoice=await f.worker.issue(f.input());
  const before=f.worker.get(invoice.id),status=f.worker.publicStatus();
  const snapshot=f.worker.diagnostics();assert.ok(snapshot["nft-funding"].count>0);
  assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(`${invoice.id}|${invoice.depositAddress}|${holder}|privateKey|raw`,"i"));
  assert.deepEqual(f.worker.get(invoice.id),before);assert.deepEqual(f.worker.publicStatus(),status);
  assert.equal(f.broadcasts.length,0);assert.equal(status.diagnostics,undefined);
});

test("NFT heartbeat refreshes expired health without writing funding, proof or payout state",async t=>{
  const f=await fixture(t);await f.fund();const invoice=await f.worker.issue(f.input());
  const before=f.worker.get(invoice.id);f.elapse(61_000);
  assert.equal(f.worker.publicStatus().poolHealthy,false);
  await f.worker.refreshReadiness();assert.equal(f.worker.publicStatus().poolHealthy,true);
  assert.deepEqual(f.worker.get(invoice.id),before);assert.equal(f.broadcasts.length,0);
  f.setGas(0n);await f.worker.refreshReadiness();assert.equal(f.worker.publicStatus().nftPaymentsEnabled,false);
  f.source.getChainId=async()=>1;await assert.rejects(f.worker.refreshReadiness(),/network/);
  assert.equal(f.worker.publicStatus().poolHealthy,false);
});

test("NFT heartbeat cannot turn an unverified balance into funding or initialized health",async t=>{
  const f=await fixture(t,{initialTick:false});f.destination.readContract=async()=>10000000n;
  await f.worker.refreshReadiness();const status=f.worker.publicStatus();
  assert.equal(status.poolHealthy,false);assert.equal(status.poolFunded,false);assert.equal(status.nftPaymentsEnabled,false);
  assert.equal(f.broadcasts.length,0);
});

test("an escaped storage failure drains other NFT work before releasing the tick lock",async t=>{
  const f=await fixture(t);await f.fund();const broken=await f.worker.issue(f.input());
  f.setOwner(other);const slow=await f.worker.issue({...f.input("2"),holderAddress:other});
  const db=new DatabaseSync(f.filename);
  db.prepare("UPDATE nft_invoices SET document='invalid-json' WHERE id=?").run(broken.id);db.close();
  const original=f.source.getBalance;let release,entered=0,finished=false;
  const gate=new Promise(resolve=>{release=resolve;});
  f.source.getBalance=async args=>{if(args.address===slow.depositAddress){entered++;await gate;}return original(args);};
  // Attach rejection handling immediately; malformed storage is not a network retry.
  const checked=assert.rejects(f.worker.tick(),SyntaxError).then(()=>{finished=true;});
  try{
    for(let i=0;i<10&&!entered;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(entered,1);assert.equal(finished,false);
    await f.worker.tick();assert.equal(entered,1,"a sibling must not outlive the processing lock");
  }finally{release();await checked;}
  assert.equal(f.worker.publicStatus().poolHealthy,false);
  assert.equal(f.worker.diagnostics()["nft-tick"].inFlight,0);assert.equal(f.broadcasts.length,0);
});
