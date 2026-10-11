import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { unlockCustodyVault } from "../server/custody-vault.mjs";
import { hiddenPassword } from "./terminal-password.mjs";
import { createChogProcessor } from "../server/chog-processor.mjs";
import { createPaymentService } from "../server/payment-service.mjs";
import { openInvoiceStore } from "../server/invoice-store.mjs";
import { createNftProcessor } from "../server/nft-processor.mjs";
import { NFT_POOL_FUNDERS } from "../server/nft-pool-config.mjs";
import { openPaymentIntegrity, PaymentIntegrityError } from "../server/payment-integrity.mjs";
import { acquireOperatorLease } from "../server/operator-lease.mjs";

// This owner-run process is the ONLY current way to enable the local CHOG pilot.
// Keys remain in RAM; a closed terminal stops processing. No production claim.
let processor, nftProcessor, api, store, timer, integrity, lease, stopping=false;
try {
  const publicOrigin=(process.env.CHOGCARE_PUBLIC_ORIGIN?.trim()||"https://chogcare.vercel.app");
  if(!["https://chogcare.vercel.app","https://chogcare.com","https://www.chogcare.com","http://127.0.0.1:4173"].includes(publicOrigin))throw new Error("Payment site origin is not approved.");
  lease=await acquireOperatorLease();
  // Fail before asking for a password if another process occupies the API port.
  const probe=createServer();
  await new Promise((ok,bad)=>{probe.once("error",bad);probe.listen(4174,"127.0.0.1",ok);});
  await new Promise(ok=>probe.close(ok));
  console.log("ChogCare LOCAL MAINNET PILOT: CHOG -> USDC on Optimism for Giveth projects; CHOG -> native SOL on Solana for Animal Ethics.");
  console.log("Existing invoices keep their original destination. Arrival and finality are tracked separately.");
  console.log("Donation amount: 300-1,000,000 CHOG. Each new invoice adds exactly 10% on top for the NFT community pool and shows the full total before QR.");
  console.log("Pool contributions consolidate on Monad and bridge to the pinned Optimism treasury in batches from 5 USDC.");
  console.log("Limits: 3 active invoices, 20 operator gas grants/day across donations and pool batches.");
  console.log("NFT claims require funded Optimism USDC and ETH gas. $1 per wallet/NFT/UTC day, 3 recipients and $3/day maximum. Existing invoices keep their original amount.");
  console.log("No independent production audit has been completed. Local single-operator pilot only.");
  // Compare before schema initialisation or key unlock. Enrolment is a separate,
  // explicit offline owner action, never an automatic baseline reset.
  integrity=openPaymentIntegrity(resolve("work/payments/processor.sqlite"),resolve("work/payments/integrity/checkpoint.json"),[resolve("work/payments/preview.sqlite")]);
  const checkpoint=()=>integrity.checkpoint();
  const vault=JSON.parse(await readFile(resolve("work/payments/custody/vault.json"),"utf8"));
  let password=await hiddenPassword("Unlock dedicated custody backup (hidden): ");
  const root=await unlockCustodyVault(vault,password);password="";
  processor=createChogProcessor({filename:resolve("work/payments/processor.sqlite"),vault,root,checkpoint});
  nftProcessor=createNftProcessor({filename:resolve("work/payments/processor.sqlite"),vault,root,checkpoint});
  checkpoint();
  console.log(`OPERATOR GAS ADDRESS (Monad / MON only): ${processor.operatorAddress}`);
  console.log("Keep at least 6 MON here for one payment (5 MON child funding + operator gas margin).");
  console.log("Do not send donor CHOG to this operator address. Each invoice gets its own address.");
  console.log("Payable QR codes become available only while this process is healthy and gas-funded.");
  store=openInvoiceStore(resolve("work/payments/preview.sqlite"));
  const combined={
    publicStatus(){const chog=processor.publicStatus(),nft=nftProcessor.publicStatus();return {...chog,...nft,supportedModes:["chog","nft"],...(integrity.locked?{paymentsEnabled:false,nftPaymentsEnabled:false,poolHealthy:false}:{}),integrityLocked:integrity.locked};},
    publicChogRate(){return processor.publicChogRate();},
    profileNfts(id){return processor.profileNfts(id);},
    async issue(input,requestId){
      if(stopping || integrity.locked)throw new PaymentIntegrityError();
      try {return await (input.mode==="nft"?nftProcessor.issue(input,requestId):processor.issue(input,requestId));}
      finally {checkpoint();} // Persist the address/state BEFORE returning a QR.
    },
      get(id){return nftProcessor.get(id)??processor.get(id);},
      canRetryUnissuedNft(id){return !stopping&&!integrity.locked&&nftProcessor.canRetryUnissuedNft(id);},
      canRetryUnissuedChog(id){return !stopping&&!integrity.locked&&processor.canRetryUnissuedChog(id);},
    checkpoint,
  };
  // Initialize the funding cursor before showing a treasury address or accepting requests.
  await nftProcessor.tick();
  checkpoint();
  console.log(`NFT POOL TREASURY (Optimism / chain 10): ${nftProcessor.treasuryAddress}`);
  console.log(`USDC funder allowlist: ${NFT_POOL_FUNDERS.join(", ")}`);
  console.log("Fund with native USDC (not USDC.e) for donations and at least 0.001 ETH for gas, both on Optimism.");
  console.log("The 1 MON verification donation stays in its dedicated Monad custody address. No automatic forwarding or refund.");
  api=createPaymentService(store,publicOrigin,true,combined);
  await new Promise((ok,bad)=>{api.once("error",bad);api.listen(4174,"127.0.0.1",ok);});
  const tick=async()=>{if(stopping || integrity.locked)return;try {await Promise.all([
    processor.tick().catch(()=>console.log("CHOG network readiness check failed; retrying.")),
    nftProcessor.tick().catch(()=>console.log("NFT pool readiness check failed; new NFT payments stay gated.")),
  ]);}finally{try{checkpoint();}catch{console.error("Payment integrity locked. New QR codes and broadcasts disabled; preserve the database and checkpoint.");}}};
  await tick();timer=setInterval(tick,1000);
  console.log("Payment API: http://127.0.0.1:4174. Keep this terminal running.");
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);await new Promise(ok=>api.close(ok));await Promise.all([processor.close(),nftProcessor.close()]);store.close();try{checkpoint();}catch{console.error("Checkpoint is locked; reconcile before restarting.");}await lease.close();process.exit(0);};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
} catch(error) {
  clearInterval(timer);api?.close();await Promise.all([processor?.close(),nftProcessor?.close()]);store?.close();
  await lease?.close();
  console.error(error instanceof PaymentIntegrityError?"Payment integrity check blocked startup. First installation: stop payments and run npm run payments:integrity:enroll ONCE. If a checkpoint already exists, do not delete or reset it; reconcile the database against chain history.":error.code==="EADDRINUSE"?"Payment API or operator lease is busy (4174 / 4175). Close the other payment/maintenance terminal before restarting.":"Payment startup failed. Check your backup/password and network. No new payments enabled.");
  process.exitCode=1;
}
