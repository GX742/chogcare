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

const h=n=>`0x${BigInt(n).toString(16).padStart(64,"0")}`;
const holder="0x1111111111111111111111111111111111111111";
const other="0x2222222222222222222222222222222222222222";
const usdc=deliveryNetwork(10).usdc;
const iface=new Interface(["function transfer(address,uint256) returns(bool)"]);
function transfer(token,from,to,value,txHash,number) {
  return {address:token,transactionHash:txHash,blockNumber:number,blockHash:h(number),logIndex:0,removed:false,
    topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from,to}}),data:encodeAbiParameters([{type:"uint256"}],[value])};
}
async function fixture(t, { checkpoint = () => {}, holderAddress = holder } = {}) {
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
  await worker.tick();
  return {get worker(){return worker;},filename,broadcasts,deposits,source,destination,
    input:(tokenId="1")=>({mode:"nft",amount:"1",holderAddress:holder,tokenId,initiativeId:"burundi"}),
    async fund(){destTip=110n;tokenBalance=10000000n;await worker.tick();},
    corruptFunding(token,from=NFT_POOL_FUNDER){fundingToken=token;fundingFrom=from;},
    setOwner(value){owner=value;},setGas(value){gas=value;},setFee(value){fee=value;},setTimeout(value){timeout=value;},
    async advance(ms){clock+=ms;await worker.tick();},
    deposit(x,changes={}){sourceTip+=1n;const tx={hash:h(1000+deposits.length),blockNumber:sourceTip,blockHash:h(sourceTip),from:holder,to:x.depositAddress,value:10n**18n,input:"0x",...changes};deposits.push(tx);return tx.hash;},
    async settle(finalized=false,token=usdc){assert.ok(accepted);const tx=Transaction.from(broadcasts.at(-1));const recipient=iface.decodeFunctionData("transfer",tx.data)[0];const b=destTip+1n;receipts.set(tx.hash,{status:"success",transactionHash:tx.hash,blockNumber:b,blockHash:h(b),logs:[transfer(token,tx.from,recipient,500000n,tx.hash,b)]});nonce=tx.nonce+1;tokenBalance-=500000n;if(finalized)destTip=b;await worker.tick();return tx;},
    async finalize(){destTip+=100n;await worker.tick();},
    async restart(){await worker.close();worker=createNftProcessor(settings,deps);await worker.tick();},
  };
}

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
  assert.equal(f.broadcasts.length,1);assert.equal(f.worker.publicStatus().availableClaims,19);
});

