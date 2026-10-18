import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { erc20Abi, parseAbi, isAddress, zeroAddress, encodeFunctionData, decodeEventLog, formatUnits } from "viem";
import { monad, optimism } from "viem/chains";
import { estimateTotalFee } from "viem/op-stack";
import { createAddressAllocator } from "./address-allocator.mjs";
import { createPoolLedger } from "./pool-ledger.mjs";
import { createNftProofLedger } from "./nft-proof-ledger.mjs";
import { createPayoutOutbox } from "./payout-outbox.mjs";
import { verifyNftDeposit, isRetryableNftProofError } from "./nft-proof.mjs";
import { matchingNftTransfers } from "./nft-transfer-trace.mjs";
import { inspectReceipt, AwaitingFinalityError } from "./chain-receipts.mjs";
import { verifyApprovedNftFunding } from "./nft-pool-funding.mjs";
import { atomic } from "./sqlite-transaction.mjs";
import { paymentRequestUri } from "./payment-request.mjs";
import { PAYMENT_POLICY, SUBSIDY_UNITS } from "./policy.mjs";
import { chogBeneficiary, supportsNft, NFT_INITIATIVES } from "../src/chog-beneficiary.ts";
import { deliveryNetwork } from "../src/delivery-network.ts";
import { NFT_POOL_FUNDER, NFT_POOL_FUNDERS, NFT_POOL_CHAIN, NFT_TREASURY_PATH, NFT_POOL_GAS_MIN, NFT_PAYOUT_FEE_CAP } from "./nft-pool-config.mjs";
import { createPaymentPerformance } from "./payment-performance.mjs";
import { paymentRpcClient } from "./payment-rpc.mjs";
import { canRepeatNftGrant } from "./nft-repeat-policy.mjs";

