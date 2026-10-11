# ChogCare

## Physical broadcast station (2026-10-11)

The USB-connected NodeMCU/ST7789 station celebrates finalized CHOG donations with the donor's public nickname, amount and a softly pulsing LED. See [wiring, Arduino upload and Windows bridge instructions](firmware/README.md). The external LED uses **D0**; move the TFT reset wire to **D1** and leave its other SPI wires unchanged. The bridge only reads payment data and does not send funds. Run `npm run station -- --port COM4` only after verifying the actual NodeMCU port; close Arduino Serial Monitor first.

ChogCare is an owner-operated donation pilot with CHOG QR donations, CHOG NFT daily grants, a public care board and a physical live-broadcast station.

## Current checkout status (2026-10-11)

**Current implementation: owner-unlocked local payment pilot.** The public frontend is hosted on Vercel; a narrow Tailscale Funnel proxy exposes only HLS video and the payment API. Run `npm run payments:start` personally and enter the existing vault password in its hidden terminal prompt. Website deployment does not start or update this local worker. Invoice issuance requires current network, custody and gas checks. Do not expose Vite, Owncast administration or payment storage.

CHOG donations support 300–1,000,000 CHOG, with a 10% NFT-pool contribution added on top. The worker validates exact payments and pinned destinations, then processes the conversion and delivery. The supported initiatives are Burundi, School Supplies & Crypto Education, The Solar Foundation, Vida Verde and Animal Ethics; their server-pinned delivery routes differ. Included destination receipts and finalized delivery are distinct states. Physical station celebrations require finalized CHOG delivery, not just an invoice or bridge response.

The NFT grant requires verified ownership of the configured CHOG collection and an exact, non-refundable 1 MON verification donation. New grants are $1, up to three recipients and $3 total per UTC day. Eligibility is enforced both per wallet and per collection/token ID/day; transferring the same NFT cannot reset its daily claim. No wallet connection is used. Public addresses do not prove ownership before reservation, so temporary slot blocking remains possible. See [NFT pool operations](docs/NFT-POOL-OPERATIONS.md).

Read [the current operator runbook](docs/PAYMENTS-LOCAL-PILOT.md) and [the latest internal security review](docs/SECURITY-AUDIT-2026-10-11.md). `npm run payments:route:check` verifies fresh quotes without loading keys; `npm run payments:status` is read-only. The audit uses disposable keys, temporary databases and mocked chain responses, not the user's custody keys or real transfers. Passing tests are not an independent audit or a production safety guarantee.

### Earlier preview milestone (historical; superseded for CHOG by the pilot above)

The public UI now uses a **no-wallet-connection checkout preview**, replacing the old injected-wallet flow. There is no Wagmi provider, wallet reconnect, signing call or real deposit address on the current page. Previous wallet-route code and browser recovery records are retained, but the old DonationPanel is not mounted.

The new local payment service stores non-payable invoice previews in SQLite. QR codes encode clearly labelled plain text, not payment requests. `POST /api/payments/invoices` always returns 503: **real payments are disabled**. No signer, public deposit-address issuance, chain watcher, swap/bridge worker, refund worker or pool payout is running. This is a partial implementation, not a deployed payment processor.

The owner set a **10 USDC daily pool limit**: at most 20 grants of 0.50 USDC. Internal SQLite reservations enforce the cap including pending grants and prevent balance from being replenished merely by a day reset. They start with zero credited funding, not an invented 10-USDC balance. Funding/settlement ledger methods are internal building blocks; no public funding or payout endpoint exists.

An internal address allocator derives unique deposit addresses from a public HD branch, pins the branch in SQLite, and persists each invoice/index/address atomically. Retry returns the same address. The owner created the encrypted custody backup on 2026-10-08; the local API detects it as **locked**. The agent has not requested its password or unlocked it. The allocator remains disconnected from public invoices until settlement is operational.

