import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HDNodeWallet, Transaction, Wallet } from "ethers";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, decodeFunctionData, erc20Abi, formatUnits, keccak256 } from "viem";
import { createChogRefunds } from "../server/chog-refunds.mjs";
import { createAddressAllocator } from "../server/address-allocator.mjs";
import { sourceJournal } from "../server/source-journal.mjs";
import { DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { CHOG } from "../src/route.ts";

const h = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const id = "a".repeat(64), quoted = 330n * 10n ** 18n, MON = 10n ** 18n;
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
function fixture(t, { amount = MON, native = 0n } = {}) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const key = HDNodeWallet.createRandom("", DEPOSIT_BASE_PATH), child = key.deriveChild(0), donor = Wallet.createRandom();
  const xpub = key.neuter().extendedKey, vault = { version: 1, basePath: DEPOSIT_BASE_PATH, xpub, keyId: createHash("sha256").update(xpub).digest("hex") };
  db.exec("CREATE TABLE chog_invoices(id TEXT PRIMARY KEY,state TEXT,document TEXT); CREATE TABLE delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT UNIQUE); CREATE TABLE pool_contributions(invoice_id TEXT PRIMARY KEY,units TEXT,source_hash TEXT);");
  const allocation = createAddressAllocator(db, vault).allocate(id), journal = sourceJournal(db);
  const timestamp = Date.now(), invoice = { id, state: "manual-review", index: 0, depositAddress: allocation.address,
    units: String(quoted), amount: "330", donationAmount: "300", poolContributionAmount: "30", contributionPercent: 10,
    initiativeId: "school-supplies", destinationChainId: 10, createdBlock: "100", cursor: "100", expiresAt: timestamp + 1_200_000,
    message: `Received ${formatUnits(amount,18)} CHOG. This invoice requires 330 CHOG. Processing is on hold; do not pay again.` };
  const save = () => db.prepare("INSERT OR REPLACE INTO chog_invoices VALUES(?,?,?)").run(id, invoice.state, JSON.stringify(invoice)); save();
  const original = JSON.stringify(invoice), nonces = new Map(), balances = new Map([[child.address.toLowerCase(),native],[key.address.toLowerCase(),100n*MON]]);
  let tokenBalance = amount, head = 200n, finalized = 200n, autoFinalize = true, queue = false, timeoutAfterSend = false, reverted = false, checkpointFailure = false;
  let checkpointCount = 0, signCount = 0, beforeSign = null, estimateHook = null, lastCheckpoint = "";
  const receipts = new Map(), transactions = new Map(), pending = new Map(), attempts = [], signed = [];
  const makeLog = (from,to,value,hash,number) => ({ address: CHOG, transactionHash: hash, blockHash:h(number), blockNumber:number, logIndex:0, removed:false,
    topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from,to}}), data:encodeAbiParameters([{type:"uint256"}],[value]) });
  const deposit = makeLog(donor.address,child.address,amount,h(7000),101n), events = [deposit];
  receipts.set(h(7000),{status:"success",from:donor.address,to:CHOG,transactionHash:h(7000),blockNumber:101n,blockHash:h(101),logs:[deposit]});
  transactions.set(h(7000),{hash:h(7000),from:donor.address,to:CHOG,input:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[child.address,amount]}),value:0n,chainId:143,type:"eip1559",blockNumber:101n,blockHash:h(101)});
  const checkpointShape = () => JSON.stringify({ jobs: db.prepare("SELECT * FROM chog_refunds").all(), sends: db.prepare("SELECT * FROM source_sends").all() });
  const checkpoint = () => { if(checkpointFailure) { const error=new Error("fixed test failure");error.name="PaymentIntegrityError";throw error; } checkpointCount++;lastCheckpoint=checkpointShape(); };
  const wallet = actual => ({ address:actual.address, async signTransaction(call) { signCount++; if(beforeSign)await beforeSign(actual,call); const raw=await actual.signTransaction(call);signed.push(raw);return raw; } });
  const root = { address:key.address, neuter:()=>key.neuter(), deriveChild:index=>wallet(key.deriveChild(index)), signTransaction:call=>wallet(key).signTransaction(call) };
  const apply = raw => {
    const tx=Transaction.from(raw), hash=keccak256(raw);head++;
    const logs = [];
    if(!reverted) {
      balances.set(tx.from.toLowerCase(),(balances.get(tx.from.toLowerCase())??0n)-tx.value-tx.gasLimit*1_000_000_000n);
      if(tx.data==="0x")balances.set(tx.to.toLowerCase(),(balances.get(tx.to.toLowerCase())??0n)+tx.value);
      else { const decoded=decodeFunctionData({abi:erc20Abi,data:tx.data});tokenBalance-=decoded.args[1];logs.push(makeLog(tx.from,decoded.args[0],decoded.args[1],hash,head));events.push(...logs); }
    }
    nonces.set(tx.from.toLowerCase(),tx.nonce+1);
    receipts.set(hash,{status:reverted?"reverted":"success",from:tx.from,to:tx.to,transactionHash:hash,blockNumber:head,blockHash:h(head),logs});
    transactions.set(hash,{hash,from:tx.from,to:tx.to,input:tx.data,value:tx.value,nonce:tx.nonce,chainId:143,type:"eip1559",gas:tx.gasLimit,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas,accessList:[],blockNumber:head,blockHash:h(head)});
    if(autoFinalize)finalized=head;
  };
  const source = {
    getChainId:async()=>143,
    getBlock:async args=>({number:args.blockNumber??(args.blockTag==="finalized"?finalized:head),hash:h(args.blockNumber??(args.blockTag==="finalized"?finalized:head)),timestamp:BigInt(Math.floor(timestamp/1000))}),
    getCode:async()=>"0x",
    getTransaction:async({hash})=>transactions.get(hash),
    getContractEvents:async args=>events.filter(log=>log.blockNumber>=args.fromBlock&&log.blockNumber<=args.toBlock&&(!args.args.to||log.topics[2].toLowerCase().endsWith(args.args.to.slice(2).toLowerCase()))&&(!args.args.from||log.topics[1].toLowerCase().endsWith(args.args.from.slice(2).toLowerCase()))),
    readContract:async()=>tokenBalance,
    getTransactionCount:async({address,blockTag})=>{
      const base=nonces.get(address.toLowerCase())??0;
      return blockTag==="pending"&&[...pending.values()].some(raw=>same(Transaction.from(raw).from,address))?base+1:base;
    },
    getBalance:async({address})=>balances.get(address.toLowerCase())??0n,
    getGasPrice:async()=>1_000_000_000n,
    estimateGas:async call=>{ if(estimateHook)await estimateHook(call); if(call.data!=="0x"&&(balances.get(call.account.toLowerCase())??0n)===0n)throw Error("simulation requires a funded sender");return call.data==="0x"?21_000n:100_000n; },
    getTransactionReceipt:async({hash})=>{if(receipts.has(hash))return receipts.get(hash);const error=new Error("not found");error.name="TransactionReceiptNotFoundError";throw error;},
    sendRawTransaction:async({serializedTransaction:raw})=>{
      assert.equal(lastCheckpoint,checkpointShape(),"the complete outbox must be checkpointed before each broadcast");
      const hash=keccak256(raw), row=db.prepare("SELECT * FROM source_sends WHERE hash=?").get(hash);
      assert.equal(row?.raw,raw,"no transaction can be broadcast before its immutable raw is persisted");attempts.push(hash);
      if(!receipts.has(hash)&&!pending.has(hash)){if(queue)pending.set(hash,raw);else apply(raw);}
      if(timeoutAfterSend){timeoutAfterSend=false;throw Error("transport failed after inclusion");}return hash;
    },
  };
  let engine=createChogRefunds({db,source,root,vault,journal,checkpoint,now:()=>timestamp});
  return {db,source,invoice,original,root,child,donor,journal,attempts,signed,get engine(){return engine;},get signCount(){return signCount;},get checkpointCount(){return checkpointCount;},
    save,restart(){engine=createChogRefunds({db,source,root,vault,journal,checkpoint,now:()=>timestamp});},
    prefund(value=MON){balances.set(child.address.toLowerCase(),value);},
    holdFinality(){autoFinalize=false;},finalize(){finalized=head;},queue(){queue=true;},mine(){queue=false;for(const [hash,raw]of pending){apply(raw);pending.delete(hash);}},
    timeout(){timeoutAfterSend=true;},revert(){reverted=true;},checkpointFailure(){checkpointFailure=true;},
    beforeSign(hook){beforeSign=hook;},estimateHook(hook){estimateHook=hook;},changeTokenBalance(value){tokenBalance=value;},
    rows(){return db.prepare("SELECT * FROM source_sends ORDER BY rowid").all();},
    addManual(name="manual_chog_refunds_legacy_fixture",byEvent=false){db.exec(`CREATE TABLE ${name}(invoice_id TEXT,deposit_hash TEXT,log_index INTEGER,gas_raw TEXT,gas_hash TEXT,gas_sender TEXT,gas_nonce INTEGER,refund_raw TEXT,refund_hash TEXT,refund_sender TEXT,refund_nonce INTEGER);`);db.prepare(`INSERT INTO ${name}(invoice_id,deposit_hash,log_index,gas_raw) VALUES(?,?,0,'gas-only')`).run(byEvent?"b".repeat(64):id,h(7000));},
  };
}

