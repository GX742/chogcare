# ChogCare payment pilot operator runbook

## Current operation on 18 October 2026

This is an owner-operated custody pilot, not independently audited unattended production software. Vercel serves the frontend; the local worker must be running separately. Website deployment does not start or refresh that worker. Vite is optional for local development, not required for the deployed frontend.

From the project folder, start the existing worker personally:

```powershell
npm run payments:start
```

Enter the **existing** vault password only at its hidden prompt and leave the terminal open. Do not recreate the vault, delete databases, restore older storage, reset integrity enrollment or create a replacement invoice to bypass a timeout. Identify and stop only your previous payment terminal if its port is occupied. `INTEGRITY_HOLD` requires reconciliation, not reenrollment.

Verify readiness without a password:

```powershell
Invoke-RestMethod 'https://chogcare.vercel.app/api/payments/config' | ConvertTo-Json -Depth 6
```

CHOG issuance requires `paymentsEnabled`, an unlocked custody state, network/gas readiness and no integrity lock. NFT issuance additionally needs `nftPaymentsEnabled`, `poolHealthy`, `poolGasReady`, available funded claims and a checkout slot. Do not pay again when a worker is offline or a transaction is uncertain.

Current CHOG donations support 300–1,000,000 CHOG with 10% added on top for the NFT pool: 300 to the initiative means 330 total. The board and physical thank-you display show the donation excluding that addition. Supported initiatives are Burundi, School Supplies & Crypto Education, The Solar Foundation, Vida Verde and Animal Ethics. Current new USDC routes use Optimism; Animal Ethics has its pinned native SOL route. Historical invoices retain their original route and amount. Included receipts are not finalized delivery; the physical station requires finalized CHOG delivery and a healthy worker.

A single canonical, finalized CHOG transfer received within the original invoice window is accepted when it is at least the requested total and within the existing processing cap: 1,100,000 CHOG for current invoices, 1,000,000 for legacy invoices without a pool contribution. The entire received amount is processed; the original quote, address, QR and deadline remain unchanged. Current invoices divide the actual amount in a 10:1 cause/pool ratio using integer token units. For example, 333 received against a 330 request allocates 302.727272727272727272 CHOG to the cause and 30.272727272727272728 CHOG to the pool, before external conversion and delivery fees. Payment details and station retain the actual cause allocation. The thank-you headline, downloadable image, social post, care board and completed-donation total use the donor's originally selected donation: 300 CHOG in this example. This presentation does not alter settlement or hide the actual transfer from payment details. Public totals still validate the full actual deposit proof and aggregate original donation amounts exactly, excluding the added pool contribution and overpayment.

An underpayment is held without starting the exchange. Multiple transfers are not combined into a payment, and late transfers or amounts above the cap need operator review. No automatic refund is available. Temporary RPC, receipt or finality failures preserve the scan position and retry; they do not establish a permanent amount mismatch.

Worker `2026-10-18-overpayment-recovery-v13` can reconsider an old amount-mismatch hold only when it has no deposit proof, transaction journal or processing history. It scans the complete original address history through a frozen finalized head, in pages of at most 2,000 blocks and at most 10,000 blocks in total. It requires exactly one eligible transfer, an unchanged invoice, an empty source journal and an available queue slot before recording the verified actual amount. Other holds remain for review. Restart both the station bridge and payment worker to load these changes; enter the existing vault password only in the local admin app or hidden prompt.

New NFT grants are **$1 each, three recipients maximum and $3 total per UTC day**, with both wallet/day and collection/token-ID/day eligibility. Transferring the same NFT does not reset its daily claim. Existing $0.50 invoices remain unchanged. Verification requires exactly 1 MON, a non-refundable donation held in its separate custody address. See [NFT pool operations](NFT-POOL-OPERATIONS.md) for funding and gas details.

The owner chose no wallet connection/signature. Someone knowing a public holder/token pair can temporarily reserve its checkout slot; rate limits and short holds do not authenticate ownership. The public board omits wallet addresses, but an NFT avatar and public receipts can permit onchain owner correlation.

Keep custody storage private and back up the vault, databases and integrity checkpoint consistently. The HTTP worker and unlocked signer still share one process/account; malware running as the owner remains a critical risk. Do not expose Vite, Owncast administration or local service ports. No automatic refund or sweeping implementation is available. Retry only original committed transaction bytes; ambiguous, late or incorrect payments need invoice-specific reconciliation.