To prepare a NEW dedicated encrypted custody backup, run `npm run payments:vault:setup` yourself in an interactive terminal, choose a unique long password, and back up the encrypted file plus password separately. Use `npm run payments:vault:check` to test recovery. Never send the password, seed, private keys or encrypted backup in chat. This step does not enable payments; do not deposit funds yet. Read `docs/PAYMENT-CHECKOUT.md` before using this for custody.

Owner-confirmed policy: Chog Genesis ERC-721 on Monad at `0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763`; 1 MON verification payment is a non-refundable donation; $0.50 benefit once per NFT per UTC calendar day, regardless of ownership changes. Collection code/name/symbol/ERC-721 support and supply 1,969 were checked through Monad RPC on 2026-10-08. This is not an independent authenticity or security audit.

The read-only validators check NFT verification, genuine CHOG Transfer events and exact Ethereum USDC funding/payout receipts against canonical finalized blocks. The internal payout outbox binds a verified NFT proof to its daily reservation, checks a signed exact 0.50-USDC transfer, and commits the signed bytes, nonce and budget submission atomically before broadcasting. Timeout recovery only rebroadcasts those identical bytes. These modules are tested but **not connected to live deposits or a running signer**. Atomic real-invoice issuance, abuse-resistant reservation expiry, indexing and swap/bridge settlement remain required.

## Security reviews

See [the latest review](docs/SECURITY-AUDIT-2026-10-11.md), with earlier dated reviews retained as historical snapshots. This is an internal review, not an independent audit or security guarantee. The old wallet send function is hard-disabled: its historical LI.FI metadata parser is not a safe custody-signing policy.

Private application files are blocked before Vite static/raw-file handlers and by `server.fs.deny`. Payment storage on this machine has Windows ACLs restricted to the current account, SYSTEM and Administrators. `npm run payments:storage:protect` reapplies that local ACL policy; it does not protect against a compromised current account. Do not expose Vite, place secrets in `public/`, or use this workstation as a production signer.

Run `npm run security:check` for the build, all tests and full dependency audit. Contract tests now use an isolated Hardhat EDR chain, not Ganache; no real wallet keys are used. `npm run payments:test` runs the payment/security subset.

See [payment architecture and launch blockers](docs/PAYMENT-CHECKOUT.md). All sections below “Historical wallet-route notes” describe the previous implementation, not today's public checkout.

## Run locally

```powershell
npm install
npm run test
npm run payments:dev
```

In a second terminal:

```powershell
npm run dev
```

Open `http://127.0.0.1:4173`.

Payment API binds only to `127.0.0.1:4174`; Vite proxies `/api/payments`. Node 25 is used locally (native TypeScript stripping and `node:sqlite`). `vite preview` only serves static files and does not provide this API. Public deployment needs a separate API deployment/reverse proxy and a security review; do not expose the dev server.

## Historical wallet-route notes

## Visual refresh

The English interface uses local Manrope / DM Sans fonts, an ink-dark background with violet and cool lavender accents, rounded surfaces, the supplied ChogCare artwork as a compact top-left logo, and the GX avatar. The brand includes Chogathon 2026. A square broadcast placeholder on the right reserves a 16:9 video area for a future 1920 × 1080 stream; no stream is connected yet. The dense canvas uses smooth heart shapes in one violet hue with very subtle individual breathing, without moving color waves. Only the cell under the pointer lights up, with a short fading trail along the cells crossed by the cursor. There is no radial pointer spotlight. Cached sprites limit rendering work. The heartbeat control pauses the decoration; reduced-motion preferences and hidden tabs also stop animation.

The default NFT-pool panel is a clearly labelled upcoming feature: it does not connect a wallet, issue deposit addresses, verify NFT ownership or disburse money. Activating it still requires the official NFT collection, agreed eligibility rules, a funded pool, and the onchain/relayer implementation for verification transfers. The existing live CHOG/USDC flow remains in the separate “Give with CHOG” tab; its wallet connection and transaction protections are retained.