test("an unfunded child returns the full underpayment with a capped gas top-up and no donation credit",async t=>{
  const f=fixture(t);const result=await f.engine.start(f.invoice);
  assert.equal(result.status,"completed");assert.equal(result.amount,"1");assert.equal(f.rows().length,2);
  const [gas,refund]=f.rows().map(row=>Transaction.from(row.raw));
  assert.equal(gas.value,150_000n*2_000_000_000n);assert.ok(gas.value+gas.gasLimit*gas.maxFeePerGas<=MON/20n);
  assert.equal(refund.value,0n);assert.ok(same(refund.from,f.child.address));assert.ok(same(refund.to,CHOG));
  const decoded=decodeFunctionData({abi:erc20Abi,data:refund.data});assert.ok(same(decoded.args[0],f.donor.address));assert.equal(decoded.args[1],MON);
  assert.equal(f.db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id).document,f.original);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM delivered_events").get().n,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM pool_contributions").get().n,0);
  assert.ok(f.checkpointCount>=5);const before=f.signCount;f.restart();await f.engine.resume(f.invoice);assert.equal(f.signCount,before);
});

test("an overpayment refunds the entire received amount and reuses existing MON without a gas grant",async t=>{
  const amount=333n*MON,f=fixture(t,{amount,native:MON});const result=await f.engine.start(f.invoice);
  assert.equal(result.status,"completed");assert.equal(result.amount,"333");assert.equal(f.rows().length,1);assert.equal(f.rows()[0].phase,"refund-chog");
  assert.equal(decodeFunctionData({abi:erc20Abi,data:Transaction.from(f.rows()[0].raw).data}).args[1],amount);
});

