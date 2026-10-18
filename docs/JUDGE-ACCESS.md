# Judge access

## Submission fields

**GitHub repository:** https://github.com/GX742/chogcare

**Website:** https://chogcare.xyz

Put the project owner's contact email in the organisers' private contact field. It is not published in this repository.

The following text fits the form's 8,000-character judge-access limit:

> ChogCare's website and GitHub source are public. No invitation, account, password, wallet connection or payment is required to review the project.
>
> Open https://chogcare.xyz on desktop or iPhone/Safari. The home page shows the real physical care station through the live camera. Video starts muted; tap Play broadcast if the browser requires it. Select Choose a cause, inspect an initiative and open its donation options. Review the amount, separate 10% community-pool contribution and availability notices. You do not need to send funds or create a payable invoice.
>
> The live camera, Arduino and payment worker are operated locally. If the installation is offline or custody is locked, the site reports that state. Website deployment alone does not start those services. The public dashboard at https://chogcare.xyz/dashboard is read-only; desktop admin controls and custody credentials are not shared with judges.
>
> Source, setup instructions and the dated security review are in https://github.com/GX742/chogcare. For a local interface review, use Node.js 24.22+ within the 24.x line, run npm ci --ignore-scripts, then npm run dev. npm test runs isolated tests without real transfers or operator keys. Historical Solidity prototypes are not the settlement backend of the hosted app.

## Suggested walkthrough

1. Open the website and observe the physical device. A camera preview can appear before full video playback; the LIVE badge refers to playing video.
2. Choose a cause and read its project details and donation route.
3. Open donation options and inspect the amount, pool allocation and total. Stop before any payment. An unavailable checkout is an operational state, not a simulated successful donation.
4. Open the public dashboard. It contains aggregate status and read-only estimates; it has no service-start, signing or private inbox controls.
5. Inspect `firmware/` for the display and LED sequence, `server/` for payment validation and `test/` for regression coverage.
6. Read the current security review for the difference between tested safeguards and residual custody, host and protocol risks.

## Physical station verification

The operator can run **ChogCare Admin → Services → Care station → Test screen** on the connected Windows installation. It sends a fixed, explicitly labelled **TEST - NO PAYMENT** scene and does not create a transaction, donation-history record or leaderboard entry. Judges do not need the operator's password or remote desktop access.

Real celebrations require finalized CHOG delivery. Opening the page, watching the camera or creating an unpaid invoice does not light the donation LED. The LED turns off after the 15-second scene.
