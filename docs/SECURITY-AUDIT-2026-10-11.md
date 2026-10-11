# ChogCare security review

11 October 2026. Scope: frontend and QR instructions, profiles and care board, HTTP admission, CHOG/NFT workers, receipts, custody and integrity controls, historical contracts, physical station bridge, local storage, broadcast proxy and dependencies.

The confirmed findings below have code fixes and regression tests. This remains an owner-operated custody pilot, not independently audited unattended production software. No confirmed public API path for arbitrary signing, redirecting payments or reading private computer files was found in the inspected boundaries. That is not proof that no such vulnerability exists.

## Confirmed fixes

| Finding | Severity | Correction |
| --- | --- | --- |
| NFT metadata was fully downloaded before size checking; cache could grow indefinitely | Medium availability | Streaming 64 KiB cap including chunked/misleading lengths; 128-entry TTL cache; bounded, coalesced profile lookups |
| Metadata gateway redirects could leave the approved origin | Medium conditional | Fixed gateway and rejected redirects; verified donation identity and NFT ownership before lookup |
| Profile and preview writes could proceed during an integrity hold | Medium | Guards before writes and after awaited admission/lookup; protected reads fail closed |
| Failed profile checkpoint could return recovered publication success | Medium | No success before checkpoint completion and final integrity check |
| Concurrent Solana RPC responses used a changing shared request ID | Medium availability | Each response binds to its own immutable request ID |
| Donor draft keys persisted private invoice capabilities longer than necessary | Low privacy | Tab-only storage; only the already-open legacy draft migrates; no restoration of old history |
| Sharing could retain a configured private recovery pathname | Low conditional privacy | Public root only; query and fragment removed |
| Ambiguous client identifiers, avatar URLs and excess DTO fields | Low defense in depth | Full-string validation, shared strict avatar policy, bounded fields and public DTO projection |
| Broadcast configuration could conflict with allowed origins | Low defense in depth | Known public relay only; localhost permitted only from a local application |
| Broadcast errors lacked consistent security headers | Low defense in depth | Server-level nosniff, no-referrer, denied framing, data-only CSP and denied sensitive browser permissions |

Fixed-host construction and rejected redirects follow [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Referrer suppression limits browser URL disclosure, not transaction correlation; see [MDN Referrer Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy).

## Payment safeguards

Payment instructions pin assets, chains, recipients, amounts and canonical QR URIs. Source identity comes from verified chain evidence rather than submitted wallet or nickname fields. Signed bytes and nonce are committed before broadcast; uncertain submission retries those same bytes. Canonical finalized receipt verification, funded budgets and persisted token/day plus wallet/day checks remain enforced across restart and NFT transfer.

The public API has no recipient-edit, arbitrary-sign, funding-credit or manual-recovery endpoint. The station bridge only reads verified payment state and sends bounded USB thank-you messages after finalized CHOG delivery. Historical Solidity contracts are disconnected prototypes, not independently reviewed production contracts for this custody pilot.

## Exposure and storage

Checked Vercel private paths, including `.env`, `.git/config`, custody storage and backend/script sources, return 404. The relay rejects Owncast administration, general API, metrics and database paths. Its only published routes are HLS and the payment API. Inspected local application services bind to loopback. This is not a complete router or whole-computer penetration test.

Owncast uses its dedicated unprivileged account, NoNewPrivileges, private temporary/device namespaces and a strict filesystem boundary. Its data directory is mode 700, database/sidecars 600, and recovery backup directory root-owned mode 700. Installed v0.3.0 matches the currently listed [official stable release](https://github.com/owncast/owncast/releases/tag/v0.3.0). The proxy does not expose the Owncast UI or chat.

Windows payment-storage ACLs allow only the owner, SYSTEM and Administrators. Vault, databases, checkpoints, local environment files and working artifacts are ignored by Git. A known credential-pattern scan found no matching release files; this is not exhaustive entropy scanning or a guarantee about every historical revision.

Video is served through a relay, not a direct home-IP URL. Tailscale describes Funnel as hiding the device IP behind its relay; see [Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel). The provider still knows connection information. Camera content, unrelated services, public blockchain activity or compromised accounts can reveal identity. Do not promise that nobody can infer the owner's location.

## Residual risks

1. **Custody and host compromise.** HTTP handling and unlocked signing keys share a process/account. Malware, administrators or OS compromise can access that trust boundary. ACLs and an encrypted vault do not solve compromise after unlocking. Keep pilot balances small; isolate the signer and get independent review before meaningful unattended volume.
2. **Unsigned NFT reservations.** The owner chose no wallet connection/signature. Public holder/token information allows temporary slot blocking. Short holds and rate limits mitigate but do not eliminate abuse; ownership proof before reservation would require changing this flow.
3. **Identity correlation.** Wallet addresses are not directly displayed on the board. NFT avatars/token IDs and public receipts can nevertheless identify their onchain owner. The ChogCare badge reduces avatar linkage, not blockchain visibility.
4. **Protocol and RPC trust.** Relay, configured RPCs, upstream administrators, DNS/TLS and reorg assumptions remain trusted. Refunds, wrong/late deposits and ambiguous transfers need invoice-specific reconciliation; automatic refunds are not implemented.
5. **Availability.** Home power/uplink, Funnel and RPC outages can stop payments or video. Application rate limits do not guarantee distributed denial-of-service resistance. Vercel does not keep the local worker alive.
6. **Windows firewall.** Two broad Public inbound Node.js allowances remain enabled because the audit process lacks administrator permission. Current loopback binding limits exposure, but those rules are unnecessary if a future Node service binds broadly. Other OS services, router forwarding and account security are not certified by this source review.

## Required operator actions

In **administrator PowerShell**, from the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\harden-node-firewall.ps1
```

The helper validates the two exact rule names, program, profiles, protocols, ports and addresses before disabling them. It supports `-WhatIf`, creates no allowances, does not turn off the firewall and prints precise rollback commands. Private-network rules, OBS, Tailscale and payment processes are unchanged.

In a separate normal owner terminal, start the existing updated worker with `npm run payments:start` and the existing hidden vault password. Verify config/readiness before creating a new invoice. Do not reenroll, delete databases or pay again to fix a timeout. Restart the station USB bridge separately if used; publication does not restart local processes.

## Verification

The full JavaScript suite passes **270/270**, including synthetic processor/HTTP tests, browser boundaries, NFT/day accounting, amount/recipient substitutions, concurrent requests, journal restart and the new audit regressions. Linux Owncast recovery mock tests pass **29/29**, and isolated PowerShell configuration checks pass. Production TypeScript/Vite build and compile-only NodeMCU firmware checks succeed; no device was flashed. The full npm report lists **zero known advisories** across 224 installed dependency entries at audit time. These checks do not prove host security, protocol economics or real end-to-end settlement.

The proxy passed `nginx -t` and was applied with a soft nginx reload, not an Owncast or payment restart. Local worker fixes take effect after an owner-controlled worker start. No real transfer, custody decryption, secret rotation, database reset or historical invoice restoration was performed during this review.
