# ChogCare security review — 18 October 2026

## Verdict and scope

No confirmed exposed custody credential, personal contact detail, private financial file or exploitable critical/high application finding was identified in the checked source, reachable Git history, public HTTP boundaries and GitHub material. This is a bounded internal engineering review, not proof that every vulnerability is absent or an independent production financial audit.

Scope included the current React website, local payment API and transaction/receipt policies, Electron renderer/IPC boundary, local operations storage, USB station bridge, firmware, media proxy, dependency lockfiles and repository publication surface. Historical Solidity prototypes were compiled and tested but remain disconnected from the hosted custody flow.

## Evidence

| Check | Result |
| --- | --- |
| Full JavaScript and isolated contract regression suite on Node 24.22.0 | 565 passed, zero failures or skips, including file replacement, staged symlinks, environment substitution and bounded download regressions |
| Solidity compilation | 32 source units compiled; upstream OpenZeppelin future-keyword warnings remain |
| Full npm audit: root, `ops/payments`, `admin` | 0 known advisories in all three reports at review time |
| Desktop build and native renderer smoke | Passed on Electron 44.9.0 with embedded Node 24.22.0, isolated mock data and no renderer errors |
| Source/release guard | No credential-pattern or forbidden-runtime-file finding |
| Gitleaks 8.30.1, all 45 pre-publication reachable commits | No confirmed secret; two unfiltered matches were the exact public CHOG ERC-20 contract address |
| Seven existing GitHub Actions logs | No Gitleaks finding; no release assets, Actions artifacts, issues or comments required private-data removal |
| Commit author emails | GitHub noreply address only |
| Public images with EXIF/XMP | Three existing charity photos had metadata; no GPS, personal creator/contact or owner tags found. One retained capture timestamps |
| Public website private-file probes | `.env`, Git metadata, custody/support storage, backend scripts and desktop admin paths returned 404 |
| Broadcast relay probes | Administration, general API, metrics, database and temporary-media/directory paths returned 404 |
| New mobile player behaviour | Actual browser playback and preview-to-video handoff passed; image refresh failure retained the previous frame. This was browser emulation, not a physical iPhone certification |

The public CHOG contract address is intentionally documented and is not a wallet private key. The scanner configuration excludes only that exact value; it does not exclude environment examples, documentation, all addresses or whole commits. Scans use full redaction. A randomly generated, in-memory credential canary verifies that CI's scanner actually rejects secrets.

## Changes from this review

1. Added full-history secret scanning to GitHub Actions using an exact Gitleaks version and verified release SHA-256, read-only repository permission and a bounded scan. Existing credential/source guards and dependency audits remain in place.
2. Enabled Dependabot vulnerability alerts on the repository. Judge documentation now separates public website/source access from local operator access.
3. Removed unnecessary PowerShell module/provider discovery from private operations ACL setup. Direct .NET APIs retain the exact owner/SYSTEM/Administrators DACL, reject linked paths, persist Access only and verify the result. The production 15-second bound and fail-closed behaviour were not relaxed. The old hosted CI failed on this startup timeout.
4. Updated the stale avatar source assertion to accept the responsive image attributes while still requiring the intended avatar and accessible text. The earlier full run had 552 passing tests and this one failing assertion; all 553 now pass locally.
5. Replaced conflicting historical README instructions with the current architecture, supported Node LTS setup and a payment-free judge walkthrough. Updated the Windows operator guide's obsolete Node 25 instructions.
6. Removed the hardcoded legacy Twitch channel from current defaults and the environment example. A Twitch fallback now requires explicit configuration; normal Owncast playback is unchanged. Historical client-side account identifiers are not credentials, and Git history was not rewritten.
7. Updated the source's Electron pin and desktop packaging target from 44.7.0 to 44.9.0. The intermediate 44.8.0 release backports Chromium/V8 fixes and moves its embedded Node to 24.22.0; 44.9.0 also fixes window preference inheritance and a certificate-verification race. A regression assertion keeps the packaging target and locked engine aligned. This source update does not replace an already installed desktop binary.
8. Enabled native GitHub secret scanning/push protection, private vulnerability reporting, extended CodeQL for JavaScript/TypeScript, Python and Actions, and protected `main`. The first CodeQL run produced 19 JavaScript signals; the [follow-up](CODEQL-REVIEW-2026-10-18.md) records fixes and per-alert local/test dispositions. The scanner findings are not hidden by the initial clean secret/dependency results.

