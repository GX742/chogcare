import { isAddress, zeroAddress } from "viem";
import { chogBeneficiary, supportsNft } from "./chog-beneficiary.ts";

export type NftInvoice = {
  kind:"payment"; mode:"nft"; id:string; state:"awaiting-payment"|"verifying"|"verified"|"paying"|"confirming"|"delivered"|"expired"|"manual-review";
  amount:"1";asset:"MON";chainId:143;destinationChainId:10;initiativeId:string;recipient:string;subsidyUsdc:"0.50";
  tokenId:string;holderAddress:string;depositAddress:string;paymentUri:string;expiresAt:number;claimDay:string;
  depositHash:string|null;destinationHash:string|null;observedDestinationHash:string|null;message:string|null;
};
export function validateNftInvoice(value:unknown):NftInvoice {
  if(!value||typeof value!=="object")throw new Error("Invalid NFT invoice.");
  const x=value as NftInvoice;
  const addr=(s:unknown)=>typeof s==="string"&&isAddress(s)&&s.toLowerCase()!==zeroAddress;
  if(x.kind!=="payment"||x.mode!=="nft"||!/^([a-f0-9]{64})$/.test(x.id)||x.amount!=="1"||x.asset!=="MON"||x.chainId!==143||x.destinationChainId!==10||!supportsNft(x.initiativeId)||
    x.recipient?.toLowerCase()!==chogBeneficiary(x.initiativeId,10).toLowerCase()||x.subsidyUsdc!=="0.50"||!addr(x.holderAddress)||!addr(x.depositAddress)||x.holderAddress.toLowerCase()===x.depositAddress.toLowerCase()||
    typeof x.tokenId!=="string"||!/^\d{1,78}$/.test(x.tokenId)||BigInt(x.tokenId)>=2n**256n||!Number.isSafeInteger(x.expiresAt)||!/^\d{4}-\d{2}-\d{2}$/.test(x.claimDay)||
    x.paymentUri!==`ethereum:${x.depositAddress}@143?value=1000000000000000000`||
    !["awaiting-payment","verifying","verified","paying","confirming","delivered","expired","manual-review"].includes(x.state)||
    [x.depositHash,x.destinationHash,x.observedDestinationHash].some(h=>h!==null&&(typeof h!=="string"||!/^0x[\da-f]{64}$/i.test(h)))||
    (x.message!==null&&(typeof x.message!=="string"||x.message.length>300))||
    (["confirming","delivered"].includes(x.state)&&!x.destinationHash))throw new Error("NFT payment instructions failed validation. Do not send funds.");
  return x;
}
