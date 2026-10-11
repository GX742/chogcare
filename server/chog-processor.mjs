import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { verifiedLeaderboardDonation } from "./donor-leaderboard.mjs";
import { createPublicClient, http, erc20Abi, encodeFunctionData, parseUnits, formatUnits, decodeEventLog, parseAbi } from "viem";
import { monad, mainnet, optimism } from "viem/chains";
import { deliveryNetwork, NEW_DONATION_CHAIN_ID, SOLANA_CHAIN_ID } from "../src/delivery-network.ts";
import { createAddressAllocator } from "./address-allocator.mjs";
import { verifyChogDeposit, finalizedReceipt, inspectReceipt, AwaitingFinalityError, NonCanonicalReceiptError } from "./chain-receipts.mjs";
import { bridgeQuote, relayJson, RELAY_DEPOSITORY } from "./relay-route.mjs";
import { saleQuote, usdcQuote } from "./source-quotes.mjs";
import { CHOG_DONATION_MAX_BRIDGE_LOSS_BPS, minimumBridgeDelivery, assertBridgeDelivery, assertCrossAssetBridgeDelivery } from "./bridge-cost-policy.mjs";
import { chogBeneficiary, acceptsNewChog, initiativeChain, CHOG_INITIATIVES, NFT_POOL_TREASURY } from "../src/chog-beneficiary.ts";
import { contributionForDonationUnits, splitSettlementUnits } from "../src/pool-contribution.ts";
import { sourceJournal } from "./source-journal.mjs";
import { validateSourceCall } from "./source-policy.mjs";
import { Transaction } from "ethers";
import { atomic } from "./sqlite-transaction.mjs";
import { paymentRequestUri } from "./payment-request.mjs";
import { createSolanaReceiptVerifier } from "./solana-receipt.mjs";
import { validatePoolBatchCall } from "./pool-batch-policy.mjs";
import { NFT_CONTRIBUTION_SOURCE_PATH, NFT_POOL_BATCH_MIN_USDC, NFT_POOL_SOURCE_GAS_GRANT, NFT_TREASURY_PATH } from "./nft-pool-config.mjs";
import { CHOG, MONAD_USDC, UNISWAP_ROUTER, WMON, GIVETH_PROJECT_RECIPIENT, sellAbi, swapRouterAbi } from "../src/route.ts";
import { PAYMENT_POLICY } from "./policy.mjs";

const GAS_GRANT = parseUnits("5",18);
const OPERATOR_READY_BALANCE = parseUnits("6",18); // Include gas for funding the child.
const same=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
const hashPattern=/^0x[0-9a-f]{64}$/i;
const solanaSignaturePattern=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const approve=(token,spender,amount)=>({to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[spender,amount]})});
const profileNftAbi=parseAbi(["function tokensOfOwner(address) view returns (uint256[])","function tokenURI(uint256) view returns (string)"]);
const ipfsUri=/^ipfs:\/\/([a-z0-9]{46,90})(\/[a-zA-Z0-9._/-]{1,180})?$/;
const ipfsGateway=uri=>{const match=ipfsUri.exec(uri);if(!match||match[2]?.split("/").includes(".."))return null;return `https://gateway.pinata.cloud/ipfs/${match[1]}${match[2]??""}`;};
const NFT_METADATA_MAX_BYTES=65_536, NFT_METADATA_CACHE_LIMIT=128, NFT_PROFILE_REQUEST_LIMIT=8;

// External metadata is display-only. Never follow a gateway redirect into the
// owner's LAN or buffer an unbounded/chunked response in the custody process.
export async function fetchProfileMetadata(uri, fetcher=fetch) {
  const url=ipfsGateway(uri);
  if(!url)return null;
  const response=await fetcher(url,{redirect:"error",headers:{Accept:"application/json"},signal:AbortSignal.timeout(7000)});
  const declared=response.headers.get("content-length");
  if(!response.ok||!response.body||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>NFT_METADATA_MAX_BYTES)){
    await response.body?.cancel().catch(()=>{});
    throw new Error("NFT metadata response rejected.");
  }
  let bytes=0;const chunks=[];
  for await(const chunk of response.body){
    bytes+=chunk.byteLength;
    if(bytes>NFT_METADATA_MAX_BYTES)throw new Error("NFT metadata exceeds the display limit.");
    chunks.push(Buffer.from(chunk));
  }
  const metadata=JSON.parse(Buffer.concat(chunks,bytes).toString("utf8"));
  if(!metadata||typeof metadata!=="object"||Array.isArray(metadata))throw new Error("Invalid NFT metadata.");
  return metadata;
}

