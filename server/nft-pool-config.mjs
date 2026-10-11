// Public, owner-approved values. Never accept a treasury, funder or recipient from HTTP.
export const NFT_POOL_FUNDER = "0x5A60fdEdCAbE82EeBF0Ca855BdF101015765CC18";
// Additional source explicitly approved by the owner; preserve the original DB binding.
export const NFT_POOL_FUNDERS = Object.freeze([
  NFT_POOL_FUNDER,
  "0x19a863aeC37C83C7Cb34548c29f1F7e41BCB51Ca",
]);
export const NFT_POOL_CHAIN = 10;
// A grandchild is disjoint from every direct-child CHOG/NFT deposit address.
export const NFT_TREASURY_PATH = "1000000/0";
// Mandatory CHOG checkout contributions are first consolidated on Monad. The
// sibling path is disjoint from both invoice children and the Optimism payout
// treasury. Small contributions are bridged in a batch so the bridge cannot
// consume most of a donor's pool contribution.
export const NFT_CONTRIBUTION_SOURCE_PATH = "1000000/1";
export const NFT_POOL_BATCH_MIN_USDC = 5_000_000n;
export const NFT_POOL_SOURCE_GAS_GRANT = 1_000_000_000_000_000_000n;
export const NFT_POOL_GAS_MIN = 1_000_000_000_000_000n; // 0.001 ETH, operating reserve.
export const NFT_PAYOUT_FEE_CAP = 100_000_000_000_000n; // 0.0001 ETH estimated total fee.
