// Burundi recipient networks checked against the project's Giveth page on
// 2026-10-08. Native USDC addresses checked against Circle's contract list.
// Never infer cross-chain support from an identical EVM address alone.
export const NEW_DONATION_CHAIN_ID = 10;
export const SOLANA_CHAIN_ID = 792703809;
export type DonationDestinationChainId = 1 | 10 | typeof SOLANA_CHAIN_ID;
const networks = {
  1: { id: 1, name: "Ethereum", relayChain: "ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", asset: "USDC", decimals: 6, kind: "evm", explorer: "https://etherscan.io" },
  10: { id: 10, name: "Optimism", relayChain: "optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", asset: "USDC", decimals: 6, kind: "evm", explorer: "https://optimistic.etherscan.io" },
  [SOLANA_CHAIN_ID]: { id: SOLANA_CHAIN_ID, name: "Solana", relayChain: "solana", usdc: "11111111111111111111111111111111", asset: "SOL", decimals: 9, kind: "solana", explorer: "https://solscan.io" },
} as const;

export function deliveryNetwork(id: number = 1) {
  if (id !== 1 && id !== 10 && id !== SOLANA_CHAIN_ID) throw new Error("Unsupported donation destination.");
  return networks[id];
}
