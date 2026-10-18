# Donation images

The verified donation screen shows an initiative-specific image above **Share on X**, with a **Download PNG** link. Downloading saves a 1672 × 941 PNG; the donor can attach it to the X draft manually. The X intent link itself cannot upload the image.

The four active initiatives use owner-supplied artwork, converted to lossless WebP without changing the pixels. Only the selected template loads, after a receipt is eligible for sharing. Archived Burundi receipts use the original header, the Burundi photo and a correctly labelled replacement panel.

- CHOG cards use `invoice.donationAmount`, falling back to the original amount for historical invoices. The additional 10% pool contribution is excluded.
- NFT cards show the invoice's actual `subsidyUsdc`, including historical 0.50 grants. They say **From the NFT pool** and **USDC**, distinct from the 1 MON verification payment.
- Amounts remain exact decimal strings. The renderer measures the font's ink bounds, centres the amount within the inset window and reduces its size to fit. Very long decimal fractions continue on a smaller second line without rounding or truncation.
- A static Manrope ExtraBold Latin font ensures consistent weight in Safari and Chromium. Source: `@fontsource/manrope` 5.3.0; SIL Open Font License is included beside the asset.

Generation happens locally in the browser using fixed same-origin artwork. Images and filenames contain no invoice recovery ID, wallet address, nickname, NFT identifier or transaction hash. There is no upload endpoint or new server dependency. Blob download URLs are revoked on cleanup; loading failure leaves sharing available and offers a retry.

After a profile is published, its invoice moves into the existing private session history. **Your donation images** remains available above the main content, including after reloading that same tab. It automatically opens the newest saved donation, verifies its receipt and matches the initiative artwork and exact amount without manual selection. Legacy v1 history is supported. Viewing an image never reactivates or replaces an outstanding payment. Nothing is fetched until the button is opened; closing the dialog releases the generated image.

## Validation

`test/donation-card.test.mjs` covers eligible receipt states, initiative/amount validation, exact formatting, safe filenames, NFT attribution and layout bounds. Existing sharing and invoice validation tests continue to cover the receipt boundary.

Browser QA used synthetic, validated paid invoices with all non-GET API requests blocked: Chromium and WebKit; 1440, 390 and 320 pixel viewports; all four templates; a one-million CHOG donation; an 18-place decimal; current and historical NFT grants; archived Burundi; failed artwork loading and retry. Downloaded files decoded as full-size PNGs. For the four original CHOG templates, pixel comparisons confirmed that all changes stayed inside the amount inset and the rest of the artwork was preserved.

Receipt-history QA additionally covers profile completion followed by reload, old session history with a different active checkout, automatic matching of the latest receipt, native downloads, network failure/retry, identity substitution rejection, Escape/focus handling, and unchanged session storage throughout viewing. Tests make no real payments or profile publications.
