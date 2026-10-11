# ChogCare architecture

> Historical custom-contract design, NOT the current payment flow. The former preview-only description is obsolete. The active custodial CHOG and NFT implementation is documented in [current architecture](C:/Users/User/Documents/Codex/2026-10-07/ghb/docs/ARCHITECTURE-CURRENT.md) and the [9 October security review](C:/Users/User/Documents/Codex/2026-10-07/ghb/docs/SECURITY-AUDIT-2026-10-09.md). The contracts below are not connected to that checkout.

## Trust boundaries

The user signs one source-chain transaction. The source router pulls exactly the approved CHOG amount, calls one allowlisted swap adapter, checks the actual USDC balance delta against `minUsdcOut`, optionally consumes a signed holder subsidy, then sends the exact USDC total to one allowlisted bridge adapter.

The destination receiver accepts completion calls only from a bridge adapter holding `BRIDGE_ROLE`. It rejects duplicate donation IDs and recipients that are not on the Giveth allowlist, then transfers USDC directly to the initiative wallet.

## Why two contracts

Cross-chain delivery is asynchronous. A Monad transaction cannot prove synchronous Ethereum completion. `DonationRequested` and `DonationCompleted` events form the observable state machine. The product backend must track the bridge message and expose `pending`, `completed`, `retryable`, or `failed` states.

## Production requirements

- Replace both mock adapters with audited protocol-specific adapters.
- Bind each adapter to immutable, documented router addresses and function selectors.
- Use native Circle USDC on both chains. Do not silently accept an arbitrary bridged token with the same symbol.
- Put admin roles behind a Safe multisig and timelock. Keep the pauser role on a separate emergency Safe.
- Generate subsidy vouchers only after checking the NFT collection, campaign rules, wallet, nonce and expiry.
- Keep swap quotes short-lived and enforce `minUsdcOut` onchain.
- Reconcile source and destination events and alert on messages that exceed the bridge SLA.
- Add per-transaction and daily subsidy limits before funding the treasury.
- Commission two independent audits and a public bug bounty before mainnet.

## Known limitation

The current MVP allowlists Giveth recipient addresses manually. A production indexer should read canonical recipient addresses from Giveth and submit changes through the timelock. Project metadata is recorded as `bytes32`; the transfer itself goes directly to the initiative wallet.