test("a pending raw survives restart and reuses the identical hash without replacing its nonce",async t=>{
  const f=fixture(t,{native:MON});f.queue();assert.equal((await f.engine.start(f.invoice)).status,"processing");
  const hash=f.rows()[0].hash;assert.equal(f.signCount,1);f.restart();await f.engine.resume(f.invoice);
  assert.equal(f.signCount,1);assert.deepEqual(f.attempts,[hash,hash]);f.mine();
  assert.equal((await f.engine.resume(f.invoice)).status,"completed");assert.equal(f.signCount,1);assert.equal(f.rows().length,1);
});

test("receipt inclusion is confirming until canonical finality, then completion persists across restart",async t=>{
  const f=fixture(t,{native:MON});f.holdFinality();const result=await f.engine.start(f.invoice);
  assert.equal(result.status,"confirming");assert.ok(result.txHash);assert.equal(f.db.prepare("SELECT receipt FROM chog_refunds").get().receipt,null);
  f.restart();await f.engine.resume(f.invoice);assert.equal(f.engine.publicStatus(id).status,"confirming");assert.equal(f.signCount,1);
  f.finalize();assert.equal((await f.engine.resume(f.invoice)).status,"completed");assert.ok(f.db.prepare("SELECT receipt FROM chog_refunds").get().receipt);
});

