# ChogCare

**Give to a cause. Watch the care station light up.**

ChogCare connects a donation website to a physical care station: a NodeMCU, a colour display and a green LED, visible through a live camera. A verified donation becomes a thank-you on the device.

[Open ChogCare](https://chogcare.xyz) · [Judge access](docs/JUDGE-ACCESS.md) · [Security review](docs/SECURITY-AUDIT-2026-10-18.md)

## For judges

The website and source code are public. **No login, invitation, wallet connection or payment is required to review the project.** Start with the [judge walkthrough](docs/JUDGE-ACCESS.md).

The website runs on Vercel. The live camera, payment worker and USB station run on the operator's computer. Their availability depends on that installation being online; the site shows unavailable states instead of inventing successful activity.

## What the project does

- **Charity selection:** choose education, clean energy, environmental or animal-welfare initiatives.
- **CHOG checkout:** an invoice pins the amount, destination chain and charity recipient. A separate 10% community-pool contribution is shown before payment.
- **Verified delivery:** included transactions, finalized delivery and failed or uncertain processing remain distinct states.
- **Physical response:** after finalized CHOG delivery, the display shows the initiative, amount and thanks. The external LED pulses for the 15-second scene, then turns off.
- **Mobile broadcast:** a lightweight portrait stream, native Safari playback and refreshing camera previews cover the initial video connection period. Autoplay can still require a tap under browser restrictions.
- **Operator tools:** a local Windows app manages owned services, private support messages and the USB bridge. A separate public dashboard is read-only.
- **NFT community pool:** verified CHOG NFT holders can use the configured daily grant while the funded worker is ready. Eligibility and daily limits persist across restarts.

Animal Ethics uses its published Solana donation route. Giveth initiatives use the server-pinned routes described in the [operator runbook](docs/PAYMENTS-LOCAL-PILOT.md). The project does not claim to be a partner of these organisations.

## Run the website locally

Use **Node.js 24.22 or later within the 24.x LTS line**; the exact tested version is in [.node-version](.node-version).

```sh
npm ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:4173`. No custody setup is needed to inspect the interface. A fresh checkout does not include an unlocked payment worker, operator credentials or physical hardware. Use the public website for the existing camera installation.

```sh
npm run build
npm test
npm run security:source
npm audit --audit-level=low
```

Tests use isolated databases, disposable credentials and mocked chain responses. They do not use the operator's keys or make real donations. Windows-only ACL checks require a normal, non-administrator account; hosted CI provisions its own temporary test identity.

## Architecture

| Component | Location | Responsibility |
| --- | --- | --- |
| React / Vite frontend | `src/`, `public/` | Website, checkout instructions and mobile playback |
| Payment worker | `server/`, `scripts/start-payments.mjs` | Validated invoices, pinned routes, chain receipts and durable transaction journals |
| Windows operator app | `admin/`, `src/admin/` | Sandboxed interface and restricted local IPC |
| NodeMCU firmware and USB bridge | `firmware/`, `scripts/station-bridge.mjs` | Display and LED after verified arrivals; cannot send funds |
| Broadcast gateway | `ops/owncast/` | Owncast, isolated mobile encoders and a narrow public media/API proxy |
| Historical contract prototypes | `contracts/` | Isolated contract tests; disconnected from the current hosted custody flow |

The public website cannot execute local admin commands, edit recipients, list support tickets or read custody files. The station bridge cannot create or sign a transaction.

## Security and privacy

The [18 October review](docs/SECURITY-AUDIT-2026-10-18.md) records the checks, fixes and remaining risks. CI runs source guards, full-history secret scanning, regression tests, builds and dependency audits. Published source excludes environment files, keys, encrypted custody backups, financial databases, support messages and local work artifacts.

This remains an **owner-operated payment pilot**, with signing keys unlocked locally during processing. A compromised operator account or computer, third-party protocols and RPC failures remain material risks. Passing checks is not an independent financial audit or a guarantee against every vulnerability. Live blockchain transactions and optional public NFT avatars can reveal identity through correlation.

Do not send passwords, seed phrases, private keys, encrypted backups or private invoice references through a public GitHub issue. [Security reporting instructions](SECURITY.md) explain the private reporting channel.

## Documentation

- [Judge access and a walkthrough without making a payment](docs/JUDGE-ACCESS.md)
- [Current security review](docs/SECURITY-AUDIT-2026-10-18.md)
- [Windows operator guide](docs/CHOGCARE-ADMIN.md)
- [Payment operations and recovery](docs/PAYMENTS-LOCAL-PILOT.md)
- [NFT pool operations](docs/NFT-POOL-OPERATIONS.md)
- [Physical station wiring and firmware](firmware/README.md)
- [Broadcast setup](ops/owncast/README.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)

Earlier dated reviews and historical contract notes describe previous versions. The current checkout does not connect an injected wallet or use the retired wallet-signing flow.
