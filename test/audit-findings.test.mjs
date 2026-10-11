// Regressions for the 2026-10-09 audit mitigations. Public NFT identity is still
// not authentication: one-active-per-holder limits, but cannot eliminate, squatting.
// Only disposable databases, generated test keys, mock RPC and ephemeral HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { HDNodeWallet } from "ethers";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { createNftProcessor } from "../server/nft-processor.mjs";
import { DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { NFT_POOL_FUNDER } from "../server/nft-pool-config.mjs";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { createPaymentService } from "../server/payment-service.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";

const hash = n => `0x${BigInt(n).toString(16).padStart(64,"0")}`;
const holder = "0x1111111111111111111111111111111111111111";
async function fundedNft(t) {
  const directory=mkdtempSync(join(tmpdir(),"chogcare-audit-"));
  const root=HDNodeWallet.createRandom("",DEPOSIT_BASE_PATH);
  const xpub=root.neuter().extendedKey;
  const vault={version:1,basePath:DEPOSIT_BASE_PATH,xpub,keyId:createHash("sha256").update(xpub).digest("hex")};
  let destinationTip=100n,sourceTip=100n,deposit=null,verificationReads=0;
  let time=Date.parse("2026-10-09T12:00:00Z");
  let processor;
  const source={
    getChainId:async()=>143,
    getBlock:async({blockTag,blockNumber})=>({number:blockTag?sourceTip:blockNumber,hash:hash(blockTag?sourceTip:blockNumber),timestamp:BigInt(time/1000),transactions:deposit?[deposit]:[]}),
    readContract:async()=>holder,
    getBalance:async()=>deposit?10n**18n:0n,
    getTransaction:async()=>{verificationReads++;const error=new Error("Temporary RPC outage");error.name="TimeoutError";throw error;},
    getTransactionReceipt:async()=>({status:"success",blockNumber:101n}),
  };
  const receipt=()=>({status:"success",transactionHash:hash(900),blockNumber:101n,blockHash:hash(101),logs:[{
    address:deliveryNetwork(10).usdc,transactionHash:hash(900),blockNumber:101n,blockHash:hash(101),logIndex:0,removed:false,
    topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:NFT_POOL_FUNDER,to:processor.treasuryAddress}}),
    data:encodeAbiParameters([{type:"uint256"}],[10000000n]),
  }]});
  const destination={
    getChainId:async()=>10,
    getBlock:async({blockTag,blockNumber})=>({number:blockTag?destinationTip:blockNumber,hash:hash(blockTag?destinationTip:blockNumber),timestamp:BigInt(time/1000)}),
    getContractEvents:async({fromBlock,toBlock})=>fromBlock<=101n&&toBlock>=101n?receipt().logs:[],
    getTransactionReceipt:async()=>receipt(),
    getBalance:async()=>10n**16n,
    readContract:async()=>10000000n,
  };
  processor=createNftProcessor({filename:join(directory,"test.sqlite"),root,vault},{source,destination,now:()=>time});
  t.after(async()=>{await processor.close();rmSync(directory,{recursive:true,force:true});});
  await processor.tick();destinationTip=101n;await processor.tick();
  return {processor,input:tokenId=>({mode:"nft",amount:"1",initiativeId:"burundi",holderAddress:holder,tokenId}),
    deposit(x){sourceTip=101n;deposit={from:holder,to:x.depositAddress,value:10n**18n,hash:hash(1000)};},
    reads:()=>verificationReads, advance:ms=>{time+=ms;}};
}

test("AUDIT REGRESSION: one public holder cannot reserve all NFT checkout slots",async t=>{
  const f=await fundedNft(t);
  await f.processor.issue(f.input("1"));
  for(const id of ["2","3"])await assert.rejects(f.processor.issue(f.input(id)),/already active/);
  assert.equal(f.reads(),0,"no ownership-control transaction was needed to reserve");
  assert.equal(f.processor.publicStatus().availableClaims,2);
  assert.equal(f.processor.publicStatus().availableCheckoutSlots,2);
  assert.equal(f.processor.publicStatus().nftPaymentsEnabled,true);
});

test("AUDIT REGRESSION: transient NFT proof failure retries the pinned hash without releasing funds",async t=>{
  const f=await fundedNft(t),invoice=await f.processor.issue(f.input("1"));
  f.deposit(invoice);await f.processor.tick();
  assert.equal(f.processor.get(invoice.id).state,"verifying");
  const pinned=f.processor.get(invoice.id).depositHash;
  const reads=f.reads();await f.processor.tick();assert.equal(f.reads(),reads,"no busy retries");
  f.advance(5000);await f.processor.tick();
  assert.equal(f.reads(),reads+1,"the same proof is re-verified after backoff");
  assert.equal(f.processor.get(invoice.id).depositHash,pinned);
  assert.equal(f.processor.publicStatus().reservedTodayUsdc,"1.00");
});

test("AUDIT REGRESSION: two browser sessions behind one proxy have independent polling budgets",async t=>{
  const store=openInvoiceStore(":memory:"),server=createPaymentService(store);
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const url=`http://127.0.0.1:${server.address().port}/api/payments/config`;
  const cookies=[];
  for(let i=0;i<2;i++){const response=await fetch(url);cookies.push(response.headers.get("set-cookie").split(";")[0]);await response.json();}
  for(let i=0;i<100;i++){const response=await fetch(url,{headers:{Cookie:cookies[i%2]}});assert.equal(response.status,200);await response.json();}
});