test("an ambiguous transport failure after inclusion never causes another gas funding or refund",async t=>{
  const f=fixture(t);f.timeout();assert.equal((await f.engine.start(f.invoice)).status,"completed");
  const hashes=f.rows().map(row=>row.hash);f.restart();await f.engine.resume(f.invoice);assert.equal(f.signCount,2);assert.deepEqual(f.rows().map(row=>row.hash),hashes);
});

test("canonical finalized reverts block the job and never authorize a replacement",async t=>{
  const f=fixture(t,{native:MON});f.revert();assert.equal((await f.engine.start(f.invoice)).status,"blocked");
  f.restart();await f.engine.resume(f.invoice);assert.equal(f.signCount,1);assert.equal(f.rows().length,1);
});

test("both historical manual journals, including a cancelled gas-only binding or the same event on another invoice, exclude adoption",async t=>{
  for(const name of ["manual_chog_refunds","manual_chog_refunds_legacy_fixture"])for(const byEvent of [false,true]){
    const f=fixture(t);f.addManual(name,byEvent);
    if(!byEvent)assert.equal(f.engine.canStart(f.invoice),false);
    assert.equal(await f.engine.start(f.invoice),null);assert.equal(f.engine.has(id),false);assert.equal(f.signCount,0);assert.equal(f.rows().length,0);
  }
});

test("downstream processing, existing source sends and unknown holds cannot become refund jobs",async t=>{
  for(const patch of [{state:"processing"},{depositProof:{}},{receivedUnits:"1"},{sale:{}},{bridge:{}},{refundProof:{}},{message:"Unknown operator hold"}]){
    const f=fixture(t);Object.assign(f.invoice,patch);f.save();assert.equal(await f.engine.start(f.invoice),null);assert.equal(f.signCount,0);
  }
  for(const table of ["delivered_events","pool_contributions"]){
    const f=fixture(t);if(table==="delivered_events")f.db.prepare("INSERT INTO delivered_events VALUES('event',?)").run(id);else f.db.prepare("INSERT INTO pool_contributions VALUES(?,'1','source')").run(id);
    assert.equal(await f.engine.start(f.invoice),null);assert.equal(f.signCount,0);
  }
  const f=fixture(t);f.db.prepare("INSERT INTO source_sends VALUES(?,'gas','sender',0,'hash','raw','day')").run(id);assert.equal(await f.engine.start(f.invoice),null);assert.equal(f.signCount,0);
});

test("an invoice mutation while preparing a transaction blocks signing and preserves the original job",async t=>{
  const f=fixture(t);f.estimateHook(async()=>{f.invoice.message="Changed operator hold";f.save();});
  assert.equal((await f.engine.start(f.invoice)).status,"blocked");assert.equal(f.signCount,0);assert.equal(f.rows().length,0);
});

test("an additional deposit during signing blocks raw persistence and no transaction is broadcast",async t=>{
  const f=fixture(t,{native:MON});f.beforeSign(async()=>f.changeTokenBalance(2n*MON));
  assert.equal((await f.engine.start(f.invoice)).status,"blocked");assert.equal(f.rows().length,0);assert.equal(f.attempts.length,0);
});

test("integrity failures propagate before signing and every refund case is immutable and undeletable",async t=>{
  const f=fixture(t);f.checkpointFailure();await assert.rejects(f.engine.start(f.invoice),error=>error.name==="PaymentIntegrityError");assert.equal(f.signCount,0);assert.equal(f.engine.has(id),false);
  const g=fixture(t,{native:MON});g.queue();await g.engine.start(g.invoice);
  for(const statement of ["DELETE FROM chog_refunds","UPDATE chog_refunds SET proof='{}'","UPDATE chog_refunds SET operator='changed'","UPDATE chog_refunds SET invoice_snapshot='{}'"]){assert.throws(()=>g.db.exec(statement));}
});

test("temporary RPC failure retains the job for retry without exposing its private error",async t=>{
  const f=fixture(t,{native:MON});const balance=f.source.getBalance;let once=true;
  f.source.getBalance=async args=>{if(once){once=false;throw Error("private RPC detail");}return balance(args);};
  const result=await f.engine.start(f.invoice);assert.equal(result.status,"processing");assert.equal(f.signCount,0);assert.doesNotMatch(JSON.stringify(result),/private|sender|proof|raw|invoice/);
  f.restart();assert.equal((await f.engine.resume(f.invoice)).status,"completed");
});