Use full `npm run security:check` and read [the latest security review](SECURITY-AUDIT-2026-10-18.md). Automated checks are synthetic, not proof of real settlement or an independent audit.

## Historical operator details from 8 October 2026

The remainder is retained as a dated implementation snapshot. Its old recipient restrictions, disabled NFT mode, grant amounts, limits and deployment statements are superseded by the current section above.

Updated 2026-10-08. This is an owner-operated local mainnet pilot, **not independently audited production software**. The implementation can issue real deposit addresses and sign real transactions after the owner unlocks it. No real payment was sent during automated verification. Do not present the mock-chain tests as a completed mainnet donation.

## Start using the existing encrypted vault

Do not recreate the vault. Back up the existing encrypted vault and the payment database outside the web project; keep the password separately. Never send any of these in chat.

In an owner-controlled interactive terminal:

```powershell
cd C:\Users\User\Documents\Codex\2026-10-07\ghb
npm run payments:route:check
npm run payments:start
```

If port 4174 is occupied, stop the existing `payments:dev` process first. Enter the existing vault password at the hidden prompt. Do not put it in command arguments, environment variables, the website or chat. The program prints only a **public operator gas address**. Fund that address with at least **6 MON on Monad** for the first invoice (5 MON allocated to the child plus operator gas margin). Do not send CHOG to the operator address. Unused child gas remains at the child address; an automated gas sweep is not implemented.

Keep this terminal and the existing Vite frontend on port 4173 running. When the processor is unlocked, network checks succeed and operator gas funding is available, the CHOG button enables itself. No environment flag can bypass unlocking. Restarting requires the password again, then resumes persisted work. Closing the browser does not stop the worker. Closing the worker stops processing until restarted.

Do not expose either development server publicly. The frontend is served through Vite and proxies the loopback payment API on 4174. Public hosting requires a separate hardened deployment, signer isolation, authentication/session policy, HTTPS, monitored backups and an independent review.

## Owner-controlled first real payment

1. Select Perfect Villages in Burundi and 300 CHOG. Only this recipient is enabled; other causes remain browsable.
2. Click **Create payment QR**. Check Monad chain 143, CHOG token and exact amount. A fresh address and EIP-681 token-transfer QR are issued only after current route checks.
3. Use your own wallet to send CHOG **once** to that invoice address. You still authorize the transfer in your wallet; the website never connects to it. Do not use an exchange withdrawal or send to the token contract. Some wallets cannot interpret EIP-681; copy the address and amount separately in that case.
4. The checkout progresses through transfer, exchange, bridge and finality. A verified, included Ethereum USDC transfer becomes `confirming`, with its amount and explorer link; it is NOT yet finalized. Ethereum finality typically takes around 15 minutes after inclusion and is not accelerated by higher source fees. Save the invoice ID. A network timeout is not permission to send again.
5. **Donation delivered** appears only after a finalized Ethereum USDC Transfer to the pinned initiative, above the invoice minimum. The actual delivered amount and Ethereum transaction link are displayed. Confirm the first result yourself in the explorer before increasing volume.

The quote is not a guarantee against protocol failure. Price changes can pause processing rather than lower the accepted minimum. Source steps are sequential, not atomic: partial progress can leave CHOG, MON or USDC in custody. Funds cannot be guaranteed recoverable if an upstream protocol fails.

Worker `2026-10-08-finality-v2` polls every 2 seconds without overlapping runs. It caches only successfully verified finalized Monad receipts in bounded RAM, not pending receipts; restart re-verifies them. After a real Ethereum transfer is observed, it can verify finality directly without repeatedly depending on Relay availability. Noncanonical/missing transfers clear the observation and return to bridge tracking. The `confirming` state still consumes an active-invoice slot. UI polling remains bounded at 5 seconds; no wallet transaction or invoice is recreated to speed up status.

## Route and addresses

- CHOG on Monad: `0x350035555E10d9AfAF1566AaebfCeD5BA6C27777`.
- Monad USDC: `0x754704bc059f8c67012fed69bc8a327a5aafb603`.
- Ethereum USDC: `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`.
- Pinned Burundi beneficiary: `0x1de498918d04B8Bf162210103CDd547f73387B2E`.
- Pinned Relay depository: `0x4cd00e387622c35bddb9b4c962c136462338bc31`.
- Pinned Relay solver: `0xf70da97812cb96acdf810712aa562db8dfa3dbef`.

