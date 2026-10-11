import { GIVETH_PROJECT_RECIPIENT } from "./route.ts";
import { SOLANA_CHAIN_ID, type DonationDestinationChainId } from "./delivery-network.ts";
// Server-selected, source-verified recipients. Never take addresses from HTTP.
// Giveth project.addresses entries, isRecipient=true, networkId=10;
// independently rechecked on the official project pages on 2026-10-09.
const optimismRecipients: Record<string, `0x${string}`> = {
  "school-supplies": "0x8270a0FEBBA70899419E76A98bF2B5DC15Fe2Ff4",
  "solar-foundation": "0x84178186a503ef41d30Da4cDB2bC27AEFA65eD0F",
  "vida-verde": "0x05c73EcEF963FD68A414E713F4B28d9E792c73Bd",
};
export const ANIMAL_ETHICS_SOL_RECIPIENT = "J7XmJiC44bFTbTzoAF69qhWPZq6LUkvf8wPk2UV4zXXL" as const;
// Public, dedicated Optimism treasury derived from the locally encrypted
// custody backup. It is a settlement target, never accepted from HTTP input.
export const NFT_POOL_TREASURY = "0x4832b38D6945D39Edd74f9E847bD35c29da9cAA2" as const;
export const CHOG_INITIATIVES = ["burundi", "school-supplies", "solar-foundation", "vida-verde", "animal-ethics"] as const;
export const NFT_INITIATIVES = ["burundi", "school-supplies", "solar-foundation", "vida-verde"] as const;
// Historical Animal Ethics Ethereum invoices remain readable on their original
// immutable address. New Animal Ethics donations use the separately verified
// native SOL address published on the organization's official website.
export function supportsChog(id: string): boolean { return CHOG_INITIATIVES.some(value => value === id); }
export function acceptsNewChog(id: string): boolean { return CHOG_INITIATIVES.some(value => value === id); }
export function supportsNft(id: string): boolean { return NFT_INITIATIVES.some(value => value === id); }
export function initiativeChain(id: string, legacyDefault: 1 | 10 = 10): DonationDestinationChainId { return id === "animal-ethics" ? SOLANA_CHAIN_ID : id === "burundi" ? legacyDefault : 10; }
export function chogBeneficiary(id: string, chainId: number) {
  if (id === "burundi" && (chainId === 1 || chainId === 10)) return GIVETH_PROJECT_RECIPIENT;
  if (chainId === 10 && Object.hasOwn(optimismRecipients, id)) return optimismRecipients[id];
  if (id === "animal-ethics" && chainId === SOLANA_CHAIN_ID) return ANIMAL_ETHICS_SOL_RECIPIENT;
  if (id === "nft-pool" && chainId === 10) return NFT_POOL_TREASURY;
  // Historical invoice binding ONLY. Never redirect an already-issued invoice.
  if (id === "animal-ethics" && chainId === 1) return "0x7D71DF4c7752D49A08199cDD65f4fd8C2aA12f09" as const;
  throw new Error("Beneficiary is not approved for this network.");
}