const network = deliveryNetwork(NFT_POOL_CHAIN);
const nftAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function tokensOfOwner(address) view returns (uint256[])"]);
const same = (a,b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const day = now => new Date(now).toISOString().slice(0,10);
const hash = x => typeof x === "string" && /^0x[\da-f]{64}$/i.test(x);
const ACTIVE_STATES = "'awaiting-payment','verifying','verified','paying','confirming','manual-review'";
const ACTIVE_LIMIT = 3;
const NEW_INVOICE_WINDOW_MS = 5 * 60_000;
const MAX_PROOF_FAILURES = 8;
const FUNDING_SCAN_BLOCKS = 50n;

// Owner-unlocked local worker. Dedicated Optimism treasury; shares only the
// durable deposit allocator with CHOG. Never reuses the Monad operator nonce.
export function createNftProcessor({ filename, vault, root, checkpoint = () => {} }, dependencies = {}) {
  if (root.neuter().extendedKey !== vault.xpub) throw new Error("Signer branch mismatch.");
  const wallet = root.derivePath(NFT_TREASURY_PATH);
  const source = dependencies.source ?? paymentRpcClient(monad);
  const destination = dependencies.destination ?? paymentRpcClient(optimism);
  const feeEstimate = dependencies.feeEstimate ?? (args => estimateTotalFee(destination,args));
  const now = dependencies.now ?? Date.now;
  const metrics = createPaymentPerformance();
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS nft_invoices (id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nft_pool_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1),treasury TEXT NOT NULL,funder TEXT NOT NULL,chain_id INTEGER NOT NULL,funding_cursor TEXT);`);
  const allocator = createAddressAllocator(db,vault);
  const ledger = createPoolLedger(db,10), proofs = createNftProofLedger(db), outbox = createPayoutOutbox(db,wallet.address,10);
  db.prepare("INSERT OR IGNORE INTO nft_pool_meta VALUES (1,?,?,10,NULL)").run(wallet.address.toLowerCase(),NFT_POOL_FUNDER.toLowerCase());
  const meta = db.prepare("SELECT * FROM nft_pool_meta WHERE singleton=1").get();
  if (!same(meta.treasury,wallet.address) || !same(meta.funder,NFT_POOL_FUNDER) || meta.chain_id !== 10) throw new Error("NFT treasury configuration mismatch.");
  let running=false, closed=false, healthyAt=0, gas=0n, usdc=0n, issuing=false;
  let readinessRequest=null, fundingVerified=false;
  // Read-only heartbeat, independent of the serialized proof/payout queue.
  // Balances alone NEVER credit funding: the verified funding ledger and its
  // first successful sync remain mandatory before this can advertise health.
  const refreshReadiness=()=>{
    if(closed)return Promise.resolve();
    if(readinessRequest)return readinessRequest;
    readinessRequest=(async()=>{
      const [sourceChain,destinationChain]=await Promise.all([source.getChainId(),destination.getChainId()]);
      if(sourceChain!==143||destinationChain!==10)throw new Error("Wrong network.");
      const [nextGas,nextUsdc]=await Promise.all([destination.getBalance({address:wallet.address}),destination.readContract({address:network.usdc,abi:erc20Abi,functionName:"balanceOf",args:[wallet.address]})]);
      if(!closed){gas=nextGas;usdc=nextUsdc;if(fundingVerified)healthyAt=now();}
    })().catch(error=>{healthyAt=0;throw error;}).finally(()=>{readinessRequest=null;});
    return readinessRequest;
  };
  const save = x => db.prepare("UPDATE nft_invoices SET state=?,document=? WHERE id=?").run(x.state,JSON.stringify(x),x.id);
  const load = id => {const r=db.prepare("SELECT document FROM nft_invoices WHERE id=?").get(id);return r?JSON.parse(r.document):null;};
  const pendingUnits = () => BigInt(db.prepare("SELECT COALESCE(SUM(units),0) AS n FROM pool_reservations WHERE state!='paid'").get().n);
  const activeCount = () => db.prepare(`SELECT COUNT(*) AS n FROM nft_invoices WHERE state IN (${ACTIVE_STATES})`).get().n;
  const assertIdentityAdmission = input => {
    const holder = input.holderAddress.toLowerCase(), token = String(BigInt(input.tokenId));
    // Public identity is not proof of control. These are bounded abuse mitigations,
    // not authentication: a bot can still squat on someone else's public identity.
    if (db.prepare(`SELECT 1 FROM nft_invoices WHERE state IN (${ACTIVE_STATES}) AND
      (lower(json_extract(document,'$.holderAddress'))=? OR json_extract(document,'$.tokenId')=?) LIMIT 1`).get(holder,token)) {
      throw new Error("An invoice for this holder or NFT is already active. Keep the original invoice; do not pay again.");
    }
    // The allowlisted holder may repeat sequentially. An active or ambiguous
    // invoice above still blocks another address, including for this holder.
    if(canRepeatNftGrant(holder))return;
    const today = day(now());
    if (db.prepare("SELECT 1 FROM pool_reservations WHERE day=? AND (holder_address=? OR (collection=? AND token_id=?))").get(today,holder,PAYMENT_POLICY.nftCollection,token)) {
      throw Object.assign(new Error("This wallet or NFT already has a grant reserved for today."),{code:"NFT_DAILY_LIMIT"});
    }
    // An expired unpaid request never proves who created it. Counting it against
    // the public holder/NFT would let someone else ban that identity for a day.
    // Active/ambiguous reservations above still block duplicate checkouts, and
    // the retained paid reservation still enforces the genuine daily claim.
  };
  const grantUnits = x => {const row=db.prepare("SELECT units FROM pool_reservations WHERE invoice_id=?").get(x.id);return row?.units??Number(x.subsidyUnits??500_000);};
  const publicInvoice = x => ({kind:"payment",mode:"nft",id:x.id,state:x.state,amount:"1",asset:"MON",chainId:143,destinationChainId:10,
    initiativeId:x.initiativeId??"burundi",recipient:chogBeneficiary(x.initiativeId??"burundi",10),subsidyUsdc:Number(formatUnits(BigInt(grantUnits(x)),6)).toFixed(2),tokenId:x.tokenId,holderAddress:x.holderAddress,
    depositAddress:x.depositAddress,paymentUri:x.paymentUri,expiresAt:x.expiresAt,claimDay:x.claimDay,depositHash:x.depositHash??null,
    destinationHash:x.destinationHash??null,observedDestinationHash:x.observedDestinationHash??null,message:x.message??null});
  const healthy = () => !closed && now()-healthyAt<60000;

  // Eligibility is read-only. The HTTP layer may call it before reserving a
  // request-journal slot, but issuance always reruns it against fresh chain and
  // ledger state before allocating a deposit address. Never cache authorization.
  async function eligibleInput(input) {
    if(input.mode!=="nft"||input.amount!=="1"||!supportsNft(input.initiativeId)||!isAddress(input.holderAddress)||same(input.holderAddress,zeroAddress)||input.tokenId!==undefined&&(typeof input.tokenId!=="string"||!/^\d{1,78}$/.test(input.tokenId)||BigInt(input.tokenId)>=2n**256n))throw new Error("Invalid holder invoice.");
    const [created,sourceChain]=await Promise.all([source.getBlock({blockTag:"finalized"}),source.getChainId()]);
    if(sourceChain!==143)throw new Error("Wrong source chain.");
    if(input.tokenId===undefined) {
      const tokens=await source.readContract({address:PAYMENT_POLICY.nftCollection,abi:nftAbi,functionName:"tokensOfOwner",args:[input.holderAddress],blockNumber:created.number});
      if(!Array.isArray(tokens)||tokens.length>1969||tokens.some(t=>typeof t!=="bigint"||t<0n||t>=2n**256n))throw new Error("Invalid NFT lookup response.");
      if(!tokens.length)throw Object.assign(new Error("No CHOG NFT found."),{code:"NFT_NOT_OWNED"});
      const token=tokens.find(t=>canRepeatNftGrant(input.holderAddress)||!db.prepare("SELECT 1 FROM pool_reservations WHERE collection=? AND token_id=? AND day=?").get(PAYMENT_POLICY.nftCollection,String(t),day(now())));
      if(token===undefined)throw Object.assign(new Error("Daily NFT grants already used."),{code:"NFT_DAILY_LIMIT"});
      input={...input,tokenId:String(token)};
    }
    assertIdentityAdmission(input);
    const owner=await source.readContract({address:PAYMENT_POLICY.nftCollection,abi:nftAbi,functionName:"ownerOf",args:[BigInt(input.tokenId)],blockNumber:created.number});
    if(!same(owner,input.holderAddress))throw Object.assign(new Error("Address does not own this NFT."),{code:"NFT_NOT_OWNED"});
    const createdAt=now(),midnight=Date.parse(`${day(createdAt)}T00:00:00Z`)+86400000;
    if(midnight-createdAt<120000)throw new Error("Wait for the daily reset before starting.");
    assertIdentityAdmission(input);
    return {input,created,createdAt,midnight};
  }

  function deferProof(x,error) {
    const count = Number.isSafeInteger(x.proofFailures) ? x.proofFailures + 1 : 1;
    x.proofFailures = count;
    if (isRetryableNftProofError(error) && count < MAX_PROOF_FAILURES) {
      x.state = "verifying";
      x.proofRetryAt = now() + Math.min(5_000 * 2 ** (count - 1),300_000);
      x.message = "Payment detected. Verification will retry automatically; do not send MON again.";
    } else {
      x.state = "manual-review";
      x.proofRetryAt = null;
      x.message = "Verification needs operator review. Keep this invoice; do not send MON again.";
    }
    save(x); // Candidate and pool reservation survive retries, expiry and restarts.
  }

  async function verifyPinnedDeposit(x) {
    if (x.proofRetryAt && now() < x.proofRetryAt) return false;
    try {
      if (!hash(x.depositHash)) throw new Error("Missing pinned NFT deposit.");
      const proof = await metrics.measure("nft-proof",()=>verifyNftDeposit(source,{...x,kind:"nft-verification",state:"awaiting-payment",createdBlock:BigInt(x.createdBlock)},x.depositHash));
      atomic(db,()=>{
        const existing = db.prepare("SELECT document FROM nft_proofs WHERE invoice_id=?").get(x.id);
        if (existing) {
          if (existing.document !== JSON.stringify(proof)) throw new Error("Previously verified NFT proof changed. Manual review required.");
        } else {
          const reservation=db.prepare("SELECT claim_scope FROM pool_reservations WHERE invoice_id=?").get(x.id);
          if(!reservation)throw new Error("Missing NFT reservation.");
          proofs.recordVerifiedProof(proof,x.createdAt,reservation.claim_scope);
        }
        x.state="verified";x.proofRetryAt=null;x.message=null;save(x);
      });
      return true;
    } catch(error) { deferProof(x,error);return false; }
  }

  async function syncFunding() {
    const tip = await destination.getBlock({blockTag:"finalized"});
    let cursor = db.prepare("SELECT funding_cursor FROM nft_pool_meta WHERE singleton=1").get().funding_cursor;
    // Start before showing the new address. Never synthesize funding from a balance.
    if (cursor === null) {
      cursor=String(tip.number);
      db.prepare("UPDATE nft_pool_meta SET funding_cursor=? WHERE singleton=1").run(cursor);
    }
    // Commit one provider-sized page per tick. A 2,000-block transport request
    // used to discard up to 39 successful subpages when a later page failed or
    // exceeded its deadline, retrying the same history forever. Never skip the
    // saved cursor, including after downtime, and never credit from a balance.
    const from=BigInt(cursor)+1n, end=from+FUNDING_SCAN_BLOCKS-1n<tip.number?from+FUNDING_SCAN_BLOCKS-1n:tip.number;
    if (from<=end) {
      const logs=await destination.getContractEvents({address:network.usdc,abi:erc20Abi,eventName:"Transfer",args:{from:[...NFT_POOL_FUNDERS],to:wallet.address},fromBlock:from,toBlock:end,strict:true});
      for(const l of logs) {
        const event=decodeEventLog({abi:erc20Abi,eventName:"Transfer",data:l.data,topics:l.topics,strict:true});
        ledger.creditVerifiedFunding(await verifyApprovedNftFunding(destination,wallet.address,event.args.from,l.transactionHash,l.logIndex));
      }
      db.prepare("UPDATE nft_pool_meta SET funding_cursor=? WHERE singleton=1").run(String(end));
    }
    // ChogCare-generated contributions are not accepted merely because they
    // reached the treasury. Independently re-verify the finalized Optimism log
    // that the CHOG worker bound to its persisted, signed Relay batch.
    const hasBatches=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pool_contribution_batches'").get();
    if(hasBatches){const rows=db.prepare("SELECT id,document FROM pool_contribution_batches WHERE state='delivered' AND COALESCE(json_extract(document,'$.credited'),0)=0 ORDER BY rowid LIMIT 10").all();
      for(const row of rows){const batch=JSON.parse(row.document);
        if(!hash(batch.destinationHash)||!same(batch.treasury,wallet.address)||batch.destinationChainId!==10||!/^\d{1,20}$/.test(batch.deliveredUsdc??"")||!Number.isSafeInteger(batch.logIndex)||batch.logIndex<0)throw new Error("Invalid internal NFT pool batch record.");
        const inspected=await inspectReceipt(destination,10,batch.destinationHash);if(!inspected.finalized)continue;
        const log=inspected.receipt.logs.find(item=>item.logIndex===batch.logIndex&&same(item.address,network.usdc)&&same(item.transactionHash,batch.destinationHash)&&same(item.blockHash,inspected.receipt.blockHash)&&item.blockNumber===inspected.receipt.blockNumber&&!item.removed);
        if(!log)throw new Error("NFT pool batch receipt does not contain the pinned funding log.");
        let event;try{event=decodeEventLog({abi:erc20Abi,eventName:"Transfer",data:log.data,topics:log.topics,strict:true});}catch{throw new Error("Invalid NFT pool batch transfer log.");}
        if(!same(event.args.to,wallet.address)||event.args.value!==BigInt(batch.deliveredUsdc)||event.args.value<BigInt(batch.minOutput))throw new Error("NFT pool batch funding does not match its verified minimum.");
        if(event.args.value>1_000_000_000_000n)throw new Error("NFT pool batch exceeds the accounting limit.");
        ledger.creditVerifiedFunding({chainId:10,txHash:batch.destinationHash,logIndex:batch.logIndex,units:Number(event.args.value)});
        batch.credited=true;db.prepare("UPDATE pool_contribution_batches SET document=? WHERE id=? AND state='delivered'").run(JSON.stringify(batch),row.id);
      }
    }
    [gas,usdc]=await Promise.all([destination.getBalance({address:wallet.address}),destination.readContract({address:network.usdc,abi:erc20Abi,functionName:"balanceOf",args:[wallet.address]})]);
  }

  async function observeDeposit(x) {
    // A crash after pinning a candidate must never make us select another hash.
    if (x.depositHash) { await verifyPinnedDeposit(x); return; }
    const [tip,sourceChain]=await Promise.all([source.getBlock({blockTag:"finalized"}),source.getChainId()]);
    if(sourceChain!==143)throw new Error("Wrong source chain.");
    let cursor=BigInt(x.cursor);
    // Older workers skipped smart-wallet calls. Re-scan their original window
    // once, never replace a pinned proof or a payout/reservation.
    if(!x.internalScanVersion&&typeof source.request==="function") {
      cursor=BigInt(x.createdBlock);x.cursor=String(cursor);x.internalScanVersion=1;save(x);
    }
    // These dedicated addresses never send MON. A finalized zero balance lets
    // us skip empty blocks; after funds arrive we inspect full canonical blocks.
    const balance=await source.getBalance({address:x.depositAddress,blockNumber:tip.number});
    if(balance===0n) cursor=tip.number;
    else {
      // Dedicated deposit addresses never send MON. Locate first funding in
      // logarithmic RPC calls instead of downloading hundreds of full blocks.
      if(typeof source.request==="function"&&await source.getBalance({address:x.depositAddress,blockNumber:cursor})===0n) {
        let low=cursor+1n,high=tip.number;
        while(low<high){const mid=(low+high)/2n;if(await source.getBalance({address:x.depositAddress,blockNumber:mid})>0n)high=mid;else low=mid+1n;}
        cursor=low-1n;x.cursor=String(cursor);save(x);
      }
      const end=cursor+40n<tip.number?cursor+40n:tip.number;
      for(let start=cursor+1n;start<=end;start+=2n) {
        const numbers=[];for(let n=start;n<start+2n&&n<=end;n++)numbers.push(n);
        const blocks=await Promise.all(numbers.map(blockNumber=>source.getBlock({blockNumber,includeTransactions:true})));
        for(const b of blocks) {
          if(!Array.isArray(b.transactions)||b.transactions.some(t=>typeof t!=="object"))throw new Error("Full transaction blocks required.");
          for(const tx of b.transactions) {
            if(!same(tx.to,x.depositAddress)||!same(tx.from,x.holderAddress)||tx.value===0n)continue;
            // Pin the candidate before proof checks, so ambiguity never releases a reservation.
            x.depositHash=tx.hash;x.state="verifying";save(x);
            await verifyPinnedDeposit(x);
            return;
          }
          if(typeof source.request==="function") {
            const traces=await source.request({method:"debug_traceBlockByNumber",params:[`0x${b.number.toString(16)}`,{tracer:"callTracer"}]});
            if(!Array.isArray(traces)||traces.length!==b.transactions.length)throw new Error("Incomplete NFT block traces.");
            for(const trace of traces) {
              const tx=b.transactions.find(t=>same(t.hash,trace.txHash));
              if(!tx||trace.error||!trace.result)throw new Error("Invalid NFT block trace.");
              if(matchingNftTransfers(trace.result,x.holderAddress,x.depositAddress).length===1) {
                x.depositHash=tx.hash;x.state="verifying";save(x);
                await verifyPinnedDeposit(x);return;
              }
            }
          }
          cursor=b.number;
          x.cursor=String(cursor);save(x); // Preserve progress if a later RPC is rate-limited.
        }
      }
    }
    x.cursor=String(cursor);
    if(cursor>=tip.number && tip.timestamp*1000n>BigInt(x.expiresAt+60000)) {
      atomic(db,()=>{
        if(x.depositHash || db.prepare("SELECT 1 FROM nft_proofs WHERE invoice_id=?").get(x.id) || db.prepare("SELECT 1 FROM pool_outbox WHERE invoice_id=?").get(x.id))throw new Error("Reservation is not releasable.");
        db.prepare("DELETE FROM pool_reservations WHERE invoice_id=? AND state='reserved' AND payout_hash IS NULL").run(x.id);
        x.state="expired";save(x);
      });
    } else save(x);
  }

  async function pay(x) {
    const initiativeId=x.initiativeId??"burundi",recipient=chogBeneficiary(initiativeId,10);
    const units=BigInt(grantUnits(x));
    let row=db.prepare("SELECT tx_hash FROM pool_outbox WHERE invoice_id=?").get(x.id);
    if(!row) {
      // Re-verify canonical payment and ownership immediately before signing.
      if (!await verifyPinnedDeposit(x)) return;
      if(await destination.getChainId()!==10)throw new Error("Wrong payout network.");
      const [latest,pending]=await Promise.all([destination.getTransactionCount({address:wallet.address,blockTag:"latest"}),destination.getTransactionCount({address:wallet.address,blockTag:"pending"})]);
      if(latest!==pending)return;
      if(db.prepare("SELECT 1 FROM pool_outbox WHERE nonce>=?").get(latest))return;
      const call={account:wallet.address,to:network.usdc,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[recipient,units]})};
      const [estimated,price,totalFee,balance,tokenBalance]=await Promise.all([destination.estimateGas(call),destination.getGasPrice(),feeEstimate(call),destination.getBalance({address:wallet.address}),destination.readContract({address:network.usdc,abi:erc20Abi,functionName:"balanceOf",args:[wallet.address]})]);
      const gasLimit=estimated*125n/100n,maxFeePerGas=price*2n;
      if(gasLimit>150000n||gasLimit<21000n||price<=0n||totalFee> NFT_PAYOUT_FEE_CAP||totalFee<0n||gasLimit*maxFeePerGas>NFT_PAYOUT_FEE_CAP||balance<NFT_POOL_GAS_MIN||tokenBalance<units)throw new Error("Treasury balance or gas policy prevents payout.");
      checkpoint();
      const raw=await wallet.signTransaction({to:call.to,value:0n,data:call.data,chainId:10,type:2,nonce:latest,gasLimit,maxFeePerGas,maxPriorityFeePerGas:price/10n});
      outbox.persistSignedGrant(x.id,initiativeId,raw,now());
      checkpoint();
      row=db.prepare("SELECT tx_hash FROM pool_outbox WHERE invoice_id=?").get(x.id);
    }
    // Persisted hash wins after every crash. Never build a replacement payment.
    x.state="paying";x.destinationHash=row.tx_hash;save(x);
    let receipt;
    try {receipt=await destination.getTransactionReceipt({hash:row.tx_hash});}
    catch(error){if(error.name!=="TransactionReceiptNotFoundError")throw error;}
    if(!receipt){checkpoint();await outbox.broadcast(destination,x.id,checkpoint);return;}
    if(receipt.status!=="success"){x.state="manual-review";x.message="Payout needs operator recovery. Do not pay again.";save(x);return;}
    const inspected=await inspectReceipt(destination,10,row.tx_hash,receipt);
    for(const l of inspected.receipt.logs) {
      if(l.removed||!same(l.address,network.usdc)||!same(l.transactionHash,row.tx_hash)||l.blockNumber!==receipt.blockNumber||!same(l.blockHash,receipt.blockHash))continue;
      let event;try{event=decodeEventLog({abi:erc20Abi,eventName:"Transfer",data:l.data,topics:l.topics,strict:true});}catch{continue;}
      if(!same(event.args.from,wallet.address)||!same(event.args.to,recipient)||event.args.value!==units)continue;
      if(inspected.finalized){await outbox.confirm(destination,x.id,l.logIndex);x.state="delivered";x.message=null;}
      else {x.state="confirming";x.observedDestinationHash=row.tx_hash;x.message=null;}
      save(x);return;
    }
    throw new Error("Expected USDC transfer not found.");
  }

  return {
    diagnostics(){return metrics.snapshot();},
    treasuryAddress:wallet.address,
    canRetryUnissuedNft(id) {
      // Only a request that never reached address allocation may be retried.
      // An allocated address is ambiguous even if the invoice insert failed.
      return !closed && !issuing && /^[a-f0-9]{64}$/.test(id) && !load(id) &&
        !db.prepare("SELECT 1 FROM deposit_addresses WHERE invoice_id=?").get(id) &&
        !db.prepare("SELECT 1 FROM pool_reservations WHERE invoice_id=?").get(id);
    },
    refreshReadiness,
    publicStatus() {
      const s=ledger.summary(now());
      const availableCheckoutSlots=Math.max(0,ACTIVE_LIMIT-activeCount());
      return {nftWorkerVersion:"2026-10-18-security-preflight-v13",nftReadiness:!healthy()?"network-unavailable":gas<NFT_POOL_GAS_MIN?"gas-needed":usdc<pendingUnits()+BigInt(SUBSIDY_UNITS)||s.fundedAvailableUnits<SUBSIDY_UNITS?"funding-needed":s.availableClaims<=0?"daily-limit":availableCheckoutSlots<=0?"queue-full":"ready",nftSupported:true,nftPaymentsEnabled:healthy()&&gas>=NFT_POOL_GAS_MIN&&usdc>=pendingUnits()+BigInt(SUBSIDY_UNITS)&&s.availableClaims>0&&availableCheckoutSlots>0,
        nftSupportedInitiatives:[...NFT_INITIATIVES],poolChainId:10,poolTreasury:wallet.address,poolUsdc:network.usdc,poolFunder:NFT_POOL_FUNDER,poolFunders:[...NFT_POOL_FUNDERS],poolFunded:s.fundedAvailableUnits>=SUBSIDY_UNITS,
        availableClaims:s.availableClaims,availableCheckoutSlots,nftQueueFull:availableCheckoutSlots===0,reservedTodayUsdc:(s.reservedTodayUnits/1000000).toFixed(2),poolGasReady:gas>=NFT_POOL_GAS_MIN,poolHealthy:healthy()};
    },
    async preflight(input) {
      if(!this.publicStatus().nftPaymentsEnabled)throw new Error("NFT pool is not ready.");
      await eligibleInput(input);
    },
    async issue(input, requestId) {
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId))) throw new Error("Invalid internal request ID.");
      if(issuing)throw new Error("Another invoice is being prepared.");issuing=true;
      try {
        if(!this.publicStatus().nftPaymentsEnabled)throw new Error("NFT pool is not ready.");
        const eligible=await eligibleInput(input);
        input=eligible.input;
        const {created,createdAt,midnight}=eligible;
        const id=requestId ?? randomBytes(32).toString("hex"),allocation=allocator.allocate(id);
        const x={id,initiativeId:input.initiativeId,state:"awaiting-payment",holderAddress:input.holderAddress,tokenId:String(BigInt(input.tokenId)),subsidyUnits:SUBSIDY_UNITS,depositAddress:allocation.address,createdAt,claimDay:day(createdAt),
          createdBlock:String(created.number),cursor:String(created.number),expiresAt:Math.min(createdAt+NEW_INVOICE_WINDOW_MS,midnight-60000),paymentUri:paymentRequestUri({mode:"nft",depositAddress:allocation.address,amount:"1",chainId:143})};
        atomic(db,()=>{
          if(!this.publicStatus().nftPaymentsEnabled)throw new Error("Pool funds were reserved by another invoice.");
          assertIdentityAdmission(input);
          if(db.prepare("SELECT COUNT(*) AS n FROM nft_invoices").get().n>=2000)throw new Error("Pilot storage limit reached.");
          ledger.reserve({invoiceId:id,collection:PAYMENT_POLICY.nftCollection,tokenId:x.tokenId,holderAddress:x.holderAddress},createdAt);
          db.prepare("INSERT INTO nft_invoices VALUES (?,?,?)").run(id,x.state,JSON.stringify(x));
        });return publicInvoice(x);
      } finally {issuing=false;}
    },
    get(id){if(!/^[a-f0-9]{64}$/.test(id))return null;const x=load(id);return x?publicInvoice(x):null;},
    async tick() {
      if(running||closed)return;running=true;
      try {return await metrics.measure("nft-tick",async()=>{
        const [sourceChain,destinationChain]=await Promise.all([source.getChainId(),destination.getChainId()]);
        if(sourceChain!==143||destinationChain!==10)throw new Error("Wrong network.");
        await metrics.measure("nft-funding",syncFunding);fundingVerified=true;healthyAt=now();
        const rows=db.prepare("SELECT document FROM nft_invoices WHERE state IN ('awaiting-payment','verifying','verified','paying','confirming') ORDER BY rowid").all();
        // Detection/proofs use independent deposit addresses and can overlap.
        // Every treasury operation (including nonce reads and signing) stays in
        // ONE queue. A slow unpaid invoice must not block an existing payout.
        // Process in bounded groups even when resuming a historical database.
        let payoutTail=Promise.resolve();
        const settle=x=>{
          const result=payoutTail.then(()=>metrics.measure("nft-payout",()=>pay(x)));
          payoutTail=result.catch(()=>{});return result;
        };
        const processRow=async row=>{const x=JSON.parse(row.document);try {
          if(x.state==="awaiting-payment")await metrics.measure("nft-discovery",()=>observeDeposit(x));
          else if(x.state==="verifying")await verifyPinnedDeposit(x);
          if(["verified","paying","confirming"].includes(x.state))await settle(x);
        }catch(error){x.message=error instanceof AwaitingFinalityError?"Waiting for network finality. Do not pay again.":"Processing is paused. Keep this invoice; do not pay again.";save(x);}};
        for(let offset=0;offset<rows.length;offset+=ACTIVE_LIMIT){
          // Drain siblings even if a local storage error escapes processRow.
          // Never release the tick/signing lock while another task is alive.
          const results=await Promise.allSettled(rows.slice(offset,offset+ACTIVE_LIMIT).map(processRow));
          const failure=results.find(result=>result.status==="rejected");
          if(failure)throw failure.reason;
        }
      });} catch(error){fundingVerified=false;healthyAt=0;throw error;}finally{running=false;}
    },
    async close(){closed=true;while(running||issuing||readinessRequest)await new Promise(r=>setTimeout(r,50));db.close();},
  };
}