// Local single-operator pilot. The root is provided ONLY by the owner's hidden
// terminal prompt, never via HTTP/env/browser. No arbitrary signing HTTP method.
export function createChogProcessor({ filename, vault, root, checkpoint=()=>{}, monadRpc="https://rpc.monad.xyz", ethereumRpc="https://ethereum-rpc.publicnode.com", optimismRpc="https://mainnet.optimism.io", solanaRpc="https://api.mainnet-beta.solana.com", newDestinationChainId=NEW_DONATION_CHAIN_ID }, dependencies={}) {
  deliveryNetwork(newDestinationChainId);
  if(root.neuter().extendedKey!==vault.xpub)throw new Error("Signer branch mismatch.");
  for(const url of [monadRpc,ethereumRpc,optimismRpc,solanaRpc])if(new URL(url).protocol!=="https:")throw new Error("HTTPS RPC required.");
  // Dependency injection is code-only for deterministic tests, never HTTP input.
  const source=dependencies.source??createPublicClient({chain:monad,transport:http(monadRpc,{timeout:15_000,retryCount:0})});
  const destination=dependencies.destination??createPublicClient({chain:mainnet,transport:http(ethereumRpc,{timeout:15_000,retryCount:0})});
  const opDestination=dependencies.optimismDestination??createPublicClient({chain:optimism,transport:http(optimismRpc,{timeout:15_000,retryCount:0})});
  const destinationClient=id=>id===1?destination:id===10?opDestination:null;
  const solana=dependencies.solanaVerifier??createSolanaReceiptVerifier(solanaRpc);
  const quoteSale=dependencies.saleQuote??saleQuote, quoteSwap=dependencies.usdcQuote??usdcQuote;
  const quoteBridge=dependencies.bridgeQuote??bridgeQuote, getRelay=dependencies.relayJson??relayJson;
  const db=new DatabaseSync(filename);
  const poolCollector=root.derivePath(NFT_CONTRIBUTION_SOURCE_PATH), poolTreasury=root.derivePath(NFT_TREASURY_PATH);
  const configuredPoolTreasury=dependencies.nftPoolTreasury??(Object.keys(dependencies).length?poolTreasury.address:NFT_POOL_TREASURY);
  if(!same(poolTreasury.address,configuredPoolTreasury)||same(poolCollector.address,poolTreasury.address)||same(poolCollector.address,root.address))throw new Error("NFT pool custody paths do not match the pinned configuration.");
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS chog_invoices(id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivered_events(event_id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS pool_contributions(invoice_id TEXT PRIMARY KEY,units TEXT NOT NULL,source_hash TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS pool_contribution_batches(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);`);
  const allocator=createAddressAllocator(db,vault), journal=sourceJournal(db);
  let running=false, closed=false, healthyAt=0, gasBalance=0n, expiredCursor="";
  let rateCache=null,rateRequest=null,poolPendingUsdc=0n;
  const nftMetadataCache=new Map(),nftMetadataRequests=new Map(),nftProfileRequests=new Map();
  // Only finalized/canonical source receipts are cached, in RAM. Restart always
  // re-verifies them. Pending receipts and Ethereum observations are never cached.
  const sourceConfirmed=new Map();
  const confirmedSource=async hash=>{
    if(sourceConfirmed.has(hash))return sourceConfirmed.get(hash);
    const result=await finalizedReceipt(source,143,hash);
    if(sourceConfirmed.size>=256)sourceConfirmed.delete(sourceConfirmed.keys().next().value);
    sourceConfirmed.set(hash,result);return result;
  };
  const save=x=>db.prepare("UPDATE chog_invoices SET state=?,document=? WHERE id=?").run(x.state,JSON.stringify(x),x.id);
  const load=id=>{const row=db.prepare("SELECT document FROM chog_invoices WHERE id=?").get(id);return row?JSON.parse(row.document):null;};
  const publicInvoice=x=>{const network=deliveryNetwork(x.destinationChainId);return {kind:"payment",id:x.id,mode:"chog",asset:"CHOG",chainId:143,amount:x.amount,donationAmount:x.donationAmount??x.amount,
    poolContributionAmount:x.poolContributionAmount??null,contributionPercent:x.contributionPercent??0,poolContributionState:x.contributionPercent===10?(journal.get(x.id,"pool-contribution")?"collected":"pending"):null,
    initiativeId:x.initiativeId??"burundi",recipient:chogBeneficiary(x.initiativeId??"burundi",network.id),
    depositAddress:x.depositAddress,paymentUri:paymentRequestUri({mode:"chog",amount:x.amount,depositAddress:x.depositAddress,chainId:143}),
    minUsdc:x.minOutput,state:x.state,expiresAt:x.expiresAt,depositHash:x.depositHash??null,bridgeHash:journal.get(x.id,"bridge")?.hash??null,destinationHash:x.destinationHash??null,
    deliveredUsdc:x.deliveredUsdc??null,observedDestinationHash:x.observedDestinationHash??null,observedUsdc:x.observedUsdc??null,message:x.message??null,
    processingStartedAt:x.processingStartedAt??null,bridgeStartedAt:x.bridgeStartedAt??null,destinationIncludedAt:x.destinationIncludedAt??null,
    destinationChainId:network.id,destinationAsset:network.asset,destinationDecimals:network.decimals,minimumUsd:x.minimumUsd??x.minOutput,bridgeEstimatedSeconds:x.bridge?.estimatedSeconds??x.bridgeEstimatedSeconds??null};};

  async function send(x,phase,wallet,build) {
    let row=journal.get(x.id,phase);
    if(!row) {
      const call=await build();
      if(!call)return null;
      validateSourceCall(phase,{...call,from:wallet.address},x,root.address);
      const [latest,pending]=await Promise.all([source.getTransactionCount({address:wallet.address,blockTag:"latest"}),source.getTransactionCount({address:wallet.address,blockTag:"pending"})]);
      if(latest!==pending)return null;
      const gasPrice=await source.getGasPrice(), maxFeePerGas=gasPrice*2n;
      if(maxFeePerGas>500_000_000_000n)throw new Error("Gas spike: processing paused automatically.");
      const estimated=await source.estimateGas({account:wallet.address,...call});
      const gasLimit=estimated*125n/100n;
      if(gasLimit>1_500_000n)throw new Error("Gas estimate exceeds local pilot limit.");
      if(await source.getBalance({address:wallet.address})<call.value+gasLimit*maxFeePerGas)throw new Error("Operator gas funds are insufficient.");
      if(phase==="bridge" && Date.now()>x.bridge.validUntil)throw new Error("Bridge quote expired before signing.");
      validateSourceCall(phase,{...call,from:wallet.address},x,root.address);
      checkpoint();
      const raw=await wallet.signTransaction({...call,chainId:143,type:2,nonce:latest,gasLimit,maxFeePerGas,maxPriorityFeePerGas:gasPrice/10n});
      row=journal.persist(x.id,phase,wallet.address,latest,raw);
      checkpoint();
      if(phase==="bridge") {x.bridgeStartedAt=Date.now();save(x);}
    }
    if(!same(keccakRaw(row.raw),row.hash))throw new Error("Stored transaction integrity failure.");
    validateSourceCall(phase,Transaction.from(row.raw),x,root.address,Date.now(),true);
    if(sourceConfirmed.has(row.hash))return sourceConfirmed.get(row.hash).receipt;
    let receipt;
    try { receipt=await source.getTransactionReceipt({hash:row.hash}); }
    catch(error) { if(error.name!=="TransactionReceiptNotFoundError")throw error; }
    if(!receipt) {
      // Sending identical signed bytes cannot create a second payment. Never
      // substitute a new quote/nonce when the transport result is unknown.
      checkpoint(); // Also covers a persisted transaction restored after a crash.
      try { const returned=await source.sendRawTransaction({serializedTransaction:row.raw}); if(!same(returned,row.hash))throw new Error("RPC hash mismatch."); }
      catch { x.message="Transaction submitted or pending. Checking its original hash; do not pay again."; save(x); }
      return null;
    }
    if(receipt.status!=="success") { x.state="manual-review"; x.message="A processing transaction reverted. Funds need operator review; do not pay again."; save(x);return null; }
    const {receipt:confirmed}=await confirmedSource(row.hash);
    return confirmed;
  }

  const saveBatch=x=>db.prepare("UPDATE pool_contribution_batches SET state=?,document=? WHERE id=?").run(x.state,JSON.stringify(x),x.id);
  const activeBatch=()=>{const row=db.prepare("SELECT document FROM pool_contribution_batches WHERE state IN ('preparing','bridging','confirming','manual-review') ORDER BY rowid LIMIT 1").get();return row?JSON.parse(row.document):null;};
  async function sendPoolBatch(x,phase,wallet,build) {
    let row=journal.get(x.id,phase);
    if(!row) {
      const call=await build();if(!call)return null;
      validatePoolBatchCall(phase,{...call,from:wallet.address},x,root.address,poolCollector.address);
      const [latest,pending]=await Promise.all([source.getTransactionCount({address:wallet.address,blockTag:"latest"}),source.getTransactionCount({address:wallet.address,blockTag:"pending"})]);
      if(latest!==pending)return null;
      const gasPrice=await source.getGasPrice(),maxFeePerGas=gasPrice*2n;
      if(maxFeePerGas>500_000_000_000n)throw new Error("Gas spike: NFT pool batching paused automatically.");
      const estimated=await source.estimateGas({account:wallet.address,...call}),gasLimit=estimated*125n/100n;
      if(gasLimit>1_500_000n)throw new Error("NFT pool batch gas estimate exceeds the limit.");
      if(await source.getBalance({address:wallet.address})<call.value+gasLimit*maxFeePerGas)throw new Error("NFT pool batch gas funds are insufficient.");
      if(phase==="pool-bridge"&&Date.now()>x.bridge.validUntil)throw new Error("NFT pool batch quote expired before signing.");
      checkpoint();
      const raw=await wallet.signTransaction({...call,chainId:143,type:2,nonce:latest,gasLimit,maxFeePerGas,maxPriorityFeePerGas:gasPrice/10n});
      row=journal.persist(x.id,phase,wallet.address,latest,raw);checkpoint();
    }
    if(!same(keccakRaw(row.raw),row.hash))throw new Error("Stored NFT pool batch transaction integrity failure.");
    validatePoolBatchCall(phase,Transaction.from(row.raw),x,root.address,poolCollector.address);
    if(sourceConfirmed.has(row.hash))return sourceConfirmed.get(row.hash).receipt;
    let receipt;try{receipt=await source.getTransactionReceipt({hash:row.hash});}catch(error){if(error.name!=="TransactionReceiptNotFoundError")throw error;}
    if(!receipt){checkpoint();try{const returned=await source.sendRawTransaction({serializedTransaction:row.raw});if(!same(returned,row.hash))throw new Error("RPC hash mismatch.");}catch{x.message="NFT pool batch submitted or pending. Tracking the original hash.";saveBatch(x);}return null;}
    if(receipt.status!=="success"){x.state="manual-review";x.message="NFT pool batching transaction reverted. Contributions remain recoverable.";saveBatch(x);return null;}
    return (await confirmedSource(row.hash)).receipt;
  }

  async function processContributionBatch() {
    poolPendingUsdc=await source.readContract({address:MONAD_USDC,abi:erc20Abi,functionName:"balanceOf",args:[poolCollector.address]});
    let x=activeBatch();
    if(!x) {
      if(poolPendingUsdc<NFT_POOL_BATCH_MIN_USDC)return;
      if(db.prepare("SELECT COUNT(*) AS n FROM pool_contribution_batches").get().n>=500)throw new Error("NFT pool batch storage limit reached.");
      x={id:randomBytes(32).toString("hex"),state:"preparing",collector:poolCollector.address,treasury:NFT_POOL_TREASURY,destinationChainId:10,amount:String(poolPendingUsdc),minOutput:null,bridge:null,message:null};
      db.prepare("INSERT INTO pool_contribution_batches VALUES (?,?,?)").run(x.id,x.state,JSON.stringify(x));
    }
    if(x.state==="manual-review")return;
    if(x.state==="preparing") {
      if(!journal.get(x.id,"pool-gas")&&await source.getBalance({address:poolCollector.address})<NFT_POOL_SOURCE_GAS_GRANT/2n){if(!await sendPoolBatch(x,"pool-gas",root,async()=>({to:poolCollector.address,value:NFT_POOL_SOURCE_GAS_GRANT,data:"0x"})))return;}
      else if(journal.get(x.id,"pool-gas")&&!await sendPoolBatch(x,"pool-gas",root,async()=>null))return;
      if(!await sendPoolBatch(x,"pool-approve",poolCollector,async()=>approve(MONAD_USDC,RELAY_DEPOSITORY,BigInt(x.amount))))return;
      if(!journal.get(x.id,"pool-bridge") && (!x.bridge||Date.now()>x.bridge.validUntil)) {
        const required=minimumBridgeDelivery(BigInt(x.amount));
        x.bridge=await quoteBridge(poolCollector.address,BigInt(x.amount),required,10,"nft-pool");assertBridgeDelivery(x.bridge,required);x.minOutput=x.bridge.minOutput;saveBatch(x);
      }
      if(!await sendPoolBatch(x,"pool-bridge",poolCollector,async()=>({to:x.bridge.to,data:x.bridge.data,value:0n})))return;
      x.state="bridging";x.message=null;saveBatch(x);
    }
    if(x.state==="bridging"||x.state==="confirming") {
      let candidates=x.state==="confirming"&&hashPattern.test(x.observedDestinationHash)?[x.observedDestinationHash]:null;
      if(!candidates){const status=await getRelay(`/intents/status/v3?requestId=${x.bridge.requestId}`);
        if(status.originChainId!==143||status.destinationChainId!==10||!Array.isArray(status.inTxHashes)||!status.inTxHashes.some(h=>same(h,journal.get(x.id,"pool-bridge").hash)))return;
        if(["refund","failure"].includes(status.status)){x.state="manual-review";x.message="NFT pool batch needs recovery; no replacement transfer will be created.";saveBatch(x);return;}
        if(!["submitted","success"].includes(status.status)||!Array.isArray(status.txHashes))return;candidates=status.txHashes.slice(0,10);}
      for(const hash of candidates){if(!hashPattern.test(hash))continue;let observation;try{observation=await inspectReceipt(opDestination,10,hash);}catch(error){if(error.name!=="TransactionReceiptNotFoundError"&&!(error instanceof NonCanonicalReceiptError))throw error;continue;}
        const {receipt}=observation;for(const log of receipt.logs){if(!same(log.address,deliveryNetwork(10).usdc)||log.removed||!same(log.transactionHash,hash)||!same(log.blockHash,receipt.blockHash)||log.blockNumber!==receipt.blockNumber)continue;
          let event;try{event=decodeEventLog({abi:erc20Abi,eventName:"Transfer",topics:log.topics,data:log.data,strict:true});}catch{continue;}
          if(!same(event.args.to,NFT_POOL_TREASURY)||event.args.value<BigInt(x.minOutput)||!Number.isSafeInteger(log.logIndex)||log.logIndex<0)continue;
          if(!observation.finalized){x.state="confirming";x.observedDestinationHash=hash;x.observedUsdc=String(event.args.value);x.message=null;saveBatch(x);return;}
          x.state="delivered";x.destinationHash=hash;x.deliveredUsdc=String(event.args.value);x.logIndex=log.logIndex;x.message=null;saveBatch(x);poolPendingUsdc=0n;return;}}
      if(x.state==="confirming"){x.state="bridging";x.observedDestinationHash=null;x.observedUsdc=null;x.message="NFT pool batch observation was reorganized; rechecking its original bridge.";saveBatch(x);}
    }
  }

  async function processInvoice(x) {
    // Missing chain means a legacy Ethereum invoice. Never migrate paid or
    // already-issued instructions by changing the new-invoice default.
    const network=deliveryNetwork(x.destinationChainId);
    const initiativeId=x.initiativeId??"burundi", recipient=chogBeneficiary(initiativeId,network.id);
    const wallet=root.deriveChild(x.index);
    if(!same(wallet.address,x.depositAddress))throw new Error("Invoice address derivation mismatch.");
    if(x.state==="awaiting-payment" || x.state==="expired") {
      const final=await source.getBlock({blockTag:"finalized"});
      const from=BigInt(x.cursor)+1n, end=from+1999n<final.number?from+1999n:final.number;
      if(from>end)return;
      const logs=await source.getContractEvents({address:CHOG,abi:erc20Abi,eventName:"Transfer",args:{to:x.depositAddress},fromBlock:from,toBlock:end,strict:true});
      if(logs.length) {
        if(logs.length!==1) {x.state="manual-review";x.message="Multiple deposits detected. Operator review required.";save(x);return;}
        const l=logs[0];
        try { const proof=await verifyChogDeposit(source,{kind:"chog-donation",state:"awaiting-payment",id:x.id,depositAddress:x.depositAddress,amountUnits:BigInt(x.units),createdBlock:BigInt(x.createdBlock),expiresAt:x.expiresAt},l.transactionHash,l.logIndex);x.depositProof=proof; }
        catch {x.state="manual-review";x.message="Deposit amount or time differs from the invoice. Do not pay again.";save(x);return;}
        x.depositHash=l.transactionHash;x.state="processing";x.processingStartedAt=Date.now();x.message=null;save(x);
      } else {x.cursor=String(end);if(Date.now()>x.expiresAt)x.state="expired";save(x);return;}
    }
    if(x.state==="processing") {
      if(initiativeId==="animal-ethics" && network.id!==SOLANA_CHAIN_ID) {
        // Preserve historical Ethereum invoices on their original immutable
        // recipient. Only newly issued native-SOL invoices can auto-settle.
        x.state="manual-review";x.message="This historical recipient requires operator review. Your original payment is preserved; do not pay again.";save(x);return;
      }
      if(!x.sale) {x.sale=await quoteSale(source,BigInt(x.units));save(x);}
      if(!await send(x,"gas",root,async()=>({to:x.depositAddress,value:GAS_GRANT,data:"0x"})))return;
      if(!await send(x,"approve-chog",wallet,async()=>approve(CHOG,x.sale.router,BigInt(x.units))))return;
      const sold=await send(x,"sell",wallet,async()=>({to:x.sale.router,value:0n,data:encodeFunctionData({abi:sellAbi,functionName:"sell",args:[{amountIn:BigInt(x.units),amountOutMin:BigInt(x.sale.minMon),token:CHOG,to:x.depositAddress,deadline:BigInt(Math.floor(Date.now()/1000)+300)}]})}));
      if(!sold)return;
      if(!x.monToSwap) {
        const approval=await confirmedSource(journal.get(x.id,"approve-chog").hash);
        const operatorRemaining=GAS_GRANT-approval.receipt.gasUsed*approval.receipt.effectiveGasPrice-sold.gasUsed*sold.effectiveGasPrice;
        const balance=await source.getBalance({address:x.depositAddress,blockNumber:sold.blockNumber});
        const proceeds=balance-operatorRemaining;
        if(proceeds<BigInt(x.sale.minMon)||operatorRemaining<0n)throw new Error("Sale proceeds do not reconcile.");
        x.monToSwap=String(proceeds);save(x);
      }
      if(!x.swap) {x.swap=await quoteSwap(source,BigInt(x.monToSwap));if(BigInt(x.swap.minUsdc)<BigInt(x.minimumTotalUsdc??x.minimumUsd??x.minOutput))throw new Error("Market moved below invoice minimum; awaiting recovery.");save(x);}
      const swapped=await send(x,"swap",wallet,async()=>({to:UNISWAP_ROUTER,value:BigInt(x.monToSwap),data:encodeFunctionData({abi:swapRouterAbi,functionName:"exactInputSingle",args:[{tokenIn:WMON,tokenOut:MONAD_USDC,fee:x.swap.fee,recipient:x.depositAddress,amountIn:BigInt(x.monToSwap),amountOutMinimum:BigInt(x.swap.minUsdc),sqrtPriceLimitX96:0n}]})}));
      if(!swapped)return;
      if(!x.usdcToBridge) {
        const settlement=await source.readContract({address:MONAD_USDC,abi:erc20Abi,functionName:"balanceOf",args:[x.depositAddress],blockNumber:swapped.blockNumber});
        if(x.contributionPercent===10){
          const split=splitSettlementUnits(settlement);
          x.usdcToBridge=String(split.causeUnits);x.poolContributionUsdc=String(split.poolUnits);
          if(split.causeUnits<BigInt(x.minimumCauseSourceUsdc))throw new Error("Market moved below the cause allocation minimum; awaiting recovery.");
        }else x.usdcToBridge=String(settlement);
        save(x);
      }
      if(x.contributionPercent===10 && !journal.get(x.id,"pool-contribution")) {
        const collected=await send(x,"pool-contribution",wallet,async()=>({to:MONAD_USDC,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[poolCollector.address,BigInt(x.poolContributionUsdc)]})}));
        if(!collected)return;
        atomic(db,()=>{const hash=journal.get(x.id,"pool-contribution").hash,old=db.prepare("SELECT * FROM pool_contributions WHERE invoice_id=?").get(x.id);
          if(old&&(old.units!==x.poolContributionUsdc||!same(old.source_hash,hash)))throw new Error("Pool contribution accounting conflict.");
          if(!old)db.prepare("INSERT INTO pool_contributions VALUES (?,?,?)").run(x.id,x.poolContributionUsdc,hash);});
      }
      if(!await send(x,"approve-usdc",wallet,async()=>approve(MONAD_USDC,RELAY_DEPOSITORY,BigInt(x.usdcToBridge))))return;
      const bridged=await send(x,"bridge",wallet,async()=>{
        x.bridge=await quoteBridge(x.depositAddress,BigInt(x.usdcToBridge),network.kind==="solana"?1n:BigInt(x.minOutput),network.id,initiativeId);
        if(network.kind==="solana")assertCrossAssetBridgeDelivery(x.bridge,BigInt(x.minimumUsd));
        save(x);
        return {to:x.bridge.to,data:x.bridge.data,value:0n};
      });
      if(!bridged)return;
      x.state="bridging";x.message=null;save(x);
    }
    if(x.state==="bridging" || x.state==="confirming") {
      // Once an actual transfer is observed, Relay availability must not block
      // finality checks. A reorg clears the observation and returns to discovery.
      const destinationHashPattern=network.kind==="solana"?solanaSignaturePattern:hashPattern;
      let candidates=x.state==="confirming"&&destinationHashPattern.test(x.observedDestinationHash)?[x.observedDestinationHash]:null;
      if(!candidates){
        const status=await getRelay(`/intents/status/v3?requestId=${x.bridge.requestId}`);
        if(status.originChainId!==143 || status.destinationChainId!==network.id || !Array.isArray(status.inTxHashes) || !status.inTxHashes.some(h=>same(h,journal.get(x.id,"bridge").hash)))return;
        if(["refund","failure"].includes(status.status)) {x.state="manual-review";x.message="Bridge needs recovery. No second payment will be sent.";save(x);return;}
        x.message=status.status==="delayed"?"Relay reports a delay. Tracking your original payment; do not pay again.":null;save(x);
        if(!["submitted","success"].includes(status.status) || !Array.isArray(status.txHashes))return;
        candidates=status.txHashes.slice(0,10);
      }
      if(network.kind==="solana"){
        for(const signature of candidates){
          if(!solanaSignaturePattern.test(signature))continue;
          const observation=await solana.inspectNativeTransfer(signature,recipient,BigInt(x.bridge.minOutput));
          if(!observation)continue;
          atomic(db,()=>{db.prepare("INSERT INTO delivered_events VALUES (?,?)").run(observation.eventId,x.id);
            x.state="delivered";x.destinationHash=signature;x.deliveredUsdc=String(observation.amount);x.message="Native SOL delivery confirmed on Solana.";save(x);});return;
        }
        return;
      }
      for(const hash of candidates) {
        if(!hashPattern.test(hash))continue;
        let observation;
        try{observation=await inspectReceipt(destinationClient(network.id),network.id,hash);}catch(error){
          if(error.name!=="TransactionReceiptNotFoundError" && !(error instanceof NonCanonicalReceiptError))throw error;
          continue;
        }
        const {receipt}=observation;
        for(const log of receipt.logs) {
          if(!same(log.address,network.usdc) || log.removed || !same(log.transactionHash,hash) || !same(log.blockHash,receipt.blockHash) || log.blockNumber!==receipt.blockNumber)continue;
          let event;try {event=decodeEventLog({abi:erc20Abi,eventName:"Transfer",topics:log.topics,data:log.data,strict:true});}catch{continue;}
          if(!same(event.args.to,recipient)||event.args.value<BigInt(x.bridge.minOutput)||!Number.isSafeInteger(log.logIndex)||log.logIndex<0)continue;
          if(!observation.finalized){
            x.state="confirming";x.observedDestinationHash=hash;x.observedUsdc=String(event.args.value);
            x.destinationIncludedAt=Number(observation.block.timestamp)*1000;
            x.message=null;save(x);return;
          }
          atomic(db,()=>{db.prepare("INSERT INTO delivered_events VALUES (?,?)").run(`${network.id}:${hash.toLowerCase()}:${log.logIndex}`,x.id);
            x.state="delivered";x.destinationHash=hash;x.deliveredUsdc=String(event.args.value);x.message=`USDC delivery confirmed on ${network.name}.`;save(x);});return;
        }
      }
      if(x.state==="confirming"){
        x.state="bridging";x.observedDestinationHash=null;x.observedUsdc=null;x.destinationIncludedAt=null;
        x.message="The previously observed transfer is no longer verified in the canonical chain. Rechecking the original bridge; do not pay again.";save(x);
      }
    }
  }
  async function publicChogRate(){
    if(closed)throw new Error("Payment worker is closed.");
    if(rateCache&&Date.now()-rateCache.quotedAt<30_000)return rateCache;
    if(rateRequest)return rateRequest;
    rateRequest=(async()=>{
      const referenceUnits=300n*10n**18n;
      const sale=await quoteSale(source,referenceUnits),swap=await quoteSwap(source,BigInt(sale.minMon));
      // Both internal quote stages reserve 1% slippage. Reverse only those
      // display haircuts; invoice minimums still use the conservative values.
      const estimatedUsdMicros=BigInt(swap.minUsdc)*10_000n/9_801n;
      if(estimatedUsdMicros<=0n||estimatedUsdMicros>1_000_000_000n)throw new Error("CHOG quote outside display bounds.");
      rateCache={referenceChog:"300",estimatedUsdMicros:String(estimatedUsdMicros),quotedAt:Date.now()};return rateCache;
    })();
    try{return await rateRequest;}finally{rateRequest=null;}
  }
  async function profileNfts(id){
    if(closed||typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id))throw new Error("A received CHOG donation is required.");
    if(nftProfileRequests.has(id))return nftProfileRequests.get(id);
    if(nftProfileRequests.size>=NFT_PROFILE_REQUEST_LIMIT)throw new Error("NFT profile lookup is busy. Try again shortly.");
    const request=(async()=>{
      const x=load(id),donation=verifiedLeaderboardDonation(x,id);
      if(!donation)throw new Error("A received CHOG donation is required.");
      const tokenIds=await source.readContract({address:PAYMENT_POLICY.nftCollection,abi:profileNftAbi,functionName:"tokensOfOwner",args:[donation.sender]});
      if(!Array.isArray(tokenIds)||tokenIds.length>1969||tokenIds.some(token=>typeof token!=="bigint"||token<0n||token>=2n**256n))throw new Error("Invalid NFT lookup response.");
      const unique=[...new Set(tokenIds.map(String))].slice(0,24);
      const nfts=await Promise.all(unique.map(async tokenId=>{
        const cached=nftMetadataCache.get(tokenId);
        if(cached&&cached.expiresAt>Date.now())return cached.result;
        nftMetadataCache.delete(tokenId);
        if(nftMetadataRequests.has(tokenId))return nftMetadataRequests.get(tokenId);
        const metadataRequest=(async()=>{
          let result={tokenId,name:`CHOG #${tokenId}`,image:null},valid=false;
          try{
            const metadataUri=await source.readContract({address:PAYMENT_POLICY.nftCollection,abi:profileNftAbi,functionName:"tokenURI",args:[BigInt(tokenId)]});
            const metadata=await fetchProfileMetadata(metadataUri,dependencies.metadataFetch??fetch);
            if(metadata){result={tokenId,name:typeof metadata.name==="string"&&metadata.name.length<=80?metadata.name:`CHOG #${tokenId}`,image:ipfsGateway(metadata.image)};valid=true;}
          }catch{/* Ownership is still shown with a local collection fallback. */}
          if(nftMetadataCache.size>=NFT_METADATA_CACHE_LIMIT)nftMetadataCache.delete(nftMetadataCache.keys().next().value);
          nftMetadataCache.set(tokenId,{result,expiresAt:Date.now()+(valid?600_000:30_000)});return result;
        })();
        nftMetadataRequests.set(tokenId,metadataRequest);
        try{return await metadataRequest;}finally{nftMetadataRequests.delete(tokenId);}
      }));
      return {invoiceId:x.id,state:x.state,initiativeId:x.initiativeId,amount:x.donationAmount??x.amount,nfts};
    })();
    nftProfileRequests.set(id,request);
    try{return await request;}finally{nftProfileRequests.delete(id);}
  }
  return {
    publicChogRate,
    profileNfts,
    leaderboardDonation(id){return closed||!/^[a-f0-9]{64}$/.test(id??"")?null:verifiedLeaderboardDonation(load(id),id);},
    publicStatus(){return {paymentsEnabled:!closed&&Date.now()-healthyAt<60_000&&gasBalance>=OPERATOR_READY_BALANCE,paymentMode:"local-pilot",workerVersion:"2026-10-11-pending-profile-v6",destinationChainId:newDestinationChainId,supportedModes:["chog"],supportedInitiatives:[...CHOG_INITIATIVES],poolContributionPercent:10,poolContributionMode:"added-on-top",poolContributionBatchMinimumUsdc:"5.00",poolContributionPendingUsdc:formatUnits(poolPendingUsdc,6)};},
    canRetryUnissuedChog(id){return !closed && /^[a-f0-9]{64}$/.test(id) && !load(id) && !db.prepare("SELECT 1 FROM deposit_addresses WHERE invoice_id=?").get(id);},
    async issue(input, requestId) {
      if(requestId!==undefined && !/^[a-f0-9]{64}$/.test(requestId))throw new Error("Invalid internal request ID.");
      if(requestId) {
        const existing=load(requestId);
        if(existing) {
          if(input.mode!=="chog" || input.initiativeId!==(existing.initiativeId??"burundi") || input.amount!==(existing.donationAmount??existing.amount))throw new Error("Existing invoice terms cannot change.");
          return publicInvoice(existing);
        }
      }
      if(!this.publicStatus().paymentsEnabled)throw new Error("Payment worker is locked, offline or needs MON for gas.");
      if(input.mode!=="chog"||!acceptsNewChog(input.initiativeId)||typeof input.amount!=="string"||!/^\d{1,7}(\.\d{1,18})?$/.test(input.amount))throw new Error("Unsupported CHOG donation.");
      const invoiceChain=initiativeChain(input.initiativeId,newDestinationChainId);
      chogBeneficiary(input.initiativeId,invoiceChain);
      if(invoiceChain===SOLANA_CHAIN_ID ? !await solana.ready() : await destinationClient(invoiceChain).getChainId()!==invoiceChain)throw new Error("Destination RPC mismatch.");
      const donationUnits=parseUnits(input.amount,18);
      if(donationUnits<300n*10n**18n||donationUnits>1_000_000n*10n**18n)throw new Error("Donation outside pilot limits.");
      const allocation=contributionForDonationUnits(donationUnits),units=allocation.totalUnits;
      const sale=await quoteSale(source,units), swap=await quoteSwap(source,BigInt(sale.minMon));
      const sourceSplit=splitSettlementUnits(BigInt(swap.minUsdc));
      const requiredDelivery=minimumBridgeDelivery(sourceSplit.causeUnits,CHOG_DONATION_MAX_BRIDGE_LOSS_BPS);
      const estimate=await quoteBridge(root.address,sourceSplit.causeUnits,invoiceChain===SOLANA_CHAIN_ID?1n:200_000n,invoiceChain,input.initiativeId);
      if(invoiceChain===SOLANA_CHAIN_ID)assertCrossAssetBridgeDelivery(estimate,requiredDelivery);else assertBridgeDelivery(estimate,requiredDelivery);
      if(db.prepare("SELECT COUNT(*) AS n FROM chog_invoices WHERE state IN ('awaiting-payment','processing','bridging','confirming')").get().n>=3)throw new Error("Three payments are already active. Please wait.");
      const id=requestId??randomBytes(32).toString("hex"), addressAllocation=allocator.allocate(id), created=await source.getBlock({blockTag:"finalized"});
      const x={id,initiativeId:input.initiativeId,index:addressAllocation.derivation_index,depositAddress:addressAllocation.address,
        amount:formatUnits(units,18),donationAmount:formatUnits(donationUnits,18),poolContributionAmount:formatUnits(allocation.contributionUnits,18),contributionPercent:10,poolCollector:poolCollector.address,
        units:String(units),minimumTotalUsdc:swap.minUsdc,minimumCauseSourceUsdc:String(sourceSplit.causeUnits),minOutput:estimate.minOutput,minimumUsd:invoiceChain===SOLANA_CHAIN_ID?estimate.minimumOutputUsdMicros:estimate.minOutput,
        createdBlock:String(created.number),cursor:String(created.number),expiresAt:Date.now()+20*60_000,state:"awaiting-payment",destinationChainId:invoiceChain,bridgeEstimatedSeconds:estimate.estimatedSeconds??null};
      atomic(db,()=>{
        if(db.prepare("SELECT COUNT(*) AS n FROM chog_invoices WHERE state IN ('awaiting-payment','processing','bridging','confirming')").get().n>=3)throw new Error("Payment slots are full.");
        if(db.prepare("SELECT COUNT(*) AS n FROM chog_invoices").get().n>=1000)throw new Error("Pilot invoice storage limit reached.");
        db.prepare("INSERT INTO chog_invoices VALUES (?,?,?)").run(id,x.state,JSON.stringify(x));
      });return publicInvoice(x);
    },
    get(id){if(!/^[a-f0-9]{64}$/.test(id))return null;const x=load(id);return x?publicInvoice(x):null;},
    async tick() {
      if(running||closed)return;running=true;
      try {
        const [sourceChain,destinationChain]=await Promise.all([source.getChainId(),destinationClient(newDestinationChainId).getChainId()]);
        if(sourceChain!==143||destinationChain!==newDestinationChainId)throw new Error("RPC chain mismatch.");
        gasBalance=await source.getBalance({address:root.address});healthyAt=Date.now();
        const invoices=db.prepare("SELECT document FROM chog_invoices WHERE state IN ('awaiting-payment','processing','bridging','confirming') ORDER BY rowid").all();
        // Continue observing expired addresses, rotating one per tick. Expired
        // invoices never block active orders, and late deposits remain reviewable.
        const expired=db.prepare("SELECT id,document FROM chog_invoices WHERE state='expired' AND id>? ORDER BY id LIMIT 1").get(expiredCursor);
        if(expired){expiredCursor=expired.id;invoices.push(expired);}else expiredCursor="";
        const safelyProcess=async x=>{try {await processInvoice(x);}catch(error) {
          x.message=error instanceof AwaitingFinalityError?"Transaction included on Monad. Waiting for source finality before continuing; no further payment is needed.":x.state==="confirming"?"A destination transfer was observed. Network verification is temporarily unavailable; final delivery is not confirmed yet. Do not pay again.":"Processing paused while the network or route is checked. Do not pay again.";save(x);
        }};
        const pending=invoices.map(row=>JSON.parse(row.document));
        // Read-only destination checks are independent of the source signer.
        // A slow bridge must not hold up another payment's exchange (or finality).
        // Keep ALL source work serialized: child funding shares the root nonce.
        const tracking=pending.filter(x=>["bridging","confirming"].includes(x.state));
        const sourceWork=pending.filter(x=>!["bridging","confirming"].includes(x.state));
        await Promise.all([
          ...tracking.map(safelyProcess),
          (async()=>{for(const x of sourceWork)await safelyProcess(x);})(),
        ]);
        // Batch only after all invoice source work completes: operator funding
        // and collector transactions must never race for a shared signer nonce.
        try{await processContributionBatch();}catch{const batch=activeBatch();if(batch&&batch.state!=="manual-review"){batch.message="NFT pool batching is paused. Contributions remain in the dedicated collector and the original batch will retry.";saveBatch(batch);}}
      } catch(error) {healthyAt=0;throw error;} finally {running=false;}
    },
    async close(){closed=true;while(running)await new Promise(r=>setTimeout(r,50));db.close();},
    operatorAddress:root.address,
  };
}

import { keccak256 as keccakRaw } from "viem";
