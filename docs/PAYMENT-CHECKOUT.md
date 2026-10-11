# No-connection payment checkout

**Current update, 2026-10-08:** CHOG real-invoice issuance and a sequential local settlement worker have now been implemented. See [PAYMENTS-LOCAL-PILOT.md](PAYMENTS-LOCAL-PILOT.md), which supersedes the CHOG preview-only status below. The owner must unlock the existing vault locally and fund operator gas; no real mainnet test has been executed by the agent. NFT verification/pool settlement remains unconnected. The remainder of this file records the earlier architecture and preview milestone, not current CHOG readiness.

## Status

Partial implementation, preview only. Never send funds to a QR from this build: it has no payment destination. The previous direct-wallet route is disconnected from the UI, but its code, tests and local recovery records are preserved. Existing onchain transactions are not cancelled by this UI change.

Implemented:

- English CHOG and NFT checkout forms in the established ChogCare theme.
- Amount validation using integer token units; CHOG minimum 300.
- Local HTTP service and SQLite preview storage (24-hour retention, no holder address persisted).
- Plain-text, visibly labelled non-payable preview QR codes, with no false paid/verified states or countdown.
- Read-only NFT-deposit proof validator, currently internal and not exposed by HTTP.
- Atomic database uniqueness for a proof's invoice, transaction hash and NFT/day key.
- Tests of validation, API readiness gating, proof rejection and replay prevention.
- Internal encrypted HD custody backup tooling and public-only address allocator, with durable unique invoice indices, retry stability and branch pinning. Not connected to the public invoice endpoint.
- Internal pool ledger: 10-USDC daily reservation cap, a separate 10-USDC daily submission cap for delayed backlogs, 0.50-USDC grants, one NFT per UTC day, duplicate funding-event rejection and unresolved payout holds. These are authorization-day limits; blockchain inclusion can occur later.
- Read-only finalized CHOG deposit, approved-funder Ethereum USDC funding and exact 0.50-USDC payout verifiers. Canonical block, chain, token contract, event identity, recipient and amount are checked. These still need a persistent watcher and treasury reconciliation.
- Internal pool payout outbox: proof/reservation binding, strict signed EIP-1559 transfer policy, unique treasury nonce, atomic budget + signed-bytes persistence, timeout/unknown state, same-bytes rebroadcast, and verified destination delivery. Only the pinned Burundi recipient is permitted. No key is held by this module.
- Web boundary for private files, exact POST Origin/Host checks, byte/request limits, bounded preview storage, safe response headers and a Windows payment-directory ACL utility.
- Internal EIP-681 CHOG/native-MON request builder, tested for exact units and chain 143. Public previews still contain only non-payable text.

Not connected or implemented end-to-end: public real-invoice issuance, unlocked custody signer, chain indexing, source settlement, bridge monitoring, refund handling, funded treasury, atomic issuance/eligibility/budget workflow and an automated worker using the payout outbox. There is no switch that makes this build safe to accept deposits. Address generation, verification and the outbox are tested primitives, not a working payment processor.

## Owner-approved product rules

- Own payment processor, not an external payment provider.
- Monad chain 143. CHOG token: `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`.
- NFT collection: `0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763` (Chog Genesis, ERC-721).
- NFT verification payment: exactly 1 MON, retained as a donation, not refunded. Network gas is additional.
- Pool benefit: 0.50 USDC, at most once per NFT per UTC calendar day. The implementation interprets daily reset as 00:00 UTC, not a rolling 24-hour cooldown. Ownership transfers do not reset the NFT's daily limit.
- Reused transaction hashes are rejected across all days.
- Total subsidy budget: 10 USDC per UTC calendar day, or 20 grants. Gas and bridge fees need separate operator funding; the pool currently has zero credited funds. A new day resets the cap, not the actual treasury balance.

## Custody backup preparation (owner action)

The owner has already created the local backup on 2026-10-08. Do not run setup again to replace it. Its password remains with the owner. Current local ACLs restrict payment storage to the owner account, SYSTEM and Administrators; production still needs a separate signer identity, external secret storage and recovery procedures.

Run `npm run payments:vault:setup` personally in a terminal. The script creates a fresh HD branch at `m/44'/60'/0'/0`, encrypts it with the standard ethers JSON keystore format, verifies decryption/recovery, then exclusively writes `work/payments/custody/vault.json`. Existing backups are never overwritten. The password is hidden and is never taken from command-line arguments, environment variables, browser input or chat. Private keys and seed phrases are never printed or saved in plaintext.

