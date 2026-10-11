import { isAddress, zeroAddress } from "viem";
import { chogBeneficiary, supportsNft } from "./chog-beneficiary.ts";
import { NFT_POOL_GRANT_USDC } from "./nft-pool-policy.ts";
import { validInvoiceId } from "./checkout-session.ts";
import { matchesInvoiceField as matches, pickInvoiceFields } from "./invoice-validation.ts";

export type NftInvoice = {
  kind:"payment"; mode:"nft"; id:string; state:"awaiting-payment"|"verifying"|"verified"|"paying"|"confirming"|"delivered"|"expired"|"manual-review";
  amount:"1";asset:"MON";chainId:143;destinationChainId:10;initiativeId:string;recipient:string;subsidyUsdc:"0.50"|"1.00";
  tokenId:string;holderAddress:string;depositAddress:string;paymentUri:string;expiresAt:number;claimDay:string;
  depositHash:string|null;destinationHash:string|null;observedDestinationHash:string|null;message:string|null;
};
export function validateNftInvoice(value:unknown):NftInvoice {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid NFT invoice.");
  const x=value as NftInvoice;
  const addr=(s:unknown)=>typeof s==="string"&&isAddress(s)&&s.toLowerCase()!==zeroAddress;
  if(x.kind!=="payment"||x.mode!=="nft"||!validInvoiceId(x.id)||x.amount!=="1"||x.asset!=="MON"||x.chainId!==143||x.destinationChainId!==10||!supportsNft(x.initiativeId)||
    x.recipient?.toLowerCase()!==chogBeneficiary(x.initiativeId,10).toLowerCase()||!["0.50",NFT_POOL_GRANT_USDC].includes(x.subsidyUsdc)||!addr(x.holderAddress)||!addr(x.depositAddress)||x.holderAddress.toLowerCase()===x.depositAddress.toLowerCase()||
    !matches(x.tokenId,/^\d{1,78}$/)||BigInt(x.tokenId)>=2n**256n||!Number.isSafeInteger(x.expiresAt)||x.expiresAt<=0||!matches(x.claimDay,/^\d{4}-\d{2}-\d{2}$/)||
    x.paymentUri!==`ethereum:${x.depositAddress}@143?value=1000000000000000000`||
    !["awaiting-payment","verifying","verified","paying","confirming","delivered","expired","manual-review"].includes(x.state)||
    [x.depositHash,x.destinationHash,x.observedDestinationHash].some(h=>h!==null&&!matches(h,/^0x[\da-f]{64}$/i))||
    (x.message!==null&&(typeof x.message!=="string"||x.message.length>300))||
    (["confirming","delivered"].includes(x.state)&&!x.destinationHash))throw new Error("NFT payment instructions failed validation. Do not send funds.");
  const claimDate=new Date(`${x.claimDay}T00:00:00.000Z`);
  if(!Number.isFinite(claimDate.getTime())||claimDate.toISOString().slice(0,10)!==x.claimDay)throw new Error("Invalid NFT claim day.");
  return pickInvoiceFields(x,["kind","mode","id","state","amount","asset","chainId","destinationChainId","initiativeId","recipient","subsidyUsdc","tokenId","holderAddress","depositAddress","paymentUri","expiresAt","claimDay","depositHash","destinationHash","observedDestinationHash","message"]);
}