## Application safeguards inspected

- Public payment routes validate Host, exact Origin for writes, fetch context, request shape, encoding, body sizes, deadlines and rate limits. Responses suppress raw backend errors and are not cached.
- Recipient/asset/chain and QR instructions are server-pinned. Existing request identity, durable transaction bytes, nonce tracking and finalized receipt checks are covered by substitution, retry and restart regressions.
- The Electron renderer is sandboxed with context isolation, no Node integration, restricted local resources and trusted-main-frame IPC. Actions use fixed schemas and allowlisted destinations. The RunAsNode fuse remains enabled for the tested Electron worker transport; inspector and inherited Node-options fuses remain disabled.
- Private support messages and settings use separate, protected local storage. Public status and leaderboard projections omit private invoice capabilities, wallet-address fields and support contents. Optional NFT avatars still permit public-chain correlation.
- Firmware/USB commands cannot sign or create payments. Device tests are explicitly labelled. Normal LED activation follows finalized CHOG delivery, not a page view, invoice or broadcast heartbeat.
- The public gateway exposes narrow HLS/media and payment routes, with loopback listeners and denied administrative routes. Deployment input and Git ignore rules exclude private state.

## Remaining material risks

1. **Custody and workstation trust:** unlocked signing and HTTP handling still share the operator's trust boundary. Malware, administrator access or a compromised account can defeat local storage protections. Signing isolation and independent review are still needed before meaningful unattended volume.
2. **Third-party and network trust:** bridges, RPCs, chain finality assumptions, DNS/TLS, hosting, power and connectivity can fail. Included and finalized transactions remain distinct. Wrong/late deposits and ambiguous transfers require reconciliation; this audit did not move funds or test live end-to-end settlement.
3. **Unsigned NFT reservations:** the no-wallet-signature design can allow temporary slot blocking using public holder data. Limits mitigate rather than eliminate it.
4. **Privacy:** public blockchain addresses, transaction records, voluntarily published nicknames/NFT avatars and camera content can identify people through correlation. A public repository and relay do not provide anonymity.
5. **Local installation:** the locally built Windows installer is unsigned, and published source is not proof that an already installed binary matches it. No installer replacement, secret rotation, custody unlock, integrity re-enrolment or financial database reset was performed.
6. **Review limits:** no whole-computer penetration test, independent protocol/contract audit, comprehensive public-internet DDoS test or physical iPhone certification was performed. Secret scanners can miss unknown patterns. Repository and CI status must be checked at the final published revision.

## Infrastructure version check

Owncast 0.3.0 matches its official stable release at review time. The installed nginx is Ubuntu's `1.28.3-2ubuntu1.11`, including the September CVE-2026-42533 backport; its running executable matches that installed binary. The upstream base version alone does not describe its patch status. The October upstream advisories still require continued vendor tracking. The inspected gateway uses loopback HTTP with no HTTP/3, TLS session tickets, AIO, SSI or URI-rewriting directives; those advisory preconditions were not present in the reviewed public configuration. This is a configuration assessment, not a declaration that every nginx build/configuration is unaffected.

## References

- [Gitleaks CLI and configuration](https://github.com/gitleaks/gitleaks)
- [GitHub Dependabot alerts](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron 44.8.0 fixes](https://github.com/electron/electron/releases/tag/v44.8.0), [44.9.0 fixes](https://github.com/electron/electron/releases/tag/v44.9.0)
- [nginx security advisories](https://nginx.org/en/security_advisories.html)
- [Earlier internal review](SECURITY-AUDIT-2026-10-11.md)
