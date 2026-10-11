import { formatUnits, parseUnits } from "viem";

const invoiceIdPattern = /^[a-f0-9]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const amountPattern = /^\d{1,7}(\.\d{1,18})?$/;
const matches = (pattern, value) => typeof value === "string" && value.match(pattern)?.[0] === value;
const same = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const visibleState = state => state === "confirming" || state === "delivered";

// Internal only. No RPC, NFT lookup, database write or new financial action.
// Identity comes from the source receipt already verified by the processor,
// never from a browser-supplied nickname, avatar or entered wallet address.
export function verifiedLeaderboardDonation(invoice, id) {
  if (!matches(invoiceIdPattern, id) || invoice?.id !== id || !visibleState(invoice.state)) return null;
  const proof = invoice.depositProof;
  if (proof?.kind !== "confirmed-chog-transfer" || proof.invoiceId !== id || proof.chainId !== 143 ||
      !matches(addressPattern, proof.sender) || /^0x0{40}$/i.test(proof.sender) ||
      !matches(hashPattern, proof.txHash) || !same(proof.txHash, invoice.depositHash) ||
      !matches(/^\d{1,78}$/, proof.amountUnits) ||
      proof.amountUnits !== invoice.units) return null;
  const amount = invoice.donationAmount ?? invoice.amount;
  if (!matches(amountPattern, amount)) return null;
  const units = parseUnits(amount, 18);
  if (units <= 0n || units > BigInt(proof.amountUnits)) return null;
  return { sender: proof.sender.toLowerCase(), state: invoice.state, amount, initiativeId: invoice.initiativeId ?? "burundi" };
}

export function buildDonorLeaderboard(records, readDonation, limit = 20) {
  if (typeof readDonation !== "function") return [];
  const donors = new Map(), seenInvoices = new Set();
  for (const profile of records) {
    if (!matches(invoiceIdPattern, profile?.invoiceId) || seenInvoices.has(profile.invoiceId)) continue;
    seenInvoices.add(profile.invoiceId);
    const donation = readDonation(profile.invoiceId);
    if (!donation || !visibleState(donation.state) || !matches(addressPattern, donation.sender) ||
        /^0x0{40}$/i.test(donation.sender) || !matches(amountPattern, donation.amount) ||
        typeof profile.nickname !== "string" || !Number.isSafeInteger(profile.publishedAt)) continue;
    const units = parseUnits(donation.amount, 18);
    if (units <= 0n) continue;
    const sender = donation.sender.toLowerCase();
    let donor = donors.get(sender);
    if (!donor) {
      donor = { units: 0n, profile, initiativeId: donation.initiativeId, firstPublishedAt: profile.publishedAt, confirming: false };
      donors.set(sender, donor);
    }
    donor.units += units;
    donor.firstPublishedAt = Math.min(donor.firstPublishedAt, profile.publishedAt);
    donor.confirming ||= donation.state === "confirming";
    if (profile.publishedAt > donor.profile.publishedAt ||
        (profile.publishedAt === donor.profile.publishedAt && profile.invoiceId > donor.profile.invoiceId)) {
      donor.profile = profile;
      donor.initiativeId = donation.initiativeId;
    }
  }
  // Sum every eligible published donation BEFORE applying the public top-20.
  // BigInt ordering also works for totals beyond JS Number's exact range.
  return [...donors.values()].sort((left, right) => {
    if (left.units !== right.units) return left.units > right.units ? -1 : 1;
    if (left.firstPublishedAt !== right.firstPublishedAt) return left.firstPublishedAt < right.firstPublishedAt ? -1 : 1;
    return left.profile.invoiceId < right.profile.invoiceId ? -1 : left.profile.invoiceId > right.profile.invoiceId ? 1 : 0;
  }).slice(0, limit).map((donor, index) => ({
    rank: index + 1,
    nickname: donor.profile.nickname,
    initiativeId: donor.initiativeId,
    amount: formatUnits(donor.units, 18),
    avatarTokenId: donor.profile.avatarTokenId ?? null,
    avatarName: donor.profile.avatarName ?? null,
    avatarImage: donor.profile.avatarImage ?? null,
    publishedAt: donor.profile.publishedAt,
    status: donor.confirming ? "confirming" : "delivered",
  }));
}
