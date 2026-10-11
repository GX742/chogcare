import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { broadcastStreamUrl, publicBroadcastOrigin } from "../src/broadcast-source.ts";
import { validInvoiceId, pendingCreation } from "../src/checkout-session.ts";
import { chogBeneficiary } from "../src/chog-beneficiary.ts";
import { donationShare } from "../src/donation-share.ts";
import { CHOG } from "../src/route.ts";
import { validatePayableInvoice } from "../src/payable-invoice.ts";
import { validateNftInvoice } from "../src/nft-invoice.ts";
import { clearDonorDraft, donorDraftKey, normalizeDonorNickname, parseNftOptions, parsePublicProfile, readDonorDraft, saveDonorDraft, validAvatarTokenId } from "../src/donor-profile-model.ts";
import { contentSecurityPolicy, privateWebPath } from "../server/web-boundary.ts";

const invoiceId = "a".repeat(64), hash = `0x${"b".repeat(64)}`;
const depositAddress = "0x3333333333333333333333333333333333333333", holderAddress = "0x1111111111111111111111111111111111111111";
const cid = "bafybeihau2egcccbdxymeckmmbrqytbfor5gkt3en6d5fsbueymdbq7g6e";
const image = `https://gateway.pinata.cloud/ipfs/${cid}/1130.webp`;
const nft = { tokenId: "1130", name: "CHOG #1130", image };
const profile = { nickname: "GX", amount: "300", initiativeId: "solar-foundation", avatarTokenId: "1130", avatarName: nft.name, avatarImage: image, publishedAt: 1791700000000 };
function storage(initial = []) {
  const values = new Map(initial);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function chogInvoice(changes = {}) {
  return {
    kind: "payment", id: invoiceId, mode: "chog", asset: "CHOG", chainId: 143, amount: "330", initiativeId: "solar-foundation",
    recipient: chogBeneficiary("solar-foundation", 10), depositAddress, paymentUri: `ethereum:${CHOG}@143/transfer?address=${getAddress(depositAddress)}&uint256=${330n * 10n ** 18n}`,
    minUsdc: "880000", state: "awaiting-payment", expiresAt: Date.now() + 60000, depositHash: null, bridgeHash: null, destinationHash: null,
    deliveredUsdc: null, observedUsdc: null, observedDestinationHash: null, message: null,
    destinationChainId: 10, destinationAsset: "USDC", destinationDecimals: 6, minimumUsd: "880000", bridgeEstimatedSeconds: null,
    donationAmount: "300", poolContributionAmount: "30", contributionPercent: 10, poolContributionState: "pending", ...changes,
  };
}
function nftInvoice(changes = {}) {
  return {
    kind: "payment", id: invoiceId, mode: "nft", amount: "1", asset: "MON", chainId: 143, destinationChainId: 10,
    initiativeId: "solar-foundation", recipient: chogBeneficiary("solar-foundation", 10), subsidyUsdc: "1.00",
    tokenId: "1130", holderAddress, depositAddress, paymentUri: `ethereum:${depositAddress}@143?value=1000000000000000000`,
    expiresAt: Date.now() + 60000, claimDay: "2026-10-11", state: "awaiting-payment", depositHash: null, destinationHash: null, observedDestinationHash: null, message: null, ...changes,
  };
}

test("public broadcast source is pinned to the CSP relay and strips unrelated paths", () => {
  const expected = `${publicBroadcastOrigin}/hls/stream.m3u8`;
  assert.equal(broadcastStreamUrl(undefined, "https://chogcare.vercel.app"), expected);
  assert.equal(broadcastStreamUrl(`${publicBroadcastOrigin}/admin?secret=1#key`, "https://chogcare.com"), expected);
  for (const value of ["https://evil.example", "https://127.0.0.1:8080", "https://192.168.1.1", "http://127.0.0.1:8080", "http://localhost:8080", `${publicBroadcastOrigin}:444`, publicBroadcastOrigin.replace(".net", ".net.evil.example"), publicBroadcastOrigin.replace("https://", "https://user:password@"), `${publicBroadcastOrigin}\n`, "javascript:alert(1)", "//evil.example", {}, null]) {
    assert.equal(broadcastStreamUrl(value, "https://chogcare.vercel.app"), null, String(value));
  }
});
test("loopback Owncast is allowed only from the local app and only on the CSP port", () => {
  for (const app of ["http://127.0.0.1:4173", "http://localhost:4173", "http://[::1]:4173"]) {
    for (const source of ["http://127.0.0.1:8080", "http://localhost:8080"]) assert.equal(broadcastStreamUrl(source, app), `${source}/hls/stream.m3u8`);
  }
  for (const app of ["https://localhost.evil.example", "https://example.com", "file:///local/site.html"]) assert.equal(broadcastStreamUrl("http://localhost:8080", app), null);
  for (const source of ["http://localhost:4174", "http://127.0.0.1:80", "http://[::1]:8080", "http://192.168.1.1:8080"]) assert.equal(broadcastStreamUrl(source, "http://localhost:4173"), null);
});

test("share links never disclose checkout paths, query strings or fragments", () => {
  const input = { state: "delivered", mode: "chog", amount: "330", initiativeId: "solar-foundation" };
  const share = donationShare(input, `https://chogcare.example/invoices/${invoiceId}/profile?wallet=secret#private`);
  assert.equal(share.site, "https://chogcare.example/");
  assert.doesNotMatch(share.href, /invoices|secret|private|aaaaaaaa/);
  for (const change of [{ initiativeId: "__proto__" }, { initiativeId: "constructor" }, { mode: "anything" }, { amount: "330\n" }, { amount: "330\u2028" }, { amount: 330 }, { amount: "0" }]) assert.equal(donationShare({ ...input, ...change }), null);
});

test("invoice recovery capabilities and pending keys require full matches", () => {
  assert.equal(validInvoiceId(invoiceId), true);
  for (const id of [`${invoiceId}\n`, `${invoiceId}\r\n`, `${invoiceId}\u2028`, invoiceId.toUpperCase(), [], {}, undefined]) assert.equal(validInvoiceId(id), false);
  const store = storage([["chogcare:pending-chog:v1", JSON.stringify({ key: "12345678-1234-4123-8123-123456789012\n", input: { mode: "chog", amount: "300", holderAddress: "", initiativeId: "solar-foundation" } })]]);
  assert.throws(() => pendingCreation("chog", store), /invalid/);
});
test("CHOG instructions reject coerced amounts and ambiguous identifiers or receipts", () => {
  assert.equal(validatePayableInvoice(chogInvoice()).amount, "330");
  for (const change of [{ id: `${invoiceId}\n` }, { amount: "330\n" }, { minUsdc: 880000 }, { minUsdc: "880000\n" }, { minimumUsd: "880000\n" }, { donationAmount: "300\n" }, { poolContributionAmount: "30\n" }, { depositHash: `${hash}\n` }, { bridgeHash: `${hash}\n` }, { destinationHash: `${hash}\n` }, { observedDestinationHash: `${hash}\n` }, { deliveredUsdc: "880000\n" }, { observedUsdc: "880000\n" }, { message: {} }, { message: "x".repeat(301) }]) {
    assert.throws(() => validatePayableInvoice(chogInvoice(change)), JSON.stringify(change));
  }
});
test("client DTO projection does not retain unexpected private invoice properties", () => {
  for (const [makeInvoice, validate] of [[chogInvoice, validatePayableInvoice], [nftInvoice, validateNftInvoice]]) {
    const source = makeInvoice({ privateKey: "synthetic", signedTransaction: "synthetic", vaultReference: "synthetic" });
    const parsed = validate(source);
    assert.equal(parsed.id, invoiceId);
    assert.doesNotMatch(JSON.stringify(parsed), /privateKey|signedTransaction|vaultReference|synthetic/);
    assert.equal(source.privateKey, "synthetic", "Do not mutate the response");
  }
});
test("NFT payment identity, day and receipt validation reject malformed exact values", () => {
  assert.equal(validateNftInvoice(nftInvoice()).tokenId, "1130");
  for (const change of [{ id: `${invoiceId}\n` }, { tokenId: "1130\n" }, { tokenId: 1130 }, { tokenId: String(2n ** 256n) }, { claimDay: "2026-10-11\n" }, { claimDay: "2026-02-30" }, { claimDay: "2026-13-01" }, { expiresAt: 0 }, { depositHash: `${hash}\n` }, { destinationHash: `${hash}\n` }, { observedDestinationHash: `${hash}\n` }]) assert.throws(() => validateNftInvoice(nftInvoice(change)), JSON.stringify(change));
});

test("profile parsing uses bounded public fields and the strict avatar URL guard", () => {
  const source = { ...profile, invoiceId, walletAddress: holderAddress, privateKey: "synthetic" };
  assert.deepEqual(parsePublicProfile(source), profile);
  assert.doesNotMatch(JSON.stringify(parsePublicProfile(source)), /invoiceId|walletAddress|privateKey|synthetic/);
  for (const change of [{ nickname: "x".repeat(25) }, { nickname: "GX\u202e" }, { amount: "300\n" }, { initiativeId: "__proto__" }, { avatarTokenId: "1130\n" }, { publishedAt: "1791700000000" }, { publishedAt: 0 }]) assert.equal(parsePublicProfile({ ...profile, ...change }), null);
  for (const value of [`${image}\n`, `https://gateway.pinata.cloud/ipfs/${cid}/../secret.png`, `https://gateway.pinata.cloud/ipfs/${cid}/%2e%2e/secret.png`, "https://evil.example/avatar.png", "data:image/svg+xml,<svg/onload=alert(1)>"]) assert.equal(parsePublicProfile({ ...profile, avatarImage: value }).avatarImage, null);
});
test("NFT options reject numeric coercion, uint256 overflow, duplicate tokens and unsafe metadata", () => {
  assert.deepEqual(parseNftOptions([nft, nft, { ...nft, tokenId: 1130 }, { ...nft, tokenId: "1130\n" }, { ...nft, tokenId: String(2n ** 256n) }, { ...nft, tokenId: "2", name: "x".repeat(81) }]), [nft]);
  assert.equal(parseNftOptions([{ ...nft, image: `https://gateway.pinata.cloud/ipfs/${cid}/../admin` }])[0].image, null);
  assert.equal(parseNftOptions(Array.from({ length: 50 }, (_, index) => ({ ...nft, tokenId: String(index) }))).length, 24);
  assert.equal(validAvatarTokenId(String(2n ** 256n - 1n)), true);
  assert.equal(validAvatarTokenId(String(2n ** 256n)), false);
  assert.equal(normalizeDonorNickname("  GX   Crew  "), "GX Crew");
  for (const value of ["<script>", "GX\u202e", "GX\0", "x".repeat(100), null, {}]) assert.equal(normalizeDonorNickname(value), null);
});
test("donor draft storage is per-session and only migrates the already-open invoice", () => {
  const key = donorDraftKey(invoiceId), otherKey = donorDraftKey("b".repeat(64)), draft = { nickname: "GX", avatarTokenId: "1130" };
  const legacy = storage([[key, JSON.stringify(draft)], [otherKey, JSON.stringify(draft)]]), session = storage();
  assert.deepEqual(readDonorDraft(invoiceId, [nft], session, legacy), draft);
  assert.equal(session.getItem(key), JSON.stringify(draft));
  assert.equal(legacy.getItem(key), null);
  assert.equal(legacy.getItem(otherKey), JSON.stringify(draft), "Do not enumerate or restore old history");
  saveDonorDraft(invoiceId, { nickname: "GX", avatarTokenId: null }, [nft], session);
  assert.deepEqual(readDonorDraft(invoiceId, [nft], session), { nickname: "GX", avatarTokenId: null });
  clearDonorDraft(invoiceId, session, legacy);
  assert.equal(session.getItem(key), null);
  assert.equal(legacy.getItem(key), null);
});
test("invalid or stale drafts cannot silently publish a nickname or an unowned avatar", () => {
  const key = donorDraftKey(invoiceId), session = storage();
  for (const draft of [{ nickname: "x".repeat(25), avatarTokenId: null }, { nickname: "GX", avatarTokenId: "99999" }, { nickname: "GX", avatarTokenId: 1130 }, { nickname: "GX\u202e", avatarTokenId: null }]) {
    session.setItem(key, JSON.stringify(draft));
    assert.equal(readDonorDraft(invoiceId, [nft], session), null);
    assert.throws(() => saveDonorDraft(invoiceId, draft, [nft], session));
  }
  assert.throws(() => donorDraftKey(`${invoiceId}\n`));
});
test("migration does not delete a valid persistent choice before the session save succeeds", () => {
  const key = donorDraftKey(invoiceId), raw = JSON.stringify({ nickname: "GX", avatarTokenId: null }), legacy = storage([[key, raw]]);
  const failed = { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); }, removeItem: () => {} };
  assert.throws(() => readDonorDraft(invoiceId, [], failed, legacy));
  assert.equal(legacy.getItem(key), raw);
});

