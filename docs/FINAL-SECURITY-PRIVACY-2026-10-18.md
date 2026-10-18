# ChogCare final security and privacy review — 18 October 2026

## Verdict

The reviewed application did not reveal a working remote chain for stealing funds, substituting a recipient, replaying a payout, executing code, injecting SQL, or reading private custody/support files. This is an internal engineering assessment, not an independent financial audit or proof that unknown vulnerabilities are absent.

Two availability weaknesses were corrected and confirmed active in the running service. Personal email was removed from the current public branch histories, but an old GitHub commit object still exposes the original author metadata. Important availability limitations and that archived disclosure remain distinct from protection of funds. The project must not be described as fully anonymous, invulnerable, or completely free of personal data.

The requested threat model excludes a previously compromised operator computer/account. Exploitation of the application's public interfaces remains in scope, including the possible impact of an unknown remote-code-execution flaw on its locally unlocked signer. RPC, bridge, hosting, DNS/TLS and liquidity assumptions remain relevant even with an uncompromised computer.

## Evidence

| Check | Result |
| --- | --- |
| Complete JavaScript/isolated-contract suite after fixes, Node 24.22.0 | 676 tests: 675 passed, zero failures, one explicitly skipped native C++ fixture because no host compiler is installed |
| Solidity prototypes | Compiled by the test workflow; these contracts are disconnected from current hosted settlement |
| Website build and source release guard | Passed; no detected credential pattern or forbidden runtime artifact |
| npm audits, root / payment package / desktop package | Zero known advisories in all three reports at review time |
| Gitleaks 8.30.1, public reachable history and production assets | No detected credential; author metadata required a separate review |
| Public HTTP review | 31 low-rate read-only probes: site/media/API available; tested environment/Git/database/backend/admin/private-media paths denied; foreign Origin rejected |
| Private invoice enumeration | No invoice listing endpoint; a synthetic unknown 256-bit recovery reference returned 404 |
| Public leaderboard projection | No wallet-address, private invoice-reference, contact, session or custody fields in the checked reply |
| Session cookie and browser boundary | HttpOnly, Secure, SameSite=Strict; no-store API replies, no-referrer, CSP and frame restrictions confirmed |
| Existing payment databases | Read-only SQLite quick_check returned ok for both databases; no financial records modified |
| GitHub | Required verify/history-secret/CodeQL checks on protected main; read-only workflow token; no open CodeQL, Dependabot or secret-scanning alerts at review time |
| Public assets and metadata | 36 tracked images reviewed; three initiative photos retain third-party metadata, without detected owner contact/GPS tags; no production source maps or private paths detected |
| Public GitHub discussion surfaces | 22 PR bodies, 22 issue comments and two review comments checked without finding the identified personal mailbox |

Tests use disposable state and mocked chains; public probes did not create invoices, reserve grants, submit support messages, sign transactions or move funds. An initial heavily parallel full run hit a brittle 50 ms fallback test timeout. The corrected fixture still gives the intentionally hung primary a short timeout, verifies the backup's chain and result, and permits the healthy local backup two seconds. Production RPC deadlines were not relaxed. The complete rerun passed.

## Corrected findings

1. **Unpaid requests could lock a real NFT identity out for the UTC day.** Checkout creation does not prove control of the supplied holder address. Counting expired unpaid requests against that public wallet/NFT allowed another caller to trigger its day-long denial. Unpaid expiry no longer consumes daily identity eligibility. Active/ambiguous reservations, actually paid wallet/NFT daily claims, exact verified 1 MON payments, replay prevention and the shared three-grant budget remain enforced. Regression tests cover restart, changed ownership and successful paid-claim limits.
2. **Invalid NFT requests could consume permanent request-journal capacity.** New NFT requests now perform a strictly read-only eligibility check before claiming a durable request key. Ownership/daily-limit/RPC failures before issuance do not allocate an address, reserve funds or write the journal. The worker repeats the same checks during issuance; a successful preflight is never cached authorization. Existing pending/complete keys and their original invoice IDs are preserved. Tests cover concurrent requests, ownership changes, readiness/integrity changes and uncertain post-allocation errors.
3. **The optional donor-profile privacy notice was incomplete.** It now says that joining publishes nickname, avatar, donation amount and cause on the care board and live station. It retains the warning that an NFT avatar can be linked to its onchain owner.
4. **Future merge-author privacy is explicit.** Repository instructions require a verified GitHub noreply author for commits and an explicit noreply author override for squash merges, followed by a public metadata check. A repository-level metadata rule was attempted, but GitHub rejected that rule type; no such server-side enforcement is claimed.

The owner restarted Payments, and the public configuration confirmed the corrected worker marker `2026-10-18-security-preflight-v13`, payments enabled, custody configured and integrity unlocked. A successful frontend deployment alone does not update an already-running local worker. Existing passwords remained local; no vault reset, integrity re-enrolment, invoice deletion or financial-history migration was performed.