The UI builds live mainnet transactions. The connected wallet signs a single atomic batch using EIP-5792. Unsupported wallets stop before signing; sequential fallback is disabled. A first-time smart-account upgrade can require an additional wallet prompt.

## Live route

1. Read the CHOG → MON quote from the official Nad.fun lens.
2. Compare the deployed Uniswap v3 MON/USDC fee tiers and obtain a LI.FI bridge quote before signing. Minimum input is 300 CHOG.
3. Validate the wallet, source/destination chains, input amount, tokens, spender and recipient, including the bridge payload. Quotes expire after two minutes. A refreshed route may not reduce the previously displayed minimum output.
4. Submit exact CHOG approval → Nad.fun sale → Uniswap swap → CHOG approval cleanup → exact USDC approval → LI.FI bridge → USDC approval cleanup with `atomicRequired: true`.
5. All source calls either execute together or revert together (gas may still be spent on a revert). Ethereum delivery is asynchronous and is tracked separately; source confirmation is not reported as completed delivery.

For an existing MetaMask v1.3.0 EIP-7702 account, the complete batch is also simulated read-only against real Monad state before signing. The wallet estimates aggregate gas instead of reusing the bridge API's gas limit.

## Recovering an interrupted earlier donation

If an earlier sequential run already produced USDC, choose **Уже есть USDC**, enter the amount still held on Monad, and preview the bridge quote. This mode only approves/bridges existing USDC and clears the allowance; it never sells CHOG again. The 300 CHOG minimum applies only to new CHOG donations.

Submission IDs and source transaction hashes are saved under an account- and chain-specific localStorage key before/after signing. A Web Lock prevents concurrent submission from two tabs. An ambiguous timeout remains locked; use **Проверить статус** or enter the source hash from the wallet. Do not clear browser storage to bypass the lock. A source receipt must contain the expected USDC transfer into LI.FI before recovery accepts it. Browser storage is a local safeguard, not cross-device idempotency.

An unresolved wallet relay failure with no usable batch ID or transaction hash requires checking the wallet's final history/status. Changing RPCs cannot cancel an already queued wallet relay request.

One MON is kept as a conservative gas reserve. The quoted minimum USDC amount, not the optimistic amount, is bridged; any positive swap remainder stays in the user's wallet.

The first mainnet pilot is locked to the verified Giveth project `creating-the-perfect-villages-in-burundi` and its Ethereum recipient `0x1de498918d04B8Bf162210103CDd547f73387B2E` to prevent an accidental address substitution.

## What is implemented

- Responsive React interface with injected-wallet connection and Monad network switching.
- Live frontend transaction builder for Nad.fun, Uniswap v3 and LI.FI.
- Monad source router with allowlisted swap and bridge adapters, retained for the later subsidy/relayer stage.
- Measured-balance slippage protection rather than trusting adapter return values.
- EIP-712 subsidy voucher capped at 0.50 USDC with replay protection.
- Ethereum receiver with bridge authorization, recipient allowlist and donation replay protection.
- Pausing, role separation, emergency recovery while paused and reentrancy protection.
- In-process Solidity compile and end-to-end tests using Ganache.

## What I need from the project owner

1. A small funded test wallet for an end-to-end low-value mainnet test. Never share its private key or recovery phrase.
2. Approval of Nad.fun + Uniswap v3 + LI.FI as the production protocol route, or the preferred replacements.
4. Later: official CHOG NFT collection address, exact $0.50 eligibility rule, subsidy treasury and Safe multisig addresses.
5. Before meaningful volume: independent auditors, monitoring/incident owners, legal terms and bug-bounty budget.

## Security status

This is an engineering MVP, not audited production software. No honest developer can promise that a smart contract or third-party route "cannot be hacked." Start with a disposable wallet and a minimal amount. Meaningful volume must wait for fork tests, invariant tests, independent audits and operational runbooks.

See [architecture](./docs/ARCHITECTURE.md) for trust boundaries and deployment requirements.