test("local boundary blocks database sidecars, certificate files and nonce line breaks", () => {
  for (const path of ["/data.sqlite3", "/data.sqlite3-wal", "/data.sqlite3-shm", "/data.sqlite-journal", "/data.db-wal", "/data.db-shm", "/data.db-journal", "/certificate.crt", "/certificate.cer", "/certificate.der", "/data.db-wal%20."]) assert.equal(privateWebPath(path), true, path);
  assert.throws(() => contentSecurityPolicy(`${"a".repeat(24)}\n`), /nonce/);
});
test("deployed CSP and referrer policy preserve private capability boundaries", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const headers = new Map(config.headers.flatMap(rule => rule.headers).map(header => [header.key, header.value]));
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.match(headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(headers.get("Content-Security-Policy"), /script-src 'self';/);
  assert.match(headers.get("Content-Security-Policy"), /style-src 'self';/);
  assert.match(headers.get("Content-Security-Policy"), /form-action 'none'/);
  assert.match(contentSecurityPolicy(), /img-src[^;]*https:\/\/gateway\.pinata\.cloud/);
  assert.doesNotMatch(headers.get("Content-Security-Policy"), /unsafe-inline|unsafe-eval|localhost|127\.0\.0\.1|https:\*/);
  assert.deepEqual(config.rewrites, [
    { source: "/api/payments/:path*", destination: `${publicBroadcastOrigin}/api/payments/:path*` },
    { source: "/dashboard", destination: "/index.html" },
    { source: "/dashboard/", destination: "/index.html" },
  ]);
});
test("public privacy copy distinguishes omission of wallet addresses from NFT anonymity", () => {
  const board = readFileSync(new URL("../src/Leaderboard.tsx", import.meta.url), "utf8"), donor = readFileSync(new URL("../src/DonorProfile.tsx", import.meta.url), "utf8");
  assert.match(board, /Wallet addresses are not displayed\./);
  assert.doesNotMatch(board, /Wallet addresses stay private\./);
  assert.match(donor, /NFT avatars are public and can be linked to their onchain owner\./);
  assert.match(donor, /Choose the ChogCare badge for more privacy\./);
  assert.doesNotMatch(donor, /localStorage\.setItem/);
});
