import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { unlockCustodyVault } from "../server/custody-vault.mjs";
import { hiddenPassword } from "./terminal-password.mjs";
import { createChogProcessor } from "../server/chog-processor.mjs";
import { createPaymentService } from "../server/payment-service.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createNftProcessor } from "../server/nft-processor.mjs";
import { NFT_POOL_FUNDERS } from "../server/nft-pool-config.mjs";
import { openPaymentIntegrity, PaymentIntegrityError } from "../server/payment-integrity.mjs";
import { acquireOperatorLease } from "../server/operator-lease.mjs";
import { createOperationsRuntime } from "../server/operations-runtime.mjs";
import { openReadOnlyImpactSource } from "../server/ops-dashboard.mjs";
import { createBackupProtection, createPaymentBackup, verifyRecoveryBundle } from "../server/payment-backup.mjs";

// Fixed local diagnostics only. Never forward a caught error, RPC payload,
// password, keystore or signed transaction into the desktop activity log.
export const PAYMENT_STARTUP_FAILURES = Object.freeze({
  "startup-vault-read": "Could not read the existing custody backup. No keys were unlocked. Preserve the backup file.",
  "startup-vault-unlock": "Custody backup could not be unlocked or its branch did not match. Check the existing custody password locally; never recreate the vault.",
  "startup-chog-init": "Custody unlocked, but CHOG storage or pinned route initialization failed. Preserve the databases; do not reset integrity.",
  "startup-nft-init": "Custody unlocked, but NFT accounting initialization failed. Preserve the existing pool records.",
  "startup-nft-readiness": "Initial NFT funding/network verification failed. No new payments were enabled; keep existing invoices.",
  "startup-operations-init": "Custody unlocked, but local operations storage or permissions initialization failed. No new payments were enabled; preserve existing records.",
});

