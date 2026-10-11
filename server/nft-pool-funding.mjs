import { NFT_POOL_FUNDERS, NFT_POOL_CHAIN } from "./nft-pool-config.mjs";
import { verifyPoolFunding } from "./chain-receipts.mjs";

// Shared by the scanner and local reconciliation. Never credit a balance or an
// unfinalized receipt, and never accept a funder supplied through an HTTP API.
export async function verifyApprovedNftFunding(client, treasury, funder, txHash, logIndex) {
  const approved = NFT_POOL_FUNDERS.find(a => typeof funder === "string" && a.toLowerCase() === funder.toLowerCase());
  if (!approved) throw new Error("NFT pool funding sender is not approved.");
  return verifyPoolFunding(client, { treasury, funder: approved, chainId: NFT_POOL_CHAIN }, txHash, logIndex);
}
