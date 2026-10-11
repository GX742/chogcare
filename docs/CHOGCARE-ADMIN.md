# ChogCare Admin operator guide

ChogCare Admin manages the existing ChogCare installation on this Windows computer. The desktop app has local controls; the phone dashboard only shows public status and aggregate impact. Opening the app does not unlock custody or authorize a payment.

## Install and start

1. Open `work/admin-release/ChogCare-Admin-Setup-1.0.0.exe` and choose your installation folder. The locally built installer is unsigned; do not disable Windows security protections.
2. Open **ChogCare Admin** from its desktop shortcut. Keep the existing project folder and installed Node.js 25.9 or newer Node 25 runtime available; this release uses that installation rather than copying custody storage into the app.
3. Under **Settings**, check the NodeMCU USB port. The current setup defaults to COM4; use the actual assigned port and close Arduino Serial Monitor before connecting.
4. Choose **Start services**. Enter the existing custody vault password in the app, not in chat. Services already running outside the app are not duplicated or terminated. If an old payment terminal owns the worker, it remains external; finish its normal graceful shutdown before starting an app-managed worker.
5. Choose **Open OBS** and start your camera stream in OBS. The app controls the local Owncast server, not the OBS stream-start button.

The previously running payment worker must complete this one-time handoff to load the new support and dashboard API. A website deployment cannot hot-reload that process. During the handoff the site may briefly pause new payments; existing invoices remain stored and must not be paid again.

Closing the window leaves the app running in the system tray. **Quit safely** drains only app-managed payments, USB bridge and offline support. Owncast, nginx and OBS remain running unless stopped explicitly. Do not force-close the app during a pending financial shutdown or service change.

## Use the controls

- **Overview** shows the latest local checks, service controls and open support count.
- **Services** starts or stops supported fixed components. It cannot execute arbitrary commands or kill an unrelated process. A running local gateway is not proof that the public tunnel is reachable.
- **Bridge fees** fetches a verified read-only estimate for 300, 3,000 or 30,000 CHOG. The separate 10% community-pool contribution is shown. Estimates expire; refresh them before relying on amounts. This screen does not create an invoice, sign or send funds.
- **Support** receives reports submitted explicitly through **Contact support** on the website. You can mark a report read or resolved. Reply manually using the contact the donor supplied; this release does not send automatic replies or emails.
- **Activity** shows bounded, sanitized events rather than raw subprocess logs, keys or signed transactions.
- **Settings** saves the USB port and applies the verified Owncast video profile after you enter its current admin password. Stop and start the OBS stream yourself to apply that video profile. Neither the stream key nor a password is saved by this action.

## Phone dashboard

Open `https://chogcare.vercel.app/dashboard` after deployment. The responsive dashboard uses the supplied CHOG coin and sunset artwork. It shows public service readiness, aggregate CHOG donations when available, daily NFT places and read-only bridge estimates. It has no local service actions or privileged IPC access.

The physical station state is **Not confirmed** until an authoritative public check is available. A failed public request does not prove the underlying service is offline. Bridge estimates never unlock payments or reserve NFT places.

## Support and local security

Reports are stored separately from financial data in `work/support/support.sqlite`. The Windows app protects this directory and `work/admin` to the current Windows account, SYSTEM and Administrators before opening them. Unexpected linked files or failed permission setup stop initialization. Support text is private local plaintext, not encrypted; it is never publicly listed.

Donors choose the message and contact they send. Sharing the invoice reference requires explicit consent. No password, private key, full wallet history or automatic diagnostic dump belongs in a report. Support has request-size, rate, idempotency and storage limits; it can be unavailable when this computer or the existing public gateway is down.

The renderer is sandboxed and can only invoke fixed local actions through verified main-window IPC. Public routes never serve the desktop controls. Passwords are passed in memory for one operation and are not saved in app settings, logs, arguments or environment variables. JavaScript memory handling is not a guarantee of forensic erasure.

This remains a local owner-operated payment pilot. The app does not protect a compromised Windows account, guarantee livestream uptime, eliminate third-party bridge risk or replace an independent financial security audit.

## Developer verification

Use `npm run admin:build` to build the renderer and `npm run admin:package` to produce the Windows installer. `npm test`, `npm run build` and `npm audit` cover the existing website and the new controller, support and dashboard boundaries. `admin/smoke.mjs` checks the native renderer with an isolated mock controller; it never opens a real vault or starts a financial worker.
