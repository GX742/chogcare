import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { CHOG, GIVETH_PROJECT_RECIPIENT } from "./route.ts";
import { deliveryNetwork } from "./delivery-network.ts";
import { chogBeneficiary } from "./chog-beneficiary.ts";
import { contributionForDonationUnits } from "./pool-contribution.ts";
import { validInvoiceId } from "./checkout-session.ts";
import { matchesInvoiceField as matches, pickInvoiceFields } from "./invoice-validation.ts";
export type PayableInvoice = {
  kind: "payment"; id: string; mode: "chog"; asset: "CHOG"; chainId: 143;
  amount: string; initiativeId: string; recipient: string; depositAddress: string;
  paymentUri: string; minUsdc: string; state: "awaiting-payment" | "processing" | "bridging" | "confirming" | "delivered" | "expired" | "manual-review";
  expiresAt: number; depositHash: string | null; bridgeHash: string | null; destinationHash: string | null; message: string | null;
  deliveredUsdc: string | null;
  observedDestinationHash?: string | null; observedUsdc?: string | null;
  processingStartedAt?: number | null; bridgeStartedAt?: number | null; destinationIncludedAt?: number | null;
  destinationChainId?: 1 | 10 | 792703809; destinationAsset?: "USDC" | "SOL"; destinationDecimals?: 6 | 9; minimumUsd?: string; bridgeEstimatedSeconds?: number | null;
  donationAmount?: string; poolContributionAmount?: string | null; contributionPercent?: 0 | 10; poolContributionState?: "pending" | "collected" | null;
};
const evmHash=/^0x[0-9a-f]{64}$/i,solanaSignature=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export function validatePayableInvoice(raw: unknown): PayableInvoice {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Payment instructions failed verification.");
  const x=raw as PayableInvoice;
  const network=x?deliveryNetwork(x.destinationChainId):null;
  const recipient=x&&network?chogBeneficiary(x.initiativeId,network.id):"";
  const sameRecipient=network?.kind==="solana"?x?.recipient===recipient:x?.recipient?.toLowerCase()===recipient.toLowerCase();
  const destinationHashValid=(hash:string|null|undefined)=>hash===null||hash===undefined||matches(hash,network?.kind==="solana"?solanaSignature:evmHash);
  if(!x || x.kind!=="payment" || !validInvoiceId(x.id) || x.chainId!==143 || x.mode!=="chog" || x.asset!=="CHOG" ||
    !sameRecipient || x.destinationAsset!==network?.asset || x.destinationDecimals!==network?.decimals ||
    !isAddress(x.depositAddress) || [zeroAddress,CHOG,GIVETH_PROJECT_RECIPIENT,recipient].some(a=>a.toLowerCase()===x.depositAddress.toLowerCase()) ||
    !matches(x.amount,/^\d{1,7}(\.\d{1,18})?$/) ||
    !["awaiting-payment","processing","bridging","confirming","delivered","expired","manual-review"].includes(x.state) ||
    !Number.isSafeInteger(x.expiresAt) || x.expiresAt<=0 || !matches(x.minUsdc,/^\d{1,20}$/) || BigInt(x.minUsdc)<=0n || !matches(x.minimumUsd,/^\d{1,20}$/) || BigInt(x.minimumUsd)<200_000n ||
    (x.message!==null&&(typeof x.message!=="string"||x.message.length>300)))throw new Error("Payment instructions failed verification.");
  const units=parseUnits(x.amount,18),contributionInvoice=x.contributionPercent===10;
  if(contributionInvoice){
    if(!matches(x.donationAmount,/^\d{1,7}(\.\d{1,18})?$/)||!matches(x.poolContributionAmount,/^\d{1,7}(\.\d{1,18})?$/)||!["pending","collected"].includes(x.poolContributionState??""))throw new Error("Pool contribution details are missing.");
    const donationUnits=parseUnits(x.donationAmount,18),allocation=contributionForDonationUnits(donationUnits);
    if(donationUnits<300n*10n**18n||donationUnits>1_000_000n*10n**18n||parseUnits(x.poolContributionAmount,18)!==allocation.contributionUnits||units!==allocation.totalUnits)throw new Error("Pool contribution calculation failed verification.");
  }else if(x.contributionPercent!==undefined&&x.contributionPercent!==0)throw new Error("Unsupported pool contribution rate.");
  if(units<(contributionInvoice?330n:300n)*10n**18n || units>(contributionInvoice?1_100_000n:1_000_000n)*10n**18n)throw new Error("Payment amount outside pilot limits.");
  const uri=`ethereum:${CHOG}@143/transfer?address=${getAddress(x.depositAddress)}&uint256=${units}`;
  if(x.paymentUri!==uri || [x.depositHash,x.bridgeHash].some(h=>h!==null && !matches(h,evmHash)) || !destinationHashValid(x.destinationHash))throw new Error("Payment address or receipt failed verification.");
  if(x.deliveredUsdc!=null&&!matches(x.deliveredUsdc,/^\d{1,20}$/)||x.observedUsdc!=null&&!matches(x.observedUsdc,/^\d{1,20}$/))throw new Error("Invalid destination amount.");
  if(x.state==="delivered" && (!x.destinationHash || !x.depositHash || !x.bridgeHash || !matches(x.deliveredUsdc,/^\d{1,20}$/) || BigInt(x.deliveredUsdc)<BigInt(x.minUsdc)))throw new Error("Destination receipt is missing or below the invoice minimum.");
  if(!destinationHashValid(x.observedDestinationHash))throw new Error("Invalid observed transaction.");
  for(const value of [x.processingStartedAt,x.bridgeStartedAt,x.destinationIncludedAt])if(value!=null && (!Number.isSafeInteger(value)||value<=0))throw new Error("Invalid payment timing.");
  if(x.bridgeEstimatedSeconds!=null && (!Number.isSafeInteger(x.bridgeEstimatedSeconds)||x.bridgeEstimatedSeconds<1||x.bridgeEstimatedSeconds>3600))throw new Error("Invalid bridge estimate.");
  if(x.state==="confirming" && (!x.observedDestinationHash || !x.depositHash || !x.bridgeHash || x.destinationHash || x.deliveredUsdc || !matches(x.observedUsdc,/^\d{1,20}$/) || BigInt(x.observedUsdc)<BigInt(x.minUsdc)))throw new Error("Unverified destination observation.");
  return {...pickInvoiceFields(x,["kind","id","mode","asset","chainId","amount","initiativeId","recipient","depositAddress","paymentUri","minUsdc","state","expiresAt","depositHash","bridgeHash","destinationHash","message","deliveredUsdc","observedDestinationHash","observedUsdc","processingStartedAt","bridgeStartedAt","destinationIncludedAt","destinationChainId","destinationAsset","destinationDecimals","minimumUsd","bridgeEstimatedSeconds","donationAmount","poolContributionAmount","contributionPercent","poolContributionState"]),destinationChainId:network!.id};
}
