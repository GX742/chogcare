import { validInvoiceId, currentStore } from "./checkout-session.ts";
import { initiativeNames } from "./donation-share.ts";
import { isPositiveChogAmount, safeLeaderboardAvatarImage } from "./leaderboard-model.ts";

export type NftOption = { tokenId: string; name: string; image: string | null };
export type PublicProfile = {
  nickname: string; amount: string; initiativeId: string; avatarTokenId: string | null;
  avatarName: string | null; avatarImage: string | null; publishedAt: number;
};
export type DonorDraft = { nickname: string; avatarTokenId: string | null };
type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const tokenIdPattern = /^[0-9]{1,78}$/;
const nicknamePattern = /^[-_.\p{L}\p{N} ]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validAvatarTokenId(value: unknown): value is string {
  return typeof value === "string" && value.match(tokenIdPattern)?.[0] === value && BigInt(value) < 2n ** 256n;
}
export function normalizeDonorNickname(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 96) return null;
  const clean = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const length = [...clean].length;
  return length >= 2 && length <= 24 && clean.match(nicknamePattern)?.[0] === clean ? clean : null;
}
function avatarName(value: unknown): string | null {
  return typeof value === "string" && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
export function parsePublicProfile(value: unknown): PublicProfile | null {
  if (!isRecord(value)) return null;
  const nickname = normalizeDonorNickname(value.nickname);
  if (!nickname || !isPositiveChogAmount(value.amount) || typeof value.initiativeId !== "string" ||
    !Object.hasOwn(initiativeNames, value.initiativeId) || !Number.isSafeInteger(value.publishedAt) || (value.publishedAt as number) <= 0 ||
    (value.avatarTokenId !== null && !validAvatarTokenId(value.avatarTokenId))) return null;
  // Do not copy recovery IDs, wallet addresses or unexpected response properties.
  return {
    nickname, amount: value.amount, initiativeId: value.initiativeId,
    avatarTokenId: value.avatarTokenId as string | null, avatarName: avatarName(value.avatarName),
    avatarImage: safeLeaderboardAvatarImage(value.avatarImage), publishedAt: value.publishedAt as number,
  };
}
export function parseNftOptions(value: unknown): NftOption[] {
  if (!Array.isArray(value)) return [];
  const options: NftOption[] = [], seen = new Set<string>();
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item) || !validAvatarTokenId(item.tokenId) || seen.has(item.tokenId)) continue;
    const name = avatarName(item.name);
    if (!name) continue;
    seen.add(item.tokenId);
    options.push({ tokenId: item.tokenId, name, image: safeLeaderboardAvatarImage(item.image) });
    if (options.length === 24) break;
  }
  return options;
}
function parseDraft(raw: string | null, options: NftOption[]): DonorDraft | null {
  if (!raw || raw.length > 512) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;
  const nickname = normalizeDonorNickname(value.nickname);
  if (!nickname || (value.avatarTokenId !== null && !options.some(item => item.tokenId === value.avatarTokenId))) return null;
  return { nickname, avatarTokenId: value.avatarTokenId as string | null };
}
export function donorDraftKey(invoiceId: string): string {
  if (!validInvoiceId(invoiceId)) throw new Error("Invalid private profile recovery ID.");
  return `chogcare:donor-profile:${invoiceId}`;
}
export function readDonorDraft(invoiceId: string, options: NftOption[], storage: DraftStore = currentStore(), legacyStorage?: DraftStore): DonorDraft | null {
  const key = donorDraftKey(invoiceId), raw = storage.getItem(key);
  if (raw !== null) {
    const draft = parseDraft(raw, options);
    legacyStorage?.removeItem(key);
    return draft;
  }
  if (!legacyStorage) return null;
  const legacyRaw = legacyStorage.getItem(key);
  if (legacyRaw === null) return null;
  const draft = parseDraft(legacyRaw, options);
  // Migrate only this already-open invoice. Save the valid choice first, then
  // remove its persistent copy; do not enumerate or restore old payment history.
  if (draft) storage.setItem(key, JSON.stringify(draft));
  legacyStorage.removeItem(key);
  return draft;
}
export function saveDonorDraft(invoiceId: string, draft: DonorDraft, options: NftOption[], storage: DraftStore = currentStore()): void {
  const parsed = parseDraft(JSON.stringify(draft), options);
  if (!parsed) throw new Error("Invalid profile choice.");
  storage.setItem(donorDraftKey(invoiceId), JSON.stringify(parsed));
}
export function clearDonorDraft(invoiceId: string, storage?: DraftStore, legacyStorage?: DraftStore): void {
  const key = donorDraftKey(invoiceId);
  try { (storage ?? currentStore()).removeItem(key); }
  finally { legacyStorage?.removeItem(key); }
}