// The CLI and the private desktop IPC bootstrap share exactly this startup.
// Neither path bypasses the operator lease, integrity baseline or custody vault.
export async function startPaymentWorker({ passwordProvider = hiddenPassword, onEvent = () => {}, registerStop = () => {}, serviceOptions, optionsFactory } = {}, dependencies = {}) {
const acquireLease = dependencies.acquireOperatorLease ?? acquireOperatorLease;
const netServer = dependencies.createServer ?? createServer;
const openIntegrity = dependencies.openPaymentIntegrity ?? openPaymentIntegrity;
const read = dependencies.readFile ?? readFile;
const unlock = dependencies.unlockCustodyVault ?? unlockCustodyVault;
const chogFactory = dependencies.createChogProcessor ?? createChogProcessor;
const nftFactory = dependencies.createNftProcessor ?? createNftProcessor;
const invoiceStore = dependencies.openInvoiceStore ?? openInvoiceStore;
const paymentService = dependencies.createPaymentService ?? createPaymentService;
const schedule = dependencies.setInterval ?? setInterval;
const cancelTimer = dependencies.clearInterval ?? clearInterval;
const protectBackup = dependencies.createBackupProtection ?? createBackupProtection;
const backup = dependencies.createPaymentBackup ?? createPaymentBackup;
const verifyBackup = dependencies.verifyRecoveryBundle ?? verifyRecoveryBundle;
let processor, nftProcessor, api, store, timer, integrity, lease, operations, impactSource, stopping = false, cleanupPromise;
let backupProtection, lastBackupAttempt = 0, lastBackupAt = 0, backupVerified = false;
const snapshot = () => {
  if (!backupProtection || integrity?.locked || integrityFault) return null;
  lastBackupAttempt = Date.now();
  try {
    const result = backup(resolve("work/payments"), backupProtection);
    lastBackupAt = Date.now(); emit("backup-saved"); return result;
  } catch { emit("backup-failed", "warning"); return null; }
};
let nftInitialized = false, integrityFault = false;
const tickRunning = { chog: false, tracking: false, nft: false };
let failureCode;
let finishStartup;
const startupDone = new Promise(ok => { finishStartup = ok; });
const emit = (code, level = "info") => { try { onEvent({ code, level }); } catch { /* UI observers never control payment safety. */ } };
const assertActive = () => { if (stopping) throw Object.assign(new Error("Startup cancelled."), { code: "ADMIN_CANCELLED" }); };
const cleanup = () => cleanupPromise ??= (async () => {
  cancelTimer(timer);
  if (api) await new Promise(ok => api.close(ok));
  try {
    await Promise.all([processor?.close(), nftProcessor?.close()]);
    store?.close();
    if (integrity && (processor || nftProcessor)) {
      try { integrity.checkpoint(); } catch { emit("integrity-locked", "error"); }
    }
    if (processor || nftProcessor) snapshot();
  } finally { backupProtection?.close(); operations?.close(); impactSource?.close(); await lease?.close(); }
  emit("stopped");
})();
const stop = async () => { stopping = true; cancelTimer(timer); await startupDone; await cleanup(); };
registerStop(stop);
try {
  const publicOrigin=(process.env.CHOGCARE_PUBLIC_ORIGIN?.trim()||"https://chogcare.xyz");
  if(!new Set(["https://chogcare.xyz","https://chogcare.vercel.app","https://chogcare.com","https://www.chogcare.com","http://127.0.0.1:4173"]).has(publicOrigin))throw new Error("Payment site origin is not approved.");
  lease=await acquireLease(); assertActive();
  // Fail before asking for a password if another process occupies the API port.
  const probe=netServer();
  await new Promise((ok,bad)=>{probe.once("error",bad);probe.listen(4174,"127.0.0.1",ok);});
  await new Promise(ok=>probe.close(ok));
  assertActive();
  console.log("ChogCare LOCAL MAINNET PILOT: CHOG -> USDC on Optimism for Giveth projects; CHOG -> native SOL on Solana for Animal Ethics.");
  console.log("Existing invoices keep their original destination. Arrival and finality are tracked separately.");
  console.log("Donation amount: 300-1,000,000 CHOG. Each new invoice adds exactly 10% on top for the NFT community pool and shows the full total before QR.");
  console.log("Pool contributions consolidate on Monad and bridge to the pinned Optimism treasury in batches from 5 USDC.");
  console.log("Limits: 3 active invoices, 20 operator gas grants/day across donations and pool batches.");
  console.log("NFT claims require funded Optimism USDC and ETH gas. Standard allowance: $1 per wallet/NFT/UTC day; the approved repeat holder shares the same 3-grant and $3/day maximum. Existing invoices keep their original amount.");
  console.log("No independent production audit has been completed. Local single-operator pilot only.");
  // Compare before schema initialisation or key unlock. Enrolment is a separate,
  // explicit offline owner action, never an automatic baseline reset.
  integrity=openIntegrity(resolve("work/payments/processor.sqlite"),resolve("work/payments/integrity/checkpoint.json"),[resolve("work/payments/preview.sqlite")]);
  const checkpoint=()=>integrity.checkpoint();
  failureCode="startup-vault-read";
  const vault=JSON.parse(await read(resolve("work/payments/custody/vault.json"),"utf8"));
  assertActive();
  // A GUI password is requested only now, over inherited one-use IPC, not via
  // argv, environment, an HTTP endpoint, a file, or redirected terminal input.
  let password;
  let root;
  failureCode="startup-vault-unlock";
  try {
    password=await passwordProvider("Unlock dedicated custody backup (hidden): "); assertActive(); root=await unlock(vault,password); assertActive();
    // Recovery is best-effort, never a new kill switch for paid invoices.
    // Password stays local and is discarded immediately after this offline drill.
    try {
      backupProtection=protectBackup(password);
      const saved=snapshot();
      if(saved){
        const result=verifyBackup(await read(saved.output),password,resolve("work/payments/backups"));
        backupVerified=result?.verified===true;
        emit(backupVerified?"backup-verified":"backup-failed",backupVerified?"info":"warning");
      }
    } catch { emit("backup-failed", "warning"); }
  }
  finally { password=""; }
  assertActive();
  failureCode="startup-chog-init";
  processor=chogFactory({filename:resolve("work/payments/processor.sqlite"),vault,root,checkpoint});
  failureCode="startup-nft-init";
  nftProcessor=nftFactory({filename:resolve("work/payments/processor.sqlite"),vault,root,checkpoint});
  failureCode=undefined;
  checkpoint();
  console.log(`OPERATOR GAS ADDRESS (Monad / MON only): ${processor.operatorAddress}`);
  console.log("New invoices need at least 1.75 MON here (1.5 MON capped source budget + funding margin). Legacy invoices preserve their original 5 MON budget.");
  console.log("Do not send donor CHOG to this operator address. Each invoice gets its own address.");
  console.log("Payable QR codes become available only while this process is healthy and gas-funded.");
  store=invoiceStore(resolve("work/payments/preview.sqlite"));
  const combined={
    publicStatus(){
      const chog=processor.publicStatus(),nft={...nftProcessor.publicStatus()};
      if(!nftInitialized){nft.nftPaymentsEnabled=false;nft.poolHealthy=false;delete nft.poolTreasury;}
      const locked=integrity.locked||integrityFault;
      return {...chog,...nft,supportedModes:["chog","nft"],...(locked?{paymentsEnabled:false,nftPaymentsEnabled:false,poolHealthy:false}:{}),integrityLocked:locked};
    },
    publicChogRate(){return processor.publicChogRate();},
    profileNfts(id){return processor.profileNfts(id);},
    leaderboardDonation(id){return stopping||integrity.locked||integrityFault?null:processor.leaderboardDonation(id);},
    nftPoolImpact(){return stopping||integrity.locked||integrityFault?null:nftProcessor.nftPoolImpact?.()??null;},
    async preflightNft(input){
      if(stopping || integrity.locked || integrityFault)throw new PaymentIntegrityError();
      if(!nftInitialized)throw new Error("NFT funding verification is not ready. No payment was started.");
      await nftProcessor.preflight(input);
      if(stopping || integrity.locked || integrityFault)throw new PaymentIntegrityError();
    },
    async issue(input,requestId){
      if(stopping || integrity.locked || integrityFault)throw new PaymentIntegrityError();
      if(input.mode==="nft"&&!nftInitialized)throw new Error("NFT funding verification is not ready. No payment was started.");
      try {return await (input.mode==="nft"?nftProcessor.issue(input,requestId):processor.issue(input,requestId));}
      finally {checkpoint();} // Persist the address/state BEFORE returning a QR.
    },
      get(id){return nftProcessor.get(id)??processor.get(id);},
      cancelUnpaidChog(id){if(stopping||integrity.locked||integrityFault)throw new PaymentIntegrityError();try{return processor.cancelUnpaidChog(id);}finally{checkpoint();}},
      canRetryUnissuedNft(id){return !stopping&&!integrity.locked&&!integrityFault&&nftProcessor.canRetryUnissuedNft(id);},
      canRetryUnissuedChog(id){return !stopping&&!integrity.locked&&!integrityFault&&processor.canRetryUnissuedChog(id);},
    checkpoint,
  };
  // NFT readiness is independent of CHOG readiness. An RPC/funding-check failure
  // must not destroy a successfully unlocked worker. NFT's own health, budget,
  // gas and receipt checks remain closed; retries never synthesize funding.
  const checkNft = async () => {
    try {
      await nftProcessor.tick();
      if(!nftInitialized&&nftProcessor.publicStatus().poolHealthy===true){
        // Persist the funding cursor before advertising any treasury address.
        checkpoint();
        nftInitialized=true;
        console.log(`NFT POOL TREASURY (Optimism / chain 10): ${nftProcessor.treasuryAddress}`);
        console.log(`USDC funder allowlist: ${NFT_POOL_FUNDERS.join(", ")}`);
        console.log("Fund with native USDC (not USDC.e) for donations and at least 0.001 ETH for gas, both on Optimism.");
        console.log("The 1 MON verification donation stays in its dedicated Monad custody address. No automatic forwarding or refund.");
      }
    } catch(error) {
      if(error instanceof PaymentIntegrityError)throw error;
      console.log("NFT pool readiness check failed; retrying. NFT payments stay gated.");
      emit("nft-network", "warning");
    }
  };
  failureCode="startup-nft-readiness";
  await checkNft();
  failureCode=undefined;
  assertActive();
  checkpoint();
  failureCode="startup-operations-init";
  if (!optionsFactory && serviceOptions === undefined) {
    impactSource = (dependencies.openReadOnlyImpactSource ?? openReadOnlyImpactSource)(resolve("work/payments/processor.sqlite"));
    operations = (dependencies.createOperationsRuntime ?? createOperationsRuntime)({ workspacePath: process.cwd(), status: () => combined.publicStatus(), impact: () => impactSource.summary() });
  }
  api=paymentService(store,publicOrigin,true,combined,optionsFactory ? await optionsFactory({ combined, store }) : serviceOptions ?? operations.options);
  failureCode=undefined;
  assertActive();
  await new Promise((ok,bad)=>{api.once("error",bad);api.listen(4174,"127.0.0.1",ok);});
  // Each processor remains serialized for its own signer. A slow CHOG RPC or
  // route must not hold NFT detection/finality checks behind the shared loop.
  // The signers use disjoint branches; integrity faults still gate both modes.
  const tick=async(mode,check)=>{if(stopping || integrity.locked || integrityFault || tickRunning[mode])return;tickRunning[mode]=true;try {await check();}catch{integrityFault=true;emit("integrity-locked","error");}finally{try{checkpoint();}catch{integrityFault=true;console.error("Payment integrity locked. New QR codes and broadcasts disabled; preserve the database and checkpoint.");emit("integrity-locked", "error");}finally{tickRunning[mode]=false;}}};
  const tickChog=()=>tick("chog",()=>processor.tick().catch(error=>{if(error instanceof PaymentIntegrityError)throw error;console.log("CHOG network readiness check failed; retrying.");emit("chog-network", "warning");}));
  const tickNft=()=>tick("nft",checkNft);
  const tickTracking=()=>tick("tracking",()=>processor.track?.());
  let readinessRunning=false,lastReadiness=0;
  const refreshReadiness=async()=>{
    if(stopping||integrity.locked||integrityFault||readinessRunning)return;
    readinessRunning=true;
    try {await Promise.all([["chog",processor],["nft",nftProcessor]].map(async([mode,worker])=>{
      try {await worker.refreshReadiness?.();}
      catch(error){if(error instanceof PaymentIntegrityError){integrityFault=true;emit("integrity-locked","error");}else emit(`${mode}-network`,"warning");}
    }));}finally{readinessRunning=false;}
  };
  await Promise.all([tickChog(),tickNft()]); assertActive(); timer=schedule(()=>{
    // Snapshot only between worker ticks, once per hour. SQLite snapshots include
    // committed WAL data; snapshot itself is synchronous across both databases.
    if(!stopping&&!Object.values(tickRunning).some(Boolean)&&Date.now()-lastBackupAttempt>=3_600_000)snapshot();
    void tickChog();void tickNft();void tickTracking();
    // A live read-only probe keeps the original 60-second health TTL fresh
    // even while a long transfer owns its signer. Never keep stale health by
    // extending that TTL or synthesizing funds; actual RPC failures still gate.
    if(Date.now()-lastReadiness>=5000){lastReadiness=Date.now();void refreshReadiness();}
  },1000);
  console.log("Payment API: http://127.0.0.1:4174. Keep this terminal running.");
  emit("ready");
  // Private, in-process numeric diagnostics only; not part of public config or
  // HTTP. Reading this does not unlock custody or trigger any chain operation.
  return { close: stop, diagnostics: () => ({ chog: processor.diagnostics?.() ?? {}, nft: nftProcessor.diagnostics?.() ?? {}, backup: { lastBackupAt, verifiedAtStartup: backupVerified } }) };
} catch(error) {
  if (failureCode && error?.code !== "ADMIN_CANCELLED" && error?.code !== "EADDRINUSE" && !(error instanceof PaymentIntegrityError)) emit(failureCode, "error");
  stopping = true;
  await cleanup();
  if (error?.code === "ADMIN_CANCELLED") return null;
  emit(error instanceof PaymentIntegrityError ? "integrity-locked" : error?.code === "EADDRINUSE" ? "busy" : "startup-failed", "error");
  throw error;
} finally { finishStartup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startPaymentWorker({ onEvent(event) { if (Object.hasOwn(PAYMENT_STARTUP_FAILURES,event.code)) console.error(PAYMENT_STARTUP_FAILURES[event.code]); }, registerStop(stop) { process.once("SIGINT", () => { void stop().catch(() => { process.exitCode=1; }); }); process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode=1; }); }); } }).catch(error => {
  console.error(error instanceof PaymentIntegrityError?"Payment integrity check blocked startup. First installation: stop payments and run npm run payments:integrity:enroll ONCE. If a checkpoint already exists, do not delete or reset it; reconcile the database against chain history.":error.code==="EADDRINUSE"?"Payment API or operator lease is busy (4174 / 4175). Close the other payment/maintenance terminal before restarting.":"Payment startup failed. Check your backup/password and network. No new payments enabled.");
  process.exitCode=1;
  });
}