Keep the encrypted file and its password in separate secure backups. Without both, funds can be permanently lost. `npm run payments:vault:check` verifies recovery without signing or sending a transaction. Encryption does not protect an unlocked, compromised server. The JSON file includes a public xpub: disclosure reveals linked invoice addresses, and combining an xpub with a leaked non-hardened child private key compromises the branch. Do not publish it. POSIX file modes do not replace Windows ACL review.

SQLite allocation uses `BEGIN IMMEDIATE`, unique invoice/address/index constraints and a pinned branch fingerprint. Back up the database with the vault. Do not restore a stale database into a live service: its derivation counter could reuse historical addresses. Live activation needs a recovery/reconciliation runbook, off-machine backups and signing limits. The current HTTP service does not allocate addresses even if a backup is present.

## Required live architecture

1. Server validates initiative against its own recipient registry, amount, live swap/bridge feasibility and terms. Do not trust browser recipient or price fields.
2. For holder invoices, read ownerOf for a specific token ID before payment, reject exhausted daily eligibility and reserve sufficient pool budget. Do not take 1 MON when the pool cannot honor the benefit. A supplied address alone is not proof of control.
3. Allocate a unique deposit address under a dedicated custody/signer service. Persist invoice, address derivation, creation block, expiry, terms, recipient and minimum-output policy before showing QR. Never reuse addresses or identify orders only by equal amounts. Never derive custody keys in the browser.
4. Build an EIP-681 request: CHOG ERC-20 transfer to the invoice deposit address on chain 143, or native 1 MON transfer. Include copyable address, exact amount, chain and token separately for wallets without URI support. QR does not automatically execute swaps.
5. A persistent watcher scans finalized blocks with a durable cursor. Validate the actual CHOG Transfer event, not just tx success. Handle duplicate logs, reorgs, late, partial, excess and wrong-token deposits explicitly. Do not discard late money when a UI timer expires.
6. For NFT invoices, validate the direct native transfer against the issued invoice and check ownerOf(tokenId) at the payment and current finalized snapshots. The current validator intentionally does not support internal smart-account transfers or exchange withdrawals; broader support needs trace-aware attribution.
7. Reserve daily eligibility and treasury budget in one database transaction, then create a durable payout job. A proof record is not a paid claim. An outbox needs explicit retry/unknown-result handling, nonce serialization and onchain reconciliation before retrying.
8. A restricted signer handles source swaps and bridge submission. Existing browser EIP-5792 calls cannot be reused unchanged with ordinary deposit EOAs. Production needs a reviewed settlement contract/adapter or a durable sequential worker with explicit intermediate-asset recovery. Fund source gas without allowing an unbounded gas-faucet attack.
9. Track destination USDC receipt independently. Expose separate deposited, processing, bridging, delivered, refund/manual-review states. Never equate a source receipt or API timeout with final delivery/failure.
10. Track 1 MON donations separately from pool-funded 0.50 USDC donations. Do not silently consume the verification donation as worker gas. Decide destination, aggregation and fee funding before activation.

## Custody and launch requirements

- Choose deployment host and secret manager. Use a new dedicated operator wallet, never an existing personal wallet. Keep keys outside the repo and outside any VITE_* variable; never send them in chat.
- Confirm initial pool budget, total daily subsidy cap, operator gas budget and authorized treasury addresses. Exact 0.50-USDC delivery needs separate fee funding.
- Restrict recipients, assets, router addresses, calldata selectors, slippage and per-transaction/day spending. Put treasury/admin controls behind a multisig and documented emergency procedure.
- Review refund/failed-route terms separately from the explicitly non-refundable 1 MON donation policy. Duplicate or ineligible payments still need a transparent handling policy.
- Add fork tests, signer/nonce/crash recovery tests, database concurrency tests, negative payment tests and an independent security review. Run an owner-approved small mainnet pilot only after these gates.
- Protect live API with HTTPS, secure sessions, CSRF protection, request limits and storage quotas. Current service is loopback-only development infrastructure.

## Files

- `src/PaymentCheckout.tsx`, `src/checkout.ts`, `src/checkout.css`: preview client.
- `server/payment-service.mjs`: config/previews HTTP API, hard-closed live invoice endpoint.
- `server/invoice-store.mjs`: SQLite preview and internal proof ledger.
- `server/nft-proof.mjs`: read-only verification primitive; not a watcher or payout service.
- `server/policy.mjs`: owner-approved server policy.

Protocol references: [EIP-681](https://eips.ethereum.org/EIPS/eip-681) for future payment QR requests; [ERC-721](https://eips.ethereum.org/EIPS/eip-721) for ownerOf. Sending MON proves control of the invoice-bound sender only after a valid confirmed transfer; NFT ownership is a separate check.
