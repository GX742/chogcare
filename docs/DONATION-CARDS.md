# Donation images

The verified donation screen shows an initiative-specific image above **Share on X**, with a **Download PNG** link. Downloading saves a 1672 × 941 PNG; the donor can attach it to the X draft manually. The X intent link itself cannot upload the image.

The four active initiatives use owner-supplied artwork, converted to lossless WebP without changing the pixels. Only the selected template loads, after a receipt is eligible for sharing. Archived Burundi receipts use the original header, the Burundi photo and a correctly labelled replacement panel.

- CHOG cards use the verified `invoice.receivedDonationAmount` when available, then the immutable quoted `donationAmount`, then the original amount for historical invoices. The NFT pool contribution is excluded. A verified transfer above the requested total is allocated in full using the 10:1 cause/pool ratio; the original quote and QR never change. The receipt explicitly shows received versus requested totals, with the exact actual allocation in its details and PNG. The large thank-you amount uses an approximation mark if rounded for display.
- NFT cards show the invoice's actual `subsidyUsdc`, including historical 0.50 grants. They say **From the NFT pool** and **USDC**, distinct from the 1 MON verification payment.
- Amounts remain exact decimal strings. The renderer measures the font's ink bounds, centres the amount within the inset window and reduces its size to fit. Very long decimal fractions continue on a smaller second line without rounding or truncation.
- A static Manrope ExtraBold Latin font ensures consistent weight in Safari and Chromium. Source: `@fontsource/manrope` 5.3.0; SIL Open Font License is included beside the asset.

Generation happens locally in the browser using fixed same-origin artwork. Images and filenames contain no invoice recovery ID, wallet address, nickname, NFT identifier or transaction hash. There is no upload endpoint or new server dependency. Blob download URLs are revoked on cleanup; loading failure leaves sharing available and offers a retry.

The card appears automatically inside the verified donation screen, immediately above **Share on X**. Its initiative and exact amount come from that receipt; there is no global gallery button or manual initiative selection. Publishing a leaderboard profile and receiving a delivered NFT grant keep the invoice active in this tab, so the receipt and image survive a page reload. The donor explicitly leaves a delivered receipt with **Make another donation** for CHOG or **Done** for NFT. Those existing actions archive the invoice in private session history and clear the active checkout; archived recovery data remains available in the recovery bundle.

## Validation

`test/donation-card.test.mjs` covers eligible receipt states, initiative/amount validation, exact formatting, safe filenames, NFT attribution and layout bounds. Existing sharing and invoice validation tests continue to cover the receipt boundary.

`test/payable-received-amount.test.mjs` checks that all three received-amount fields arrive together only after a verified deposit, remain within the original pilot limits, and exactly match the integer cause/pool split. Underpayment, malformed or partial metadata and changed quote fields are rejected. The 333 received versus 330 requested fixture produces an exact 302.727272727272727272 CHOG cause card and preserves the original QR. Browser QA verifies both its processing summary and downloaded receipt card in Chromium and WebKit.

Browser QA used synthetic, validated paid invoices with all non-GET API requests blocked: Chromium and WebKit; 1440, 390 and 320 pixel viewports; all four templates; a one-million CHOG donation; an 18-place decimal; current and historical NFT grants; archived Burundi; failed artwork loading and retry. Downloaded files decoded as full-size PNGs. For the four original CHOG templates, pixel comparisons confirmed that all changes stayed inside the amount inset and the rest of the artwork was preserved.

Receipt-lifecycle QA additionally restores a CHOG donation with an already published profile, reloads the page and verifies that the active invoice and inline image remain. Delivered NFT receipts receive the same check. Explicit **Make another donation** and **Done** actions clear only the active invoice and preserve its archive. The global gallery control is absent. Tests make no real payments or profile publications.