test("gas funding must be finalized before the child signs or sends a refund",async t=>{
  const f=fixture(t);f.holdFinality();assert.equal((await f.engine.start(f.invoice)).status,"processing");
  assert.equal(f.signCount,1);assert.deepEqual(f.rows().map(row=>row.phase),["refund-gas"]);
  f.restart();await f.engine.resume(f.invoice);assert.equal(f.signCount,1);
  f.finalize();assert.equal((await f.engine.resume(f.invoice)).status,"confirming");assert.equal(f.signCount,2);
  f.finalize();assert.equal((await f.engine.resume(f.invoice)).status,"completed");
});

test("fee ceilings and the shared daily funding limit prevent operator spending before signing",async t=>{
  const expensive=fixture(t);expensive.source.getGasPrice=async()=>251_000_000_000n;
  assert.equal((await expensive.engine.start(expensive.invoice)).status,"processing");assert.equal(expensive.signCount,0);assert.equal(expensive.rows().length,0);
  const capped=fixture(t);const day=new Date().toISOString().slice(0,10);
  for(let n=0;n<20;n++)capped.db.prepare("INSERT INTO source_sends VALUES(?,'pool-gas',?,0,?,'test',?)").run(h(n).slice(2),`sender-${n}`,h(n),day);
  assert.equal((await capped.engine.start(capped.invoice)).status,"processing");assert.equal(capped.signCount,0);assert.equal(capped.rows().length,20);
  const excessive=fixture(t,{native:MON});excessive.source.estimateGas=async()=>150_000n;
  assert.equal((await excessive.engine.start(excessive.invoice)).status,"blocked");assert.equal(excessive.signCount,0);assert.equal(excessive.rows().length,0);
});

test("persisted manual nonce reservations prevent a new signature and a conflicting replay",async t=>{
  const f=fixture(t);f.addManual();f.db.prepare("UPDATE manual_chog_refunds_legacy_fixture SET invoice_id=?,deposit_hash=?,gas_sender=?,gas_nonce=0,gas_hash=?").run("b".repeat(64),h(8000),f.root.address,h(9000));
  await f.engine.start(f.invoice);assert.equal(f.signCount,0);assert.equal(f.attempts.length,0);
  const g=fixture(t,{native:MON});g.queue();await g.engine.start(g.invoice);assert.equal(g.attempts.length,1);
  g.addManual();g.db.prepare("UPDATE manual_chog_refunds_legacy_fixture SET invoice_id=?,deposit_hash=?,gas_sender=?,gas_nonce=0,gas_hash=?").run("b".repeat(64),h(8000),g.child.address,h(9000));
  assert.equal((await g.engine.resume(g.invoice)).status,"blocked");assert.equal(g.attempts.length,1);assert.equal(g.signCount,1);
});

test("a larger fee requirement after the single gas grant never creates another grant or replacement",async t=>{
  const f=fixture(t);let reads=0;f.source.getGasPrice=async()=>++reads===1?1_000_000_000n:2_000_000_000n;
  // Funding's own fee read also consumes one observation; the fixed 150k grant
  // remains too small for the later doubled child refund simulation.
  await f.engine.start(f.invoice);assert.deepEqual(f.rows().map(row=>row.phase),["refund-gas"]);assert.equal(f.signCount,1);
  f.restart();await f.engine.resume(f.invoice);assert.equal(f.signCount,1);assert.equal(f.rows().length,1);
});

test("identifier and maintenance-layout guards reject trailing newlines rather than accepting a regex prefix",async t=>{
  const f=fixture(t);assert.equal(f.engine.has(id+"\n"),false);assert.equal(f.engine.publicStatus(id+"\n"),null);
  assert.equal(await f.engine.start({...f.invoice,id:id+"\n"}),null);assert.equal(f.signCount,0);
  f.db.exec('CREATE TABLE "manual_chog_refunds_legacy_fixture\n"(invoice_id TEXT,deposit_hash TEXT,log_index INTEGER)');
  assert.equal(f.engine.canStart(f.invoice),false);assert.equal(await f.engine.start(f.invoice),null);assert.equal(f.signCount,0);
});