## Confirmed privacy issue: GitHub author metadata

The original public history contained **13 commits with a personal author mailbox**, including squash merges. The repository files and built website did not contain that mailbox. With explicit owner approval, the current public histories were cleaned. The public profile retains its display name at the owner's request; this review cannot establish whether it is a legal name or a pseudonym. Exact private values are deliberately omitted here.

A clean credential scan did not detect this contact-metadata issue. Local noreply commits alone were insufficient: a GitHub squash merge can select the account's personal email unless its author address is explicitly overridden. The owner confirmed enabling GitHub's email-privacy and email-exposing-push protection settings. The published fix's author and committer email addresses were independently checked without displaying any private value.

The approved repair was published atomically with exact per-ref leases: 21 heads changed and two unaffected heads remained intact. Across all 23 public heads and 86 reachable commits, 13 email records and 14 author names were normalized; only 39 necessary commits were recreated and 47 original OIDs remained intact. All file trees, messages, dates, author metadata on the other 72 commits, every committer identity and parent topology were verified unchanged. Invalidated signatures were removed from recreated commits. Original bare repositories and bundles remain private. Main's complete branch-protection response was verified identical before and after the temporary exception.

A fresh public clone independently confirmed every expected head, all 86 content trees and zero matches for the identified private email in reachable author/committer metadata and messages. Local branches were aligned where mapped; private-only old branches and backups were retained locally. A tested local push guard blocks accidental republication of pre-cleanup history. This does not erase third-party copies or replace GitHub's account privacy settings.

Rewriting heads does **not** erase old pull-request refs, cached commit URLs, forks or copies already obtained by others. After publication, an old commit remained accessible through GitHub's API and still contained the private email. A private support-request draft was prepared but not sent; GitHub must determine whether it can purge those retained objects under its policies. Erasure from all third-party copies cannot be promised. See [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Remaining material risks

- **Anonymous checkout availability.** A caller can still occupy the small unpaid CHOG queue or reserve NFT slots using valid public holder data. The preflight fixes invalid requests and the targeted day-long penalty; it does not authenticate the person opening a valid reservation. Stronger protection needs a bot challenge and/or a signed holder intent before reservation, which changes the present interaction model.
- **Finite pilot storage.** CHOG/NFT invoice retention and the immutable request journal have finite lifetime caps. Valid unpaid requests can still consume retained capacity. Automatically deleting old or ambiguous records would risk duplicate addresses/payments, so this review does not do that. Capacity monitoring and reviewed archival, plus stronger admission, remain necessary for sustained unattended use.
- **DoS and dependencies.** Application limits do not guarantee resistance to distributed flooding. Service availability still depends on the operator installation, power, network, RPC providers, Relay and liquidity. Origin checks are browser protections, not authentication of a non-browser client.
- **Custody.** HTTP handling and unlocked signing remain within one local service boundary. No direct remote exploitation chain was found, but an unknown server exploit would have a larger impact than it would with an isolated policy-limited signer. This remains an owner-operated custody pilot.
- **Public-chain correlation.** Donor nicknames, NFT selections, initiative/amount data, public treasury/funder/authorized-holder addresses and chain transactions can be linked. Omitting wallet fields from the leaderboard does not provide anonymity. Camera content is public and must be kept free of private documents or people who have not agreed to appear.
- **Publication and accounts.** GitHub/Vercel/DNS access remains security-critical. GitHub account 2FA status was unavailable through the checked API and is not claimed verified. An installed unsigned desktop binary is not proven to match the source by repository checks alone.

## Running infrastructure

The inspected payment listeners bind to Windows loopback on ports 4174/4175 and run Node 24.22.0. Owncast, nginx, the media input helper and RTMP bind to WSL loopback. Media units use an unprivileged user, no capabilities, NoNewPrivileges, private temporary storage and restricted filesystem access. Two broad Windows inbound exceptions for the dedicated Node runtime exist; loopback-only binding currently prevents those application listeners from being remotely reachable. Removing unnecessary exceptions is separate administrator hardening, not evidence that a public payment port was found.

The running nginx package is Ubuntu `1.28.3-2ubuntu1.11`; its packaged changelog includes the CVE-2026-42533 security fix. Reviewed active configuration has no TLS/QUIC listener, URI rewrite directive, AIO, SSI or slice configuration. These facts constrain relevant upstream advisory preconditions; the base version alone is not a complete patch assessment. No general claim that every possible nginx configuration is unaffected is made. Track [official nginx advisories](https://nginx.org/en/security_advisories.html) and the distribution's updates.

## Practical release assessment

The assessed code has meaningful fund-binding, replay, storage and browser-boundary protections, with automated regression coverage. The evidence supports a controlled public pilot. It does not establish complete bot resistance, anonymity or the absence of every vulnerability. The two code corrections are active in the running worker. The current public histories are cleaned, while retained GitHub objects still require a separate privacy/support resolution before claiming that personal data has been removed everywhere.
