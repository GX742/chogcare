// Legacy scope validation only, for already-issued invoices and signed payouts.
// New reservations always use the daily NFT AND wallet limits; no exception.
export const NFT_REPEAT_HOLDER = "0x19a863aec37c83c7cb34548c29f1f7e41bcb51ca";
export const canRepeatNftGrant = address => typeof address === "string" && address.toLowerCase() === NFT_REPEAT_HOLDER;
export const nftGrantScope = (address, invoiceId) => canRepeatNftGrant(address) ? `repeat:${invoiceId}` : "daily";