Custody child addresses are unique HD-derived addresses, allocated and stored before display. There is no single shared donor address and no external Relay deposit-address service. The backend watches finalized CHOG events, funds child gas, approves the exact CHOG amount, sells via an allowlisted Nad.fun router, swaps MON proceeds through Uniswap, approves the exact USDC amount and deposits to Relay. It recomputes the signed Relay order hash and validates the solver signature, tokens, networks, beneficiary, refund destinations and minimum output. Executable quote calldata is not trusted: the deposit call is constructed locally. Original Relay order details are persisted with the bridge job for recovery/audit.

The historical Solidity prototypes are **not deployed or used by this route**. No new ChogCare smart contract was deployed. Security also depends on Nad.fun, Uniswap, Relay, their administrators and the configured RPC providers. Refund terms include protocol trust; a zero minimum refund in the provider order is not a guarantee of principal recovery.

## Limits and persistence

- 300–10,000 CHOG per invoice, 20-minute payment window, at most 3 active invoices, 1,000 stored pilot invoices.
- 5 MON child gas allocation only after a verified CHOG deposit; at most 20 allocations / 100 MON per UTC day, excluding small funding-transaction fees. This is a safety ceiling, not an estimated fee. Root funding and NFT subsidy funding are separate.
- Source gas limits: 1,500,000 gas and 500 gwei maximum fee per gas. Exact approvals; no unlimited allowances.
- Signed transactions are committed before broadcast. Each invoice/phase and sender/nonce are unique. After ambiguous transport results, only identical signed bytes are retried.
- `work/payments/processor.sqlite` holds invoice/address/cursor/state and the signed-transaction journal. Treat it as sensitive and back it up together with the vault using a consistent SQLite backup or after a clean shutdown. Do not copy a live database without its WAL consistency rules.
- Never delete or restore an old database to bypass a pending payment. This can reuse addresses/nonces and break donation accounting. Do not run multiple independent databases with the same vault.

## Interrupted or incorrect payment

```powershell
npm run payments:status
npm run payments:status -- <full-invoice-id>
```

These commands are read-only, require no password, and never print private keys or signed raw transactions. They show persisted invoice information. They do not repair an invoice or prove the current onchain balance.

Underpayments, over-cap amounts, multiple transfers in the scanned range, late payments, reverted source calls and explicit bridge failure/refund require operator review. Eligible single overpayments follow the current policy above. Expired addresses continue to be scanned one per worker tick in rotation. Later transfers to an already-processing/completed address, other tokens, native MON deposits and internal/exchange transfers are **not a supported automatic recovery path**. Never reuse an address. No automatic refund, sweep or manual-signing recovery CLI has been shipped; recovery requires a separately reviewed, invoice-specific process. Do not export child private keys alongside the branch xpub.

Before recovery: stop new invoices, preserve the vault/database, inspect all recorded hashes and actual token balances, establish whether bridge execution is still pending, and only then prepare a bounded recovery transaction. Never replace a nonce or create a second bridge job merely because an API timed out.

## NFT pool — intentionally not activated

The separate 1 MON NFT proof / $0.50 daily benefit still does not issue real payment addresses. Internal proof, budget and payout-outbox modules are tested but not wired into a funded end-to-end worker. Policy remains one NFT claim per UTC day and $10 / 20 grants total daily. Zero treasury funding has been credited. Do not send 1 MON for a preview.

## Verification and remaining launch gates

`npm run security:check` runs build, tests and npm audit. The CHOG worker tests exercise synthetic signed transactions, sequential execution, persisted restart, accepted-submit timeout, wrong amount, wrong destination, unfinalized delivery, wrong RPC network and concurrent invoice limits. Relay validation also uses a recorded real public signed order fixture. `payments:route:check` requests fresh read-only mainnet quotes; it never loads the vault.

Still required before public or significant-volume use: an owner-controlled first real payment, mainnet-fork tests of actual routers, mature failed-route/refund tooling, isolated signer, production operational security, external backup/recovery drills and independent audit. Zero known npm advisories and passing tests are not proof that funds cannot be lost.

Primary protocol reference: [Relay input validation](https://docs.relay.link/references/api/api_core_concepts/input-validation), [EIP-681](https://eips.ethereum.org/EIPS/eip-681).
