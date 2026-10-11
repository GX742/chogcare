# NFT pool: local Optimism pilot

This implementation is not an independent security audit and is not ready for an unattended public production deployment.

## Activation and funding

1. Run `npm test`, `npm run build`, and `npm run payments:nft:check`.
2. Stop the previous owner-run payment terminal with Ctrl+C. Run `npm run payments:start` from the project folder and enter the vault password locally. Never put the password in chat, environment variables or browser fields.
3. Wait for `NFT POOL TREASURY (Optimism / chain 10)` in that terminal. The worker initializes its durable funding cursor before printing the address. This address is a dedicated grandchild (`1000000/0`) of the existing encrypted custody branch, separate from every invoice and the Monad gas operator. Back up the encrypted vault AND all payment databases before funding.
4. Send native USDC on Optimism from either owner-approved address: `0x5A60fdEdCAbE82EeBF0Ca855BdF101015765CC18` or `0x19a863aeC37C83C7Cb34548c29f1F7e41BCB51Ca`. USDC contract: `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`. NOT USDC.e, NOT Ethereum, NOT Monad. Start with a small test top-up. A $10 top-up covers 10 new $1 grants in total, not an automatically renewed daily balance.
5. Send ETH on Optimism to the same treasury for gas. Issuance and new signing require at least 0.001 ETH. This is an operating balance threshold, not the fee per grant. The worker estimates L1, L2 and operator fees and pauses new signatures if the total estimate exceeds 0.0001 ETH. Estimates are not an absolute cap on all OP protocol fees.
6. USDC funding is credited only after canonical finality and exact token/from/to verification. This initial top-up confirmation can take longer than a normal L2 receipt. `/api/payments/config` exposes `nftWorkerVersion`, `poolTreasury`, `poolHealthy`, `poolGasReady`, `nftPaymentsEnabled` and `availableClaims`. Do not instruct donors to pay while disabled.

## Donor flow

If an approved funding transfer was skipped by an older worker, reconcile that exact event locally with `node scripts/reconcile-nft-funding.mjs <txHash> <logIndex> <approvedFunder>`. This verifies finalized chain-10 native-USDC receipt provenance and the database-bound treasury before crediting. It accesses no keys and sends no transaction. A unique chain/hash/log index makes rescans and retries idempotent. Unfinalized, wrong-sender, wrong-token and wrong-recipient transfers are rejected; do not manually change the budget or rewind the cursor. Restart the payment worker after changing the code allowlist.

Burundi, School Supplies & Crypto Education, The Solar Foundation and Vida Verde have pinned Optimism recipients. Animal Ethics is not available for NFT grants. Enter the holder's public address, confirm the non-refundable 1 MON terms, then reserve a grant. The server discovers an eligible CHOG token ID and verifies finalized ownership. A five-minute single-use Monad invoice is issued only after checking ownership, funded budget and gas; its window shortens near midnight. No wallet connection or approval is requested.

Send exactly 1 MON from the NFT-holding address. Do not send from an exchange or a different account. A smart-wallet internal transfer is accepted only when its canonical transaction trace proves the exact holder-to-deposit transfer; unavailable or ambiguous traces cannot be treated as verified. This 1 MON stays in the controlled Monad deposit address as a ChogCare donation. It is NOT automatically refunded, converted, forwarded to the initiative or added to the USDC ledger. Any future sweeping needs a separate reviewed implementation.

The worker verifies the canonical finalized MON payment, ownerOf at the payment block and a finalized snapshot, then rechecks before signing. It persists an exact 1.00 USDC transfer before broadcast. Gas is paid separately from treasury ETH. The UI distinguishes a canonical receipt from finalized delivery.

## Limits and recovery

- One new reservation per wallet AND per NFT per UTC day, independent of owner changes. The durable key is collection + canonical token ID + UTC date, not the current owner's address. Transferring that NFT cannot unlock another grant that day, including across worker restarts. Holding a different NFT does not unlock another grant for the same wallet. These checks cannot prove that different wallets with different NFTs belong to different human beings.
- New grants are $1 each, at most three daily recipients: a $3/day reservation budget and a separate $3/day submission budget, both also capped at three claims. All reservations count, including outstanding legacy grants. Unresolved reservations remain funded across midnight. Expiry is shortened near midnight; new requests close for the final two minutes. There is no repeat-holder exception for new grants.
- On first startup after the policy change, migration creates a local database backup and preserves old reservations, proofs and signed transactions. Existing $0.50 invoices remain $0.50; they are never silently increased, redirected or charged again. The browser gates new requests until the worker reports the new $1 / three-claim policy. Restart the owner-run worker to activate it; deploying the website alone is not enough.
- Three unresolved NFT invoices at a time. Public addresses are not authentication: reservations can be griefed by people who know valid holder/token pairs. A local pilot only; production needs stronger anti-abuse controls or cryptographic proof before reservation.
- An unpaid invoice is released only after scanning its finalized source window plus a 60-second buffer. Late deposits are not automatically paid or refunded; the original address and invoice remain recorded for operator reconciliation. Never delete databases or reuse an address.
- Wrong amounts, changed ownership, verification failures or reverted payouts go to review or remain paused. No automatic second charge or replacement payout. Review retains the reservation. RPC outages during verification may need operator review.
- Broadcast uncertainty reuses identical signed bytes/hash/nonce. Never create a new payout to fix a timeout. New payouts cannot skip an unresolved treasury nonce.
- The treasury must not be used manually for other outgoing transactions. External withdrawals can make recorded funding insufficient; balance checks then block new grants. Do not mix old Ethereum pool accounting into this chain-pinned pool.
- There is no public funding-credit, recipient-change, arbitrary-signing or manual-recovery endpoint. Signer keys remain in the owner's process RAM. Local RPC trust, custody risk, token/chain risk and possible reorgs remain.

## Checks in this change

Deterministic tests use disposable keys/databases and mocked RPCs, never real funds. They cover finalized funding, counterfeit USDC, wrong funder, MON amount and ownership, exact destination transfer, duplicate daily claims, expiry, nonce persistence after timeouts/restarts, total-fee gating, pool chain binding and browser invoice validation. A funded mainnet end-to-end NFT claim still needs an owner-controlled test after activation.
