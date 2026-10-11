# CHOG payment pilot — operator runbook

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

Wrong amounts, multiple transfers in the scanned range, late payments, reverted source calls and explicit bridge failure/refund require operator review. Expired addresses continue to be scanned one per worker tick in rotation. Later transfers to an already-processing/completed address, other tokens, native MON deposits and internal/exchange transfers are **not a supported automatic recovery path**. Never reuse an address. No automatic refund, sweep or manual-signing recovery CLI has been shipped; recovery requires a separately reviewed, invoice-specific process. Do not export child private keys alongside the branch xpub.

Before recovery: stop new invoices, preserve the vault/database, inspect all recorded hashes and actual token balances, establish whether bridge execution is still pending, and only then prepare a bounded recovery transaction. Never replace a nonce or create a second bridge job merely because an API timed out.

## NFT pool — intentionally not activated

The separate 1 MON NFT proof / $0.50 daily benefit still does not issue real payment addresses. Internal proof, budget and payout-outbox modules are tested but not wired into a funded end-to-end worker. Policy remains one NFT claim per UTC day and $10 / 20 grants total daily. Zero treasury funding has been credited. Do not send 1 MON for a preview.

## Verification and remaining launch gates

`npm run security:check` runs build, tests and npm audit. The CHOG worker tests exercise synthetic signed transactions, sequential execution, persisted restart, accepted-submit timeout, wrong amount, wrong destination, unfinalized delivery, wrong RPC network and concurrent invoice limits. Relay validation also uses a recorded real public signed order fixture. `payments:route:check` requests fresh read-only mainnet quotes; it never loads the vault.

Still required before public or significant-volume use: an owner-controlled first real payment, mainnet-fork tests of actual routers, mature failed-route/refund tooling, isolated signer, production operational security, external backup/recovery drills and independent audit. Zero known npm advisories and passing tests are not proof that funds cannot be lost.

Primary protocol reference: [Relay input validation](https://docs.relay.link/references/api/api_core_concepts/input-validation), [EIP-681](https://eips.ethereum.org/EIPS/eip-681).