test("allowlisted holder repeats the same NFT, but still needs new proof and cannot exceed $10",async t=>{
  const f=await fixture(t,{holderAddress:"0x19a863aec37c83c7cb34548c29f1f7e41bcb51ca"});await f.fund();
  for(let i=0;i<20;i++) {
    const invoice=await f.worker.issue(f.input("1638"));
    await assert.rejects(f.worker.issue(f.input("1638")),/active|not ready/);
    assert.equal(f.broadcasts.length,i);
    f.deposit(invoice);await f.worker.tick();await f.settle(true);
    assert.equal(f.worker.get(invoice.id).state,"delivered");
    if(i===0)await f.restart();
  }
  assert.equal(f.worker.publicStatus().availableClaims,0);
  await assert.rejects(f.worker.issue(f.input("1638")));
  assert.equal(f.broadcasts.length,20);
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
  assert.equal(f.worker.publicStatus().availableClaims,19);
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
  assert.equal(f.worker.publicStatus().availableClaims,20);
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
  await f.restart();assert.equal(f.worker.publicStatus().availableClaims,20);
});
test("NFT flow: reserve -> exact MON proof -> signed 0.50 Optimism USDC -> receipt -> finalized",async t=>{
  const f=await fixture(t);await f.fund();
  const x=await f.worker.issue(f.input());assert.equal(validateNftInvoice(x).state,"awaiting-payment");
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"0.50");assert.equal(f.worker.publicStatus().availableClaims,19);
  await assert.rejects(f.worker.issue(f.input()));await assert.rejects(f.worker.issue({...f.input("2"),initiativeId:"gainforest"}));
  f.deposit(x);await f.worker.tick();assert.equal(f.worker.get(x.id).state,"paying");
  const tx=await f.settle(false);assert.equal(tx.chainId,10n);assert.equal(tx.to.toLowerCase(),usdc.toLowerCase());
  assert.equal(tx.data,iface.encodeFunctionData("transfer",[GIVETH_PROJECT_RECIPIENT,500000n]));
  assert.equal(f.worker.get(x.id).state,"confirming");
  await f.finalize();assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(f.broadcasts.length,1);
  await f.restart();assert.equal(f.worker.get(x.id).state,"delivered");assert.equal(f.broadcasts.length,1);
  await assert.rejects(f.worker.issue(f.input()));
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
  assert.equal(f.worker.get(x.id).state,"expired");assert.equal(f.worker.publicStatus().availableClaims,20);
  const y=await f.worker.issue(f.input());f.deposit(y);await f.worker.tick();await f.settle(true,ETHEREUM_USDC);
  assert.notEqual(f.worker.get(y.id).state,"delivered");assert.equal(f.worker.publicStatus().reservedTodayUsdc,"0.50");
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
test("twenty finalized NFT grants exhaust the $10 budget; a 21st invoice cannot take MON",async t=>{
  const f=await fixture(t);await f.fund();
  for(let i=1;i<=20;i++){
    const x=await f.worker.issue(f.input(String(i)));f.deposit(x);await f.worker.tick();await f.settle(true);
    assert.equal(f.worker.get(x.id).state,"delivered");
  }
  assert.equal(f.worker.publicStatus().reservedTodayUsdc,"10.00");
  assert.equal(f.worker.publicStatus().availableClaims,0);
  await assert.rejects(f.worker.issue(f.input("21")));
  assert.equal(f.broadcasts.length,20);
});
test("a new owner cannot reuse a token's daily grant; expired old payment cannot satisfy a fresh invoice",async t=>{
  const f=await fixture(t);await f.fund();const x=await f.worker.issue(f.input());f.deposit(x);await f.worker.tick();await f.settle(true);
  f.setOwner(other);await assert.rejects(f.worker.issue({...f.input(),holderAddress:other}));
  f.setOwner(holder);const old=await f.worker.issue(f.input("2"));await f.advance(661000);
  const fresh=await f.worker.issue(f.input("2"));assert.notEqual(old.depositAddress,fresh.depositAddress);
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
  assert.equal(f.worker.get(x.id).depositHash,pinned);assert.equal(f.worker.publicStatus().reservedTodayUsdc,"0.50");
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
  assert.equal(f.worker.get(x.id).depositHash,pinned);assert.equal(f.worker.publicStatus().reservedTodayUsdc,"0.50");
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
  const full=f.worker.publicStatus();assert.equal(full.availableClaims,17);assert.equal(full.availableCheckoutSlots,0);
  assert.equal(full.nftQueueFull,true);assert.equal(full.nftPaymentsEnabled,false);
  await assert.rejects(f.worker.issue({...f.input("4"),holderAddress:third}),/not ready/);
  await f.restart();assert.equal(f.worker.publicStatus().nftQueueFull,true);
  await f.advance(361000);assert.equal(f.worker.publicStatus().availableCheckoutSlots,3);
  assert.equal(f.worker.publicStatus().nftPaymentsEnabled,true);assert.equal(f.worker.publicStatus().availableClaims,20);
});

test("expired unpaid identity attempts are bounded per UTC day and across owner changes",async t=>{
  const f=await fixture(t);await f.fund();
  const one=await f.worker.issue(f.input());await f.advance(361000);assert.equal(f.worker.get(one.id).state,"expired");
  const two=await f.worker.issue(f.input());await f.advance(361000);assert.equal(f.worker.get(two.id).state,"expired");
  await assert.rejects(f.worker.issue(f.input("2")),/Too many unpaid/);
  f.setOwner(other);await assert.rejects(f.worker.issue({...f.input(),holderAddress:other}),/Too many unpaid/);
  await f.restart();await assert.rejects(f.worker.issue({...f.input(),holderAddress:other}),/Too many unpaid/);
  await f.advance(86400000);const next=await f.worker.issue({...f.input(),holderAddress:other});
  assert.notEqual(next.depositAddress,one.depositAddress);assert.notEqual(next.depositAddress,two.depositAddress);
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
