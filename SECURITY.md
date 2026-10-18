# Security policy

## Scope

The current main branch is the maintained version. Older reviews and disconnected contract prototypes are historical references. ChogCare is an owner-operated custody pilot and has not received an independent production security audit.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** feature for this repository. Include the affected revision, the component, reproduction steps using disposable data and the expected impact.

Do not put custody keys, seed phrases, passwords, encrypted vaults, financial databases, support contacts or private invoice recovery references in public issues or pull requests. Do not test a report by moving real funds or accessing another person's data.

## Automated checks

- A pinned, checksum-verified Gitleaks CLI scans fetched Git history with secret values fully redacted. Its only project-specific exception is the exact public CHOG contract address.
- Source guards reject private/runtime files and common credential patterns before publication.
- CI runs isolated regression tests, the production build and npm audits for the website, payment runtime and desktop package.
- GitHub Dependabot and native scanning add advisory coverage where enabled; their availability does not replace local review.

The [dated security review](docs/SECURITY-AUDIT-2026-10-18.md) records verification evidence and the limits of these checks. No scan or test suite establishes that every vulnerability is absent.
