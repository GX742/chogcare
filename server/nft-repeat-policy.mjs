// Server-only exception. It bypasses the per-NFT daily count, never proof,
// replay protection, the beneficiary allowlist, or the global $10 budget.
export const NFT_REPEAT_HOLDER = "0x19a863aec37c83c7cb34548c29f1f7e41bcb51ca";
export const canRepeatNftGrant = address => typeof address === "string" && address.toLowerCase() === NFT_REPEAT_HOLDER;
export const nftGrantScope = (address, invoiceId) => canRepeatNftGrant(address) ? `repeat:${invoiceId}` : "daily";
